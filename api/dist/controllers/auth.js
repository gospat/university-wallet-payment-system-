"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = exports.signup = void 0;
const auth_1 = require("../services/auth");
const catchAsync_1 = require("../utils/catchAsync");
exports.signup = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const { user, token } = await auth_1.AuthService.signup(req.body);
    res.status(201).json({
        status: 'success',
        token,
        data: { user },
    });
});
exports.login = (0, catchAsync_1.catchAsync)(async (req, res, next) => {
    const { user, token } = await auth_1.AuthService.login(req.body);
    res.status(200).json({
        status: 'success',
        token,
        data: { user },
    });
});
