"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const wallet_1 = require("../controllers/wallet");
const receipt_1 = require("../controllers/receipt");
const auth_1 = require("../middlewares/auth");
const router = express_1.default.Router();
router.post('/webhook', wallet_1.webhook);
router.use(auth_1.protect);
router.get('/balance', wallet_1.getBalance);
router.post('/deposit', wallet_1.initiateDeposit);
router.get('/verify/:reference', wallet_1.verifyDeposit);
router.post('/transfer', wallet_1.transfer);
router.get('/receipt/:reference', receipt_1.downloadReceipt);
exports.default = router;
