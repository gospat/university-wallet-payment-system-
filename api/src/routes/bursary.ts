import express from 'express';
import { getPendingWithdrawals, approveWithdrawal, rejectWithdrawal } from '../controllers/bursary';
import { protect, restrictTo } from '../middlewares/auth';

const router = express.Router();

router.use(protect);
router.use(restrictTo('BURSARY', 'ADMIN'));

router.get('/withdrawals', getPendingWithdrawals);
router.post('/withdrawals/:id/approve', approveWithdrawal);
router.post('/withdrawals/:id/reject', rejectWithdrawal);

export default router;
