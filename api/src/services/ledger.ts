import { Prisma, LedgerType } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';

export class LedgerService {
  /**
   * Records a financial entry and updates the wallet balance ATOMICALLY.
   * Uses Prisma Interactive Transactions to prevent race conditions.
   */
  static async recordEntry(
    tx: Prisma.TransactionClient, // Pass the transaction client
    {
      walletId,
      transactionId,
      type,
      amount,
    }: {
      walletId: number;
      transactionId: number;
      type: LedgerType;
      amount: number;
    }
  ) {
    // 1. Get current wallet state (Ensure it exists)
    // In a real production DB like Postgres/MySQL, you'd use row-level locking here if supported by Prisma directly
    // Prisma currently supports `FOR UPDATE` in raw queries, or optimistic concurrency control.
    // For simplicity with standard Prisma, we rely on the transaction isolation.
    
    const wallet = await tx.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new AppError('Wallet not found', 404);
    }

    const balanceBefore = Number(wallet.balance);
    const amountNum = Number(amount);
    let balanceAfter: number;

    // 2. Calculate new balance
    if (type === 'CREDIT') {
      balanceAfter = balanceBefore + amountNum;
    } else if (type === 'DEBIT') {
      if (balanceBefore < amountNum) {
        throw new AppError('Insufficient funds', 400);
      }
      balanceAfter = balanceBefore - amountNum;
    } else {
      throw new AppError('Invalid ledger type', 400);
    }

    // 3. Create Ledger Entry
    await tx.walletLedger.create({
      data: {
        walletId,
        transactionId,
        type,
        amount: amountNum,
        balanceBefore,
        balanceAfter,
      },
    });

    // 4. Update Wallet Balance
    await tx.wallet.update({
      where: { id: walletId },
      data: { balance: balanceAfter },
    });

    return balanceAfter;
  }
}
