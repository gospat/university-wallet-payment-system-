import express from 'express';
import { getDashboardStats, addStudent } from '../controllers/admin';
import { protect, restrictTo } from '../middlewares/auth';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate';

const router = express.Router();

router.use(protect);
router.use(restrictTo('ADMIN'));

router.get('/stats', getDashboardStats);
const addStudentSchema = z.object({
  email: z.string().email().max(254),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  matricNumber: z.string().min(3).max(50),
  password: z.string().min(8).max(128).optional(),
  college: z.string().min(2).max(120).optional(),
  department: z.string().min(2).max(120).optional(),
  program: z.string().min(2).max(120).optional(),
});
router.post('/students', validateBody(addStudentSchema), addStudent);

export default router;
