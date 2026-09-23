import express from 'express';
import { signup, login, me, changePassword } from '../controllers/auth';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate';
import { protect } from '../middlewares/auth';

const router = express.Router();

const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  matricNumber: z.string().min(3).max(50).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

router.post('/signup', validateBody(signupSchema), signup);
router.post('/login', validateBody(loginSchema), login);

router.use(protect);
router.get('/me', me);
router.patch('/change-password', ...(changePassword as any[]));

export default router;
