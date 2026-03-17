"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletService = void 0;
const AppError_1 = require("../utils/AppError");
const database_1 = __importDefault(require("../config/database"));
const paystack_1 = require("./paystack");
const ledger_1 = require("./ledger");
const client_1 = require("@prisma/client");
class WalletService {
    static async getBalance(userId) {
        const wallet = await database_1.default.wallet.findUnique({
            where: { userId },
        });
        if (!wallet)
            throw new AppError_1.AppError('Wallet not found', 404);
        return wallet;
    }
    static async initiateDeposit(userId, amount, email) {
        if (amount < 100)
            throw new AppError_1.AppError('Minimum deposit is 100 NGN', 400);
        const wallet = await database_1.default.wallet.findUnique({ where: { userId } });
        if (!wallet)
            throw new AppError_1.AppError('Wallet not found', 404);
        const reference = `DEP_${Date.now()}_${userId}`;
        // Create Pending Transaction
        await database_1.default.transaction.create({
            data: {
                userId,
                reference,
                amount,
                type: client_1.TransactionType.DEPOSIT,
                status: client_1.TransactionStatus.PENDING,
            },
        });
        // Initialize Paystack
        const paystackData = await paystack_1.PaystackService.initializeTransaction(email, amount, {
            userId,
            walletId: wallet.id,
            reference,
        });
        return paystackData;
    }
    static async verifyDeposit(reference) {
        const paystackData = await paystack_1.PaystackService.verifyTransaction(reference);
        if (paystackData.status !== 'success') {
            throw new AppError_1.AppError('Payment failed or not completed', 400);
        }
        // Atomic Verification
        return await database_1.default.$transaction(async (tx) => {
            const transaction = await tx.transaction.findUnique({
                where: { reference },
            });
            if (!transaction)
                throw new AppError_1.AppError('Transaction not found', 404);
            if (transaction.status === client_1.TransactionStatus.SUCCESS) {
                return { message: 'Transaction already processed' };
            }
            const wallet = await tx.wallet.findUnique({ where: { userId: transaction.userId } });
            if (!wallet)
                throw new AppError_1.AppError('Wallet not found', 404);
            // Credit Wallet via Ledger
            await ledger_1.LedgerService.recordEntry(tx, {
                walletId: wallet.id,
                transactionId: transaction.id,
                type: client_1.LedgerType.CREDIT,
                amount: Number(transaction.amount),
            });
            // Update Transaction Status
            await tx.transaction.update({
                where: { id: transaction.id },
                data: { status: client_1.TransactionStatus.SUCCESS, metadata: paystackData },
            });
            return { message: 'Deposit successful', balance: Number(wallet.balance) + Number(transaction.amount) };
        });
    }
    static async transfer(senderId, receiverMatric, amount) {
        if (amount <= 0)
            throw new AppError_1.AppError('Invalid amount', 400);
        return await database_1.default.$transaction(async (tx) => {
            // 1. Get Sender Wallet
            const senderWallet = await tx.wallet.findUnique({ where: { userId: senderId } });
            if (!senderWallet)
                throw new AppError_1.AppError('Sender wallet not found', 404);
            if (Number(senderWallet.balance) < amount) {
                throw new AppError_1.AppError('Insufficient funds', 400);
            }
            // 2. Get Receiver User & Wallet
            const receiver = await tx.user.findUnique({ where: { matricNumber: receiverMatric } });
            if (!receiver)
                throw new AppError_1.AppError('Receiver not found', 404);
            const receiverWallet = await tx.wallet.findUnique({ where: { userId: receiver.id } });
            if (!receiverWallet)
                throw new AppError_1.AppError('Receiver wallet not found', 404);
            // 3. Create Transaction Record
            const reference = `TRF_${Date.now()}_${senderId}_${receiver.id}`;
            const transaction = await tx.transaction.create({
                data: {
                    userId: senderId,
                    reference,
                    amount,
                    type: client_1.TransactionType.TRANSFER,
                    status: client_1.TransactionStatus.SUCCESS,
                    description: `Transfer to ${receiver.firstName} ${receiver.lastName}`,
                    metadata: { receiverId: receiver.id, receiverName: `${receiver.firstName} ${receiver.lastName}` },
                },
            });
            // 4. Debit Sender
            await ledger_1.LedgerService.recordEntry(tx, {
                walletId: senderWallet.id,
                transactionId: transaction.id,
                type: client_1.LedgerType.DEBIT,
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
            await ledger_1.LedgerService.recordEntry(tx, {
                walletId: receiverWallet.id,
                transactionId: transaction.id,
                type: client_1.LedgerType.CREDIT,
                amount,
            });
            return { message: 'Transfer successful' };
        });
    }
}
exports.WalletService = WalletService;
