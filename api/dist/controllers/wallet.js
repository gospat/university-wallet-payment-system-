"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhook = exports.transfer = exports.verifyDeposit = exports.initiateDeposit = exports.getBalance = void 0;
const wallet_1 = require("../services/wallet");
const catchAsync_1 = require("../utils/catchAsync");
const crypto_1 = __importDefault(require("crypto"));
const AppError_1 = require("../utils/AppError");
exports.getBalance = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const balance = await wallet_1.WalletService.getBalance(req.user.id);
    res.status(200).json({
        status: 'success',
        data: { balance },
    });
});
exports.initiateDeposit = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const { amount, email } = req.body;
    if (!email) {
        return next(new AppError_1.AppError('Email is required', 400));
    }
    const result = await wallet_1.WalletService.initiateDeposit(req.user.id, Number(amount), email);
    res.status(200).json({
        status: 'success',
        data: result,
    });
});
exports.verifyDeposit = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const { reference } = req.params;
    if (typeof reference !== 'string') {
        return next(new AppError_1.AppError('Invalid reference', 400));
    }
    const result = await wallet_1.WalletService.verifyDeposit(reference);
    res.status(200).json({
        status: 'success',
        message: 'Deposit verified successfully',
        data: result,
    });
});
exports.transfer = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const { receiverMatric, amount } = req.body;
    const result = await wallet_1.WalletService.transfer(req.user.id, receiverMatric, Number(amount));
    res.status(200).json({
        status: 'success',
        message: 'Transfer successful',
        data: result,
    });
});
exports.webhook = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    const rawBody = req.rawBody;
    const hash = crypto_1.default.createHmac('sha512', secret).update(rawBody).digest('hex');
    if (hash === req.headers['x-paystack-signature']) {
        const event = req.body;
        if (event.event === 'charge.success') {
            const reference = event.data.reference;
            try {
                await wallet_1.WalletService.verifyDeposit(reference);
            }
            catch (error) {
                console.error('Webhook verification failed', error);
            }
        }
    }
    res.status(200).send('OK');
});
