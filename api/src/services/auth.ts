import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Role, AccountStatus } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { randomHex } from '../utils/security';
import { resolveEffectivePermissionsForUser } from './permissionResolver';
import { i18n } from '../i18n/en';

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const ACCESS_EXPIRES_IN: string = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const REFRESH_EXPIRES_IN: string = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const ACCESS_EXPIRES_MS: number = 15 * 60 * 1000;
const REFRESH_EXPIRES_MS: number = 7 * 24 * 60 * 60 * 1000;

export const SessionTiming = {
  ACCESS_EXPIRES_MS,
  REFRESH_EXPIRES_MS,
};

const GENERIC_LOGIN_ERROR = 'Incorrect email or password';

if (!process.env.JWT_REFRESH_SECRET || typeof process.env.JWT_REFRESH_SECRET !== 'string' || process.env.JWT_REFRESH_SECRET.length === 0) {
  throw new Error('FATAL: JWT_REFRESH_SECRET environment variable is required and must be set. Do not derive it from JWT_SECRET.');
}

const getRefreshSecret = (): string => {
  return process.env.JWT_REFRESH_SECRET as string;
};

/**
 * Access tokens embed a SESSION GENERATION (`ver`). `protect()` compares it
 * against the authoritative `User.authVersion` on every authenticated request,
 * so bumping that column immediately invalidates every already-issued access
 * token. Tokens issued before this change carry no `ver` and are treated as
 * generation 0 (the additive DB default), keeping the change backward
 * compatible.
 */
const signAccessToken = (id: number, role: Role, authVersion = 0) => {
  return jwt.sign(
    { id, role, type: 'access', ver: Number(authVersion) || 0 },
    process.env.JWT_SECRET as string,
    { expiresIn: ACCESS_EXPIRES_IN as any, algorithm: 'HS256' }
  );
};

const signRefreshToken = (userId: number, jti: string) => {
  return jwt.sign(
    { userId, jti, type: 'refresh' },
    getRefreshSecret(),
    { expiresIn: REFRESH_EXPIRES_IN as any, algorithm: 'HS256' }
  );
};

const safeUserSelect = {
  id: true,
  email: true,
  firstName: true,
  middleName: true,
  lastName: true,
  role: true,
  isSuperAdmin: true,
  matricNumber: true,
  college: true,
  department: true,
  program: true,
  level: true,
  academicSession: true,
  accountStatus: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface AuthResult {
  user: any;
  token: string;
  accessToken: string;
  refreshToken: string;
  expiresInMs: number;
}

export class AuthService {
  private static async buildTokensForUser(
    userId: number,
    role: Role,
    authVersion = 0,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresInMs: number }> {
    const accessToken = signAccessToken(userId, role, authVersion);
    const { refreshJWT } = await AuthService.generateRefreshToken(userId, ipAddress, userAgent);
    return {
      accessToken,
      refreshToken: refreshJWT,
      expiresInMs: ACCESS_EXPIRES_MS,
    };
  }

  static async generateRefreshToken(userId: number, ipAddress?: string, userAgent?: string) {
    const tokenHex = randomHex(64);
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);

    await prisma.refreshToken.create({
      data: {
        userId,
        token: tokenHex,
        expiresAt,
        ipAddress,
        userAgent,
      },
    });

    const jti = tokenHex;
    const refreshJWT = signRefreshToken(userId, jti);

    return { tokenHex, refreshJWT };
  }

  static async refreshSession(refreshJWT: string, ipAddress?: string, userAgent?: string) {
    let decoded: any;
    try {
      decoded = jwt.verify(refreshJWT, getRefreshSecret(), { algorithms: ['HS256'] });
    } catch (err) {
      throw new AppError('Invalid refresh token. Please log in again.', 401);
    }

    if (typeof decoded !== 'object' || !decoded || typeof decoded.userId !== 'number' || typeof decoded.jti !== 'string') {
      throw new AppError('Invalid refresh token. Please log in again.', 401);
    }

    if (decoded.type && decoded.type !== 'refresh') {
      throw new AppError('Invalid token type. Please use a refresh token.', 401);
    }

    const tokenHex = decoded.jti;
    const refreshRow = await prisma.refreshToken.findUnique({
      where: { token: tokenHex },
      include: { user: true },
    });

    if (!refreshRow) {
      throw new AppError('Refresh token not found. Please log in again.', 401);
    }

    if (refreshRow.revokedAt) {
      throw new AppError('Refresh token has been revoked. Please log in again.', 401);
    }

    if (refreshRow.expiresAt < new Date()) {
      throw new AppError('Refresh token has expired. Please log in again.', 401);
    }

    const user = refreshRow.user;

    if (user.accountStatus !== AccountStatus.ACTIVE) {
      throw new AppError('This account is no longer active.', 403);
    }

    const permissions: string[] = await resolveEffectivePermissionsForUser({
      id: user.id,
      role: user.role,
      isSuperAdmin: (user as any).isSuperAdmin === true,
    });

    const result = await prisma.$transaction(async (tx) => {
      // ---------------------------------------------------------------------
      // ATOMIC ROTATION CLAIM (§ requirement 8)
      // ---------------------------------------------------------------------
      // The previous implementation read the row, checked `revokedAt`, then
      // updated it — a check-then-mutate sequence that allowed the SAME refresh
      // token to be rotated twice concurrently (two independent valid sessions
      // minted from one token). This single conditional UPDATE re-evaluates the
      // predicate against the CURRENT committed row under the row lock, so with
      // concurrent callers exactly ONE matches a row (count === 1) and every
      // other caller matches 0 and is rejected. The claim and the replacement
      // token creation are in the same transaction, so there is no window in
      // which a token is revoked without a successor.
      const claimed = await tx.refreshToken.updateMany({
        where: {
          token: tokenHex,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: {
          revokedAt: new Date(),
          lastUsedAt: new Date(),
        },
      });

      if (claimed.count !== 1) {
        throw new AppError('Refresh token has already been used. Please log in again.', 401);
      }

      const newTokenHex = randomHex(64);
      const newExpiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);

      await tx.refreshToken.create({
        data: {
          userId: user.id,
          token: newTokenHex,
          expiresAt: newExpiresAt,
          ipAddress,
          userAgent,
        },
      });

      const newAccessToken = signAccessToken(
        user.id,
        user.role,
        Number((user as any).authVersion ?? 0),
      );
      const newRefreshJWT = signRefreshToken(user.id, newTokenHex);

      return { newAccessToken, newRefreshJWT };
    });

    const safeUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: safeUserSelect,
    });

    await prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: i18n.auditActions.sessionRefreshed,
          entityType: 'SESSION',
          entityId: String(refreshRow.id),
          ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
          userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
          details: { rotated: true },
        },
      })
      .catch(() => {});

    return {
      user: { ...safeUser, permissions },
      accessToken: result.newAccessToken,
      refreshToken: result.newRefreshJWT,
      expiresInMs: ACCESS_EXPIRES_MS,
    };
  }

  static async revokeAll(userId: number, opts?: { ipAddress?: string; userAgent?: string }) {
    const { count } = await prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    if (count > 0) {
      await prisma.auditLog
        .create({
          data: {
            userId,
            action: i18n.auditActions.logoutAll,
            entityType: 'SESSION',
            entityId: String(userId),
            ipAddress: opts?.ipAddress ? String(opts.ipAddress).slice(0, 64) : null,
            userAgent: opts?.userAgent ? String(opts.userAgent).slice(0, 512) : null,
            details: { revokedSessions: count },
          },
        })
        .catch(() => {});
    }
  }

  static async revokeSingle(userId: number, refreshJWT: string, opts?: { ipAddress?: string; userAgent?: string }) {
    let decoded: any;
    try {
      decoded = jwt.verify(refreshJWT, getRefreshSecret(), { algorithms: ['HS256'] });
    } catch {
      throw new AppError('Invalid refresh token.', 401);
    }
    if (!decoded || typeof decoded.jti !== 'string') {
      throw new AppError('Invalid refresh token.', 401);
    }
    const tokenHex = decoded.jti;
    const row = await prisma.refreshToken.findUnique({
      where: { token: tokenHex },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (!row || row.userId !== userId) {
      throw new AppError('Invalid refresh token.', 401);
    }
    await prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    await prisma.auditLog
      .create({
        data: {
          userId,
          action: i18n.auditActions.logout,
          entityType: 'SESSION',
          entityId: String(row.id),
          ipAddress: opts?.ipAddress ? String(opts.ipAddress).slice(0, 64) : null,
          userAgent: opts?.userAgent ? String(opts.userAgent).slice(0, 512) : null,
          details: { via: 'AUTH_LOGOUT' },
        },
      })
      .catch(() => {});
    return { revoked: true };
  }

  // NOTE: `AuthService.signup()` has been REMOVED (§ requirement 2). Public
  // self-signup no longer exists anywhere in the codebase, so there is no code
  // path that can create an anonymous account.

  static async login(
    data: any,
    ipAddress?: string,
    userAgent?: string,
    audience?: Role,
  ): Promise<AuthResult> {
    // Login supports TWO identifier modes:
    //  · `identifier` (new) → can be email OR student matric number.
    //  · `email` (legacy)    → always interpreted as email only (preserved for old integrations/tests).
    const identifierRaw: string | undefined =
      data.identifier != null ? String(data.identifier) : data.email != null ? String(data.email) : undefined;
    const { password } = data;

    if (!identifierRaw || !password) {
      throw new AppError(i18n.errors.auth.noCredentials, 400);
    }
    const identifier = identifierRaw.trim();
    const looksLikeEmail = /^\S+@\S+\.\S+$/.test(identifier);

    // Login identifier resolution — intentionally flexible on matric formats
    // (supports any stored identifier, e.g. 2020/001, 2024/1000, 2024/PG/2000,
    // 2024-HND-077, etc). We NEVER apply a regex filter or format transform here
    // so that WHATEVER string was stored in `users.matricNumber` during user
    // creation is what the database lookup uses.
    //
    // Email path: strict unique match on lowercased email (email is always
    // stored lowercased).
    // Matric path: same 3-variant case-insensitive lookup pattern used by
    // StudentService.getByMatric(), so `2024/PG/2000` works whether the user
    // types `2024/pg/2000`, `2024/Pg/2000`, or `2024/PG/2000` regardless of the
    // underlying DB collation.
    let userWithPassword: any = null;
    if (looksLikeEmail) {
      userWithPassword =
        (await prisma.user.findUnique({ where: { email: identifier.toLowerCase() } })) ??
        (await prisma.user.findFirst({
          where: {
            OR: [
              { matricNumber: identifier },
              { matricNumber: identifier.toLowerCase() },
              { matricNumber: identifier.toUpperCase() },
            ],
          },
          orderBy: { id: 'asc' },
        }));
    } else {
      userWithPassword =
        (await prisma.user.findFirst({
          where: {
            OR: [
              { matricNumber: identifier },
              { matricNumber: identifier.toLowerCase() },
              { matricNumber: identifier.toUpperCase() },
            ],
          },
          orderBy: { id: 'asc' },
        })) ??
        (await prisma.user.findUnique({ where: { email: identifier.toLowerCase() } }));
    }

    if (!userWithPassword) {
      throw new AppError(GENERIC_LOGIN_ERROR, 401);
    }

    if (userWithPassword.accountStatus === AccountStatus.SUSPENDED) {
      throw new AppError(i18n.errors.auth.accountSuspended, 403);
    }
    if (userWithPassword.accountStatus === AccountStatus.WITHDRAWN) {
      throw new AppError(i18n.errors.auth.accountInactive, 403);
    }
    if (userWithPassword.accountStatus === AccountStatus.GRADUATED) {
      throw new AppError(i18n.errors.auth.accountGraduated, 403);
    }

    const now = new Date();
    if (userWithPassword.lockedUntil && userWithPassword.lockedUntil > now) {
      const minutesLeft = Math.ceil(
        (userWithPassword.lockedUntil.getTime() - now.getTime()) / 60000
      );
      throw new AppError(
        i18n.errors.auth.accountLocked(minutesLeft),
        429
      );
    }

    const passwordMatches = await bcrypt.compare(password, userWithPassword.password);

    if (!passwordMatches) {
      const newFailedCount = (userWithPassword.failedLoginAttempts ?? 0) + 1;
      const lockUntil: Date | null =
        newFailedCount >= MAX_FAILED_LOGIN_ATTEMPTS
          ? new Date(now.getTime() + LOCKOUT_MINUTES * 60000)
          : userWithPassword.lockedUntil && userWithPassword.lockedUntil > now
          ? userWithPassword.lockedUntil
          : null;

      await prisma.user.update({
        where: { id: userWithPassword.id },
        data: { failedLoginAttempts: newFailedCount, lockedUntil: lockUntil },
      });

      await prisma.auditLog
        .create({
          data: {
            userId: userWithPassword.id,
            action: i18n.auditActions.loginFailed,
            entityType: 'USER',
            entityId: String(userWithPassword.id),
            ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
            userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
            details: { reason: 'BAD_PASSWORD', attempt: newFailedCount, locked: !!lockUntil },
          },
        })
        .catch(() => {});

      throw new AppError(GENERIC_LOGIN_ERROR, 401);
    }

    if (audience && userWithPassword.role !== audience) {
      await prisma.auditLog
        .create({
          data: {
            userId: userWithPassword.id,
            action: i18n.auditActions.loginWrongAudience,
            entityType: 'USER',
            entityId: String(userWithPassword.id),
            ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
            userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
            details: { submittedAudience: audience, actualRole: userWithPassword.role },
          },
        })
        .catch(() => {});
      throw new AppError(GENERIC_LOGIN_ERROR, 401);
    }

    await prisma.user.update({
      where: { id: userWithPassword.id },
      data: {
        lastLoginAt: now,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: userWithPassword.id },
      // `authVersion` is needed to stamp the session generation onto the access
      // token; it is stripped from the response payload below.
      select: { ...safeUserSelect, authVersion: true },
    });
    if (!user) throw new AppError(i18n.errors.auth.userNotFound, 404);

    const { authVersion: loginAuthVersion, ...publicUser } = user as any;

    const permissions: string[] = await resolveEffectivePermissionsForUser({
      id: publicUser.id,
      role: publicUser.role,
      isSuperAdmin: (publicUser as any).isSuperAdmin === true,
    });

    await prisma.auditLog
      .create({
        data: {
          userId: publicUser.id,
          action: i18n.auditActions.login,
          entityType: 'USER',
          entityId: String(publicUser.id),
          ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
          userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
          details: { role: publicUser.role, audience: audience ?? null },
        },
      })
      .catch(() => {});

    const tokens = await AuthService.buildTokensForUser(
      publicUser.id,
      publicUser.role,
      Number(loginAuthVersion ?? 0),
      ipAddress,
      userAgent,
    );

    return {
      user: { ...publicUser, permissions },
      token: tokens.accessToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInMs: tokens.expiresInMs,
    };
  }

  static async me(userId: number) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: safeUserSelect,
    });
    if (!user) {
      throw new AppError('The user belonging to this token no longer exists.', 401);
    }
    if (user.accountStatus !== AccountStatus.ACTIVE) {
      throw new AppError('This account is no longer active.', 403);
    }
    const permissions: string[] = await resolveEffectivePermissionsForUser({
      id: user.id,
      role: user.role,
      isSuperAdmin: (user as any).isSuperAdmin === true,
    });
    return { ...user, permissions };
  }

  static async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    opts?: { ipAddress?: string; userAgent?: string },
  ) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) throw new AppError('Current password is incorrect.', 401);
    if (await bcrypt.compare(newPassword, user.password)) {
      throw new AppError(i18n.errors.auth.passwordSame, 400);
    }
    if (newPassword.length < 8) {
      throw new AppError(i18n.errors.auth.passwordTooShort, 400);
    }

    // The bootstrap credential IS the lowercased surname (or matric number when
    // no surname is known), so those values — and the account's own email and
    // its local part — must never be reusable as the new password, otherwise
    // the first-login change would be cosmetic only.
    const newLower = newPassword.trim().toLowerCase();
    const forbidden = new Set<string>();
    const surname = String(user.lastName ?? '').trim().toLowerCase();
    if (surname) forbidden.add(surname);
    const matric = String(user.matricNumber ?? '').trim().toLowerCase();
    if (matric) forbidden.add(matric);
    const email = String(user.email ?? '').trim().toLowerCase();
    if (email) {
      forbidden.add(email);
      const localPart = email.split('@')[0];
      if (localPart) forbidden.add(localPart);
    }
    if (forbidden.has(newLower)) {
      throw new AppError(
        'New password must not be your surname, matriculation number or email address.',
        400,
      );
    }

    const hash = await bcrypt.hash(newPassword, 12);

    // One transaction: password write, session-generation bump and refresh-token
    // revocation. Bumping `authVersion` invalidates every already-issued access
    // token (including the caller's own), and revoking refresh tokens removes
    // every renewable session — so a password change genuinely ends all prior
    // sessions rather than only affecting future logins.
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          password: hash,
          mustChangePassword: false,
          authVersion: { increment: 1 },
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'PASSWORD_CHANGED',
          entityType: 'USER',
          entityId: String(userId),
          ipAddress: opts?.ipAddress ? String(opts.ipAddress).slice(0, 64) : null,
          userAgent: opts?.userAgent ? String(opts.userAgent).slice(0, 512) : null,
          details: { via: 'SELF_SERVICE', sessionsRevoked: true },
        },
      });
    });
  }
}
