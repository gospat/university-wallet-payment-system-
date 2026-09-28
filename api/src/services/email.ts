import nodemailer, { Transporter } from 'nodemailer';
import { getDefaultEmailDomain } from '../utils/alatpay';
import { brandingEnvOnly } from '../utils/branding';
import { selectEmailProvider } from './emailProviders';
import type { MailArgs } from './emailProviders';

const envBranding = brandingEnvOnly();

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const sentCaptures: any[] = [];

class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

const emailStrings = {
  universityName: envBranding.name,
  universityAddress: envBranding.address || '123 Academic Way, Campus City',
  logoUrl: envBranding.logoUrl,
  copyright: `© ${new Date().getFullYear()} ${envBranding.name}. All rights reserved.`,
  buttons: {
    downloadReceipt: 'Download Receipt',
    resetPassword: 'Reset Password',
    viewInvoice: 'View Invoice',
    loginPortal: 'Log in to Portal',
  },
  roles: {
    studentBlue: '#1e40af',
  },
} as const;

function formatNaira(amountNgnNumber: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(amountNgnNumber);
}

function checkForSecrets(content: string): void {
  const patterns = [
    /sk_/,
    /pk_/,
    /JWT_/,
    /SMTP_PASS/,
    /\$2[aby]?\$\d{2}\$/,
  ];
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      throw new SecurityError('Email body may contain secrets. Aborted.');
    }
  }
}

export function buttonLink(url: string, label: string, accentHex?: string): { html: string; text: string } {
  const color = accentHex && /^#?[0-9a-fA-F]{3,8}$/.test(accentHex.trim())
    ? (accentHex.startsWith('#') ? accentHex : `#${accentHex}`)
    : emailStrings.roles.studentBlue;
  return {
    html: `<a href="${url}" style="display:inline-block;background:${color};color:#ffffff;padding:10px 20px;text-decoration:none;font-weight:bold;">${label}</a>`,
    text: `${label}: ${url}`,
  };
}

export function wrapEmail(bodyHtml: string, bodyText: string, accentHex?: string): { html: string; text: string } {
  const headerAccent = accentHex && /^#?[0-9a-fA-F]{3,8}$/.test(accentHex.trim())
    ? (accentHex.startsWith('#') ? accentHex : `#${accentHex}`)
    : emailStrings.roles.studentBlue;
  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Notification</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f5f5f5;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:20px 0;">
<tr>
<td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;">
<tr>
<td style="padding:20px 30px;background:${headerAccent};color:#ffffff;">
<h1 style="margin:0;font-size:20px;">${emailStrings.universityName}</h1>
</td>
</tr>
<tr>
<td style="padding:30px;">
${bodyHtml}
</td>
</tr>
<tr>
<td style="padding:20px 30px;background:#f0f0f0;color:#888888;font-size:12px;">
<p style="margin:0 0 8px 0;">${emailStrings.universityAddress}</p>
<p style="margin:0;">${emailStrings.copyright}</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
  `.trim();
  const text = `${emailStrings.universityName}\n\n${bodyText}\n\n${emailStrings.universityAddress}\n${emailStrings.copyright}`;
  return { html, text };
}

let _transport: Transporter | null = null;

export function createTransport(): Transporter {
  if (_transport) return _transport;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const allPresent = !!(host && port && user && pass && host.trim() && port.trim() && user.trim() && pass.trim());

  if (allPresent) {
    _transport = nodemailer.createTransport({
      host,
      port: parseInt(port, 10),
      secure,
      auth: { user, pass },
    });
  } else {
    _transport = nodemailer.createTransport({ jsonTransport: true } as any);
  }

  return _transport;
}

export async function sendEmail({
  to,
  rendered,
  bcc,
  forceSmtp,
  fromOverride,
}: {
  to: string;
  rendered: RenderedEmail;
  bcc?: string;
  forceSmtp?: boolean;
  fromOverride?: { name: string; address: string };
  replyToOverride?: string;
}): Promise<{ success: boolean; messageId?: string; provider?: 'resend' | 'smtp' | 'mock'; error?: string; info?: any }> {
  const combined = rendered.subject + rendered.html + rendered.text;
  checkForSecrets(combined);

  const fromName = fromOverride?.name || process.env.EMAIL_FROM_NAME || 'University Bursary';
  const defaultDomain = getDefaultEmailDomain();
  const fromAddress = fromOverride?.address || process.env.EMAIL_FROM_ADDRESS || `no-reply@${defaultDomain}`;
  const replyTo = (arguments[0] as any)?.replyToOverride || process.env.EMAIL_REPLY_TO_ADDRESS || fromAddress;

  const provider = selectEmailProvider(forceSmtp);
  const mail: MailArgs = {
    from: { name: fromName, address: fromAddress },
    to,
    bcc,
    replyTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };

  const result = await provider.send(mail);
  return {
    success: result.success,
    messageId: result.messageId,
    provider: result.provider,
    error: result.error,
    info: { provider: result.provider, messageId: result.messageId, error: result.error },
  };
}

export function renderPaymentSuccessful({
  studentName,
  feeName,
  amountNgnNumber,
  reference,
  receiptNumber,
  receiptDownloadUrl,
}: {
  studentName: string;
  feeName: string;
  amountNgnNumber: number;
  reference: string;
  receiptNumber: string;
  receiptDownloadUrl: string;
}): RenderedEmail {
  const amount = formatNaira(amountNgnNumber);
  const btn = buttonLink(receiptDownloadUrl, emailStrings.buttons.downloadReceipt);

  const bodyHtml = `
<p>Dear ${studentName},</p>
<p>Your payment for <strong>${feeName}</strong> has been successfully received.</p>
<table cellpadding="8" cellspacing="0" border="1" bordercolor="#e0e0e0" style="border-collapse:collapse;margin:16px 0;">
<tr><td style="background:#f0f0f0;"><strong>Amount</strong></td><td>${amount}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Reference</strong></td><td>${reference}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Receipt</strong></td><td>${receiptNumber}</td></tr>
</table>
<p style="margin:20px 0;">${btn.html}</p>
<p style="color:#666666;font-size:12px;"><em>If you did not make this payment, please contact bursary immediately.</em></p>
  `.trim();

  const bodyText =
    `Dear ${studentName},\n\n` +
    `Your payment for ${feeName} has been successfully received.\n\n` +
    `Amount: ${amount}\n` +
    `Reference: ${reference}\n` +
    `Receipt: ${receiptNumber}\n\n` +
    `${btn.text}\n\n` +
    `NOTE: If you did not make this payment, please contact bursary immediately.`;

  const wrapped = wrapEmail(bodyHtml, bodyText);
  return {
    subject: `Payment Successful — ${reference}`,
    html: wrapped.html,
    text: wrapped.text,
  };
}

export function renderPaymentInitiated({
  studentName,
  feeName,
  amountNgnNumber,
  reference,
}: {
  studentName: string;
  feeName: string;
  amountNgnNumber: number;
  reference: string;
}): RenderedEmail {
  const amount = formatNaira(amountNgnNumber);

  const bodyHtml = `
<p>Dear ${studentName},</p>
<p>We are processing your payment of <strong>${amount}</strong> for <strong>${feeName}</strong>.</p>
<p>No receipt has been issued yet.</p>
<p>Reference: ${reference}</p>
  `.trim();

  const bodyText =
    `Dear ${studentName},\n\n` +
    `We are processing your payment of ${amount} for ${feeName}.\n\n` +
    `No receipt has been issued yet.\n\n` +
    `Reference: ${reference}`;

  const wrapped = wrapEmail(bodyHtml, bodyText);
  return {
    subject: `Payment Initiated — ${reference}`,
    html: wrapped.html,
    text: wrapped.text,
  };
}

export function renderPaymentFailed({
  studentName,
  reference,
  attemptDate,
}: {
  studentName: string;
  reference: string;
  attemptDate: string | Date;
}): RenderedEmail {
  const date = attemptDate instanceof Date ? attemptDate.toLocaleString() : attemptDate;

  const bodyHtml = `
<p>Dear ${studentName},</p>
<p>Your payment attempt could not be completed. Please try again or contact bursary for assistance.</p>
<table cellpadding="8" cellspacing="0" border="1" bordercolor="#e0e0e0" style="border-collapse:collapse;margin:16px 0;">
<tr><td style="background:#f0f0f0;"><strong>Reference</strong></td><td>${reference}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Attempt Date</strong></td><td>${date}</td></tr>
</table>
  `.trim();

  const bodyText =
    `Dear ${studentName},\n\n` +
    `Your payment attempt could not be completed. Please try again or contact bursary for assistance.\n\n` +
    `Reference: ${reference}\n` +
    `Attempt Date: ${date}`;

  const wrapped = wrapEmail(bodyHtml, bodyText);
  return {
    subject: `Payment Attempt Not Successful — ${reference}`,
    html: wrapped.html,
    text: wrapped.text,
  };
}

export function renderPaymentReversed({
  studentName,
  reference,
  amountNgnNumber,
  reversedAt,
}: {
  studentName: string;
  reference: string;
  amountNgnNumber: number;
  reversedAt: string | Date;
}): RenderedEmail {
  const amount = formatNaira(amountNgnNumber);
  const date = reversedAt instanceof Date ? reversedAt.toLocaleString() : reversedAt;

  const bodyHtml = `
<p>Dear ${studentName},</p>
<p>A payment reversal has been applied to your account.</p>
<table cellpadding="8" cellspacing="0" border="1" bordercolor="#e0e0e0" style="border-collapse:collapse;margin:16px 0;">
<tr><td style="background:#f0f0f0;"><strong>Reference</strong></td><td>${reference}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Amount</strong></td><td>${amount}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Reversed At</strong></td><td>${date}</td></tr>
</table>
  `.trim();

  const bodyText =
    `Dear ${studentName},\n\n` +
    `A payment reversal has been applied to your account.\n\n` +
    `Reference: ${reference}\n` +
    `Amount: ${amount}\n` +
    `Reversed At: ${date}`;

  const wrapped = wrapEmail(bodyHtml, bodyText);
  return {
    subject: `Payment Reversed — ${reference}`,
    html: wrapped.html,
    text: wrapped.text,
  };
}

export function renderRefundStatusChanged({
  studentName,
  reference,
  refundStatus,
  amountNgnNumber,
}: {
  studentName: string;
  reference: string;
  refundStatus: string;
  amountNgnNumber: number;
}): RenderedEmail {
  const amount = formatNaira(amountNgnNumber);

  const bodyHtml = `
<p>Dear ${studentName},</p>
<p>The refund for your transaction has been updated to <strong>${refundStatus}</strong>.</p>
<table cellpadding="8" cellspacing="0" border="1" bordercolor="#e0e0e0" style="border-collapse:collapse;margin:16px 0;">
<tr><td style="background:#f0f0f0;"><strong>Reference</strong></td><td>${reference}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Amount</strong></td><td>${amount}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Status</strong></td><td>${refundStatus}</td></tr>
</table>
  `.trim();

  const bodyText =
    `Dear ${studentName},\n\n` +
    `The refund for your transaction has been updated to ${refundStatus}.\n\n` +
    `Reference: ${reference}\n` +
    `Amount: ${amount}\n` +
    `Status: ${refundStatus}`;

  const wrapped = wrapEmail(bodyHtml, bodyText);
  return {
    subject: `Refund ${refundStatus} — ${reference}`,
    html: wrapped.html,
    text: wrapped.text,
  };
}

export function renderPasswordReset({
  userFirstname,
  resetUrl,
  expiresMinutes = 60,
}: {
  userFirstname: string;
  resetUrl: string;
  expiresMinutes?: number;
}): RenderedEmail {
  const btn = buttonLink(resetUrl, emailStrings.buttons.resetPassword);

  const bodyHtml = `
<p>Dear ${userFirstname},</p>
<p>Click the button below to reset your password. This link is valid for <strong>${expiresMinutes} minutes</strong>.</p>
<p style="margin:20px 0;">${btn.html}</p>
<p style="color:#666666;font-size:12px;"><em>If you did not request this, please ignore this email. Your password will not change.</em></p>
  `.trim();

  const bodyText =
    `Dear ${userFirstname},\n\n` +
    `Click here to reset your password — valid for ${expiresMinutes} minutes.\n\n` +
    `${btn.text}\n\n` +
    `WARNING: If you did not request this, please ignore this email. Your password will not change.`;

  const wrapped = wrapEmail(bodyHtml, bodyText);
  return {
    subject: 'Reset your password',
    html: wrapped.html,
    text: wrapped.text,
  };
}

export function renderStudentAccountCreated({
  studentName,
  matricNumber,
  email,
  temporaryPassword,
  portalLoginUrl,
}: {
  studentName: string;
  matricNumber: string;
  email: string;
  temporaryPassword: string;
  portalLoginUrl: string;
}): RenderedEmail {
  const btn = buttonLink(portalLoginUrl, emailStrings.buttons.loginPortal);

  const bodyHtml = `
<p>Dear ${studentName},</p>
<p>Your student account has been created. Here are your login details:</p>
<table cellpadding="8" cellspacing="0" border="1" bordercolor="#e0e0e0" style="border-collapse:collapse;margin:16px 0;">
<tr><td style="background:#f0f0f0;"><strong>Matric Number</strong></td><td>${matricNumber}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Email</strong></td><td>${email}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Temporary Password</strong></td><td>${temporaryPassword}</td></tr>
</table>
<p style="margin:20px 0;">${btn.html}</p>
<p style="color:#b91c1c;"><strong>CHANGE your password on first login immediately to keep your account secure.</strong></p>
  `.trim();

  const bodyText =
    `Dear ${studentName},\n\n` +
    `Your account has been created.\n\n` +
    `Matric: ${matricNumber}\n` +
    `Email: ${email}\n` +
    `Temporary password: ${temporaryPassword}\n\n` +
    `${btn.text}\n\n` +
    `CHANGE your password on first login immediately to keep your account secure.`;

  const wrapped = wrapEmail(bodyHtml, bodyText);
  return {
    subject: 'Your Student Account has been created',
    html: wrapped.html,
    text: wrapped.text,
  };
}

export async function renderStudentAccountCreatedConfigurable(
  args: {
    studentName: string;
    matricNumber: string;
    email: string;
    temporaryPassword: string;
  },
  opts?: { templateKey?: string },
): Promise<{ rendered: RenderedEmail; senderName: string; senderAddress: string; replyToAddress?: string | null }> {
  // Dynamically import to avoid circular imports with emailTemplate.ts
  const { renderStudentCredentialEmailHtmlText, getResolvedTemplateByKey } = await import('./emailTemplate');
  const key = opts?.templateKey || 'student_credentials';
  const [renderResult, config] = await Promise.all([
    renderStudentCredentialEmailHtmlText(args, { templateKey: key }),
    getResolvedTemplateByKey(key),
  ]);
  return {
    rendered: renderResult.rendered,
    senderName: config.senderName,
    senderAddress: config.senderAddress,
    replyToAddress: config.replyToAddress,
  };
}

export function renderPaymentReminder({
  studentName,
  feeName,
  amountNgnNumber,
  dueDate,
  invoiceUrl,
  daysLeft,
}: {
  studentName: string;
  feeName: string;
  amountNgnNumber: number;
  dueDate: string | Date;
  invoiceUrl: string;
  daysLeft: number;
}): RenderedEmail {
  const amount = formatNaira(amountNgnNumber);
  const date = dueDate instanceof Date ? dueDate.toLocaleDateString() : dueDate;
  const btn = buttonLink(invoiceUrl, emailStrings.buttons.viewInvoice);

  const bodyHtml = `
<p>Dear ${studentName},</p>
<p>This is a friendly reminder that your <strong>${feeName}</strong> fee is due on <strong>${date}</strong> with balance ${amount}.</p>
<p>You have <strong>${daysLeft} day(s) left</strong>. Please pay on time to avoid penalties.</p>
<p style="margin:20px 0;">${btn.html}</p>
  `.trim();

  const bodyText =
    `Dear ${studentName},\n\n` +
    `This is a friendly reminder that your ${feeName} fee is due on ${date} with balance ${amount}.\n\n` +
    `You have ${daysLeft} day(s) left. Please pay on time to avoid penalties.\n\n` +
    `${btn.text}`;

  const wrapped = wrapEmail(bodyHtml, bodyText);
  return {
    subject: `Reminder: ${feeName} payment due in ${daysLeft} days`,
    html: wrapped.html,
    text: wrapped.text,
  };
}

export function renderStudentBillAssigned({
  student,
  fee,
  invoice,
  assignment,
  noteToStudent,
}: {
  student: { firstName?: string | null; lastName?: string | null; matricNumber?: string | null; email?: string | null };
  fee: { name: string; description?: string | null; id?: number };
  invoice: { id: number; invoiceNumber: string; amountDue: number | string | { toNumber?: () => number; toString: () => string }; dueDate?: string | Date | null };
  assignment?: { id?: number };
  noteToStudent?: string | null;
}): RenderedEmail {
  const studentName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || 'Student';
  const amountNum =
    typeof invoice.amountDue === 'number'
      ? invoice.amountDue
      : typeof invoice.amountDue === 'string'
        ? Number(invoice.amountDue)
        : typeof invoice.amountDue?.toNumber === 'function'
          ? invoice.amountDue.toNumber()
          : Number(String(invoice.amountDue ?? 0));
  const amount = formatNaira(Number.isFinite(amountNum) ? amountNum : 0);
  const dateStr =
    !invoice.dueDate
      ? 'As soon as possible'
      : invoice.dueDate instanceof Date
        ? invoice.dueDate.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
        : String(invoice.dueDate);
  const portalBase =
    process.env.STUDENT_PORTAL_URL ||
    process.env.CORS_ORIGIN ||
    'http://localhost:5173';
  const cleanBase = String(portalBase).replace(/\/+$/, '');
  const invoiceUrl = `${cleanBase}/student/fees?invoiceId=${encodeURIComponent(String(invoice.id))}`;
  const btn = buttonLink(invoiceUrl, 'Pay this bill');

  const descriptionRow = fee.description
    ? `<tr><td style="background:#f0f0f0;"><strong>Fee description</strong></td><td style="white-space:pre-wrap;">${String(fee.description)}</td></tr>`
    : '';
  const noteRow = noteToStudent
    ? `<div style="margin-top:20px;padding:16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;">
         <p style="margin:0 0 6px 0;"><strong>Note from the Bursary department:</strong></p>
         <p style="margin:0;white-space:pre-wrap;">${String(noteToStudent)}</p>
       </div>`
    : '';
  const assignmentRow = assignment?.id
    ? `<tr><td style="background:#f0f0f0;"><strong>Assignment reference</strong></td><td>#${assignment.id}</td></tr>`
    : '';

  const bodyHtml = `
<p>Dear ${studentName},</p>
<p>A new bill has been assigned to you by the Bursary department. Please review and pay at your earliest convenience:</p>
<table cellpadding="8" cellspacing="0" border="1" bordercolor="#e0e0e0" style="border-collapse:collapse;margin:16px 0;">
<tr><td style="background:#f0f0f0;"><strong>Student / Matric</strong></td><td>${studentName}${student.matricNumber ? ` — <span style="font-family:monospace;">${student.matricNumber}</span>` : ''}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Fee</strong></td><td>${fee.name}${fee.id ? ` <span style="color:#666;font-size:12px;">(Fee#${fee.id})</span>` : ''}</td></tr>
${descriptionRow}
<tr><td style="background:#f0f0f0;"><strong>Invoice</strong></td><td><span style="font-family:monospace;">${invoice.invoiceNumber}</span></td></tr>
<tr><td style="background:#f0f0f0;"><strong>Amount due</strong></td><td style="font-weight:bold;color:#b91c1c;font-size:16px;">${amount}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Due date</strong></td><td>${dateStr}</td></tr>
${assignmentRow}
</table>
<p style="margin:20px 0;">${btn.html}</p>
<p style="color:#666666;font-size:12px;">If you have any questions about this charge, contact the bursary department quoting the invoice number above.</p>
${noteRow}
  `.trim();

  const bodyText =
    `Dear ${studentName},\n\n` +
    `A new bill has been assigned to you by the Bursary department:\n\n` +
    `Fee: ${fee.name}\n` +
    (fee.description ? `Description: ${fee.description}\n` : '') +
    `Invoice: ${invoice.invoiceNumber}\n` +
    `Amount due: ${amount}\n` +
    `Due date: ${dateStr}\n` +
    (student.matricNumber ? `Matric number: ${student.matricNumber}\n` : '') +
    (assignment?.id ? `Assignment reference: #${assignment.id}\n` : '') +
    `\nPay here: ${invoiceUrl}\n\n` +
    (noteToStudent ? `Note from Bursary: ${noteToStudent}\n\n` : '') +
    `Contact the bursary department if you have any questions, quoting the invoice number.`;

  const wrapped = wrapEmail(bodyHtml, bodyText);
  return {
    subject: `New bill assigned: ${fee.name} (${invoice.invoiceNumber})`,
    html: wrapped.html,
    text: wrapped.text,
  };
}

/**
 * Non-blocking email for direct-bill one-click. Returns true on success (or json-transport fallback).
 * Returns false on transport error and logs WARN — never throws to avoid breaking the billing endpoint.
 */
export async function sendStudentBillAssigned(
  student: Parameters<typeof renderStudentBillAssigned>[0]['student'],
  fee: Parameters<typeof renderStudentBillAssigned>[0]['fee'],
  invoice: Parameters<typeof renderStudentBillAssigned>[0]['invoice'],
  assignment?: Parameters<typeof renderStudentBillAssigned>[0]['assignment'],
  noteToStudent?: string | null,
): Promise<boolean> {
  try {
    const to = student.email;
    if (!to) return false;
    const rendered = renderStudentBillAssigned({ student, fee, invoice, assignment, noteToStudent: noteToStudent ?? null });
    const result = await sendEmail({ to: String(to), rendered });
    return !!result?.success;
  } catch (e: any) {
    try { console.warn('[sendStudentBillAssigned] failed:', e?.message || String(e)); } catch {}
    return false;
  }
}
