import express from 'express';
import { signup, login } from '../controllers/auth';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate';

const router = express.Router();

const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  matricNumber: z.string().min(3).max(50).optional(),
  role: z.enum(['STUDENT', 'ADMIN', 'BURSARY']).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

router.post('/signup', validateBody(signupSchema), signup);
router.post('/login', validateBody(loginSchema), login);

export default router;
