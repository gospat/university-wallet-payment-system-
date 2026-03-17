"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadReceipt = void 0;
const catchAsync_1 = require("../utils/catchAsync");
const AppError_1 = require("../utils/AppError");
const database_1 = __importDefault(require("../config/database"));
const receipt_1 = require("../services/receipt");
exports.downloadReceipt = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const { reference } = req.params;
    const userId = req.user.id;
    const transaction = await database_1.default.transaction.findUnique({
        where: { reference },
        include: { user: true },
    });
    if (!transaction) {
        return next(new AppError_1.AppError('Transaction not found', 404));
    }
    // Ensure user owns the transaction (or is admin/bursary)
    if (transaction.userId !== userId && req.user.role === 'STUDENT') {
        return next(new AppError_1.AppError('Unauthorized access to this receipt', 403));
    }
    if (transaction.status !== 'SUCCESS') {
        return next(new AppError_1.AppError('Receipts are only available for successful transactions', 400));
    }
    const pdfBuffer = await receipt_1.ReceiptService.generateReceipt(transaction);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipt_${reference}.pdf`);
    res.send(pdfBuffer);
});
