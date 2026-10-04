import express from 'express';
import rateLimit from 'express-rate-limit';
import { signup, login, refresh, logout, logoutAll, me, changePassword, forgotPassword, resetPassword } from '../controllers/auth';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate';
import { protect } from '../middlewares/auth';
import { reqIp } from '../utils/http';
import { Role } from '@prisma/client';

const router = express.Router();

const signupSchema = z.object({
  email: z.string().trim().max(255).email(),
  password: z.string().min(8).max(128).trim(),
  firstName: z.string().min(1).max(80).trim(),
  lastName: z.string().min(1).max(80).trim(),
  matricNumber: z.string().trim().min(3, 'Matric number must be at least 3 characters').max(50, 'Matric number must be 50 characters or fewer').regex(/^[A-Za-z0-9][A-Za-z0-9/\-. _]*$/, "Matric number must start with a letter or digit and contain only letters, digits, slash ( / ), hyphen ( - ), dot ( . ), underscore ( _ ), or space.").optional(),
});

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

router.post('/signup', validateBody(signupSchema), signup);
router.post('/login', validateBody(loginSchema), login);
router.post('/refresh', ...(refresh as any[]));
router.post('/forgot-password', forgotLimiterByIp, forgotLimiterByEmail, validateBody(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', resetPassword as any[]);

router.use(protect);
router.get('/me', me);
router.post('/logout', ...(logout as any[]));
router.post('/logout-all', logoutAll);
router.patch('/change-password', ...(changePassword as any[]));

export default router;
