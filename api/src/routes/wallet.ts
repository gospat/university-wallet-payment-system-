import express from 'express';
import { getBalance, getTransactions, initiateDeposit, verifyDeposit, transfer, requestWithdrawal, webhook } from '../controllers/wallet';
import { downloadReceipt, downloadStatement } from '../controllers/receipt';
import { protect } from '../middlewares/auth';

const router = express.Router();

router.post('/webhook', webhook);

router.use(protect);

router.get('/balance', getBalance);
router.get('/transactions', getTransactions);
router.post('/deposit', initiateDeposit);
router.get('/verify/:reference', verifyDeposit);
router.post('/transfer', transfer);
router.post('/withdraw', requestWithdrawal);
router.get('/receipt/:reference', downloadReceipt);
router.get('/statement', downloadStatement);

export default router;
