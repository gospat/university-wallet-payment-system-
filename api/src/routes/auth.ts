import express from 'express';
import rateLimit from 'express-rate-limit';
import { login, refresh, logout, logoutAll, me, changePassword, forgotPassword, resetPassword } from '../controllers/auth';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate';
import { protectSelfService } from '../middlewares/auth';
import { csrfOriginGuard } from '../middlewares/csrfOrigin';
import { reqIp } from '../utils/http';
import { Role } from '@prisma/client';

const router = express.Router();

const loginSchema = z.object({
  identifier: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()),
    z.string().min(1, 'Email or matric number is required').max(255),
  ),
  password: z.string().min(1).max(128).trim(),
  audience: z.enum([Role.ADMIN, Role.BURSARY, Role.STUDENT]).optional(),
}).strict();

const forgotPasswordSchema = z.object({
  email: z.string().trim().max(255).email(),
});

const forgotLimiterByEmail = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const e = String((req as any).body?.email || 'unknown').trim().toLowerCase();
    return `forgot-by-email:${e}`;
  },
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
  message: { status: 'fail', message: 'Too many password reset requests for this email. Please try again in 15 minutes.' },
});

const forgotLimiterByIp = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `forgot-by-ip:${reqIp(req as any) || 'anon'}`,
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
  message: { status: 'fail', message: 'Too many password reset requests from this IP. Please try again in an hour.' },
});

// ---------------------------------------------------------------------------
// PUBLIC SELF-SIGNUP — REMOVED (§ requirement 2)
// ---------------------------------------------------------------------------
// Anonymous account creation is not permitted. The endpoint is answered with a
// plain 404 (never 403/410) so it reveals nothing about prior state and cannot
// be used for account enumeration. Accounts are created only by authorised
// administrators through the admin / student-import surface.
router.post('/signup', (_req, res) => {
  res.status(404).json({ status: 'fail', message: 'Not found.' });
});

router.post('/login', validateBody(loginSchema), login);
// Cookie-based refresh → defence-in-depth CSRF origin check.
router.post('/refresh', csrfOriginGuard, ...(refresh as any[]));
router.post('/forgot-password', forgotLimiterByIp, forgotLimiterByEmail, validateBody(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', resetPassword as any[]);

// ---------------------------------------------------------------------------
// SELF-SERVICE SURFACE — `protectSelfService`, NOT `protect`.
// ---------------------------------------------------------------------------
// A student still holding the predictable bootstrap credential is in a
// restricted first-login state. `protect()` blocks that state with 403
// PASSWORD_CHANGE_REQUIRED, so only this minimal surface (identity, password
// change, logout) is mounted behind the authentication-only middleware. Every
// other authenticated route in the application stays behind `protect()`.
router.use(protectSelfService);
router.get('/me', me);
// Cookie-based logout → defence-in-depth CSRF origin check.
router.post('/logout', csrfOriginGuard, ...(logout as any[]));
router.post('/logout-all', logoutAll);
router.patch('/change-password', ...(changePassword as any[]));

export default router;
