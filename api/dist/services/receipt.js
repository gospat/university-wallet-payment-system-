"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReceiptService = void 0;
const puppeteer_1 = __importDefault(require("puppeteer"));
const AppError_1 = require("../utils/AppError");
class ReceiptService {
    static async generateReceipt(transaction) {
        try {
            const browser = await puppeteer_1.default.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });
            const page = await browser.newPage();
            const html = `
        <html>
          <head>
            <style>
              body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #333; }
              .header { text-align: center; margin-bottom: 40px; border-bottom: 2px solid #eee; padding-bottom: 20px; }
              .header h1 { margin: 0; color: #007bff; }
              .header p { margin: 5px 0 0; color: #666; }
              .details { margin-bottom: 30px; }
              .details-row { display: flex; justify-content: space-between; margin-bottom: 10px; border-bottom: 1px solid #f9f9f9; padding-bottom: 5px; }
              .label { font-weight: bold; color: #555; }
              .value { font-family: monospace; font-size: 1.1em; }
              .amount-box { background: #f8f9fa; padding: 20px; text-align: center; border-radius: 8px; margin: 30px 0; border: 1px solid #e9ecef; }
              .amount-box h2 { margin: 0; font-size: 2.5em; color: #28a745; }
              .footer { text-align: center; font-size: 0.8em; color: #999; margin-top: 50px; }
              .watermark { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-45deg); font-size: 8em; color: rgba(0,0,0,0.03); z-index: -1; }
            </style>
          </head>
          <body>
            <div class="watermark">OFFICIAL RECEIPT</div>
            <div class="header">
              <h1>UNIVERSITY WALLET SYSTEM</h1>
              <p>Payment Confirmation Receipt</p>
            </div>

            <div class="amount-box">
              <p>Amount Paid</p>
              <h2>₦${Number(transaction.amount).toLocaleString()}</h2>
            </div>

            <div class="details">
              <div class="details-row">
                <span class="label">Student Name:</span>
                <span class="value">${transaction.user.firstName} ${transaction.user.lastName}</span>
              </div>
              <div class="details-row">
                <span class="label">Matric Number:</span>
                <span class="value">${transaction.user.matricNumber || 'N/A'}</span>
              </div>
              <div class="details-row">
                <span class="label">Reference:</span>
                <span class="value">${transaction.reference}</span>
              </div>
              <div class="details-row">
                <span class="label">Date:</span>
                <span class="value">${new Date(transaction.createdAt).toLocaleString()}</span>
              </div>
              <div class="details-row">
                <span class="label">Type:</span>
                <span class="value">${transaction.type}</span>
              </div>
              <div class="details-row">
                <span class="label">Status:</span>
                <span class="value" style="color: green">SUCCESS</span>
              </div>
            </div>

            <div class="footer">
              <p>This is a computer-generated document and requires no signature.</p>
              <p>Transaction ID: ${transaction.id}</p>
            </div>
          </body>
        </html>
      `;
            await page.setContent(html);
            const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
            await browser.close();
            return pdfBuffer;
        }
        catch (error) {
            console.error('Receipt Generation Error:', error);
            throw new AppError_1.AppError('Failed to generate receipt', 500);
        }
    }
}
exports.ReceiptService = ReceiptService;
