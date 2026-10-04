import nodemailer, { Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { sentCaptures } from './email';
import { randomHex } from '../utils/security';

export type EmailProviderName = 'resend' | 'smtp' | 'mock';

export interface MailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface MailArgs {
  from: { name: string; address: string };
  to: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
}

export interface EmailProviderResult {
  success: boolean;
  provider: EmailProviderName;
  messageId?: string;
  error?: string;
}

export interface EmailProvider {
  name: EmailProviderName;
  send(mail: MailArgs): Promise<EmailProviderResult>;
}

export function hasResendConfigured(): boolean {
  const v = process.env.RESEND_API_KEY;
  return !!v && v.trim().length > 0 && !v.includes('your-key') && !v.includes('placeholder');
}

export function hasSmtpConfigured(): boolean {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  return !!(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS
    && SMTP_HOST.trim() && SMTP_PORT.trim() && SMTP_USER.trim() && SMTP_PASS.trim());
}

class ResendProvider implements EmailProvider {
  readonly name = 'resend' as const;
  private client: Resend | null = null;
  constructor() {
    try {
      if (hasResendConfigured()) {
        this.client = new Resend(process.env.RESEND_API_KEY!);
      }
    } catch (e) {
      this.client = null;
    }
  }
  async send(mail: MailArgs): Promise<EmailProviderResult> {
    if (!this.client) {
      return { success: false, provider: 'resend', error: 'RESEND_API_KEY not configured' };
    }
    try {
      const payload: any = {
        from: `${mail.from.name} <${mail.from.address}>`,
        to: mail.to,
        ...(mail.bcc ? { bcc: mail.bcc } : {}),
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      };
      if (mail.attachments && mail.attachments.length > 0) {
        payload.attachments = mail.attachments.map((a) => ({
          filename: a.filename,
          content: typeof a.content === 'string' ? a.content : a.content.toString('base64'),
          ...(a.contentType ? { content_type: a.contentType } : {}),
        }));
      }
      const res = await this.client.emails.send(payload);
      if (res && (res as any).error) {
        return {
          success: false,
          provider: 'resend',
          error: String((res as any).error?.message || JSON.stringify((res as any).error)).slice(0, 2000),
        };
      }
      const id = (res as any)?.id;
      sentCaptures.push({ to: mail.to, subject: mail.subject, provider: 'resend', messageId: id, at: new Date().toISOString() });
      return { success: true, provider: 'resend', messageId: String(id || '') };
    } catch (err: any) {
      return {
        success: false,
        provider: 'resend',
        error: String(err?.message || err).slice(0, 2000),
      };
    }
  }
}

let _smtpTransport: Transporter | null = null;
function getSmtpTransport(): Transporter | null {
  if (_smtpTransport) return _smtpTransport;
  if (!hasSmtpConfigured()) return null;
  try {
    _smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT!, 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
    });
    return _smtpTransport;
  } catch {
    return null;
  }
}

class SmtpProvider implements EmailProvider {
  readonly name = 'smtp' as const;
  async send(mail: MailArgs): Promise<EmailProviderResult> {
    const transport = getSmtpTransport();
    if (!transport) {
      return { success: false, provider: 'smtp', error: 'SMTP not configured' };
    }
    try {
      const info = await transport.sendMail({
        from: `"${mail.from.name}" <${mail.from.address}>`,
        replyTo: mail.replyTo,
        to: mail.to,
        bcc: mail.bcc,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: mail.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      sentCaptures.push({ to: mail.to, subject: mail.subject, provider: 'smtp', info, at: new Date().toISOString() });
      return {
        success: true,
        provider: 'smtp',
        messageId: String(info?.messageId || ''),
      };
    } catch (err: any) {
      return {
        success: false,
        provider: 'smtp',
        error: String(err?.message || err).slice(0, 2000),
      };
    }
  }
}

class MockJsonProvider implements EmailProvider {
  readonly name = 'mock' as const;
  async send(mail: MailArgs): Promise<EmailProviderResult> {
    const messageId = `mock-${randomHex(12)}`;
    const info = { jsonTransport: true, messageId };
    sentCaptures.push({ to: mail.to, subject: mail.subject, provider: 'mock', info, at: new Date().toISOString() });
    return { success: true, provider: 'mock', messageId };
  }
}

export function selectEmailProvider(forceSmtp?: boolean): EmailProvider {
  if (forceSmtp) {
    if (hasSmtpConfigured()) return new SmtpProvider();
    return new MockJsonProvider();
  }
  if (hasResendConfigured()) {
    return new ResendProvider();
  }
  if (hasSmtpConfigured()) {
    return new SmtpProvider();
  }
  return new MockJsonProvider();
}
