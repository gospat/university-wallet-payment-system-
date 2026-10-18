import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth';
import { catchAsync } from '../utils/catchAsync';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate';
import { reqIp, reqUa } from '../utils/http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { Role } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { dispatchEmail } from '../queues/emailQueue';
import { i18n } from '../i18n/en';
import { randomHex, claimResetToken } from '../services/passwordResetGuard';
import { REFRESH_COOKIE_NAME, setRefreshCookie, clearRefreshCookie } from '../utils/authCookies';

// NOTE: public self-signup has been REMOVED (§ requirement 2). There is no
// `signup` controller and no `/auth/signup` route. Accounts are created
// exclusively by authorised administrators through the admin/student-import
// surface, so anonymous account creation is impossible.

export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token, accessToken, refreshToken, expiresInMs } = await AuthService.login(
    req.body,
    reqIp(req),
    reqUa(req),
    req.body?.audience as Role | undefined,
  );

  // The refresh credential is delivered ONLY as an HttpOnly cookie so frontend
  // JavaScript can never read it; it is deliberately NOT returned in the body.
  setRefreshCookie(res, refreshToken);

  res.status(200).json({
    status: 'success',
    token,
    accessToken,
    expiresInMs,
    data: { user },
  });
});

/**
 * Resolve the presented refresh token: PREFER the HttpOnly cookie, and fall
 * back to the legacy request-body field for backward compatibility with
 * clients that still send `{ refreshToken }` in the JSON body.
 */
function pickRefreshToken(req: Request): string | undefined {
  const cookieToken =
    typeof req.cookies?.[REFRESH_COOKIE_NAME] === 'string'
      ? (req.cookies[REFRESH_COOKIE_NAME] as string)
      : undefined;
  const bodyToken =
    typeof req.body?.refreshToken === 'string' && req.body.refreshToken.length > 0
      ? (req.body.refreshToken as string)
      : undefined;
  return cookieToken ?? bodyToken;
}

const refreshSchema = z.object({
  // Optional: the token may instead arrive via the HttpOnly cookie.
  refreshToken: z.string().min(1).max(2000).trim().optional(),
});

export const refresh = [
  validateBody(refreshSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const presented = pickRefreshToken(req);
    if (!presented) {
      return next(new AppError('A refresh token is required. Please log in again.', 401));
    }

    const { user, accessToken, refreshToken, expiresInMs } = await AuthService.refreshSession(
      presented,
      reqIp(req),
      reqUa(req)
    );

    // Rotate the HttpOnly cookie with the new refresh token; never expose it in
    // the response body.
    setRefreshCookie(res, refreshToken);

    res.status(200).json({
      status: 'success',
      token: accessToken,
      accessToken,
      expiresInMs,
      data: { user },
    });
  }),
];

const logoutSchema = z.object({
  // Optional: the token may instead arrive via the HttpOnly cookie.
  refreshToken: z.string().min(1).max(2000).trim().optional(),
});

export const logout = [
  validateBody(logoutSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError('Unauthorized.', 401));
    const presented = pickRefreshToken(req);
    if (presented) {
      await AuthService.revokeSingle(req.user.id, presented, {
        ip: reqIp(req) ?? undefined,
        userAgent: reqUa(req) ?? undefined,
      } as any);
    }
    // Always clear the HttpOnly refresh cookie so the browser cannot reuse it.
    clearRefreshCookie(res);
    res.status(200).json({
      status: 'success',
      message: 'You have been signed out.',
    });
  }),
];

export const logoutAll = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next();
  await AuthService.revokeAll(req.user.id, { ipAddress: reqIp(req) ?? undefined, userAgent: reqUa(req) ?? undefined });
  clearRefreshCookie(res);
  res.status(200).json({
    status: 'success',
    message: 'All sessions have been logged out.',
  });
});

export const me = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next();
  const user = await AuthService.me(req.user.id);
  res.status(200).json({
    status: 'success',
    data: { user },
  });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128).trim(),
  newPassword: z.string().min(8).max(128).trim(),
});

export const changePassword = [
  validateBody(changePasswordSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next();
    await AuthService.changePassword(
      req.user.id,
      req.body.currentPassword,
      req.body.newPassword,
      { ipAddress: reqIp(req) ?? undefined, userAgent: reqUa(req) ?? undefined },
    );
    res.status(200).json({
      status: 'success',
      message: 'Password changed successfully. Please log in again with your new password.',
    });
  }),
];

// ----------------------------------------------------------------------------
// Forgot / Reset password
// ----------------------------------------------------------------------------

const FRONTEND_BASE_URL_DEFAULT = 'http://localhost:5173';

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

function responseTimeNormalizer(startAt: number, minMs = 750): Promise<void> {
  const elapsed = Date.now() - startAt;
  if (elapsed >= minMs) return Promise.resolve();
  return new Promise((r) => setTimeout(r, minMs - elapsed));
}

export const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const email = normalizeEmail(req.body.email || '');

  const silentOk = (extraDelay = 0) =>
    responseTimeNormalizer(startedAt, 650 + extraDelay).then(() => {
      res.status(202).json({
        status: 'accepted',
        message: 'If your email is registered in the system, you will receive a password reset link shortly. Please check your inbox and spam folder.',
      });
    });

  try {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email.trim() } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        accountStatus: true,
        role: true,
      },
    });

    if (!user) return silentOk(0);

    if (String(user.accountStatus) !== 'ACTIVE') {
      // Still return success to avoid enumeration of statuses, but do not send.
      return silentOk(0);
    }

    const jti = randomHex(16);
    const expiresInSec = 15 * 60;
    const expiresInMs = expiresInSec * 1000;

    const token = jwt.sign(
      {
        sub: String(user.id),
        jti,
        role: user.role,
        type: 'pwd-reset',
        aud: 'urn:auth:pwd-reset',
      },
      process.env.JWT_SECRET as string,
      { expiresIn: expiresInSec, algorithm: 'HS256' },
    );

    const frontend = (process.env.FRONTEND_BASE_URL || FRONTEND_BASE_URL_DEFAULT).replace(/\/+$/, '');
    const resetUrl = `${frontend}/reset-password?token=${encodeURIComponent(token)}`;

    void dispatchEmail({
      emailType: 'PASSWORD_RESET',
      to: user.email,
      recipientId: user.id,
      reference: `pwd-reset:${jti}`,
      idempotencyKey: `pwd-reset-req:${jti}`,
      payload: {
        userFirstname: (user.firstName || user.lastName || 'there').trim() || 'there',
        resetUrl,
        expiresMinutes: Math.round(expiresInMs / 60000),
      },
    });

    return silentOk(0);
  } catch (err: any) {
    try { console.warn('[forgotPassword] error:', err?.code || err?.message); } catch {}
    return silentOk(150);
  }
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(4096),
  newPassword: z.string().min(8).max(128).trim(),
  confirmPassword: z.string().min(8).max(128).trim(),
}).refine((v) => v.newPassword === v.confirmPassword, {
  message: 'Passwords do not match.',
  path: ['confirmPassword'],
});

export const resetPassword = [
  validateBody(resetPasswordSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { token, newPassword } = req.body as { token: string; newPassword: string; confirmPassword: string };

    let payload: any = null;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET as string, {
        algorithms: ['HS256'],
        audience: 'urn:auth:pwd-reset',
      });
    } catch (verifyErr: any) {
      const code = verifyErr?.name;
      if (code === 'TokenExpiredError') {
        return next(new AppError('Your password reset link has expired. Please request a new one.', 409));
      }
      return next(new AppError('Your password reset link is invalid or has already been used. Please request a new one.', 409));
    }

    if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
      return next(new AppError('Your password reset link is invalid. Please request a new one.', 409));
    }

    const jti: string = payload.jti;
    const uid = Number(payload.sub);

    if (!Number.isFinite(uid) || uid <= 0) {
      return next(new AppError('Your password reset link is invalid. Please request a new one.', 409));
    }

    // ---------------------------------------------------------------------
    // ATOMIC SINGLE-USE CLAIM (§ requirement 6)
    // ---------------------------------------------------------------------
    // The claim is performed BEFORE any password mutation, in ONE conditional
    // Redis operation, so two concurrent requests presenting the same token
    // cannot both succeed — the loser is rejected here and never touches the
    // password. FAIL CLOSED: if the replay-protection store is unavailable we
    // refuse the reset rather than degrading to a weaker guarantee.
    const claim = await claimResetToken(jti, 16 * 60);
    if (claim === 'already-consumed') {
      return next(new AppError('Your password reset link has already been used. Please request a new one.', 409));
    }
    if (claim === 'store-unavailable') {
      return next(new AppError('Password reset is temporarily unavailable. Please try again shortly.', 503));
    }

    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: { id: true, email: true, role: true, accountStatus: true },
    });
    if (!user || String(user.accountStatus) !== 'ACTIVE') {
      return next(new AppError('Account is not available for password reset. Please contact support.', 409));
    }

    const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const hashed = await bcrypt.hash(newPassword, rounds);

    // Password write + session invalidation are ONE transaction: bumping
    // `authVersion` immediately invalidates every already-issued access token
    // and revoking refresh tokens kills every renewable session.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            password: hashed,
            mustChangePassword: false,
            failedLoginAttempts: 0,
            lockedUntil: null,
            authVersion: { increment: 1 },
          },
        });
        await tx.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            action: 'PASSWORD_RESET_COMPLETED',
            entityType: 'USER',
            entityId: String(user.id),
            userId: user.id,
            ipAddress: reqIp(req as any) ? String(reqIp(req as any)).slice(0, 64) : null,
            userAgent: reqUa(req as any) ? String(reqUa(req as any)).slice(0, 512) : null,
            details: { actorType: 'SELF', sessionsRevoked: true },
          },
        });
      });
    } catch (err) {
      // The token has already been claimed; a transient DB failure must not be
      // reported as success. Surface a retryable error (the user re-requests).
      return next(new AppError('Could not complete the password reset. Please request a new link.', 503));
    }

    res.status(200).json({
      status: 'success',
      message: 'Your password has been updated. Please log in with your new password.',
    });
  }),
];
