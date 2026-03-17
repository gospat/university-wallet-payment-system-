import puppeteer from 'puppeteer';
import { AppError } from '../utils/AppError';
import QRCode from 'qrcode';

export class ReceiptService {
  static async generateStatement(user: any, transactions: any[], balance: number) {
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();

      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              @page { size: A4; margin: 0; }
              body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #333; background: #fff; }
              .container { max-width: 800px; margin: 0 auto; border: 1px solid #ddd; padding: 40px; position: relative; }
              
              .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #007bff; padding-bottom: 20px; margin-bottom: 30px; }
              .logo { text-align: left; }
              .logo h1 { margin: 0; color: #007bff; font-size: 24px; text-transform: uppercase; letter-spacing: 1px; }
              .logo p { margin: 5px 0 0; font-size: 12px; color: #666; }
              .receipt-title { text-align: right; }
              .receipt-title h2 { margin: 0; font-size: 28px; color: #333; }
              .receipt-title p { margin: 5px 0 0; color: #888; font-size: 14px; }

              .info-section { display: flex; justify-content: space-between; background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px; border: 1px solid #e9ecef; }
              .info-group { margin-bottom: 10px; }
              .info-label { font-size: 11px; color: #888; text-transform: uppercase; font-weight: bold; }
              .info-value { font-size: 14px; color: #333; font-weight: 500; }
              
              .balance-box { text-align: right; }
              .balance-label { font-size: 12px; color: #666; text-transform: uppercase; }
              .balance-value { font-size: 28px; font-weight: bold; color: #28a745; margin: 0; }

              table { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 12px; }
              th { background-color: #f1f5f9; color: #495057; font-weight: bold; text-align: left; padding: 12px; text-transform: uppercase; border-bottom: 2px solid #dee2e6; }
              td { padding: 12px; border-bottom: 1px solid #e9ecef; color: #495057; }
              tr:nth-child(even) { background-color: #f8f9fa; }
              .text-right { text-align: right; }
              .text-center { text-align: center; }
              
              .status-success { color: #28a745; font-weight: bold; }
              .status-pending { color: #ffc107; font-weight: bold; }
              .status-failed { color: #dc3545; font-weight: bold; }
              .type-deposit { color: #007bff; }
              .type-withdraw { color: #dc3545; }

              .footer { margin-top: 50px; border-top: 1px solid #eee; padding-top: 20px; text-align: center; font-size: 10px; color: #999; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <div class="logo">
                  <h1>University Wallet</h1>
                  <p>Official Account Statement</p>
                  <p>Lagos, Nigeria</p>
                </div>
                <div class="receipt-title">
                  <h2>STATEMENT</h2>
                  <p>Generated: ${new Date().toLocaleString('en-NG')}</p>
                </div>
              </div>

              <div class="info-section">
                <div>
                  <div class="info-group">
                    <div class="info-label">Account Holder</div>
                    <div class="info-value">${user.firstName} ${user.lastName}</div>
                  </div>
                  <div class="info-group">
                    <div class="info-label">Matriculation Number</div>
                    <div class="info-value">${user.matricNumber || 'N/A'}</div>
                  </div>
                  <div class="info-group">
                    <div class="info-label">Email Address</div>
                    <div class="info-value">${user.email}</div>
                  </div>
                </div>
                <div class="balance-box">
                  <div class="balance-label">Current Available Balance</div>
                  <div class="balance-value">₦${Number(balance).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</div>
                </div>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reference</th>
                    <th>Type</th>
                    <th class="text-center">Status</th>
                    <th class="text-right">Amount (₦)</th>
                  </tr>
                </thead>
                <tbody>
                  ${transactions.length === 0 ? '<tr><td colspan="5" class="text-center">No transactions found</td></tr>' : 
                    transactions.map(t => `
                    <tr>
                      <td>${new Date(t.createdAt).toLocaleDateString('en-NG')}</td>
                      <td style="font-family: monospace;">${t.reference}</td>
                      <td class="${t.type === 'DEPOSIT' ? 'type-deposit' : 'type-withdraw'}">${t.type}</td>
                      <td class="text-center ${t.status === 'SUCCESS' ? 'status-success' : t.status === 'FAILED' ? 'status-failed' : 'status-pending'}">${t.status}</td>
                      <td class="text-right font-weight-bold">${Number(t.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>

              <div class="footer">
                <p>This is a computer-generated document and requires no signature.</p>
                <p>For any discrepancies, please contact the University Bursary Department immediately.</p>
              </div>
            </div>
          </body>
        </html>
      `;

      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({ 
        format: 'A4', 
        printBackground: true,
        margin: { top: '20px', bottom: '20px' }
      });

      await browser.close();
      return Buffer.from(pdfBuffer);
    } catch (error) {
      console.error('Statement Generation Error:', error);
      throw new AppError('Failed to generate statement', 500);
    }
  }

  static async generateReceipt(transaction: any) {
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();

      // Generate QR Code containing verification URL
      const qrCodeData = `https://university.edu.ng/verify-receipt/${transaction.reference}`;
      const qrCodeImage = await QRCode.toDataURL(qrCodeData);

      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              @page { size: A4; margin: 0; }
              body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #333; background: #fff; }
              .container { max-width: 800px; margin: 0 auto; border: 1px solid #ddd; padding: 40px; position: relative; }
              
              /* Header */
              .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #007bff; padding-bottom: 20px; margin-bottom: 30px; }
              .logo { text-align: left; }
              .logo h1 { margin: 0; color: #007bff; font-size: 24px; text-transform: uppercase; letter-spacing: 1px; }
              .logo p { margin: 5px 0 0; font-size: 12px; color: #666; }
              .receipt-title { text-align: right; }
              .receipt-title h2 { margin: 0; font-size: 32px; color: #333; }
              .receipt-title p { margin: 5px 0 0; color: #888; font-size: 14px; }

              /* Payment Status Badge */
              .status-badge { 
                position: absolute; 
                top: 180px; 
                right: 40px; 
                padding: 10px 20px; 
                border: 2px solid #28a745; 
                color: #28a745; 
                font-weight: bold; 
                font-size: 18px; 
                border-radius: 5px; 
                text-transform: uppercase; 
                transform: rotate(-10deg);
                opacity: 0.8;
              }

              /* Amount Box */
              .amount-section { background: #f8f9fa; padding: 25px; border-radius: 8px; text-align: center; margin: 30px 0; border: 1px solid #e9ecef; }
              .amount-label { font-size: 14px; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
              .amount-value { font-size: 42px; font-weight: bold; color: #333; margin: 0; }
              .amount-words { font-size: 12px; color: #888; font-style: italic; margin-top: 5px; }

              /* Details Grid */
              .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 40px; }
              .detail-group { margin-bottom: 15px; }
              .detail-label { font-size: 12px; color: #888; text-transform: uppercase; margin-bottom: 5px; font-weight: 600; }
              .detail-value { font-size: 16px; color: #333; font-weight: 500; border-bottom: 1px solid #eee; padding-bottom: 5px; }

              /* Footer */
              .footer { margin-top: 50px; border-top: 1px solid #eee; padding-top: 20px; display: flex; justify-content: space-between; align-items: end; }
              .footer-text { font-size: 10px; color: #999; line-height: 1.5; max-width: 60%; }
              .qr-code { text-align: right; }
              .qr-code img { width: 100px; height: 100px; }
              .qr-label { font-size: 10px; color: #666; margin-top: 5px; text-align: center; }

              /* Watermark */
              .watermark { 
                position: absolute; 
                top: 50%; 
                left: 50%; 
                transform: translate(-50%, -50%) rotate(-45deg); 
                font-size: 100px; 
                color: rgba(0,0,0,0.03); 
                z-index: -1; 
                white-space: nowrap;
                font-weight: bold;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="watermark">UNIVERSITY OFFICIAL</div>
              
              <div class="header">
                <div class="logo">
                  <h1>University Wallet</h1>
                  <p>Official Payment Receipt</p>
                  <p>Lagos, Nigeria</p>
                </div>
                <div class="receipt-title">
                  <h2>RECEIPT</h2>
                  <p>#${transaction.reference}</p>
                </div>
              </div>

              <div class="status-badge">PAID</div>

              <div class="amount-section">
                <div class="amount-label">Amount Paid</div>
                <h1 class="amount-value">₦${Number(transaction.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</h1>
                <p class="amount-words">Payment via ${transaction.type}</p>
              </div>

              <div class="details-grid">
                <div>
                  <div class="detail-group">
                    <div class="detail-label">Student Name</div>
                    <div class="detail-value">${transaction.user.firstName} ${transaction.user.lastName}</div>
                  </div>
                  <div class="detail-group">
                    <div class="detail-label">Matriculation Number</div>
                    <div class="detail-value">${transaction.user.matricNumber || 'N/A'}</div>
                  </div>
                  <div class="detail-group">
                    <div class="detail-label">Email Address</div>
                    <div class="detail-value">${transaction.user.email}</div>
                  </div>
                </div>

                <div>
                  <div class="detail-group">
                    <div class="detail-label">Payment Date & Time</div>
                    <div class="detail-value">${new Date(transaction.createdAt).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'medium' })}</div>
                  </div>
                  <div class="detail-group">
                    <div class="detail-label">Transaction Reference</div>
                    <div class="detail-value" style="font-family: monospace;">${transaction.reference}</div>
                  </div>
                  <div class="detail-group">
                    <div class="detail-label">Payment Method</div>
                    <div class="detail-value">Online Payment (Paystack)</div>
                  </div>
                </div>
              </div>

              <div class="footer">
                <div class="footer-text">
                  <p><strong>Terms & Conditions:</strong></p>
                  <p>1. This receipt is computer generated and requires no signature.</p>
                  <p>2. Payment is non-refundable unless stated otherwise by the university bursary.</p>
                  <p>3. Please keep this receipt for your records. For verification, scan the QR code.</p>
                  <p>Generated on: ${new Date().toLocaleString()}</p>
                </div>
                <div class="qr-code">
                  <img src="${qrCodeImage}" alt="Verification QR Code" />
                  <div class="qr-label">Scan to Verify</div>
                </div>
              </div>
            </div>
          </body>
        </html>
      `;

      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({ 
        format: 'A4', 
        printBackground: true,
        margin: { top: '20px', bottom: '20px' }
      });

      await browser.close();
      return Buffer.from(pdfBuffer); // Ensure it returns a proper Buffer
    } catch (error) {
      console.error('Receipt Generation Error:', error);
      throw new AppError('Failed to generate receipt', 500);
    }
  }
}
