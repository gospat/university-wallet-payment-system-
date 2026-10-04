import { z } from 'zod';
import prisma from '../config/database';
import { buildBranding } from '../utils/branding';
import { wrapEmail, buttonLink } from './email';
import type { RenderedEmail } from './email';

export const EMAIL_TEMPLATE_KEYS = {
  STUDENT_CREDENTIALS: 'student_credentials',
} as const;

export type EmailTemplateKey = typeof EMAIL_TEMPLATE_KEYS[keyof typeof EMAIL_TEMPLATE_KEYS];

export const EMAIL_TEMPLATE_DEFAULTS: Record<string, {
  senderName: string;
  senderAddress: string;
  replyToAddress?: string;
  portalLoginUrl: string;
  subjectLine: string;
  greeting: string;
  paragraph: string;
  buttonLabel: string;
  forceChangeNotice: string;
  closing: string;
}> = {
  [EMAIL_TEMPLATE_KEYS.STUDENT_CREDENTIALS]: {
    senderName: 'University Bursary',
    senderAddress: 'noreply@university.edu.ng',
    portalLoginUrl: 'https://portal.university.edu.ng/login',
    subjectLine: 'Your University Account Has Been Created',
    greeting: 'Dear {{studentName}},',
    paragraph: 'Your student account has been successfully created. You can now log in to the student portal using the credentials below.',
    buttonLabel: 'Access Student Portal',
    forceChangeNotice: 'For your security, you will be required to change your password on your first login. Please keep this email safe until you have logged in successfully.',
    closing: 'Best regards,\nThe Bursary Team\n{{universityName}}',
  },
};

export const EmailTemplateConfigPatchSchema = z.object({
  senderName: z.string().trim().min(1).max(120).optional(),
  senderAddress: z.string().trim().email().max(254).optional(),
  replyToAddress: z.string().trim().email().max(254).nullable().optional(),
  portalLoginUrl: z.string().trim().url().max(500).optional(),
  subjectLine: z.string().trim().min(1).max(200).optional(),
  greeting: z.string().trim().min(1).max(200).optional(),
  paragraph: z.string().trim().min(1).max(10000).optional(),
  buttonLabel: z.string().trim().min(1).max(60).optional(),
  forceChangeNotice: z.string().trim().min(1).max(5000).optional(),
  closing: z.string().trim().min(1).max(5000).optional(),
  accentColor: z.string().regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/).nullable().optional(),
});

export type EmailTemplateConfigPatch = z.infer<typeof EmailTemplateConfigPatchSchema>;

function envPortalLoginDefault(): string {
  return process.env.STUDENT_PORTAL_URL || process.env.CORS_ORIGIN || 'http://localhost:5173/login';
}

function envSenderDefaults(): { senderName: string; senderAddress: string; replyToAddress?: string; portalLoginUrl: string } {
  const senderName = process.env.EMAIL_FROM_NAME || EMAIL_TEMPLATE_DEFAULTS.student_credentials.senderName;
  const senderAddress = process.env.EMAIL_FROM_ADDRESS || EMAIL_TEMPLATE_DEFAULTS.student_credentials.senderAddress;
  const replyToAddress = process.env.EMAIL_REPLY_TO_ADDRESS;
  const portalLoginUrl = envPortalLoginDefault();
  return { senderName, senderAddress, replyToAddress, portalLoginUrl };
}

export async function getResolvedTemplateByKey(key: string): Promise<{
  templateKey: string;
  senderName: string;
  senderAddress: string;
  replyToAddress?: string | null;
  portalLoginUrl: string;
  subjectLine: string;
  greeting: string;
  paragraph: string;
  buttonLabel: string;
  forceChangeNotice: string;
  closing: string;
  accentColor?: string | null;
  updatedById?: number | null;
}> {
  const defaults = EMAIL_TEMPLATE_DEFAULTS[key] || EMAIL_TEMPLATE_DEFAULTS.student_credentials;
  const envDefs = envSenderDefaults();

  let row: any = null;
  try {
    row = await prisma.emailTemplateConfig.findUnique({ where: { templateKey: key } });
  } catch (e) {
    row = null;
  }
  if (!row) {
    try {
      row = await prisma.emailTemplateConfig.create({
        data: {
          templateKey: key,
          senderName: envDefs.senderName,
          senderAddress: envDefs.senderAddress,
          replyToAddress: envDefs.replyToAddress || null,
          portalLoginUrl: envDefs.portalLoginUrl,
          subjectLine: defaults.subjectLine,
          greeting: defaults.greeting,
          paragraph: defaults.paragraph,
          buttonLabel: defaults.buttonLabel,
          forceChangeNotice: defaults.forceChangeNotice,
          closing: defaults.closing,
          accentColor: null,
        },
      });
    } catch (e) {
      row = null;
    }
  }
  if (!row) {
    return {
      templateKey: key,
      senderName: envDefs.senderName,
      senderAddress: envDefs.senderAddress,
      replyToAddress: envDefs.replyToAddress || null,
      portalLoginUrl: envDefs.portalLoginUrl,
      subjectLine: defaults.subjectLine,
      greeting: defaults.greeting,
      paragraph: defaults.paragraph,
      buttonLabel: defaults.buttonLabel,
      forceChangeNotice: defaults.forceChangeNotice,
      closing: defaults.closing,
      accentColor: null,
    };
  }
  return {
    templateKey: key,
    senderName: (row.senderName && row.senderName.length ? row.senderName : envDefs.senderName),
    senderAddress: (row.senderAddress && row.senderAddress.length ? row.senderAddress : envDefs.senderAddress),
    replyToAddress: row.replyToAddress ?? envDefs.replyToAddress ?? null,
    portalLoginUrl: (row.portalLoginUrl && row.portalLoginUrl.length ? row.portalLoginUrl : envDefs.portalLoginUrl),
    subjectLine: (row.subjectLine && row.subjectLine.length ? row.subjectLine : defaults.subjectLine),
    greeting: (row.greeting && row.greeting.length ? row.greeting : defaults.greeting),
    paragraph: (row.paragraph && row.paragraph.length ? row.paragraph : defaults.paragraph),
    buttonLabel: (row.buttonLabel && row.buttonLabel.length ? row.buttonLabel : defaults.buttonLabel),
    forceChangeNotice: (row.forceChangeNotice && row.forceChangeNotice.length ? row.forceChangeNotice : defaults.forceChangeNotice),
    closing: (row.closing && row.closing.length ? row.closing : defaults.closing),
    accentColor: row.accentColor || null,
    updatedById: row.updatedById ?? null,
  };
}

export async function updateTemplateByKey(key: string, patch: EmailTemplateConfigPatch, opts?: { updatedById?: number }) {
  const validated = EmailTemplateConfigPatchSchema.parse(patch);
  const data: any = { ...validated };
  if (opts?.updatedById) data.updatedById = opts.updatedById;
  await getResolvedTemplateByKey(key);
  const updated = await prisma.emailTemplateConfig.update({
    where: { templateKey: key },
    data,
  });
  return updated;
}

export function renderPlaceholders(text: string, vars: Record<string, string | number | null | undefined>): string {
  if (!text) return '';
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => {
    const v = (vars as any)[name];
    if (v === null || v === undefined) return '';
    return String(v);
  });
}

export interface StudentCredentialVars {
  studentName: string;
  matricNumber: string;
  email: string;
  temporaryPassword: string;
  universityName?: string;
  universityAddress?: string;
}

export async function renderStudentCredentialEmailHtmlText(
  vars: StudentCredentialVars,
  overrides?: Partial<{
    templateKey: string;
    senderName: string;
    senderAddress: string;
    replyToAddress: string;
    portalLoginUrl: string;
  }>,
): Promise<{ rendered: RenderedEmail; config: ReturnType<typeof getResolvedTemplateByKey> extends Promise<infer T> ? T : never }> {
  const key = overrides?.templateKey || EMAIL_TEMPLATE_KEYS.STUDENT_CREDENTIALS;
  const config = await getResolvedTemplateByKey(key);
  const branding = await buildBranding();

  const universityName = vars.universityName || branding.name;
  const mergedVars: Record<string, string> = {
    studentName: vars.studentName,
    matricNumber: vars.matricNumber,
    email: vars.email,
    universityName,
  };

  const portalLoginUrl = overrides?.portalLoginUrl || config.portalLoginUrl || envPortalLoginDefault();
  const greeting = renderPlaceholders(config.greeting, mergedVars);
  const paragraph = renderPlaceholders(config.paragraph, mergedVars);
  const forceNotice = renderPlaceholders(config.forceChangeNotice, mergedVars);
  const closing = renderPlaceholders(config.closing, mergedVars).replace(/\n/g, '<br>');
  const closingText = renderPlaceholders(config.closing, mergedVars);
  const subject = renderPlaceholders(config.subjectLine, mergedVars);
  const btnLabel = renderPlaceholders(config.buttonLabel, mergedVars) || 'Access Student Portal';
  const btn = buttonLink(portalLoginUrl, btnLabel, config.accentColor || undefined);

  const bodyHtml = `
<p>${greeting}</p>
<p>${paragraph}</p>
<table cellpadding="8" cellspacing="0" border="1" bordercolor="#e0e0e0" style="border-collapse:collapse;margin:16px 0;">
<tr><td style="background:#f0f0f0;"><strong>Matric Number</strong></td><td>${vars.matricNumber}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Email</strong></td><td>${vars.email}</td></tr>
<tr><td style="background:#f0f0f0;"><strong>Temporary Password</strong></td><td>${vars.temporaryPassword}</td></tr>
</table>
<p style="margin:20px 0;">${btn.html}</p>
<p style="color:#b91c1c;"><strong>${forceNotice}</strong></p>
<p style="white-space:pre-line;line-height:1.6;">${closing}</p>
  `.trim();

  const bodyText =
    `${greeting}\n\n` +
    `${paragraph}\n\n` +
    `Matric Number: ${vars.matricNumber}\n` +
    `Email: ${vars.email}\n` +
    `Temporary Password: ${vars.temporaryPassword}\n\n` +
    `${btn.text}\n\n` +
    `${forceNotice}\n\n` +
    closingText;

  const wrapped = wrapEmail(bodyHtml, bodyText, config.accentColor || undefined);
  const rendered: RenderedEmail = { subject, html: wrapped.html, text: wrapped.text };
  return { rendered, config: config as any };
}

export function sanitizeEmailPayload(payload: Record<string, any>): {
  studentName?: string | null;
  matricNumber?: string | null;
  emailDomain?: string | null;
  hasTemporaryPassword: boolean;
  emailType?: string | null;
} {
  const p = payload || {};
  const out: any = {};
  if (typeof p.studentName === 'string') out.studentName = p.studentName.slice(0, 40);
  else if (typeof p.firstName === 'string' || typeof p.lastName === 'string') {
    out.studentName = `${p.firstName || ''} ${p.lastName || ''}`.trim().slice(0, 40) || null;
  }
  if (typeof p.matricNumber === 'string') out.matricNumber = p.matricNumber.slice(0, 40);
  if (typeof p.email === 'string') {
    const at = p.email.lastIndexOf('@');
    out.emailDomain = at >= 0 ? p.email.slice(at + 1) : null;
  }
  out.hasTemporaryPassword = !!(typeof p.temporaryPassword === 'string' && p.temporaryPassword.length > 0);
  if (typeof p.emailType === 'string') out.emailType = p.emailType.slice(0, 40);
  return out;
}

export const EmailTemplateService = {
  getByKey: getResolvedTemplateByKey,
  updateByKey: updateTemplateByKey,
  renderStudentCredentialEmailHtmlText,
  sanitizeEmailPayload,
  renderPlaceholders,
};

export default EmailTemplateService;
