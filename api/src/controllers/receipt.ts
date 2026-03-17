import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import prisma from '../config/database';
import { ReceiptService } from '../services/receipt';

export const downloadReceipt = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { reference } = req.params;
  const userId = req.user!.id;

  const transaction = await prisma.transaction.findUnique({
    where: { reference },
    include: { user: true },
  });

  if (!transaction) {
    return next(new AppError('Transaction not found', 404));
  }

  // Ensure user owns the transaction (or is admin/bursary)
  if (transaction.userId !== userId && req.user!.role === 'STUDENT') {
    return next(new AppError('Unauthorized access to this receipt', 403));
  }

  if (transaction.status !== 'SUCCESS') {
    return next(new AppError('Receipts are only available for successful transactions', 400));
  }

  const pdfBuffer = await ReceiptService.generateReceipt(transaction);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=receipt_${reference}.pdf`);
  res.setHeader('Content-Length', pdfBuffer.length);
  
  res.send(pdfBuffer);
});

export const downloadStatement = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user!.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { wallet: true }
  });

  if (!user || !user.wallet) {
    return next(new AppError('User or wallet not found', 404));
  }

  const transactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  const pdfBuffer = await ReceiptService.generateStatement(user, transactions, Number(user.wallet.balance));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=statement_${user.matricNumber || userId}.pdf`);
  res.setHeader('Content-Length', pdfBuffer.length);
  
  res.send(pdfBuffer);
});
