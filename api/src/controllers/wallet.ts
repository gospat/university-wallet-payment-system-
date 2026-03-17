import { Request, Response, NextFunction } from 'express';
import { WalletService } from '../services/wallet';
import { catchAsync } from '../utils/catchAsync';
import crypto from 'crypto';
import { AppError } from '../utils/AppError';
import prisma from '../config/database';
import { encrypt } from '../utils/encryption';

export const getBalance = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const balance = await WalletService.getBalance(req.user!.id);
  res.status(200).json({
    status: 'success',
    data: { balance: balance.balance },
  });
});

export const getTransactions = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const transactions = await prisma.transaction.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'desc' },
  });

  res.status(200).json({
    status: 'success',
    data: { transactions },
  });
});

export const initiateDeposit = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { amount, email } = req.body;
  if (!email) {
    return next(new AppError('Email is required', 400));
  }
  const result = await WalletService.initiateDeposit(req.user!.id, Number(amount), email);
  res.status(200).json({
    status: 'success',
    data: result,
  });
});

export const verifyDeposit = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { reference } = req.params;
  if (typeof reference !== 'string') {
    return next(new AppError('Invalid reference', 400));
  }
  const result = await WalletService.verifyDeposit(reference);
  res.status(200).json({
    status: 'success',
    message: 'Deposit verified successfully',
    data: result,
  });
});

export const transfer = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { receiverMatric, amount } = req.body;
  const result = await WalletService.transfer(req.user!.id, receiverMatric, Number(amount));
  res.status(200).json({
    status: 'success',
    message: 'Transfer successful',
    data: result,
  });
});

export const requestWithdrawal = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { amount, bank_details } = req.body;
  
  if (!amount || amount < 1000) {
    return next(new AppError('Minimum withdrawal is 1000', 400));
  }

  // Encrypt sensitive bank details before saving
  const encryptedBankDetails = {
    bank: bank_details.bank,
    account: encrypt(bank_details.account), // Encrypt Account Number
    accountName: bank_details.accountName // Optional: Encrypt name if needed
  };

  const wallet = await prisma.wallet.findUnique({ where: { userId: req.user!.id } });
  if (!wallet || Number(wallet.balance) < amount) {
    return next(new AppError('Insufficient funds', 400));
  }

  await prisma.transaction.create({
    data: {
      userId: req.user!.id,
      reference: `WD_${Date.now()}_${req.user!.id}`,
      amount: Number(amount),
      type: 'WITHDRAWAL',
      status: 'PENDING',
      metadata: encryptedBankDetails, // Save encrypted metadata
    }
  });

  res.status(200).json({
    status: 'success',
    message: 'Withdrawal request submitted'
  });
});

export const webhook = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || '';
  const rawBody = (req as any).rawBody;
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

  if (hash === req.headers['x-paystack-signature']) {
    const event = req.body;
    if (event.event === 'charge.success') {
      const reference = event.data.reference;
      try {
        await WalletService.verifyDeposit(reference);
      } catch (error) {
        console.error('Webhook verification failed', error);
      }
    }
  }

  res.status(200).send('OK');
});
