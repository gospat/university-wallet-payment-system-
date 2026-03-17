"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDashboardStats = void 0;
const catchAsync_1 = require("../utils/catchAsync");
const database_1 = __importDefault(require("../config/database"));
exports.getDashboardStats = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    // 1. Total Students
    const totalStudents = await database_1.default.user.count({
        where: { role: 'STUDENT' },
    });
    // 2. Total Deposits (Sum of successful deposit transactions)
    const totalDepositsResult = await database_1.default.transaction.aggregate({
        where: {
            type: 'DEPOSIT',
            status: 'SUCCESS',
        },
        _sum: {
            amount: true,
        },
    });
    const totalDeposits = totalDepositsResult._sum.amount || 0;
    // 3. Active Wallets (Count of wallets with status ACTIVE)
    const activeWallets = await database_1.default.wallet.count({
        where: { status: 'ACTIVE' },
    });
    // 4. Pending Requests (Count of pending withdrawals)
    const pendingRequests = await database_1.default.transaction.count({
        where: {
            type: 'WITHDRAWAL',
            status: 'PENDING',
        },
    });
    // 5. Recent Audit Logs
    const auditLogs = await database_1.default.auditLog.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { firstName: true, lastName: true } } }, // Include user details
    });
    res.status(200).json({
        status: 'success',
        data: {
            stats: {
                totalStudents,
                totalDeposits,
                activeWallets,
                pendingRequests,
            },
            auditLogs,
        },
    });
});
