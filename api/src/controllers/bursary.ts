import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { LedgerService } from '../services/ledger';
import { LedgerType, TransactionStatus } from '@prisma/client';
import { decrypt } from '../utils/encryption';

export const getPendingWithdrawals = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const withdrawals = await prisma.transaction.findMany({
    where: {
      type: 'WITHDRAWAL',
      status: 'PENDING',
    },
    include: {
      user: {
        select: {
          firstName: true,
          lastName: true,
          matricNumber: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Decrypt bank details for Bursary view
  const withdrawalsWithDecryptedData = withdrawals.map((w) => {
    const metadata = w.metadata as any;
    if (metadata && metadata.account) {
      try {
        metadata.account = decrypt(metadata.account);
      } catch (e) {
        metadata.account = '*** Decryption Failed ***';
      }
    }
    return { ...w, metadata };
  });

  res.status(200).json({
    status: 'success',
    data: { withdrawals: withdrawalsWithDecryptedData },
  });
});

export const approveWithdrawal = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;

  await prisma.$transaction(async (tx) => {
    const transaction = await tx.transaction.findUnique({
      where: { id: Number(id) },
    });

    if (!transaction || transaction.type !== 'WITHDRAWAL' || transaction.status !== 'PENDING') {
      throw new AppError('Invalid withdrawal request', 400);
    }

    const wallet = await tx.wallet.findUnique({ where: { userId: transaction.userId } });
    if (!wallet) throw new AppError('Wallet not found', 404);

    // Debit Wallet
    await LedgerService.recordEntry(tx, {
      walletId: wallet.id,
      transactionId: transaction.id,
      type: LedgerType.DEBIT,
      amount: Number(transaction.amount),
    });

    // Update Status
    await tx.transaction.update({
      where: { id: transaction.id },
      data: { status: TransactionStatus.SUCCESS },
    });

    await tx.auditLog.create({
      data: {
        userId: req.user?.id,
        action: 'WITHDRAWAL_APPROVED',
        details: { withdrawalId: transaction.id, amount: Number(transaction.amount), studentId: transaction.userId },
        ipAddress: req.ip,
      },
    });
  });

  res.status(200).json({
    status: 'success',
    message: 'Withdrawal approved',
  });
});

export const rejectWithdrawal = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;

  await prisma.$transaction(async (tx) => {
    const transaction = await tx.transaction.findUnique({ where: { id: Number(id) } });
    if (!transaction || transaction.type !== 'WITHDRAWAL' || transaction.status !== 'PENDING') {
      throw new AppError('Invalid withdrawal request', 400);
    }

    await tx.transaction.update({
      where: { id: transaction.id },
      data: { status: TransactionStatus.FAILED },
    });

    await tx.auditLog.create({
      data: {
        userId: req.user?.id,
        action: 'WITHDRAWAL_REJECTED',
        details: { withdrawalId: transaction.id, amount: Number(transaction.amount), studentId: transaction.userId },
        ipAddress: req.ip,
      },
    });
  });

  res.status(200).json({
    status: 'success',
    message: 'Withdrawal rejected',
  });
});
