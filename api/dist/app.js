"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const error_1 = require("./middlewares/error");
const auth_1 = __importDefault(require("./routes/auth"));
const wallet_1 = __importDefault(require("./routes/wallet"));
const admin_1 = __importDefault(require("./routes/admin"));
const bursary_1 = __importDefault(require("./routes/bursary"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use((0, helmet_1.default)());
app.use((0, morgan_1.default)('dev'));
// Capture raw body for Paystack webhook verification
app.use(express_1.default.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    },
}));
app.use(express_1.default.urlencoded({ extended: true }));
// Routes
app.use('/api/v1/auth', auth_1.default);
app.use('/api/v1/wallet', wallet_1.default);
app.use('/api/v1/admin', admin_1.default);
app.use('/api/v1/bursary', bursary_1.default);
// Error Handling
app.use(error_1.globalErrorHandler);
exports.default = app;
