import { AppError } from '../utils/AppError';
import prisma from '../config/database';
import { PaystackService } from './paystack';
import { LedgerService } from './ledger';
import { TransactionType, TransactionStatus, LedgerType } from '@prisma/client';
import crypto from 'crypto';

export class WalletService {
  static async getBalance(userId: number) {
    const wallet = await prisma.wallet.findUnique({
      where: { userId },
    });
    if (!wallet) throw new AppError('Wallet not found', 404);
    return wallet;
  }

  static async initiateDeposit(userId: number, amount: number, email: string, idempotencyKey: string) {
    if (!Number.isFinite(amount)) throw new AppError('Invalid amount', 400);
    if (amount < 20000) throw new AppError('Minimum deposit is ₦20,000', 400);
    if (amount > 5000000) throw new AppError('Maximum deposit amount per transaction is ₦5,000,000', 400);

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new AppError('Wallet not found', 404);

    const existing = await prisma.transaction.findFirst({
      where: { userId, type: TransactionType.DEPOSIT, idempotencyKey } as any,
      orderBy: { createdAt: 'desc' },
    });

    if (existing?.status === TransactionStatus.SUCCESS) {
      return { message: 'Deposit already completed', reference: existing.reference };
    }

    if (existing?.status === TransactionStatus.PENDING) {
      const meta: any = existing.metadata || {};
      if (meta.paystackInit?.authorization_url) {
        return meta.paystackInit;
      }
    }

    const reference = `DEP_${crypto.randomUUID()}_${userId}`;
    
    // Create Pending Transaction
    const created = await prisma.transaction.create({
      data: {
        userId,
        reference,
        idempotencyKey,
        amount,
        type: TransactionType.DEPOSIT,
        status: TransactionStatus.PENDING,
      } as any,
    });

    // Initialize Paystack
    const paystackInit = await PaystackService.initializeTransaction(email, amount, {
      userId,
      walletId: wallet.id,
      reference,
      idempotencyKey,
    });

    await prisma.transaction.update({
      where: { id: created.id },
      data: {
        metadata: {
          paystackInit,
        },
      },
    });

    return paystackInit;
  }

  static async verifyDeposit(reference: string) {
    const paystackData = await PaystackService.verifyTransaction(reference);

    if (paystackData.status !== 'success') {
      throw new AppError('Payment failed or not completed', 400);
    }

    // Atomic Verification - race-safe idempotency
    return await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({
        where: { reference },
      });

      if (!transaction) throw new AppError('Transaction not found', 404);
      
      const updated = await tx.transaction.updateMany({
        where: { id: transaction.id, status: TransactionStatus.PENDING },
        data: { status: TransactionStatus.SUCCESS },
      });

      if (updated.count === 0) {
        return { message: 'Transaction already processed' };
      }

      const wallet = await tx.wallet.findUnique({ where: { userId: transaction.userId } });
      if (!wallet) throw new AppError('Wallet not found', 404);

      // Credit Wallet via Ledger (Only credit the ACTUAL amount, not the fees)
      // We assume the fees are absorbed or handled separately.
      // If you want to show the full amount credited and then debit fees, you need more ledger entries.
      // For now, we will credit the user with the BASE amount they intended to deposit.
      
      const fees = transaction.metadata ? (transaction.metadata as any).fees : null;
      const amountToCredit = fees ? fees.tuition : Number(transaction.amount);

      const newBalance = await LedgerService.recordEntry(tx, {
        walletId: wallet.id,
        transactionId: transaction.id,
        type: LedgerType.CREDIT,
        amount: Number(amountToCredit),
      });

      await tx.transaction.update({
        where: { id: transaction.id },
        data: { metadata: paystackData },
      });

      return { message: 'Deposit successful', balance: Number(newBalance) };
    });
  }

  static async transfer(senderId: number, receiverMatric: string, amount: number) {
    if (amount <= 0) throw new AppError('Invalid amount', 400);

    return await prisma.$transaction(async (tx) => {
      // 1. Get Sender Wallet
      const senderWallet = await tx.wallet.findUnique({ where: { userId: senderId } });
      if (!senderWallet) throw new AppError('Sender wallet not found', 404);

      if (Number(senderWallet.balance) < amount) {
        throw new AppError('Insufficient funds', 400);
      }

      // 2. Get Receiver User & Wallet
      const receiver = await tx.user.findUnique({ where: { matricNumber: receiverMatric } });
      if (!receiver) throw new AppError('Receiver not found', 404);

      const receiverWallet = await tx.wallet.findUnique({ where: { userId: receiver.id } });
      if (!receiverWallet) throw new AppError('Receiver wallet not found', 404);

      // 3. Create Transaction Record
      const reference = `TRF_${Date.now()}_${senderId}_${receiver.id}`;
      const transaction = await tx.transaction.create({
        data: {
          userId: senderId,
          reference,
          amount,
          type: TransactionType.TRANSFER,
          status: TransactionStatus.SUCCESS,
          description: `Transfer to ${receiver.firstName} ${receiver.lastName}`,
          metadata: { receiverId: receiver.id, receiverName: `${receiver.firstName} ${receiver.lastName}` },
        },
      });

      // 4. Debit Sender
      await LedgerService.recordEntry(tx, {
        walletId: senderWallet.id,
        transactionId: transaction.id,
        type: LedgerType.DEBIT,
        amount,
      });

      // 5. Credit Receiver
      // We need a separate transaction record for the receiver or just link the ledger?
      // For double-entry accounting, we usually have two ledger entries linked to one transaction?
      // Or two transactions?
      // Let's create a CREDIT ledger entry for the receiver linked to the SAME transaction.
      // This is a simplified approach. Ideally, we might want two transactions (Sender Debit, Receiver Credit).
      // But linking one transaction to multiple ledger entries is fine if schema supports it.
      // My schema has WalletLedger linked to Transaction. So one Transaction can have multiple Ledger entries.

      await LedgerService.recordEntry(tx, {
        walletId: receiverWallet.id,
        transactionId: transaction.id,
        type: LedgerType.CREDIT,
        amount,
      });

      return { message: 'Transfer successful' };
    });
  }
}
