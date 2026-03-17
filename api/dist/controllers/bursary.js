"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rejectWithdrawal = exports.approveWithdrawal = exports.getPendingWithdrawals = void 0;
const catchAsync_1 = require("../utils/catchAsync");
const database_1 = __importDefault(require("../config/database"));
const AppError_1 = require("../utils/AppError");
const ledger_1 = require("../services/ledger");
const client_1 = require("@prisma/client");
exports.getPendingWithdrawals = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const withdrawals = await database_1.default.transaction.findMany({
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
    res.status(200).json({
        status: 'success',
        data: { withdrawals },
    });
});
exports.approveWithdrawal = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const { id } = req.params;
    await database_1.default.$transaction(async (tx) => {
        const transaction = await tx.transaction.findUnique({
            where: { id: Number(id) },
        });
        if (!transaction || transaction.type !== 'WITHDRAWAL' || transaction.status !== 'PENDING') {
            throw new AppError_1.AppError('Invalid withdrawal request', 400);
        }
        const wallet = await tx.wallet.findUnique({ where: { userId: transaction.userId } });
        if (!wallet)
            throw new AppError_1.AppError('Wallet not found', 404);
        // Debit Wallet
        await ledger_1.LedgerService.recordEntry(tx, {
            walletId: wallet.id,
            transactionId: transaction.id,
            type: client_1.LedgerType.DEBIT,
            amount: Number(transaction.amount),
        });
        // Update Status
        await tx.transaction.update({
            where: { id: transaction.id },
            data: { status: client_1.TransactionStatus.SUCCESS },
        });
    });
    res.status(200).json({
        status: 'success',
        message: 'Withdrawal approved',
    });
});
exports.rejectWithdrawal = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const { id } = req.params;
    await database_1.default.transaction.update({
        where: { id: Number(id) },
        data: { status: client_1.TransactionStatus.FAILED },
    });
    res.status(200).json({
        status: 'success',
        message: 'Withdrawal rejected',
    });
});
