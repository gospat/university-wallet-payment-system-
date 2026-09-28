import puppeteer from 'puppeteer';
import QRCode from 'qrcode';
import { AppError } from '../utils/AppError';
import { buildBranding, brandingEnvOnly, hasBrandingSignature, type Branding, BELLS_LOGO_DATA_URI } from '../utils/branding';
import prisma from '../config/database';

type ReceiptData = {
  receiptNumber: string;
  paidAmount: number;
  paidAt: Date;
  isVoided: boolean;
  voidedAt?: Date | null;
  paymentChannel?: string | null;
  paymentMethodDetail?: string | null;
  paystackReference?: string | null;
  qrUrl: string;
  student: { firstName: string; lastName: string; email: string; matricNumber: string | null };
  invoice?:
    | {
        invoiceNumber?: string | null;
        dueDate?: Date | null;
        session?: string | null;
        semester?: string | null;
        fee?: { name: string | null } | null;
      }
    | null;
};

function signatureBlockHtml(b: Branding): string {
  if (!hasBrandingSignature(b)) return '';
  const sigImg = b.bursarSignatureUrl
    ? `<div class="signature-line-img"><img src="${escapeHtml(b.bursarSignatureUrl)}" alt="Signature" onerror="this.style.display='none'" /></div>`
    : '';
  const nameLine = b.bursarName ? `<div class="signature-meta-name">${escapeHtml(b.bursarName)}</div>` : `<div class="signature-meta-name placeholder">Signature of Bursar</div>`;
  const titleLine = b.bursarTitle ? `<div class="signature-meta-title">${escapeHtml(b.bursarTitle)}</div>` : `<div class="signature-meta-title placeholder">Bursary Department</div>`;
  return `
  <div class="signature-block">
    <div class="signature-col">
      ${sigImg}
      <div class="signature-line"></div>
      <div class="signature-label">Signature (Bursary)</div>
      ${nameLine}
      ${titleLine}
    </div>
    <div class="approved-box">
      <div class="approved-title">APPROVED BY</div>
      <div class="approved-row"><span>Name / Signature</span><div class="approved-line"></div></div>
      <div class="approved-row"><span>Title</span><div class="approved-line"></div></div>
      <div class="approved-row"><span>Date</span><div class="approved-line"></div></div>
      <div class="approved-row approved-stamp"><span>Official Stamp / Seal</span><div class="approved-line approved-seal"></div></div>
    </div>
  </div>`;
}

function conditionalTermLine1(b: Branding): string {
  if (hasBrandingSignature(b)) {
    return '1. This receipt is official and validates the Bursary Department signatory above. It is valid only for the specific transaction referenced.';
  }
  return '1. This receipt is computer generated and requires no signature. It is valid only for the specific transaction referenced.';
}

function logoImgHtml(b: Branding, sizePx = 54): string {
  if (!b.logoUrl) return '';
  return `<div class="logo-img"><img src="${escapeHtml(b.logoUrl)}" alt="logo" style="max-height:${sizePx}px; max-width:${sizePx * 1.6}px; object-fit:contain;" onerror="this.parentNode.style.display='none'" /></div>`;
}

function logoImgHtmlProfessional(sizePx = 58): string {
  const BUOT_FALLBACK_SVG =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" fill="#0e74cc" stroke="#fff" stroke-width="2"/><text x="60" y="68" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="34" font-weight="800" fill="#fff">BUoT</text></svg>`
    );
  return `<div class="logo-img"><img src="${BELLS_LOGO_DATA_URI}" alt="Bells University of Technology Crest" style="height:${sizePx}px; width:${sizePx}px; object-fit:contain;" onerror="this.onerror=null;this.src='${BUOT_FALLBACK_SVG}'" /></div>`;
}

async function getBranding(): Promise<Branding> {
  try {
    return await buildBranding();
  } catch {
    return brandingEnvOnly();
  }
}

function moneyNGN(n: number | string) {
  const v = Number(n) || 0;
  return `₦${v.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(str: string | number | null | undefined) {
  const s = str === null || str === undefined ? '' : String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type DirectBillInfo = { assignmentId: number; matricNumber: string | null } | null;

async function lookupDirectBillForInvoice(studentId: number | undefined | null, feeId: number | undefined | null): Promise<DirectBillInfo> {
  if (!studentId || !feeId) return null;
  const row = await prisma.feeAssignment.findFirst({
    where: {
      assignmentType: 'STUDENT' as any,
      targetStudentId: Number(studentId),
      feeId: Number(feeId),
      isActive: true,
    },
    select: {
      id: true,
      targetStudent: { select: { matricNumber: true } },
    },
  });
  if (!row) return null;
  return { assignmentId: row.id, matricNumber: row.targetStudent?.matricNumber ?? null };
}

function chargeSourceCss(): string {
  return `.charge-source { margin: -18px 0 22px; padding: 10px 16px; background: #eef2ff; border-left: 3px solid #6366f1; border-radius: 4px; font-style: italic; font-size: 12.5px; color: #4338ca; letter-spacing: 0.1px; }
.charge-source strong { font-style: normal; color: #3730a3; font-weight: 600; }`;
}

function chargeSourceHtml(info: DirectBillInfo): string {
  if (!info) return '';
  const matricPart = info.matricNumber ? ` — Matric: <strong>${escapeHtml(info.matricNumber)}</strong>` : '';
  return `<div class="charge-source">Charge source: <strong>Direct Bill</strong> (Bursary assignment #${info.assignmentId})${matricPart}</div>`;
}

async function render(html: string) {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new' as any,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(res => setTimeout(res, 350));
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' },
    });
    await browser.close();
    return Buffer.from(pdfBuffer);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('Receipt PDF Error:', error);
    throw new AppError('Failed to generate receipt PDF', 500);
  }
}

export class ReceiptService {
  static async generateStatement(user: any, transactions: any[], balance: number) {
    const branding = await getBranding();
    const rows =
      transactions.length === 0
        ? '<tr><td colspan="5" class="text-center">No transactions found</td></tr>'
        : transactions
            .map((t) => {
              const cls =
                t.status === 'SUCCESS'
                  ? 'status-success'
                  : t.status === 'FAILED'
                    ? 'status-failed'
                    : 'status-pending';
              const tcls = t.type === 'FEE_PAYMENT' ? 'type-deposit' : 'type-withdraw';
              return `
                <tr>
                  <td>${new Date(t.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td style="font-family: monospace;">${escapeHtml(t.reference)}</td>
                  <td class="${tcls}">${escapeHtml(t.type)}</td>
                  <td class="text-center ${cls}">${escapeHtml(t.status)}</td>
                  <td class="text-right">${moneyNGN(t.amount)}</td>
                </tr>`;
            })
            .join('');
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
@page { size: A4; margin: 0; }
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #222; background: #fff; }
.container { max-width: 800px; margin: 0 auto; border: 1px solid #e3e7ef; padding: 36px; position: relative; overflow: hidden; isolation: isolate; background: #fff; }
.page-content { position: relative; z-index: 2; }
.watermark-layer { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.watermark-layer .wm-tile { position: absolute; inset: -20%; background-image: url(${BELLS_LOGO_DATA_URI}); background-size: 220px 220px; background-repeat: repeat; opacity: 0.055; transform: rotate(-38deg); }
.watermark-layer .wm-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-38deg); font-size: 88px; color: rgba(10, 61, 145, 0.045); white-space: nowrap; font-weight: 900; letter-spacing: 8px; }
.header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0a3d91; padding-bottom: 18px; margin-bottom: 24px; }
.logo { text-align: left; }
.logo h1 { margin: 0; color: #0a3d91; font-size: 22px; text-transform: uppercase; letter-spacing: 1px; }
.logo p { margin: 5px 0 0; font-size: 12px; color: #555; }
.title h2 { margin: 0; font-size: 28px; color: #333; text-align: right; }
.title p { margin: 5px 0 0; color: #777; font-size: 13px; text-align: right; }
.info-section { display: flex; justify-content: space-between; background: #f6f8fc; padding: 18px; border-radius: 8px; margin-bottom: 22px; border: 1px solid #e6ecf6; }
.info-group { margin-bottom: 8px; }
.info-label { font-size: 11px; color: #777; text-transform: uppercase; font-weight: 700; }
.info-value { font-size: 14px; color: #222; font-weight: 500; }
.balance-box { text-align: right; }
.balance-label { font-size: 12px; color: #555; text-transform: uppercase; }
.balance-value { font-size: 28px; font-weight: 700; color: #0a7a2f; margin: 0; }
table { width: 100%; border-collapse: collapse; margin-bottom: 28px; font-size: 12px; }
th { background-color: #eef3fb; color: #354259; font-weight: 700; text-align: left; padding: 10px 12px; text-transform: uppercase; border-bottom: 2px solid #dce3f1; }
td { padding: 10px 12px; border-bottom: 1px solid #eef1f7; color: #334155; }
tr:nth-child(even) { background-color: #fafbfe; }
.text-right { text-align: right; } .text-center { text-align: center; }
.status-success { color: #0a7a2f; font-weight: 700; } .status-pending { color: #b37a00; font-weight: 700; } .status-failed { color: #b42318; font-weight: 700; }
.type-deposit { color: #0a3d91; } .type-withdraw { color: #b42318; }
.logo-wrap { display: flex; align-items: center; gap: 14px; }
.logo-img { display: inline-flex; align-items: center; justify-content: center; }
.signature-block { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin: 36px 0 0; padding: 24px 0 0; }
.signature-col { }
.signature-line-img img { max-height: 72px; max-width: 240px; object-fit: contain; }
.signature-line { border-bottom: 1px solid #334155; margin: 18px 0 6px; width: 80%; }
.signature-label { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
.signature-meta-name { font-size: 14px; font-weight: 700; color: #222; }
.signature-meta-name.placeholder { color: #666; font-weight: 500; font-style: italic; }
.signature-meta-title { font-size: 12px; color: #555; margin-top: 4px; }
.signature-meta-title.placeholder { font-style: italic; }
.approved-box { border: 1px solid #334155; padding: 12px 14px; border-radius: 6px; }
.approved-title { font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #222; margin-bottom: 10px; text-align: center; }
.approved-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; font-size: 11px; color: #444; }
.approved-row > span { flex: 0 0 140px; }
.approved-line { flex: 1; border-bottom: 1px solid #999; height: 18px; }
.approved-seal { height: 48px; border: 1px dashed #666; border-radius: 4px; }
.footer { margin-top: 40px; border-top: 1px solid #eee; padding-top: 16px; text-align: center; font-size: 10px; color: #888; }
${chargeSourceCss()}
</style>
</head>
<body>
<div class="container">
  <div class="watermark-layer">
    <div class="wm-tile"></div>
    <div class="wm-text">OFFICIAL STATEMENT</div>
  </div>
  <div class="page-content">
  <div class="header">
    <div class="logo-wrap">
      ${logoImgHtmlProfessional(56)}
      <div class="logo">
        <h1>${escapeHtml(branding.name)}</h1>
        <p>Official Account Statement</p>
        ${branding.address ? `<p>${escapeHtml(branding.address)}</p>` : ''}
      </div>
    </div>
    <div class="title">
      <h2>STATEMENT</h2>
      <p>Generated: ${new Date().toLocaleString('en-NG')}</p>
    </div>
  </div>

  <div class="info-section">
    <div>
      <div class="info-group"><div class="info-label">Account Holder</div><div class="info-value">${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</div></div>
      <div class="info-group"><div class="info-label">Matriculation Number</div><div class="info-value">${escapeHtml(user.matricNumber || 'N/A')}</div></div>
      <div class="info-group"><div class="info-label">Email Address</div><div class="info-value">${escapeHtml(user.email)}</div></div>
    </div>
    <div class="balance-box">
      <div class="balance-label">Current Available Balance</div>
      <h2 class="balance-value">${moneyNGN(balance)}</h2>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Date</th><th>Reference</th><th>Type</th><th class="text-center">Status</th><th class="text-right">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  ${signatureBlockHtml(branding)}

  <div class="footer">
    <p>${hasBrandingSignature(branding) ? 'This is an official document authenticated by the Bursary signatory above.' : 'This is a computer-generated document and requires no signature.'}</p>
    <p>For any discrepancies, please contact the University Bursary Department immediately.${branding.phone ? ` Tel: ${escapeHtml(branding.phone)}` : ''}${branding.website ? ` • ${escapeHtml(branding.website)}` : ''}</p>
  </div>
  </div>
</div>
</body>
</html>`;
    return render(html);
  }

  static async generateReceipt(transaction: any) {
    const branding = await getBranding();
    const student = transaction.user ?? {};
    const qrUrl = transaction.receipt?.qrCodeData || `${process.env.APP_BASE_URL || 'http://localhost:3001'}/public/verify-receipt/${transaction.receipt?.verificationToken || transaction.reference}`;
    const qrCodeImage = await QRCode.toDataURL(qrUrl, { errorCorrectionLevel: 'M' });
    const statusClass = transaction.receipt?.isVoided ? 'badge-voided' : 'badge-paid';
    const statusText = transaction.receipt?.isVoided ? 'VOIDED' : 'PAID';
    const invoiceNumber = transaction.invoice?.invoiceNumber;
    const feeName = transaction.invoice?.fee?.name;
    const directBill = await lookupDirectBillForInvoice(transaction.userId ?? student.id, transaction.invoice?.feeId);
    const chargeSourceBlock = chargeSourceHtml(directBill);
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
@page { size: A4; margin: 0; }
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #222; background: #fff; }
.container { max-width: 800px; margin: 0 auto; border: 1px solid #e3e7ef; padding: 36px; position: relative; overflow: hidden; isolation: isolate; background: #fff; }
.page-content { position: relative; z-index: 2; }
.watermark-layer { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.watermark-layer .wm-tile { position: absolute; inset: -20%; background-image: url(${BELLS_LOGO_DATA_URI}); background-size: 220px 220px; background-repeat: repeat; opacity: 0.055; transform: rotate(-38deg); }
.watermark-layer .wm-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-38deg); font-size: 88px; color: rgba(10, 61, 145, 0.045); white-space: nowrap; font-weight: 900; letter-spacing: 8px; }
.header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0a3d91; padding-bottom: 18px; margin-bottom: 28px; }
.logo h1 { margin: 0; color: #0a3d91; font-size: 22px; text-transform: uppercase; letter-spacing: 1px; }
.logo p { margin: 5px 0 0; font-size: 12px; color: #555; }
.title h2 { margin: 0; font-size: 30px; color: #222; text-align: right; }
.title p { margin: 5px 0 0; color: #777; font-size: 13px; text-align: right; }
.badge { position: absolute; top: 180px; right: 40px; padding: 10px 20px; font-weight: 800; font-size: 18px; border-radius: 6px; text-transform: uppercase; transform: rotate(-8deg); opacity: 0.95; letter-spacing: 1px; z-index: 3; }
.badge-paid { border: 2px solid #0a7a2f; color: #0a7a2f; }
.badge-voided { border: 2px solid #b42318; color: #b42318; }
.amount { background: #f6f8fc; padding: 24px; border-radius: 8px; text-align: center; margin: 18px 0 28px; border: 1px solid #e6ecf6; }
.amount .label { font-size: 13px; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.amount .value { font-size: 44px; font-weight: 800; color: #0a3d91; margin: 0; }
.amount .words { font-size: 12px; color: #666; font-style: italic; margin-top: 6px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-bottom: 30px; }
.group { margin-bottom: 14px; }
.label { font-size: 11px; color: #777; text-transform: uppercase; margin-bottom: 5px; font-weight: 700; letter-spacing: 0.4px; }
.value { font-size: 15px; color: #222; font-weight: 500; border-bottom: 1px solid #eef1f7; padding-bottom: 4px; }
.fee-breakdown { background: #fafbfe; border: 1px solid #eef1f7; border-radius: 8px; padding: 18px 22px; margin-bottom: 28px; }
.fee-breakdown table { width: 100%; border-collapse: collapse; font-size: 13px; }
.fee-breakdown td { padding: 6px 0; border-bottom: none; }
.fee-breakdown td.right { text-align: right; font-weight: 600; }
.fee-breakdown tr.total td { border-top: 2px solid #dce3f1; padding-top: 10px; font-weight: 700; color: #0a3d91; }
.footer { margin-top: 40px; border-top: 1px solid #eee; padding-top: 18px; display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
.footer .text { font-size: 10px; color: #888; line-height: 1.6; max-width: 65%; }
.qr { text-align: center; }
.qr img { width: 108px; height: 108px; border: 1px solid #eef1f7; border-radius: 6px; padding: 4px; background: #fff; }
.qr .label { font-size: 10px; color: #666; margin-top: 6px; }
.logo-wrap { display: flex; align-items: flex-start; gap: 14px; }
.logo-img { display: inline-flex; align-items: center; justify-content: center; }
.signature-block { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; padding: 20px 0 0; }
.signature-col { }
.signature-line-img img { max-height: 72px; max-width: 240px; object-fit: contain; }
.signature-line { border-bottom: 1px solid #334155; margin: 18px 0 6px; width: 80%; }
.signature-label { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
.signature-meta-name { font-size: 14px; font-weight: 700; color: #222; }
.signature-meta-name.placeholder { color: #666; font-weight: 500; font-style: italic; }
.signature-meta-title { font-size: 12px; color: #555; margin-top: 4px; }
.signature-meta-title.placeholder { font-style: italic; }
.approved-box { border: 1px solid #334155; padding: 12px 14px; border-radius: 6px; }
.approved-title { font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #222; margin-bottom: 10px; text-align: center; }
.approved-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; font-size: 11px; color: #444; }
.approved-row > span { flex: 0 0 140px; }
.approved-line { flex: 1; border-bottom: 1px solid #999; height: 18px; }
.approved-seal { height: 48px; border: 1px dashed #666; border-radius: 4px; }
${chargeSourceCss()}
</style>
</head>
<body>
<div class="container">
  <div class="watermark-layer">
    <div class="wm-tile"></div>
    <div class="wm-text">OFFICIAL RECEIPT</div>
  </div>
  <div class="page-content">
  <div class="header">
    <div class="logo-wrap">
      ${logoImgHtmlProfessional(58)}
      <div class="logo">
        <h1>${escapeHtml(branding.name)}</h1>
        <p>Official Payment Receipt — Bursary Department</p>
        ${branding.address ? `<p>${escapeHtml(branding.address)}</p>` : ''}
        ${branding.website ? `<p>${escapeHtml(branding.website)}</p>` : ''}
      </div>
    </div>
    <div class="title">
      <h2>RECEIPT</h2>
      <p>#${escapeHtml(transaction.receipt?.receiptNumber || transaction.reference)}</p>
      <p>Issued: ${new Date(transaction.receipt?.generatedAt || transaction.createdAt).toLocaleString('en-NG')}</p>
    </div>
  </div>

  <div class="badge ${statusClass}">${statusText}</div>

  <div class="amount">
    <div class="label">Amount Paid</div>
    <h1 class="value">${moneyNGN(transaction.receipt?.paidAmount ?? transaction.amount)}</h1>
    <p class="words">Payment via ${escapeHtml(transaction.receipt?.paymentChannel || transaction.paystackChannel || 'Paystack')}</p>
  </div>

  <div class="grid">
    <div>
      <div class="group"><div class="label">Student Name</div><div class="value">${escapeHtml(student.firstName || '')} ${escapeHtml(student.lastName || '')}</div></div>
      <div class="group"><div class="label">Matriculation Number</div><div class="value">${escapeHtml(student.matricNumber || 'N/A')}</div></div>
      <div class="group"><div class="label">Email Address</div><div class="value">${escapeHtml(student.email || '')}</div></div>
    </div>
    <div>
      <div class="group"><div class="label">Payment Date & Time</div><div class="value">${new Date(transaction.receipt?.paidAt || transaction.createdAt).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'medium' })}</div></div>
      <div class="group"><div class="label">Transaction Reference</div><div class="value" style="font-family: monospace;">${escapeHtml(transaction.receipt?.receiptNumber || transaction.reference)}</div></div>
      <div class="group"><div class="label">Payment Method</div><div class="value">Online Payment (Paystack)${escapeHtml(transaction.receipt?.paymentMethodDetail ? ' • ' + transaction.receipt.paymentMethodDetail : '')}</div></div>
    </div>
  </div>

  ${chargeSourceBlock}

  <div class="fee-breakdown">
    <table>
      <tbody>
        ${invoiceNumber ? `<tr><td>Invoice Number</td><td class="right" style="font-family: monospace;">${escapeHtml(invoiceNumber)}</td></tr>` : ''}
        ${feeName ? `<tr><td>Fee Category / Purpose</td><td class="right">${escapeHtml(feeName)}</td></tr>` : ''}
        ${transaction.invoice?.session ? `<tr><td>Academic Session</td><td class="right">${escapeHtml(transaction.invoice.session)}</td></tr>` : ''}
        ${transaction.invoice?.semester ? `<tr><td>Semester</td><td class="right">${escapeHtml(transaction.invoice.semester)}</td></tr>` : ''}
        <tr class="total"><td>Total Amount Paid</td><td class="right">${moneyNGN(transaction.receipt?.paidAmount ?? transaction.amount)}</td></tr>
      </tbody>
    </table>
  </div>

  ${signatureBlockHtml(branding)}

  <div class="footer">
    <div class="text">
      <p><strong>Terms & Conditions:</strong></p>
      <p>${conditionalTermLine1(branding)}</p>
      <p>2. Payment is non-refundable unless approved via the formal refund request process administered by the Bursary.</p>
      <p>3. Verify this receipt independently by scanning the QR code or visiting the verification URL. ${transaction.receipt?.isVoided ? '<strong style="color:#b42318">This receipt has been VOIDED and is no longer valid.</strong>' : ''}</p>
      <p>Generated: ${new Date().toLocaleString('en-NG')}${branding.bankName && branding.bankAccount ? ` • Bank: ${escapeHtml(branding.bankName)} – ${escapeHtml(branding.bankAccount)}` : ''}</p>
    </div>
    <div class="qr">
      <img src="${qrCodeImage}" alt="Verify receipt" />
      <div class="label">Scan / open URL to verify</div>
    </div>
  </div>
  </div>
</div>
</body>
</html>`;
    return render(html);
  }

  static async generateFormalReceipt(receipt: ReceiptData) {
    const branding = await getBranding();
    const qrCodeImage = await QRCode.toDataURL(receipt.qrUrl, { errorCorrectionLevel: 'M' });
    const statusClass = receipt.isVoided ? 'badge-voided' : 'badge-paid';
    const statusText = receipt.isVoided ? 'VOIDED' : 'PAID';
    const directBill = await lookupDirectBillForInvoice((receipt.student as any)?.id, receipt.invoice?.fee ? ((receipt.invoice as any).fee as any).id : (receipt.invoice as any)?.feeId);
    const chargeSourceBlock = chargeSourceHtml(directBill);
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
@page { size: A4; margin: 0; }
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #222; background: #fff; }
.container { max-width: 800px; margin: 0 auto; border: 1px solid #e3e7ef; padding: 36px; position: relative; overflow: hidden; isolation: isolate; background: #fff; }
.page-content { position: relative; z-index: 2; }
.watermark-layer { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.watermark-layer .wm-tile { position: absolute; inset: -20%; background-image: url(${BELLS_LOGO_DATA_URI}); background-size: 220px 220px; background-repeat: repeat; opacity: 0.055; transform: rotate(-38deg); }
.watermark-layer .wm-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-38deg); font-size: 88px; color: rgba(10, 61, 145, 0.045); white-space: nowrap; font-weight: 900; letter-spacing: 8px; }
.header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0a3d91; padding-bottom: 18px; margin-bottom: 28px; }
.logo h1 { margin: 0; color: #0a3d91; font-size: 22px; text-transform: uppercase; letter-spacing: 1px; }
.logo p { margin: 5px 0 0; font-size: 12px; color: #555; }
.title h2 { margin: 0; font-size: 30px; color: #222; text-align: right; }
.title p { margin: 5px 0 0; color: #777; font-size: 13px; text-align: right; }
.badge { position: absolute; top: 180px; right: 40px; padding: 10px 20px; font-weight: 800; font-size: 18px; border-radius: 6px; text-transform: uppercase; transform: rotate(-8deg); opacity: 0.95; letter-spacing: 1px; z-index: 3; }
.badge-paid { border: 2px solid #0a7a2f; color: #0a7a2f; }
.badge-voided { border: 2px solid #b42318; color: #b42318; }
.amount { background: #f6f8fc; padding: 24px; border-radius: 8px; text-align: center; margin: 18px 0 28px; border: 1px solid #e6ecf6; }
.amount .label { font-size: 13px; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.amount .value { font-size: 44px; font-weight: 800; color: #0a3d91; margin: 0; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-bottom: 30px; }
.group { margin-bottom: 14px; }
.label { font-size: 11px; color: #777; text-transform: uppercase; margin-bottom: 5px; font-weight: 700; letter-spacing: 0.4px; }
.value { font-size: 15px; color: #222; font-weight: 500; border-bottom: 1px solid #eef1f7; padding-bottom: 4px; }
.fee-breakdown { background: #fafbfe; border: 1px solid #eef1f7; border-radius: 8px; padding: 18px 22px; margin-bottom: 28px; }
.fee-breakdown table { width: 100%; border-collapse: collapse; font-size: 13px; }
.fee-breakdown td { padding: 6px 0; border-bottom: none; }
.fee-breakdown td.right { text-align: right; font-weight: 600; }
.fee-breakdown tr.total td { border-top: 2px solid #dce3f1; padding-top: 10px; font-weight: 700; color: #0a3d91; }
.footer { margin-top: 40px; border-top: 1px solid #eee; padding-top: 18px; display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
.footer .text { font-size: 10px; color: #888; line-height: 1.6; max-width: 65%; }
.qr { text-align: center; }
.qr img { width: 108px; height: 108px; border: 1px solid #eef1f7; border-radius: 6px; padding: 4px; background: #fff; }
.qr .label { font-size: 10px; color: #666; margin-top: 6px; }
.logo-wrap { display: flex; align-items: flex-start; gap: 14px; }
.logo-img { display: inline-flex; align-items: center; justify-content: center; }
.signature-block { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; padding: 20px 0 0; }
.signature-col { }
.signature-line-img img { max-height: 72px; max-width: 240px; object-fit: contain; }
.signature-line { border-bottom: 1px solid #334155; margin: 18px 0 6px; width: 80%; }
.signature-label { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
.signature-meta-name { font-size: 14px; font-weight: 700; color: #222; }
.signature-meta-name.placeholder { color: #666; font-weight: 500; font-style: italic; }
.signature-meta-title { font-size: 12px; color: #555; margin-top: 4px; }
.signature-meta-title.placeholder { font-style: italic; }
.approved-box { border: 1px solid #334155; padding: 12px 14px; border-radius: 6px; }
.approved-title { font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #222; margin-bottom: 10px; text-align: center; }
.approved-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; font-size: 11px; color: #444; }
.approved-row > span { flex: 0 0 140px; }
.approved-line { flex: 1; border-bottom: 1px solid #999; height: 18px; }
.approved-seal { height: 48px; border: 1px dashed #666; border-radius: 4px; }
${chargeSourceCss()}
</style>
</head>
<body>
<div class="container">
  <div class="watermark-layer">
    <div class="wm-tile"></div>
    <div class="wm-text">OFFICIAL RECEIPT</div>
  </div>
  <div class="page-content">
  <div class="header">
    <div class="logo-wrap">
      ${logoImgHtmlProfessional(58)}
      <div class="logo">
        <h1>${escapeHtml(branding.name)}</h1>
        <p>Official Payment Receipt — Bursary Department</p>
        ${branding.address ? `<p>${escapeHtml(branding.address)}</p>` : ''}
        ${branding.website ? `<p>${escapeHtml(branding.website)}</p>` : ''}
      </div>
    </div>
    <div class="title">
      <h2>RECEIPT</h2>
      <p>#${escapeHtml(receipt.receiptNumber)}</p>
      <p>Issued: ${new Date(receipt.paidAt).toLocaleString('en-NG')}</p>
    </div>
  </div>

  <div class="badge ${statusClass}">${statusText}</div>

  <div class="amount">
    <div class="label">Amount Paid</div>
    <h1 class="value">${moneyNGN(receipt.paidAmount)}</h1>
    <p class="words">Payment via ${escapeHtml(receipt.paymentChannel || 'Paystack')}</p>
  </div>

  <div class="grid">
    <div>
      <div class="group"><div class="label">Student Name</div><div class="value">${escapeHtml(receipt.student.firstName)} ${escapeHtml(receipt.student.lastName)}</div></div>
      <div class="group"><div class="label">Matriculation Number</div><div class="value">${escapeHtml(receipt.student.matricNumber || 'N/A')}</div></div>
      <div class="group"><div class="label">Email Address</div><div class="value">${escapeHtml(receipt.student.email)}</div></div>
    </div>
    <div>
      <div class="group"><div class="label">Payment Date & Time</div><div class="value">${new Date(receipt.paidAt).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'medium' })}</div></div>
      <div class="group"><div class="label">Receipt Reference</div><div class="value" style="font-family: monospace;">${escapeHtml(receipt.receiptNumber)}</div></div>
      <div class="group"><div class="label">Payment Method</div><div class="value">Online Payment (Paystack)${receipt.paymentMethodDetail ? ' • ' + escapeHtml(receipt.paymentMethodDetail) : ''}</div></div>
    </div>
  </div>

  ${chargeSourceBlock}

  <div class="fee-breakdown">
    <table>
      <tbody>
        ${receipt.invoice?.invoiceNumber ? `<tr><td>Invoice Number</td><td class="right" style="font-family: monospace;">${escapeHtml(receipt.invoice.invoiceNumber)}</td></tr>` : ''}
        ${receipt.invoice?.fee?.name ? `<tr><td>Fee Category / Purpose</td><td class="right">${escapeHtml(receipt.invoice.fee.name)}</td></tr>` : ''}
        ${receipt.invoice?.session ? `<tr><td>Academic Session</td><td class="right">${escapeHtml(receipt.invoice.session)}</td></tr>` : ''}
        ${receipt.invoice?.semester ? `<tr><td>Semester</td><td class="right">${escapeHtml(receipt.invoice.semester)}</td></tr>` : ''}
        <tr class="total"><td>Total Amount Paid</td><td class="right">${moneyNGN(receipt.paidAmount)}</td></tr>
      </tbody>
    </table>
  </div>

  ${signatureBlockHtml(branding)}

  <div class="footer">
    <div class="text">
      <p><strong>Terms & Conditions:</strong></p>
      <p>${conditionalTermLine1(branding)}</p>
      <p>2. Payment is non-refundable unless approved via the formal refund request process administered by the Bursary.</p>
      <p>3. Verify this receipt independently by scanning the QR code or visiting the verification URL. ${receipt.isVoided ? '<strong style="color:#b42318">This receipt has been VOIDED and is no longer valid.</strong>' : ''}</p>
      <p>Generated: ${new Date().toLocaleString('en-NG')}${branding.bankName && branding.bankAccount ? ` • Bank: ${escapeHtml(branding.bankName)} – ${escapeHtml(branding.bankAccount)}` : ''}</p>
    </div>
    <div class="qr">
      <img src="${qrCodeImage}" alt="Verify receipt" />
      <div class="label">Scan / open URL to verify</div>
    </div>
  </div>
  </div>
</div>
</body>
</html>`;
    return render(html);
  }
}
