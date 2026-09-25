import express from 'express';
import { signup, login, refresh, logoutAll, me, changePassword } from '../controllers/auth';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate';
import { protect } from '../middlewares/auth';

const router = express.Router();

const signupSchema = z.object({
  email: z.string().trim().max(255).email(),
  password: z.string().min(8).max(128).trim(),
  firstName: z.string().min(1).max(80).trim(),
  lastName: z.string().min(1).max(80).trim(),
  matricNumber: z.string().min(3).max(50).trim().optional(),
});

const loginSchema = z.object({
  email: z.string().trim().max(255).email(),
  password: z.string().min(1).max(128).trim(),
});

router.post('/signup', validateBody(signupSchema), signup);
router.post('/login', validateBody(loginSchema), login);
router.post('/refresh', ...(refresh as any[]));

router.use(protect);
router.get('/me', me);
router.post('/logout-all', logoutAll);
router.patch('/change-password', ...(changePassword as any[]));

export default router;
