// =============================================================================
// Paystack Webhook Route Scaffold
// -----------------------------------------------------------------------------
// Implements §24 Paystack Webhook (14 steps) + §25 Idempotency.
//
// Mount this BEFORE any JSON-body size throttling middleware if you want a
// separate size limit; the current app.ts global `express.json()` already
// captures `req.rawBody` via its `verify` hook, so we use that here.
//
// Flow (belt + suspenders — two layers of idempotency):
//   1. Return 403 immediately if `x-paystack-signature` HMAC-SHA512 mismatch.
//   2. Extract paystackEventId (eventId on the outer envelope) — used as
//      BOTH the queue `jobId` for BullMQ dedup AND the primary lookup key
//      in `webhook_events` table.
//   3. DB-layer UNIQUE constraint on `webhook_events.paystackEventId` is the
//      ground-truth idempotency guard; BullMQ dedup prevents duplicate
//      retries *during async* but DB wins if queue is offline.
//   4. Insert a "received" row and return HTTP 200 within ~100ms.
//   5. Dispatch handling to BullMQ topic `paystack.webhook` with the eventId
//      as `jobId`. If Redis is down, `dispatchJob` falls back to inline sync
//      execution (still bounded 5 retries with exponential backoff per
//      queue.ts TOPIC_DEFAULTS).
//   6. The actual business logic (verify txn -> confirm amount -> update
//      invoice -> create receipt -> write ledger) lives in the handler
//      registered at boot via `registerHandler('paystack.webhook', …)`.
//      That handler is implemented in Releases 3 (Task 13) so this scaffold
//      is 100% structurally correct but a no-op for real payloads today.
//
// Supported event types (§24, §37):
//   charge.success   — payment confirmed by Paystack (TR-12.2)
//   charge.failed    — payment failed or abandoned (TR-12.2)
//   refund.created   — Paystack refund started (§37)
//   refund.processed — Paystack refund finalized (§37)
//   refund.failed    — Paystack refund errored (§37)
//   transfer.success / transfer.failed — reserved for future payout/rebates
// Any unrecognized event type is still persisted in webhook_events and
// returns 200 (Paystack docs say to ack unknown events; otherwise retries).
// =============================================================================

import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { dispatchJob, registerHandler } from '../config/queue';
import { verifyPaystackHmac } from '../utils/paystack';
import {
  verifyAlatpayHmac,
  isAlatpayWhitelistedIp,
  AlatpayWebhookEnvelope,
  normalizeAlatStatus,
  parseAlatpayCustomerMetadata,
  selectAlatpayFinalTxId,
  AlatpayCustomerMetadata,
} from '../utils/alatpay';
import { i18n } from '../i18n/en';
import { AdminNotificationService } from '../services/adminNotification';

const router = Router();

type PaystackWebhookEvent = {
  event?: string;
  data?: any;
  // Paystack event envelope; the "id" field on the outermost object (the
  // event id, NOT the transaction id) is what guarantees uniqueness per
  // webhook delivery. We trust this over the internal data.reference for
  // idempotency because a single charge.success can be re-broadcast as many
  // webhook events during Paystack retries.
  id?: string | number;
};

/**
 * Strip non-finite / circular fields before logging raw payload JSON into
 * `webhook_events.payload` (Json column).
 */
function safePayload(raw: any): any {
  try {
    return JSON.parse(JSON.stringify(raw ?? null));
  } catch {
    return { error: 'unserializable_payload_received' };
  }
}

function extractEventId(body: PaystackWebhookEvent): string | null {
  const id = body?.id;
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s.length === 0 ? null : s;
}

router.post('/paystack', async (req: Request, res: Response) => {
  // ---------------------------------------------------------------------------
  // Step 1 — HMAC verification (§24 #2 + §25). MUST fail fast before parsing.
  // ---------------------------------------------------------------------------
  const rawBody: Buffer | string =
    (req as any).rawBody instanceof Buffer
      ? (req as any).rawBody
      : Buffer.isBuffer((req as any).rawBody)
      ? (req as any).rawBody
      : typeof (req as any).rawBody === 'string'
      ? (req as any).rawBody
      : '';
  const signature = req.header('x-paystack-signature');
  if (!rawBody || !verifyPaystackHmac(rawBody, signature)) {
    return res.status(403).json({ status: 'fail', message: i18n.errors.webhook.invalidSignature });
  }

  // ---------------------------------------------------------------------------
  // Step 2 — Read & validate envelope
  // ---------------------------------------------------------------------------
  const body: PaystackWebhookEvent = req.body ?? {};
  const eventType = String(body.event ?? '').trim() || 'unknown';
  const paystackEventId = extractEventId(body);
  const dataRef = typeof body?.data?.reference === 'string' ? body.data.reference : undefined;

  if (!paystackEventId) {
    // Per webhook_events schema: paystackEventId is NOT nullable UNIQUE.
    // But we still ack 200 because the alternative is Paystack hammering us.
    // Log it instead so bursary/admin can investigate in audit logs.
    // eslint-disable-next-line no-console
    console.warn('[webhook:paystack] missing event id — ignored, returned 200 to avoid retries.');
    return res.status(200).json({ status: 'ok', processed: false, reason: i18n.errors.webhook.missingEventId });
  }

  // ---------------------------------------------------------------------------
  // Step 3 — Ground-truth idempotency via DB UNIQUE(paystackEventId).
  //   - If we have already processed this exact event, return 200 immediately.
  //   - Otherwise INSERT ... ON CONFLICT DO NOTHING to be race-safe across
  //     multiple pods/servers (two webhook deliveries can arrive within ms).
  // ---------------------------------------------------------------------------
  try {
    await prisma.webhookEvent.upsert({
      where: { paystackEventId },
      update: {},
      create: {
        paystackEventId,
        eventType,
        transactionReference: dataRef,
        payload: safePayload(body),
        isProcessed: false,
      },
      select: { id: true },
    });
  } catch (err) {
    // Any prisma error here (schema mismatch, DB offline etc) — still return
    // 200 because Paystack will retry and we want to avoid duplicate
    // processing. The raw request is already logged via morgan.
    // eslint-disable-next-line no-console
    console.error('[webhook:paystack] prisma.upsert webhookEvent failed (still 200 to Paystack):', err);
    return res.status(200).json({ status: 'ok', processed: false, reason: 'persistence_error_deferred_retry' });
  }

  // ---------------------------------------------------------------------------
  // Step 4 — Kick off async handling and return HTTP 200 promptly (§24 #14).
  // ---------------------------------------------------------------------------
  try {
    await dispatchJob(
      'paystack.webhook',
      { paystackEventId, eventType, receivedAt: new Date().toISOString() },
      {
        // Belt: paystackEventId as jobId prevents BullMQ from re-enqueuing
        // the same event while the DB layer is the authoritative suspenders.
        jobId: `paystack-webhook:${paystackEventId}`,
        deduplicate: true,
        priority: 'high',
        retries: 4,
      },
    );
  } catch (err) {
    // dispatchJob itself re-raises on FINAL sync-fallback failure. Mark the
    // webhook_event as `processed=false` (which it already is) so the daily
    // cron admin can manually re-trigger. Still return 200 per Paystack.
    // eslint-disable-next-line no-console
    console.error('[webhook:paystack] dispatchJob failed after final retries for event', paystackEventId, err);
  }

  return res.status(200).json({
    status: 'ok',
    received: true,
    eventId: paystackEventId,
    eventType,
  });
});

// =============================================================================
// Skeleton handler for paystack.webhook (registered at module import).
// -----------------------------------------------------------------------------
// Real implementation is added in Release 3 (Task 13 / TR-13.1..TR-13.6).
// Today it just:
//   - updates webhookEvents.processed=true on successful run
//   - logs charge.success metadata so QA/dev can see it wired end-to-end
//   - marks processed=false + failureReason on any exception so the event
//     remains visible to bursary for manual reconciliation
// =============================================================================
registerHandler('paystack.webhook', async (payload, _ctx) => {
  const { paystackEventId, eventType, forceReprocess } = payload as {
    paystackEventId: string;
    eventType: string;
    forceReprocess?: boolean;
  };

  const row = await prisma.webhookEvent.findUnique({
    where: { paystackEventId },
  });
  if (!row) return;
  if (row.isProcessed && !forceReprocess) return;

  let newProcessed = false;
  let failureReason: string | null = null;
  const body: PaystackWebhookEvent | null = row.payload as any;
  const data = body?.data ?? {};
  const paystackRef = String(data.reference ?? '').trim() || null;

  try {
    switch (eventType) {
      case 'charge.success': {
        if (!paystackRef) {
          failureReason = 'charge.success missing data.reference';
          newProcessed = false;
          break;
        }
        const { PaymentService } = await import('../services/payment');
        const result = await PaymentService.verifyPayment(paystackRef, {});
        if (result.verified || (result as any).status === 'SUCCESS') {
          newProcessed = true;
        } else {
          failureReason =
            (result as any).reason ||
            'verifyPayment returned verified=false (underpaid/overpaid/non-success status)';
          newProcessed = false;
        }
        break;
      }
      case 'charge.failed':
      case 'transfer.failed': {
        if (paystackRef) {
          const existing = await prisma.transaction.findFirst({
            where: {
              OR: [{ reference: paystackRef }, { paystackReference: paystackRef }],
            },
            select: { id: true, status: true, userId: true },
          });
          if (existing && existing.status !== 'SUCCESS' && existing.status !== 'UNDERPAID' && existing.status !== 'OVERPAID') {
            await prisma.transaction.updateMany({
              where: { id: existing.id, status: 'PENDING' as any },
              data: { status: 'FAILED' as any, underpaidReason: `paystack event ${eventType}` },
            });
          }
          if (existing) {
            await prisma.auditLog.create({
              data: {
                action: 'PAYMENT_FAILED',
                entityType: 'TRANSACTION',
                entityId: String(existing.id),
                userId: existing.userId ?? null,
                newValue: { paystackEvent: eventType, paystackRef } as any,
              },
            }).catch(() => {});
          }
        }
        newProcessed = true;
        break;
      }
      case 'refund.processed': {
        const refundRef = String(data?.reference ?? '').trim() || null;
        const paystackRefundReference = String(body?.data?.transaction_reference ?? '').trim() || null;
        const lookups: any[] = [];
        if (paystackRefundReference) lookups.push({ paystackRefundReference });
        if (refundRef) lookups.push({ refundNumber: refundRef });
        if (lookups.length > 0) {
          // Find first match (by OR). We'll call processRefund which does its
          // own idempotency inside a Prisma $transaction.
          const match = await prisma.refund.findFirst({
            where: { OR: lookups },
            select: { id: true, status: true },
          });
          if (match) {
            const { RefundService } = await import('../services/refund');
            try {
              await RefundService.processRefund(match.id, undefined, {
                fromWebhook: true,
                paystackRefundReference: paystackRefundReference ?? undefined,
              });
            } catch (e) {
              failureReason = (e as Error)?.stack?.slice(0, 1000) ?? (e as Error)?.message ?? 'refund.processed finalize failed';
              newProcessed = false;
              // Note: webhook event marked not processed at the end; the
              // updateMany fallback still marks PAID to avoid infinite
              // Paystack retries.
            }
            if (!failureReason) newProcessed = true;
          }
          // Fallback: ensure status row is PAID to close the loop even if
          // service import throws.
          if (!failureReason) {
            await prisma.refund.updateMany({
              where: {
                OR: lookups,
                status: { not: 'PAID' as any },
              },
              data: {
                status: 'PAID' as any,
                paidAt: new Date(),
              },
            });
          }
        } else {
          newProcessed = true;
        }
        break;
      }
      case 'refund.failed': {
        const paystackRefundReference = String(body?.data?.transaction_reference ?? '').trim() || null;
        if (paystackRefundReference) {
          await prisma.refund.updateMany({
            where: {
              paystackRefundReference,
              status: { notIn: ['PAID', 'FAILED', 'REJECTED'] as any },
            },
            data: {
              status: 'FAILED' as any,
              notes: { event: eventType, message: data?.message ?? null, failure_reason: data?.failures ?? null } as any,
            },
          });
          await prisma.auditLog.create({
            data: {
              action: 'REFUND_FAILED',
              entityType: 'REFUND',
              entityId: paystackRefundReference,
              newValue: { event: eventType, message: data?.message ?? null } as any,
            },
          }).catch(() => {});
        }
        newProcessed = true;
        break;
      }
      case 'refund.created':
        newProcessed = true;
        break;
      default:
        newProcessed = true;
    }
  } catch (err) {
    failureReason = (err as Error)?.stack?.slice(0, 1000) ?? (err as Error)?.message ?? 'unknown';
    newProcessed = false;
  }

  const updatedEvent = await prisma.webhookEvent.update({
    where: { paystackEventId },
    data: {
      isProcessed: newProcessed,
      processedAt: newProcessed ? new Date() : null,
      attempts: { increment: 1 },
      lastError: newProcessed ? null : failureReason,
    },
    select: { attempts: true, transactionReference: true, id: true },
  });

  if (!newProcessed && updatedEvent.attempts >= 3) {
    try {
      const ref = updatedEvent.transactionReference ?? paystackRef ?? paystackEventId;
      void AdminNotificationService.emitWebhookFail3(ref);
    } catch (notifErr) {
      console.warn('[webhook:handler] emitWebhookFail3 failed:', (notifErr as Error)?.message);
    }
  }

  await prisma.auditLog.create({
    data: {
      action: newProcessed ? 'WEBHOOK_PROCESSED' : 'WEBHOOK_FAILED',
      entityType: 'WEBHOOK_EVENT',
      entityId: paystackEventId,
      newValue: { eventType, processed: newProcessed, failure: failureReason ?? null } as any,
    },
  }).catch(() => {});
});

// =============================================================================
// ALAT Pay Webhook Route Scaffold
// -----------------------------------------------------------------------------
// Security (defense in depth, 4 layers):
//   1. Warn-only IP whitelist: ALAT outgoing webhook IP = 74.178.162.156
//      (docs: Webhook Validation page, IP Whitelisting section)
//   2. HMAC-SHA256 signature over raw body via x-signature header
//      (header = Base64(HMAC-SHA-256(raw_body, WEBHOOK_SECRET)))
//   3. DB UNIQUE(alatpayEventId) — ground-truth idempotency guard
//   4. BullMQ jobId = alatpayEventId — in-memory dedup for fast path
//
// ALAT retry schedule (from docs: Implementing Webhook Retries):
//   Attempt 1: at delivery.  Attempt 2: +30min.  Attempt 3: +1h.  Attempt 4: +24h.
// Any non-2xx response triggers retries → we ALWAYS return 200 unless HMAC fails.
//
// Status mapping (from setup-webhook-url sample payload): "completed" = SUCCESS.
// Value.Data.Status ∈ { completed, failed, pending, cancelled, ... }
// =============================================================================

function extractAlatpayEventId(body: AlatpayWebhookEnvelope): string | null {
  const id = body?.Value?.Data?.Id ?? (body as any)?.Value?.Data?.id ?? (body as any)?.id ?? (body as any)?.Id;
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s.length === 0 ? null : s;
}

router.post('/alatpay', async (req: Request, res: Response) => {
  // ---------------------------------------------------------------------------
  // Step 1 — IP whitelist WARN-only layer (non-blocking; HMAC alone is
  // authoritative for accept/reject decisions).
  // ---------------------------------------------------------------------------
  try {
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      (req.headers['x-real-ip'] as string) ??
      (req.socket?.remoteAddress as string) ??
      req.ip ??
      null;
    if (!isAlatpayWhitelistedIp(clientIp)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[webhook:alatpay] IP not in ALAT official whitelist 74.178.162.156 — still validating signature. IP=' + clientIp,
      );
    }
  } catch {
    /* ignore */
  }

  // ---------------------------------------------------------------------------
  // Step 2 — HMAC signature verification (AUTHORITATIVE).
  // HMAC is the authoritative accept/reject decision. We:
  //   - accept signature header names: x-alatpay-signature, alatpay-signature, x-signature (compat)
  //   - if signature is missing/invalid: return HTTP 403 with { message: 'Invalid HMAC' } and STOP processing
  //   - if signature is valid: continue processing
  // IP whitelist check remains WARN-only; HMAC failure hard-blocks.
  // ---------------------------------------------------------------------------
  const rawBody: Buffer | string =
    (req as any).rawBody instanceof Buffer
      ? (req as any).rawBody
      : typeof (req as any).rawBody === 'string'
      ? (req as any).rawBody
      : '';
  const signature =
    req.header('x-alatpay-signature') ??
    req.header('alatpay-signature') ??
    req.header('x-signature') ??
    undefined;
  const bodyLen = Buffer.isBuffer(rawBody) ? rawBody.length : String(rawBody ?? '').length;
  if (!signature || !verifyAlatpayHmac(rawBody, signature)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[webhook:alatpay] signature ${signature ? 'INVALID' : 'MISSING'} — REJECTING with 403. bodyLen=${bodyLen} headers.sig=${signature ? 'present' : 'none'}`,
    );
    return res.status(403).json({ message: 'Invalid HMAC' });
  }
  // eslint-disable-next-line no-console
  console.info(`[webhook:alatpay] signature VALID. bodyLen=${bodyLen}`);

  // ---------------------------------------------------------------------------
  // Step 3 — Parse envelope + extract event/transaction references.
  // ---------------------------------------------------------------------------
  const body: AlatpayWebhookEnvelope = req.body ?? {};
  const data = body.Value?.Data ?? {};
  const alatpayEventId = extractAlatpayEventId(body);
  const eventType =
    normalizeAlatStatus(data.Status) === 'success'
      ? 'charge.success'
      : normalizeAlatStatus(data.Status) === 'failed'
      ? 'charge.failed'
      : 'charge.unknown';
  const orderId = typeof data.OrderId === 'string' ? data.OrderId : undefined;
  const customerTxId = typeof data.Customer?.TransactionId === 'string' ? data.Customer.TransactionId : undefined;
  const transactionRef = orderId ?? customerTxId ?? (alatpayEventId ? String(alatpayEventId) : undefined);

  if (!alatpayEventId) {
    // eslint-disable-next-line no-console
    console.warn('[webhook:alatpay] missing Value.Data.Id (event id) — ack 200 to avoid retries.');
    return res.status(200).json({ status: 'ok', processed: false, reason: i18n.errors.webhook.missingEventId });
  }

  // ---------------------------------------------------------------------------
  // Step 4 — DB idempotency guard (UNIQUE alatpayEventId).
  // ---------------------------------------------------------------------------
  try {
    await prisma.webhookEvent.upsert({
      where: { alatpayEventId },
      update: {},
      create: {
        paystackEventId: null,
        alatpayEventId,
        eventType,
        transactionReference: transactionRef,
        payload: safePayload(body),
        isProcessed: false,
      },
      select: { id: true },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[webhook:alatpay] prisma.upsert webhookEvent failed (still 200 to ALAT):', err);
    return res
      .status(200)
      .json({ status: 'ok', processed: false, reason: 'persistence_error_deferred_retry' });
  }

  // ---------------------------------------------------------------------------
  // Step 5 — Kick off async handling via BullMQ dedup job + return 200 fast.
  // ---------------------------------------------------------------------------
  try {
    await dispatchJob(
      'alatpay.webhook',
      { alatpayEventId, eventType, receivedAt: new Date().toISOString() },
      {
        jobId: `alatpay-webhook:${alatpayEventId}`,
        deduplicate: true,
        priority: 'high',
        retries: 4,
      },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[webhook:alatpay] dispatchJob failed after final retries for event', alatpayEventId, err);
  }

  return res.status(200).json({
    status: 'ok',
    received: true,
    eventId: alatpayEventId,
    eventType,
    transactionRef,
  });
});

// =============================================================================
// ALAT Pay webhook handler — registered at module import.
// -----------------------------------------------------------------------------
// Correlation (A -> B -> C -> D):
//   A) internal transaction_id from Customer.Metadata (strongest)
//   B) Bells internal payment reference (PAY-XXXX) — may come from:
//        - Metadata.bells_payment_reference  OR
//        - OrderId with WEMA- prefix stripped
//   C) stored init/session/order reference (WEMA-/paykXXX)
//   D) final provider transaction UUID if already persisted
//
// After locating a single unambiguous Bells transaction, the AUTHORITATIVE
// verify ref (for AlatpayProvider.verify) is the FINAL provider transaction
// UUID (Value.Data.Id or Customer.TransactionId-UUID-shape), NOT the OrderId
// nor the init paymentReference.
//
// Provider server-side verification remains authoritative; webhook Status
// alone never writes SUCCESS.
// =============================================================================
registerHandler('alatpay.webhook', async (payload, _ctx) => {
  const { alatpayEventId, eventType, forceReprocess } = payload as {
    alatpayEventId: string;
    eventType: string;
    forceReprocess?: boolean;
  };
  const row = await prisma.webhookEvent.findUnique({
    where: { alatpayEventId },
  });
  if (!row) return;
  if (row.isProcessed && !forceReprocess) return;

  let newProcessed = false;
  let failureReason: string | null = null;
  const envelope: AlatpayWebhookEnvelope | null = row.payload as any;
  const data = envelope?.Value?.Data ?? {};

  // 1. Extract raw fields
  const dataId = typeof data.Id === 'string' ? data.Id.trim() : null;
  const orderIdRaw = typeof data.OrderId === 'string' ? data.OrderId.trim() : null;
  const customerTxIdRaw = typeof data.Customer?.TransactionId === 'string' ? data.Customer.TransactionId.trim() : null;
  const sessionIdRaw =
    typeof data.SessionId === 'string'
      ? data.SessionId.trim()
      : typeof (envelope as any)?.Value?.Data?.sessionId === 'string'
        ? (envelope as any).Value.Data.sessionId.trim()
        : null;
  const finalTxId: string | null =
    selectAlatpayFinalTxId(envelope, dataId ?? customerTxIdRaw ?? null) ||
    dataId ||
    (customerTxIdRaw && /^[0-9a-fA-F-]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(customerTxIdRaw) ? customerTxIdRaw : null);

  // 2. Parse Customer.Metadata safely (object or string JSON)
  const customerMeta: AlatpayCustomerMetadata | null = parseAlatpayCustomerMetadata(data.Customer?.Metadata ?? null);
  const metaTxId = customerMeta?.transaction_id ?? null;
  const metaBellsRef = customerMeta?.bells_payment_reference ?? null;

  // 3. Bells reference from metadata or by stripping WEMA- prefix from orderId
  const inferredBellsRef: string | null =
    (metaBellsRef && typeof metaBellsRef === 'string' ? metaBellsRef : null) ||
    (orderIdRaw && orderIdRaw.startsWith('WEMA-') ? orderIdRaw.slice('WEMA-'.length) : null);

  // 4. Locate Bells transaction deterministically (ties -> ambiguity, no money touched)
  const { PaymentService } = await import('../services/payment');
  const locate = await PaymentService.locateAlatpayTransactionFromWebhook({
    transaction_id_from_metadata: metaTxId,
    bells_payment_reference: inferredBellsRef,
    order_reference: orderIdRaw,
    init_payment_reference: customerTxIdRaw && !/^[0-9a-fA-F-]{8}-[0-9a-fA-F]{4}-/.test(customerTxIdRaw) ? customerTxIdRaw : null,
    session_id: sessionIdRaw,
    final_transaction_id: finalTxId,
  });

  // Sanitized diagnostic (never include customer PII/secrets)
  const diag = (reason: string) =>
    `[alatpay webhook ${eventType}] ${reason}; eventId=${alatpayEventId.slice(0, 40)} orderId=${orderIdRaw ? `${orderIdRaw.slice(0, 40)}` : 'null'} finalTxIdPresent=${!!finalTxId}`;

  try {
    switch (eventType) {
      case 'charge.success': {
        if ('ambiguity' in locate) {
          failureReason = diag(`correlation ambiguous: ${locate.diagnostic}; retry skipped to prevent double credit`);
          newProcessed = false;
          break;
        }
        if ('notFound' in locate) {
          failureReason = diag(`no Bells transaction found: ${locate.diagnostic}`);
          newProcessed = false;
          break;
        }
        // Authoritative verify reference: the actual final ALATPAY transaction UUID.
        // If for any reason we don't have a final UUID, we CANNOT safely call verify,
        // because OrderId and init paymentReference are not valid for /transactions/{uuid}.
        const providerVerifyRef = finalTxId;
        if (!providerVerifyRef || !String(providerVerifyRef).trim()) {
          failureReason = diag('missing authoritative final provider transaction UUID; cannot safely call /transactions verify endpoint');
          newProcessed = false;
          break;
        }
        const result = await PaymentService.verifyPayment(locate.reference, {
          providerReference: providerVerifyRef,
          expectedTransactionId: locate.id,
        });
        if (result.verified || (result as any).status === 'SUCCESS') {
          newProcessed = true;
        } else {
          failureReason =
            (result as any).reason ||
            'verifyPayment returned verified=false (underpaid/overpaid/non-success status)';
          newProcessed = false;
        }
        break;
      }
      case 'charge.failed':
      case 'charge.unknown': {
        // SAFETY: Never downgrade SUCCESS, UNDERPAID, OVERPAID rows.
        // Only mark FAILED rows we can SAFELY correlate (A/B/C/D exactly one match).
        if ('ambiguity' in locate) {
          failureReason = diag(`correlation ambiguous for failed/unknown: ${locate.diagnostic}`);
          newProcessed = false;
          break;
        }
        if ('notFound' in locate) {
          // unknown order = no record to update, still ack event processed (safe — no tx ever existed)
          newProcessed = true;
          break;
        }
        const existing = await prisma.transaction.findUnique({
          where: { id: locate.id },
          select: { id: true, status: true, userId: true },
        });
        if (!existing) {
          newProcessed = true;
          break;
        }
        // NEVER DOWNGRADE success rows
        if (
          existing.status === 'SUCCESS' ||
          existing.status === 'UNDERPAID' ||
          existing.status === 'OVERPAID' ||
          existing.status === 'REVERSED'
        ) {
          newProcessed = true;
          break;
        }
        await prisma.transaction.updateMany({
          where: { id: existing.id, status: 'PENDING' as any },
          data: { status: 'FAILED' as any, underpaidReason: `alatpay event ${eventType} / ${data.Status ?? 'unknown'}`.slice(0, 190) },
        });
        await prisma.auditLog
          .create({
            data: {
              action: 'PAYMENT_FAILED',
              entityType: 'TRANSACTION',
              entityId: String(existing.id),
              userId: existing.userId ?? null,
              newValue: {
                alatpayEvent: eventType,
                rawStatus: data.Status ?? null,
                finalTxIdPresent: !!finalTxId,
                orderId: orderIdRaw?.slice(0, 80) ?? null,
              } as any,
            },
          })
          .catch(() => {});
        newProcessed = true;
        break;
      }
      default:
        // Unknown event — still ack, never touch money
        newProcessed = true;
    }
  } catch (err) {
    failureReason = (err as Error)?.stack?.slice(0, 1000) ?? (err as Error)?.message ?? 'unknown';
    newProcessed = false;
  }

  const updatedEvent = await prisma.webhookEvent.update({
    where: { alatpayEventId },
    data: {
      isProcessed: newProcessed,
      processedAt: newProcessed ? new Date() : null,
      attempts: { increment: 1 },
      lastError: newProcessed ? null : failureReason,
      transactionReference:
        'id' in locate && locate.reference ? locate.reference : row.transactionReference ?? undefined,
    },
    select: { attempts: true, transactionReference: true, id: true },
  });

  if (!newProcessed && updatedEvent.attempts >= 3) {
    try {
      const ref = updatedEvent.transactionReference ?? ('id' in locate ? locate.reference : null) ?? alatpayEventId;
      void AdminNotificationService.emitWebhookFail3(ref);
    } catch (notifErr) {
      console.warn('[webhook:alatpay handler] emitWebhookFail3 failed:', (notifErr as Error)?.message);
    }
  }

  await prisma.auditLog
    .create({
      data: {
        action: newProcessed ? 'WEBHOOK_PROCESSED' : 'WEBHOOK_FAILED',
        entityType: 'WEBHOOK_EVENT',
        entityId: alatpayEventId,
        newValue: {
          provider: 'ALATPAY',
          eventType,
          processed: newProcessed,
          failure: failureReason ?? null,
          correlation: 'id' in locate ? { tier: 'located', id: locate.id, ref: locate.reference.slice(0, 40) } : locate,
          finalTxIdPresent: !!finalTxId,
        } as any,
      },
    })
    .catch(() => {});
});

export default router;
