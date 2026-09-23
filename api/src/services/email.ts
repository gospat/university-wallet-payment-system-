import nodemailer, { Transporter } from 'nodemailer';
import { getDefaultEmailDomain } from '../utils/alatpay';
import { brandingEnvOnly } from '../utils/branding';

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

function buttonLink(url: string, label: string): { html: string; text: string } {
  return {
    html: `<a href="${url}" style="display:inline-block;background:${emailStrings.roles.studentBlue};color:#ffffff;padding:10px 20px;text-decoration:none;font-weight:bold;">${label}</a>`,
    text: `${label}: ${url}`,
  };
}

function wrapEmail(bodyHtml: string, bodyText: string): { html: string; text: string } {
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
<td style="padding:20px 30px;background:${emailStrings.roles.studentBlue};color:#ffffff;">
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
}: {
  to: string;
  rendered: RenderedEmail;
  bcc?: string;
}): Promise<{ success: boolean; messageId?: string; info?: any }> {
  const combined = rendered.subject + rendered.html + rendered.text;
  checkForSecrets(combined);

  const fromName = process.env.EMAIL_FROM_NAME || 'University Bursary';
  const defaultDomain = getDefaultEmailDomain();
  const fromAddress = process.env.EMAIL_FROM_ADDRESS || `no-reply@${defaultDomain}`;
  const replyTo = process.env.EMAIL_REPLY_TO_ADDRESS || fromAddress;

  const transport = createTransport();
  const mailOptions = {
    from: `"${fromName}" <${fromAddress}>`,
    replyTo,
    to,
    bcc,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };

  try {
    const info = await transport.sendMail(mailOptions);
    sentCaptures.push({ to, subject: rendered.subject, info, at: new Date().toISOString() });
    return {
      success: true,
      messageId: info.messageId,
      info,
    };
  } catch (err: any) {
    const isJsonTransport = (_transport as any)?.options?.jsonTransport === true;
    if (isJsonTransport) {
      const info = { error: err?.message, jsonTransport: true };
      sentCaptures.push({ to, subject: rendered.subject, info, at: new Date().toISOString() });
      return { success: true, info };
    }
    // eslint-disable-next-line no-console
    console.warn('[email] send failed:', err?.message || err);
    throw err;
  }
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
