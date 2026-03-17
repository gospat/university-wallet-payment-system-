import express from 'express';
import { getDashboardStats, addStudent } from '../controllers/admin';
import { protect, restrictTo } from '../middlewares/auth';

const router = express.Router();

router.use(protect);
router.use(restrictTo('ADMIN'));

router.get('/stats', getDashboardStats);
router.post('/students', addStudent);

export default router;
