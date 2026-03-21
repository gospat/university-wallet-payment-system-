import express from 'express';
import { getPendingWithdrawals, approveWithdrawal, rejectWithdrawal } from '../controllers/bursary';
import { protect, restrictTo } from '../middlewares/auth';
import { z } from 'zod';
import { validateParams } from '../middlewares/validate';

const router = express.Router();

router.use(protect);
router.use(restrictTo('BURSARY', 'ADMIN'));

router.get('/withdrawals', getPendingWithdrawals);
const withdrawalIdParams = z.object({ id: z.coerce.number().int().positive() });
router.post('/withdrawals/:id/approve', validateParams(withdrawalIdParams), approveWithdrawal);
router.post('/withdrawals/:id/reject', validateParams(withdrawalIdParams), rejectWithdrawal);

export default router;
