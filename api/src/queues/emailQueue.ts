import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createBullmqProducerConnection, createBullmqWorkerConnection } from '../config/redis';
import { JobTopic } from '../config/queue';
import prisma from '../config/database';
import {
  sendEmail,
  renderPaymentSuccessful,
  renderPaymentInitiated,
  renderPaymentFailed,
  renderPaymentReversed,
  renderRefundStatusChanged,
  renderPasswordReset,
  renderPaymentReminder,
  renderStudentBillAssigned,
  renderStudentAccountCreatedConfigurable,
} from '../services/email';
import { sanitizeEmailPayload, getResolvedTemplateByKey } from '../services/emailTemplate';
import { EmailProviderType, EmailDeliveryStatus, EmailType } from '@prisma/client';
import { selectEmailProvider, hasResendConfigured, hasSmtpConfigured } from '../services/emailProviders';

export const queueCaptures: any[] = [];

const _seen = new Set<string>();

export function clearCapturesForTests(): void {
  queueCaptures.length = 0;
  _seen.clear();
}

let _emailQueue: Queue | null = null;
let _emailProducerRedis: InstanceType<typeof Redis> | null = null;
let _emailWorkerRedis: InstanceType<typeof Redis> | null = null;
let _emailWorker: Worker | null = null;

function ensureQueue(): Queue | null {
  if (_emailQueue) return _emailQueue;
  // Build an email-private PRODUCER Redis with short commandTimeout so user
  // flows fail fast and fall back to inlineFallbackSend if Redis is stuck.
  // Reuses env REDIS_URL including the /2 db path — matches other queues.
  try {
    if (!_emailProducerRedis) {
      const LAZY = process.env.REDIS_LAZY_CONNECT === 'true' || process.env.QUEUE_DISABLE_WORKERS === 'true' || process.env.NODE_ENV === 'test';
      _emailProducerRedis = createBullmqProducerConnection({
        maxRetriesPerRequest: LAZY ? 0 : 1,
        enableReadyCheck: !LAZY,
        connectTimeout: LAZY ? 400 : 1500,
        commandTimeout: LAZY ? 600 : 2000,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      if (!LAZY) {
        _emailProducerRedis.connect().catch(() => { /* inline fallback handles Redis down */ });
      }
    }
    const q = new Queue('emails', {
      connection: _emailProducerRedis,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: { count: 5 },
      },
    });
    _emailQueue = q;
    return q;
  } catch {
    return null;
  }
}

function resolveProviderType(forceSmtp?: boolean): EmailProviderType {
  if (forceSmtp) {
    return hasSmtpConfigured() ? EmailProviderType.SMTP : EmailProviderType.MOCK;
  }
  if (hasResendConfigured()) return EmailProviderType.RESEND;
  if (hasSmtpConfigured()) return EmailProviderType.SMTP;
  return EmailProviderType.MOCK;
}

function normalizeEmailType(t: string): EmailType {
  switch (String(t).toUpperCase().replace(/[^A-Z_]/g, '_')) {
    case 'STUDENT_CREDENTIALS':
    case 'STUDENT_ACCOUNT_CREATED':
      return EmailType.STUDENT_CREDENTIALS;
    case 'PASSWORD_RESET':
      return EmailType.PASSWORD_RESET;
    case 'PAYMENT_SUCCESSFUL':
    case 'PAYMENT_SUCCESS':
      return EmailType.PAYMENT_SUCCESSFUL;
    case 'FEE_ASSIGNED':
    case 'FEE_ASSIGNMENT':
      return EmailType.FEE_ASSIGNED;
    case 'BILL_CREATED':
      return EmailType.BILL_CREATED;
    case 'REFUND_REQUESTED':
      return EmailType.REFUND_REQUESTED;
    case 'REFUND_APPROVED':
      return EmailType.REFUND_APPROVED;
    case 'REFUND_REJECTED':
      return EmailType.REFUND_REJECTED;
    default:
      return EmailType.OTHER;
  }
}

export interface DispatchEmailArgs {
  emailType: string;
  recipientId?: number | string;
  reference?: string;
  to: string;
  payload: any;
  idempotencyKey?: string;
  triggeredByAdminId?: number;
  studentImportId?: number;
  forceSmtp?: boolean;
}

async function createPendingDeliveryLog(
  args: DispatchEmailArgs,
  idempotencyKey: string,
  provider: EmailProviderType,
): Promise<bigint | null> {
  try {
    const emailType = normalizeEmailType(args.emailType);
    const summary = sanitizeEmailPayload({ ...(args.payload || {}), emailType: args.emailType });
    const recipientIdNum = args.recipientId !== undefined && args.recipientId !== null
      ? Number(args.recipientId)
      : null;
    const row = await prisma.emailDeliveryLog.create({
      data: {
        emailType,
        toAddress: String(args.to).slice(0, 254),
        recipientId: Number.isFinite(recipientIdNum) && recipientIdNum !== null ? recipientIdNum : null,
        triggeredByAdminId: args.triggeredByAdminId ?? null,
        studentImportId: args.studentImportId ?? null,
        idempotencyKey: idempotencyKey.slice(0, 128),
        provider,
        status: EmailDeliveryStatus.PENDING,
        attempts: 0,
        payloadSummary: summary as any,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err: any) {
    try { console.warn('[emailQueue] createPendingDeliveryLog failed:', err?.code || err?.message || String(err).slice(0, 120)); } catch {}
    return null;
  }
}

export async function dispatchEmail(args: DispatchEmailArgs): Promise<void> {
  const { emailType, recipientId, reference, to, payload } = args;
  const idempotencyKey =
    args.idempotencyKey ?? `${emailType}:${reference || 'noref'}:${recipientId || to}`;

  if (process.env.NODE_ENV === 'test') {
    if (_seen.has(idempotencyKey)) {
      return;
    }
    _seen.add(idempotencyKey);
    queueCaptures.push({
      idempotencyKey,
      emailType,
      recipientId,
      reference,
      to,
      payload,
      at: new Date().toISOString(),
    });
    return;
  }

  const provider = resolveProviderType(Boolean(args.forceSmtp));
  await createPendingDeliveryLog(args, idempotencyKey, provider);

  try {
    const q = ensureQueue();
    if (q) {
      await q.add(
        'dispatch',
        { emailType, recipientId, reference, to, payload, logIdempotencyKey: idempotencyKey, forceSmtp: Boolean(args.forceSmtp) },
        {
          jobId: idempotencyKey,
          removeOnComplete: true,
          removeOnFail: { count: 5 },
        },
      );
      return;
    }
    // BullMQ unavailable → inline fallback with 3 retries via setTimeout sync call.
    // Use process.nextTick to avoid blocking the HTTP create flow.
    process.nextTick(() => {
      inlineFallbackSend({
        emailType,
        recipientId,
        reference,
        to,
        payload,
        logIdempotencyKey: idempotencyKey,
        forceSmtp: Boolean(args.forceSmtp),
        attempt: 0,
      });
    });
  } catch (err) {
    try { console.warn('[emailQueue] enqueue failed, fallback inline send:', (err as Error)?.message?.slice(0, 120)); } catch {}
    process.nextTick(() => {
      inlineFallbackSend({
        emailType,
        recipientId,
        reference,
        to,
        payload,
        logIdempotencyKey: idempotencyKey,
        forceSmtp: Boolean(args.forceSmtp),
        attempt: 0,
      });
    });
  }
}

const MAX_ATTEMPTS = 3;

async function updateLogStatusByKey(idempotencyKey: string, patch: {
  status: EmailDeliveryStatus;
  attempts?: number;
  lastError?: string | null;
  resendMessageId?: string | null;
  smtpMessageId?: string | null;
  retryAfter?: Date | null;
}): Promise<void> {
  try {
    const trimmed = idempotencyKey.slice(0, 128);
    const data: any = {
      status: patch.status,
    };
    if (patch.attempts !== undefined) data.attempts = patch.attempts;
    if (patch.lastError !== undefined) data.lastError = patch.lastError ? String(patch.lastError).slice(0, 2000) : null;
    if ('resendMessageId' in patch) data.resendMessageId = patch.resendMessageId || null;
    if ('smtpMessageId' in patch) data.smtpMessageId = patch.smtpMessageId ? String(patch.smtpMessageId).slice(0, 400) : null;
    if ('retryAfter' in patch) data.retryAfter = patch.retryAfter ?? null;
    await prisma.emailDeliveryLog.updateMany({
      where: { idempotencyKey: trimmed },
      data,
    });
  } catch (e: any) {
    try { console.warn('[emailQueue] updateLogStatusByKey:', e?.code || e?.message?.slice(0, 120)); } catch {}
  }
}

async function renderByEmailType(
  emailTypeRaw: string,
  payload: any,
): Promise<{ rendered: ReturnType<typeof renderPaymentSuccessful>; senderName?: string; senderAddress?: string; replyToAddress?: string }> {
  const emailType = String(emailTypeRaw).toUpperCase();
  const p = payload || {};

  if (emailType === 'STUDENT_CREDENTIALS' || emailType === 'STUDENT_ACCOUNT_CREATED') {
    const out = await renderStudentAccountCreatedConfigurable({
      studentName: p.studentName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Student',
      matricNumber: p.matricNumber || '',
      email: p.email || '',
      temporaryPassword: p.temporaryPassword || '',
    }, { templateKey: p.templateKey || 'student_credentials' });
    return {
      rendered: out.rendered,
      senderName: out.senderName,
      senderAddress: out.senderAddress,
      replyToAddress: out.replyToAddress ? String(out.replyToAddress) : undefined,
    };
  }
  if (emailType === 'PAYMENT_SUCCESSFUL' || emailType === 'PAYMENT_SUCCESS') {
    return {
      rendered: renderPaymentSuccessful({
        studentName: p.studentName,
        feeName: p.feeName,
        amountNgnNumber: Number(p.amountNgnNumber ?? p.amount ?? 0),
        reference: p.reference,
        receiptNumber: p.receiptNumber,
        receiptDownloadUrl: p.receiptDownloadUrl,
      }),
    };
  }
  if (emailType === 'PAYMENT_INITIATED') {
    return {
      rendered: renderPaymentInitiated({
        studentName: p.studentName,
        feeName: p.feeName,
        amountNgnNumber: Number(p.amountNgnNumber ?? p.amount ?? 0),
        reference: p.reference,
      }),
    };
  }
  if (emailType === 'PAYMENT_FAILED') {
    return {
      rendered: renderPaymentFailed({
        studentName: p.studentName,
        reference: p.reference,
        attemptDate: p.attemptDate || new Date().toISOString(),
      }),
    };
  }
  if (emailType === 'PAYMENT_REVERSED') {
    return {
      rendered: renderPaymentReversed({
        studentName: p.studentName,
        reference: p.reference,
        amountNgnNumber: Number(p.amountNgnNumber ?? p.amount ?? 0),
        reversedAt: p.reversedAt || new Date().toISOString(),
      }),
    };
  }
  if (emailType === 'REFUND_REQUESTED' || emailType === 'REFUND_APPROVED' || emailType === 'REFUND_REJECTED' || emailType === 'REFUND_STATUS') {
    return {
      rendered: renderRefundStatusChanged({
        studentName: p.studentName,
        reference: p.reference,
        refundStatus: p.refundStatus || emailType.replace('REFUND_', ''),
        amountNgnNumber: Number(p.amountNgnNumber ?? p.amount ?? 0),
      }),
    };
  }
  if (emailType === 'PASSWORD_RESET') {
    return {
      rendered: renderPasswordReset({
        userFirstname: p.userFirstname || p.firstName || p.studentName || 'User',
        resetUrl: p.resetUrl,
        expiresMinutes: Number(p.expiresMinutes || 60),
      }),
    };
  }
  if (emailType === 'PAYMENT_REMINDER') {
    return {
      rendered: renderPaymentReminder({
        studentName: p.studentName,
        feeName: p.feeName,
        amountNgnNumber: Number(p.amountNgnNumber ?? p.amount ?? 0),
        dueDate: p.dueDate || new Date().toISOString(),
        invoiceUrl: p.invoiceUrl,
        daysLeft: Number(p.daysLeft ?? 0),
      }),
    };
  }
  if (emailType === 'BILL_CREATED' || emailType === 'FEE_ASSIGNED' || emailType === 'STUDENT_BILL_ASSIGNED') {
    return {
      rendered: renderStudentBillAssigned({
        student: p.student,
        fee: p.fee,
        invoice: p.invoice,
        assignment: p.assignment,
        noteToStudent: p.noteToStudent ?? null,
      }),
    };
  }
  // OTHER / FALLBACK: minimal generic notification
  const subject = p.subject || 'Notification from the University';
  const body = p.body || p.message || 'You have a new notification. Please log in to the portal.';
  const url = p.url || '';
  const rendered = {
    subject,
    html: `<p>${String(body).replace(/\n/g, '<br>')}</p>` + (url ? `<p><a href="${url}">${url}</a></p>` : ''),
    text: `${body}${url ? `\n\nLink: ${url}` : ''}`,
  };
  return { rendered };
}

function backoffDelayMs(attempt: number): number {
  const n = Math.min(Math.max(0, attempt), 5);
  return Math.min(60_000, 1000 * Math.pow(2, n));
}

type InlineArgs = {
  emailType: string;
  recipientId?: number | string;
  reference?: string;
  to: string;
  payload: any;
  logIdempotencyKey: string;
  forceSmtp: boolean;
  attempt: number;
};

async function inlineFallbackSend(args: InlineArgs): Promise<void> {
  try {
    await attemptDeliveryOnce({
      emailType: args.emailType,
      to: args.to,
      payload: args.payload,
      logIdempotencyKey: args.logIdempotencyKey,
      forceSmtp: args.forceSmtp,
      currentAttempt: args.attempt,
      scheduleRetry: (nextAttempt, delayMs, retryAfter) => {
        setTimeout(() => {
          inlineFallbackSend({ ...args, attempt: nextAttempt });
        }, delayMs);
        void retryAfter;
      },
    });
  } catch (err: any) {
    try { console.warn('[emailQueue] inlineFallbackSend fatal:', err?.message?.slice(0, 120)); } catch {}
  }
}

type ScheduleRetry = (nextAttempt: number, delayMs: number, retryAfter: Date) => void;

async function attemptDeliveryOnce(opts: {
  emailType: string;
  to: string;
  payload: any;
  logIdempotencyKey: string;
  forceSmtp: boolean;
  currentAttempt: number;
  scheduleRetry?: ScheduleRetry;
}): Promise<'sent' | 'retrying' | 'failed'> {
  const { emailType, to, payload, logIdempotencyKey, forceSmtp, currentAttempt } = opts;
  let renderedResult;
  try {
    renderedResult = await renderByEmailType(emailType, payload);
  } catch (renderErr: any) {
    const msg = `render failed: ${String(renderErr?.message || renderErr).slice(0, 1800)}`;
    await updateLogStatusByKey(logIdempotencyKey, {
      status: EmailDeliveryStatus.FAILED,
      attempts: currentAttempt + 1,
      lastError: msg,
      retryAfter: null,
    });
    return 'failed';
  }
  const provider = selectEmailProvider(forceSmtp);
  let from = { name: 'University Bursary', address: 'noreply@university.edu.ng' };
  let replyTo: string | undefined;
  try {
    const tmpl = await getResolvedTemplateByKey('student_credentials');
    from = { name: renderedResult.senderName || tmpl.senderName, address: renderedResult.senderAddress || tmpl.senderAddress };
    replyTo = renderedResult.replyToAddress ?? (tmpl.replyToAddress ? String(tmpl.replyToAddress) : undefined);
  } catch {
    if (renderedResult.senderName && renderedResult.senderAddress) {
      from = { name: renderedResult.senderName, address: renderedResult.senderAddress };
      replyTo = renderedResult.replyToAddress;
    }
  }

  try {
    const result = await sendEmail({
      to,
      rendered: renderedResult.rendered,
      forceSmtp,
      fromOverride: from,
      replyToOverride: replyTo,
    } as any);

    const nextAttemptCount = currentAttempt + 1;
    if (result?.success) {
      const patch: any = {
        status: EmailDeliveryStatus.SENT,
        attempts: nextAttemptCount,
        lastError: null,
        retryAfter: null,
      };
      if (result.provider === 'resend' && result.messageId) patch.resendMessageId = result.messageId;
      if (result.provider === 'smtp' && result.messageId) patch.smtpMessageId = result.messageId;
      await updateLogStatusByKey(logIdempotencyKey, patch);
      return 'sent';
    }

    const errMsg = (result?.error || 'provider returned success=false').slice(0, 2000);
    if (nextAttemptCount < MAX_ATTEMPTS && opts.scheduleRetry) {
      const delay = backoffDelayMs(currentAttempt);
      const retryAfter = new Date(Date.now() + delay);
      await updateLogStatusByKey(logIdempotencyKey, {
        status: EmailDeliveryStatus.RETRIED,
        attempts: nextAttemptCount,
        lastError: errMsg,
        retryAfter,
      });
      opts.scheduleRetry(nextAttemptCount, delay, retryAfter);
      return 'retrying';
    }
    // Max attempts reached → FAILED
    await updateLogStatusByKey(logIdempotencyKey, {
      status: EmailDeliveryStatus.FAILED,
      attempts: nextAttemptCount,
      lastError: errMsg,
      retryAfter: null,
    });
    return 'failed';
  } catch (sendErr: any) {
    const nextAttemptCount = currentAttempt + 1;
    const errMsg = String(sendErr?.message || sendErr).slice(0, 2000);
    if (nextAttemptCount < MAX_ATTEMPTS && opts.scheduleRetry) {
      const delay = backoffDelayMs(currentAttempt);
      const retryAfter = new Date(Date.now() + delay);
      await updateLogStatusByKey(logIdempotencyKey, {
        status: EmailDeliveryStatus.RETRIED,
        attempts: nextAttemptCount,
        lastError: errMsg,
        retryAfter,
      });
      opts.scheduleRetry(nextAttemptCount, delay, retryAfter);
      return 'retrying';
    }
    await updateLogStatusByKey(logIdempotencyKey, {
      status: EmailDeliveryStatus.FAILED,
      attempts: nextAttemptCount,
      lastError: errMsg,
      retryAfter: null,
    });
    return 'failed';
  }
}

function createWorker(): Worker | null {
  if (process.env.NODE_ENV === 'test' || process.env.QUEUE_DISABLE_WORKERS === 'true') {
    return null;
  }
  try {
    // BullMQ Worker REQUIRES maxRetriesPerRequest = null (emits warning
    // otherwise every blocking BRPOP) — and MUST NOT have a commandTimeout
    // because BRPOP commands are *supposed* to block for 30s by default.
    // Use a dedicated worker Redis client, NEVER the producer/singleton.
    if (!_emailWorkerRedis) {
      _emailWorkerRedis = createBullmqWorkerConnection({
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      _emailWorkerRedis.connect().catch(() => { /* worker retries via its own events */ });
    }
    const worker = new Worker('emails', async (job) => {
      const { emailType, to, payload, logIdempotencyKey, forceSmtp } = job.data || {};
      const currentAttempt = (job.attemptsMade as number) || 0;
      await attemptDeliveryOnce({
        emailType,
        to,
        payload,
        logIdempotencyKey: logIdempotencyKey || `${emailType}:${job.id}`,
        forceSmtp: Boolean(forceSmtp),
        currentAttempt,
      });
    }, {
      connection: _emailWorkerRedis,
      concurrency: 4,
      attempts: MAX_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    } as any);
    worker.on('failed', (job, err) => {
      try { console.error('[emailQueue] worker failed jobId=', job?.id, ':', err?.message?.slice(0, 120) ?? String(err).slice(0, 120)); } catch {}
    });
    _emailWorker = worker;
    return worker;
  } catch {
      return null;
  }
}

let _workerRef = createWorker();
void _workerRef;

/**
 * Graceful shutdown hook for the email worker + its two Redis connections.
 * Idempotent, never throws. Called on SIGTERM/SIGINT in server.ts.
 */
export async function shutdownEmailQueue(): Promise<void> {
  // (1) worker first — so new jobs stop being pulled mid-close.
  if (_emailWorker) {
    const w = _emailWorker;
    _emailWorker = null;
    try { await w.close(); } catch { /* ignore */ }
  }

  // (2) queue producer
  if (_emailQueue) {
    const q = _emailQueue;
    _emailQueue = null;
    try { await q.close(); } catch { /* ignore */ }
  }

  // (3) worker redis
  if (_emailWorkerRedis) {
    const c = _emailWorkerRedis;
    _emailWorkerRedis = null;
    try { await c.quit(); } catch { try { c.disconnect(false); } catch { /* ignore */ } }
  }

  // (4) producer redis (email-private producer — separate from shared singleton)
  if (_emailProducerRedis) {
    const c = _emailProducerRedis;
    _emailProducerRedis = null;
    try { await c.quit(); } catch { try { c.disconnect(false); } catch { /* ignore */ } }
  }
}

export const EMAIL_TOPIC: JobTopic = 'email.send';
