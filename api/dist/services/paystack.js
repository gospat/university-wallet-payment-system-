"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaystackService = void 0;
const axios_1 = __importDefault(require("axios"));
const AppError_1 = require("../utils/AppError");
class PaystackService {
    static async initializeTransaction(email, amount, metadata = {}) {
        try {
            const response = await axios_1.default.post(`${this.BASE_URL}/transaction/initialize`, {
                email,
                amount: amount * 100,
                metadata,
                callback_url: 'http://localhost:3000/api/wallet/verify', // Adjust for production
            }, {
                headers: {
                    Authorization: `Bearer ${this.SECRET_KEY}`,
                    'Content-Type': 'application/json',
                },
            });
            return response.data.data;
        }
        catch (error) {
            throw new AppError_1.AppError(`Paystack Initialization Error: ${error.response?.data?.message || error.message}`, 500);
        }
    }
    static async verifyTransaction(reference) {
        try {
            const response = await axios_1.default.get(`${this.BASE_URL}/transaction/verify/${reference}`, {
                headers: {
                    Authorization: `Bearer ${this.SECRET_KEY}`,
                },
            });
            return response.data.data;
        }
        catch (error) {
            throw new AppError_1.AppError(`Paystack Verification Error: ${error.response?.data?.message || error.message}`, 500);
        }
    }
}
exports.PaystackService = PaystackService;
PaystackService.SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
PaystackService.BASE_URL = 'https://api.paystack.co';
