// =============================================================================
// TOTP MULTI-FACTOR AUTHENTICATION (MFA) SERVICE
// =============================================================================
// Owns the MFA policy, the enrolment lifecycle, second-factor verification,
// single-use challenge tokens and session minting for a completed challenge.
//
// Security properties:
//   * The TOTP secret is stored AES-256-CBC ENCRYPTED at rest (utils/encryption)
//     and is NEVER logged or returned after enrolment.
//   * Recovery codes are stored as bcrypt HASHES only; the plaintext is returned
//     once and never persisted. Consumption is ATOMIC (a conditional
//     `updateMany({ where: { id, usedAt: null } })` claim), so a code cannot be
//     redeemed twice even concurrently.
//   * Challenge tokens are single-use via an atomic Redis `SET … NX` claim and
//     FAIL CLOSED (503) when the replay-protection store is unavailable.
//   * Wrong second factors reuse the SAME account lockout maths as the password
//     path (`computeLockoutState`) — one shared counter per account.
// =============================================================================

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Role, AccountStatus } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { i18n } from '../i18n/en';
import { encrypt, decrypt } from '../utils/encryption';
import { generateTotpSecret, verifyTotp, buildOtpauthUrl, generateTotp } from '../utils/totp';
import { randomHex, claimOnce } from './passwordResetGuard';
import { AuthService, computeLockoutState } from './auth';

export const MFA_CHALLENGE_AUDIENCE = 'urn:auth:mfa-challenge';
const MFA_CHALLENGE_TYPE = 'mfa-challenge';
const MFA_CHALLENGE_TTL_SEC = 5 * 60;
const MFA_CHALLENGE_TTL_MS = MFA_CHALLENGE_TTL_SEC * 1000;

const RECOVERY_CODE_COUNT = 10;
// 32-character alphabet → 256 is an exact multiple of 32, so `byte % 32` is
// UNBIASED. Ambiguous glyphs (I, O, 0, 1) are excluded for readability.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SEC = 30;

export type MfaEnforcement = 'staff' | 'all' | 'off';

/** Resolve the configured enforcement mode (default: 'staff'), fail-safe to 'staff'. */
export function getMfaEnforcement(): MfaEnforcement {
  const v = String(process.env.MFA_ENFORCEMENT ?? 'staff').trim().toLowerCase();
  return v === 'all' || v === 'off' ? v : 'staff';
}

export function getMfaIssuer(): string {
  return process.env.MFA_ISSUER || 'Bells University Payment Portal';
}

/**
 * Whether the MFA POLICY requires this user's role to hold a second factor.
 * Independent of whether the user has actually enrolled — pair with
 * `mfaEnabled` to decide whether to force ENROLMENT.
 */
export function isMfaRequiredForUser(user: { role: Role | string; mfaEnabled?: boolean | null }): boolean {
  const mode = getMfaEnforcement();
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return user.role === Role.ADMIN || user.role === Role.BURSARY;
}

// -----------------------------------------------------------------------------
// Single-use challenge tokens
// -----------------------------------------------------------------------------

export interface MfaChallengeToken {
  token: string;
  expiresInMs: number;
}

/**
 * Sign a short-lived, single-use challenge token that proves the PASSWORD step
 * passed but carries NO session authority (its `type` is rejected by `protect()`).
 * Single-use enforcement happens on redemption via `verifyMfaChallengeToken`.
 */
export function signMfaChallengeToken(userId: number): MfaChallengeToken {
  const jti = randomHex(16);
  const token = jwt.sign(
    { sub: String(userId), jti, type: MFA_CHALLENGE_TYPE, aud: MFA_CHALLENGE_AUDIENCE },
    process.env.JWT_SECRET as string,
    { expiresIn: MFA_CHALLENGE_TTL_SEC, algorithm: 'HS256' },
  );
  return { token, expiresInMs: MFA_CHALLENGE_TTL_MS };
}

export type MfaChallengeVerify =
  | { ok: true; userId: number }
  | { ok: false; reason: 'invalid' | 'expired' | 'replayed' | 'store-unavailable' };

/**
 * Verify AND atomically consume a challenge token. The Redis `SET … NX` claim is
 * performed BEFORE returning success, so exactly one redemption can ever succeed
 * and a store outage fails CLOSED (the caller refuses the sign-in).
 */
export async function verifyMfaChallengeToken(token: string): Promise<MfaChallengeVerify> {
  let payload: any;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET as string, {
      algorithms: ['HS256'],
      audience: MFA_CHALLENGE_AUDIENCE,
    });
  } catch (err: any) {
    return { ok: false, reason: err?.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string' ||
    payload.type !== MFA_CHALLENGE_TYPE
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, reason: 'invalid' };

  const claim = await claimOnce('mfa-challenge:consumed', payload.jti, MFA_CHALLENGE_TTL_SEC);
  if (claim === 'already-consumed') return { ok: false, reason: 'replayed' };
  if (claim === 'store-unavailable') return { ok: false, reason: 'store-unavailable' };
  return { ok: true, userId };
}

// -----------------------------------------------------------------------------
// Recovery codes
// -----------------------------------------------------------------------------

export function normalizeRecoveryCode(code: string): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomRecoveryCode(): string {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

async function buildRecoveryCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = randomRecoveryCode();
    codes.push(code);
    hashes.push(await bcrypt.hash(normalizeRecoveryCode(code), rounds));
  }
  return { codes, hashes };
}

// -----------------------------------------------------------------------------
// Enrolment lifecycle
// -----------------------------------------------------------------------------

export interface EnrollmentStartResult {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  digits: number;
  period: number;
}

/** Begin enrolment: generate + persist (encrypted) a pending TOTP secret. */
export async function startEnrollment(userId: number): Promise<EnrollmentStartResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, mfaEnabled: true },
  });
  if (!user) throw new AppError(i18n.errors.auth.userNotFound, 404);
  if (user.mfaEnabled === true) throw new AppError(i18n.errors.auth.mfaAlreadyEnabled, 409);

  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: userId },
    // The secret is only "pending" until confirmEnrollment proves the user can
    // generate a valid code from it; `mfaEnabled` stays false until then.
    data: { mfaSecret: encrypt(secret), mfaEnabled: false, mfaEnrolledAt: null },
  });

  await prisma.auditLog
    .create({
      data: {
        userId,
        action: i18n.auditActions.mfaEnrollmentStarted,
        entityType: 'USER',
        entityId: String(userId),
        details: { role: (user as any).role ?? null },
      },
    })
    .catch(() => {});

  const issuer = getMfaIssuer();
  const label = `${issuer}:${user.email}`;
  return {
    secret,
    otpauthUrl: buildOtpauthUrl({ secret, label, issuer, digits: TOTP_DIGITS, period: TOTP_PERIOD_SEC }),
    issuer,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SEC,
  };
}

export interface EnrollmentConfirmResult {
  recoveryCodes: string[];
}

/**
 * Confirm enrolment: verify the presented code against the pending secret, then
 * atomically enable the factor and issue a fresh set of recovery codes.
 */
export async function confirmEnrollment(userId: number, code: string): Promise<EnrollmentConfirmResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, mfaEnabled: true, mfaSecret: true },
  });
  if (!user) throw new AppError(i18n.errors.auth.userNotFound, 404);
  if (user.mfaEnabled === true) throw new AppError(i18n.errors.auth.mfaAlreadyEnabled, 409);
  if (!user.mfaSecret) throw new AppError(i18n.errors.auth.mfaSetupNotStarted, 400);

  let secret = '';
  try {
    secret = decrypt(user.mfaSecret);
  } catch {
    secret = '';
  }
  if (!secret || !verifyTotp(code, secret, { window: 1 })) {
    throw new AppError(i18n.errors.auth.mfaCodeInvalid, 400);
  }

  const { codes, hashes } = await buildRecoveryCodes();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    for (const codeHash of hashes) {
      await tx.mfaRecoveryCode.create({ data: { userId, codeHash } });
    }
    await tx.auditLog.create({
      data: {
        userId,
        action: i18n.auditActions.mfaEnabled,
        entityType: 'USER',
        entityId: String(userId),
        details: { recoveryCodesIssued: codes.length },
      },
    });
  });

  return { recoveryCodes: codes };
}

// -----------------------------------------------------------------------------
// Second-factor verification
// -----------------------------------------------------------------------------

export interface SecondFactorResult {
  ok: boolean;
  method?: 'totp' | 'recovery';
  remainingRecoveryCodes?: number;
}

/**
 * Verify a second factor that is EITHER a 6-digit TOTP code OR a recovery code.
 * A matched recovery code is consumed atomically.
 */
export async function verifySecondFactor(userId: number, code: string): Promise<SecondFactorResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, mfaEnabled: true, mfaSecret: true },
  });
  if (!user || user.mfaEnabled !== true || !user.mfaSecret) return { ok: false };

  const normalized = String(code ?? '').trim();

  // 1. TOTP (6 digits).
  if (/^\d{6}$/.test(normalized.replace(/\s/g, ''))) {
    let secret = '';
    try {
      secret = decrypt(user.mfaSecret);
    } catch {
      secret = '';
    }
    if (secret && verifyTotp(normalized, secret, { window: 1 })) {
      return { ok: true, method: 'totp' };
    }
  }

  // 2. Recovery code (bcrypt compare against unused rows, then atomic claim).
  const candidates = await prisma.mfaRecoveryCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true },
  });
  const rec = normalizeRecoveryCode(normalized);
  if (rec.length >= 8) {
    for (const candidate of candidates) {
      const match = await bcrypt.compare(rec, candidate.codeHash).catch(() => false);
      if (match) {
        const claimed = await prisma.mfaRecoveryCode.updateMany({
          where: { id: candidate.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (claimed.count === 1) {
          const remaining = await prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
          return { ok: true, method: 'recovery', remainingRecoveryCodes: remaining };
        }
        // Lost the atomic race — the code was consumed by a concurrent request.
        return { ok: false };
      }
    }
  }

  return { ok: false };
}

/**
 * Complete the MFA challenge: verify the second factor and, on success, mint the
 * real session. Wrong factors reuse the shared account-lockout maths and FAIL
 * CLOSED (the challenge token is already consumed by the caller).
 */
export async function completeSecondFactor(
  userId: number,
  code: string,
  ipAddress?: string,
  userAgent?: string,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      mfaEnabled: true,
      accountStatus: true,
      failedLoginAttempts: true,
      lockedUntil: true,
    },
  });
  if (!user || user.mfaEnabled !== true) throw new AppError(i18n.errors.auth.mfaNotEnabled, 401);
  if (user.accountStatus !== AccountStatus.ACTIVE) {
    throw new AppError(i18n.errors.auth.accountInactive, 403);
  }

  const now = new Date();
  if (user.lockedUntil && user.lockedUntil > now) {
    const minutesLeft = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60000);
    throw new AppError(i18n.errors.auth.accountLocked(minutesLeft), 429);
  }

  const result = await verifySecondFactor(userId, code);

  if (!result.ok) {
    const lockState = computeLockoutState(user.failedLoginAttempts ?? 0, user.lockedUntil ?? null, now);
    await prisma.user.update({ where: { id: userId }, data: lockState });
    await prisma.auditLog
      .create({
        data: {
          userId,
          action: i18n.auditActions.mfaChallengeFailed,
          entityType: 'USER',
          entityId: String(userId),
          ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
          userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
          details: {
            reason: 'BAD_SECOND_FACTOR',
            attempt: lockState.failedLoginAttempts,
            locked: !!lockState.lockedUntil,
          },
        },
      })
      .catch(() => {});
    throw new AppError(i18n.errors.auth.mfaUnableToVerify, 401);
  }

  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: now, failedLoginAttempts: 0, lockedUntil: null },
  });

  await prisma.auditLog
    .create({
      data: {
        userId,
        action:
          result.method === 'recovery' ? i18n.auditActions.mfaRecoveryCodeUsed : i18n.auditActions.mfaChallengeSucceeded,
        entityType: 'USER',
        entityId: String(userId),
        ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
        details: {
          method: result.method ?? 'totp',
          remainingRecoveryCodes: result.remainingRecoveryCodes ?? null,
        },
      },
    })
    .catch(() => {});

  return AuthService.issueVerifiedSession(userId, ipAddress, userAgent, { via: 'MFA' });
}

// -----------------------------------------------------------------------------
// Proof-of-possession for sensitive MFA mutations (disable / regenerate)
// -----------------------------------------------------------------------------

async function assertSensitiveProof(
  userId: number,
  user: { password?: string },
  proof: { password?: string; code?: string },
): Promise<void> {
  const { password, code } = proof ?? {};
  if (!password && !code) throw new AppError(i18n.errors.auth.mfaProofRequired, 400);

  if (password) {
    const matches = await bcrypt.compare(String(password), String(user.password ?? '')).catch(() => false);
    if (matches) return;
  }
  if (code) {
    const verified = await verifySecondFactor(userId, code);
    if (verified.ok) return;
  }
  throw new AppError(i18n.errors.auth.mfaWrongProof, 401);
}

export async function disableMfa(
  userId: number,
  proof: { password?: string; code?: string },
  opts?: { ipAddress?: string; userAgent?: string },
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, password: true, mfaEnabled: true, mfaSecret: true },
  });
  if (!user) throw new AppError(i18n.errors.auth.userNotFound, 404);
  if (user.mfaEnabled !== true) throw new AppError(i18n.errors.auth.mfaNotEnabled, 400);

  await assertSensitiveProof(userId, user, proof);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.auditLog.create({
      data: {
        userId,
        action: i18n.auditActions.mfaDisabled,
        entityType: 'USER',
        entityId: String(userId),
        ipAddress: opts?.ipAddress ? String(opts.ipAddress).slice(0, 64) : null,
        userAgent: opts?.userAgent ? String(opts.userAgent).slice(0, 512) : null,
        details: { via: 'SELF_SERVICE' },
      },
    });
  });
}

export async function regenerateRecoveryCodes(
  userId: number,
  proof: { password?: string; code?: string },
  opts?: { ipAddress?: string; userAgent?: string },
): Promise<{ recoveryCodes: string[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, password: true, mfaEnabled: true, mfaSecret: true },
  });
  if (!user) throw new AppError(i18n.errors.auth.userNotFound, 404);
  if (user.mfaEnabled !== true) throw new AppError(i18n.errors.auth.mfaNotEnabled, 400);

  await assertSensitiveProof(userId, user, proof);

  const { codes, hashes } = await buildRecoveryCodes();

  await prisma.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    for (const codeHash of hashes) {
      await tx.mfaRecoveryCode.create({ data: { userId, codeHash } });
    }
    await tx.auditLog.create({
      data: {
        userId,
        action: i18n.auditActions.mfaRecoveryCodesGenerated,
        entityType: 'USER',
        entityId: String(userId),
        ipAddress: opts?.ipAddress ? String(opts.ipAddress).slice(0, 64) : null,
        userAgent: opts?.userAgent ? String(opts.userAgent).slice(0, 512) : null,
        details: { recoveryCodesIssued: codes.length },
      },
    });
  });

  return { recoveryCodes: codes };
}

export interface MfaStatus {
  enabled: boolean;
  enrolledAt: Date | null;
  recoveryCodesRemaining: number;
  required: boolean;
  enforcement: MfaEnforcement;
}

export async function getMfaStatus(userId: number): Promise<MfaStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, mfaEnabled: true, mfaEnrolledAt: true },
  });
  if (!user) throw new AppError(i18n.errors.auth.userNotFound, 404);

  const enabled = user.mfaEnabled === true;
  const recoveryCodesRemaining = enabled
    ? await prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } })
    : 0;

  return {
    enabled,
    enrolledAt: user.mfaEnrolledAt ?? null,
    recoveryCodesRemaining,
    required: isMfaRequiredForUser({ role: user.role, mfaEnabled: enabled }),
    enforcement: getMfaEnforcement(),
  };
}

// Re-exported for callers/tests that need to mint a code against a known secret.
export { generateTotp };
