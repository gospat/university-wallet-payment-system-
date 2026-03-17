"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = __importDefault(require("../config/database"));
const AppError_1 = require("../utils/AppError");
const signToken = (id, role) => {
    return jsonwebtoken_1.default.sign({ id, role }, process.env.JWT_SECRET || 'secret', {
        expiresIn: '90d',
    });
};
class AuthService {
    static async signup(data) {
        const { email, password, firstName, lastName, matricNumber, role } = data;
        const existingUser = await database_1.default.user.findUnique({ where: { email } });
        if (existingUser) {
            throw new AppError_1.AppError('Email already exists', 400);
        }
        const hashedPassword = await bcrypt_1.default.hash(password, 12);
        // Atomic User + Wallet Creation
        const result = await database_1.default.$transaction(async (tx) => {
            const newUser = await tx.user.create({
                data: {
                    email,
                    password: hashedPassword,
                    firstName,
                    lastName,
                    matricNumber,
                    role: role || 'STUDENT',
                },
            });
            // Create Wallet for the user
            await tx.wallet.create({
                data: {
                    userId: newUser.id,
                    balance: 0.0,
                },
            });
            return newUser;
        });
        const token = signToken(result.id, result.role);
        return { user: result, token };
    }
    static async login(data) {
        const { email, password } = data;
        if (!email || !password) {
            throw new AppError_1.AppError('Please provide email and password', 400);
        }
        const user = await database_1.default.user.findUnique({ where: { email } });
        if (!user || !(await bcrypt_1.default.compare(password, user.password))) {
            throw new AppError_1.AppError('Incorrect email or password', 401);
        }
        const token = signToken(user.id, user.role);
        return { user, token };
    }
}
exports.AuthService = AuthService;
