"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const bursary_1 = require("../controllers/bursary");
const auth_1 = require("../middlewares/auth");
const router = express_1.default.Router();
router.use(auth_1.protect);
router.use((0, auth_1.restrictTo)('BURSARY', 'ADMIN'));
router.get('/withdrawals', bursary_1.getPendingWithdrawals);
router.post('/withdrawals/:id/approve', bursary_1.approveWithdrawal);
router.post('/withdrawals/:id/reject', bursary_1.rejectWithdrawal);
exports.default = router;
