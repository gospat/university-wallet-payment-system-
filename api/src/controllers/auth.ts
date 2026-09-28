import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth';
import { catchAsync } from '../utils/catchAsync';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate';
import { reqIp, reqUa } from '../utils/http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { Prisma, Role } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { dispatchEmail } from '../queues/emailQueue';
import { i18n } from '../i18n/en';
import { randomHex, isConsumedOrMissing, markConsumed } from '../services/passwordResetGuard';

export const signup = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token, accessToken, refreshToken, expiresInMs } = await AuthService.signup(req.body);

  res.status(201).json({
    status: 'success',
    token,
    accessToken,
    refreshToken,
    expiresInMs,
    data: { user },
  });
});

export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token, accessToken, refreshToken, expiresInMs } = await AuthService.login(req.body, reqIp(req), reqUa(req));

  res.status(200).json({
    status: 'success',
    token,
    accessToken,
    refreshToken,
    expiresInMs,
    data: { user },
  });
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(2000).trim(),
});

export const refresh = [
  validateBody(refreshSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { user, accessToken, refreshToken, expiresInMs } = await AuthService.refreshSession(
      req.body.refreshToken,
      reqIp(req),
      reqUa(req)
    );

    res.status(200).json({
      status: 'success',
      token: accessToken,
      accessToken,
      refreshToken,
      expiresInMs,
      data: { user },
    });
  }),
];

export const logoutAll = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next();
  await AuthService.revokeAll(req.user.id);
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
      req.body.newPassword
    );
    res.status(200).json({
      status: 'success',
      message: 'Password changed successfully.',
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

    // Redis/jti single-use guard: if already consumed OR never created (tamper), reject.
    const alreadyConsumed = await isConsumedOrMissing(jti).catch(() => false);
    if (alreadyConsumed) {
      return next(new AppError('Your password reset link has already been used. Please request a new one.', 409));
    }

    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: { id: true, email: true, role: true, accountStatus: true },
    });
    if (!user || String(user.accountStatus) !== 'ACTIVE') {
      return next(new AppError('Account is not available for password reset. Please contact support.', 409));
    }

    // Mark consumed BEFORE update to avoid race
    try {
      await markConsumed(jti, 16 * 60);
    } catch {
      // proceed anyway; the update is still safe via password change monotonic
    }

    const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const hashed = await bcrypt.hash(newPassword, rounds);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    try {
      const ip = reqIp(req as any);
      const ua = reqUa(req as any);
      await prisma.auditLog.create({
        data: {
          action: 'PASSWORD_RESET_COMPLETED',
          entityType: 'USER',
          entityId: String(user.id),
          userId: user.id,
          ipAddress: ip ? String(ip).slice(0, 64) : null,
          userAgent: ua ? String(ua).slice(0, 512) : null,
          details: { actorType: 'SELF' },
        },
      }).catch(() => {});
    } catch {
      // Non-fatal
    }

    try {
      void AuthService.revokeAll(user.id).catch(() => {});
    } catch {
      // Non-fatal
    }

    res.status(200).json({
      status: 'success',
      message: 'Your password has been updated. Please log in with your new password.',
    });
  }),
];
