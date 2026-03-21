import express from 'express';
import { getBalance, getTransactions, initiateDeposit, verifyDeposit, transfer, requestWithdrawal, webhook } from '../controllers/wallet';
import { downloadReceipt, downloadStatement } from '../controllers/receipt';
import { protect } from '../middlewares/auth';
import { z } from 'zod';
import { requireIdempotencyKey, validateBody, validateParams } from '../middlewares/validate';

const router = express.Router();

router.post('/webhook', webhook);

router.use(protect);

const depositSchema = z.object({
  amount: z.coerce.number().finite().positive(),
  email: z.string().email().max(254),
});

const verifyParamsSchema = z.object({
  reference: z.string().min(6).max(120),
});

const transferSchema = z.object({
  receiverMatric: z.string().min(3).max(50),
  amount: z.coerce.number().finite().positive(),
});

const withdrawSchema = z.object({
  amount: z.coerce.number().finite().positive(),
  bank_details: z.object({
    bank: z.string().min(2).max(120),
    account: z.string().min(6).max(30),
    accountName: z.string().min(2).max(120).optional(),
  }),
});

router.get('/balance', getBalance);
router.get('/transactions', getTransactions);
router.post('/deposit', requireIdempotencyKey, validateBody(depositSchema), initiateDeposit);
router.get('/verify/:reference', validateParams(verifyParamsSchema), verifyDeposit);
router.post('/transfer', validateBody(transferSchema), transfer);
router.post('/withdraw', validateBody(withdrawSchema), requestWithdrawal);
router.get('/receipt/:reference', downloadReceipt);
router.get('/statement', downloadStatement);

export default router;
