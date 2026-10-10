import { Request } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import {
  Prisma,
  InvoiceStatus,
  TransactionStatus,
  Role,
  PaymentGateway,
} from '@prisma/client';
import { AppError } from '../utils/AppError';
import { Permissions } from '../types/permissions';
import {
  acquireInvoiceOperationLock,
  releaseInvoiceOperationLockByToken,
  releaseInvoiceOperationLock,
} from '../utils/invoiceLock';

const JSON_DB_NULL = Prisma.JsonNull;

export const CANCEL_TRANSACTION_REASONS = [
  'TEST_TRANSACTION',
  'DUPLICATE_ATTEMPT',
  'STUDENT_ABANDONED',
  'PROVIDER_SESSION_EXPIRED',
  'PAYMENT_COMPLETED_ON_NEW_ATTEMPT',
  'ADMINISTRATIVE_CORRECTION',
  'OTHER',
] as const;

export type CancelTransactionReason =
  (typeof CANCEL_TRANSACTION_REASONS)[number];

export const CANCEL_TRANSACTION_REASON_LABELS: Record<
  CancelTransactionReason,
  string
> = {
  TEST_TRANSACTION: 'Test / sandbox transaction',
  DUPLICATE_ATTEMPT: 'Duplicate payment attempt (replaced by newer)',
  STUDENT_ABANDONED: 'Student explicitly abandoned this attempt',
  PROVIDER_SESSION_EXPIRED: 'Provider session / checkout expired',
  PAYMENT_COMPLETED_ON_NEW_ATTEMPT: 'Payment completed on a separate new attempt',
  ADMINISTRATIVE_CORRECTION: 'Administrative correction',
  OTHER: 'Other',
};

export const CancelTransactionBodySchema = z
  .object({
    reason: z.enum(CANCEL_TRANSACTION_REASONS, {
      required_error: 'Cancellation reason is required',
      invalid_type_error: 'Invalid cancellation reason',
    }),
    writtenExplanation: z.string().trim().max(2000).optional(),
    evidenceReference: z
      .string()
      .trim()
      .max(500)
      .optional()
      .refine((v) => v == null || v.length === 0 || v.length >= 4, {
        message: 'If provided, evidence reference must be at least 4 characters',
      }),
  })
  .superRefine((val, ctx) => {
    if (val.reason === 'OTHER') {
      const x = (val.writtenExplanation ?? '').trim();
      if (x.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Written explanation is required when reason is "Other"',
          path: ['writtenExplanation'],
        });
      }
    }
  });

export type CancelTransactionBody = z.infer<typeof CancelTransactionBodySchema>;

type TransactionCancelInput = {
  transactionId: number;
  actorId: number;
  actorRole: Role;
  actorPermissions: string[];
  reason: CancelTransactionReason;
  writtenExplanation?: string;
  evidenceReference?: string;
  req?: Pick<Request, 'ip' | 'headers'>;
};

const INELIGIBLE_STATUSES: TransactionStatus[] = [
  TransactionStatus.SUCCESS,
  TransactionStatus.REVERSED,
  TransactionStatus.CANCELLED,
];

const ELIGIBLE_INVOICE_STATUSES_FOR_TX_CANCEL: InvoiceStatus[] = [
  InvoiceStatus.UNPAID,
  InvoiceStatus.PENDING,
  InvoiceStatus.FAILED,
  InvoiceStatus.PARTIALLY_PAID,
];

export class TransactionCancellationService {
  static assertAuthorized(role: Role, permissions: string[]) {
    if (role === Role.ADMIN) return true;
    if (role === Role.BURSARY && permissions.includes(Permissions.VOID_TRANSACTIONS)) {
      return true;
    }
    return false;
  }

  static async cancelTransaction(input: TransactionCancelInput) {
    if (!this.assertAuthorized(input.actorRole, input.actorPermissions ?? [])) {
      throw new AppError(
        'You do not have permission to cancel payment transactions. The VOID_TRANSACTIONS permission is required.',
        403,
      );
    }
    const {
      transactionId,
      actorId,
      reason,
      writtenExplanation,
      evidenceReference,
      req,
    } = input;

    // Precheck 0: load tx + invoice (studentId/amount) for subsequent checks
    const initialTx = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            amountDue: true,
            amountPaid: true,
          },
        },
      },
    });
    if (!initialTx) {
      throw new AppError('Transaction not found.', 404);
    }
    const invoiceId = initialTx.invoiceId;
    if (invoiceId == null) {
      throw new AppError(
        'Only invoice-backed fee payment attempts can be cancelled via this workflow.',
        400,
      );
    }

    // Shared invoice-level TTL lock so concurrent cancelInvoice / initiatePayment
    // / cancelTransaction do not race. 8s is enough for 1 DB $tx + audit.
    const invLock = await acquireInvoiceOperationLock(invoiceId, 8_000);
    if (!invLock.ok) {
      throw new AppError(
        'Another operation (invoice cancel, payment initiation, or reconciliation) is in progress for this invoice. Please wait and try again.',
        429,
      );
    }
    try {
      // --- Precheck 1: status must be eligible unpaid/non-terminal ------------
      if ((INELIGIBLE_STATUSES as TransactionStatus[]).includes(initialTx.status as any)) {
        throw new AppError(
          `Transaction ${initialTx.reference ?? initialTx.id} has status ${
            initialTx.status
          } and cannot be cancelled. Only pending, processing, failed or unbalanced unpaid attempts may be cancelled.`,
          409,
        );
      }

      // Precheck 2: if invoice status is CANCELLED / REFUNDED / REVERSED
      // allow tx cancel ONLY if tx never posted any money (safe administrative).
      if (initialTx.invoice) {
        const invSt = initialTx.invoice.status;
        const terminal = ['CANCELLED', 'REFUNDED', 'REVERSED'];
        if (terminal.includes(invSt as string) && initialTx.amount != null && Number(initialTx.amount) > 0) {
          throw new AppError(
            `Invoice ${initialTx.invoice.invoiceNumber ?? initialTx.invoice.id} is ${invSt} but this attempt already recorded a paid amount. It must be handled via refund/reversal workflow, not transaction cancellation.`,
            409,
          );
        }
      }

      // Precheck 3: No receipt exists for this tx (receipt generation is a
      // terminal financial event → cancel would erase evidence of receipted tx).
      let receiptCount: number;
      try {
        receiptCount = await prisma.receipt.count({
          where: { transactionId },
        });
      } catch (err: any) {
        const msg = (err && typeof err.message === 'string') ? err.message : String(err);
        // FAIL CLOSED: database error reading receipts is NOT equivalent to 0
        // receipts. Throw 500 so the operator retries; we must never assume
        // zero receipts exist if the database could not confirm it.
        throw new AppError(
          `Unable to confirm transaction ${transactionId} has no receipts before cancellation (${msg.slice(0, 120)}). Please try again.`,
          500,
        );
      }
      if (receiptCount > 0) {
        throw new AppError(
          `Transaction already has ${receiptCount} receipt(s). Receipted transactions must be reversed through the financial reversal workflow, not cancelled.`,
          409,
        );
      }

      // Precheck 4: No GL financial entries have been posted
      let glCount: number;
      try {
        const rawGl = await (prisma as any).generalLedger.count({
          where: { transactionId },
        });
        glCount = Number(rawGl ?? 0);
        if (Number.isNaN(glCount)) glCount = -1;
      } catch (err: any) {
        const msg = (err && typeof err.message === 'string') ? err.message : String(err);
        throw new AppError(
          `Unable to confirm transaction ${transactionId} has no General Ledger postings before cancellation (${msg.slice(0, 120)}). Please try again.`,
          500,
        );
      }
      if (glCount < 0 || glCount > 0) {
        // Negative sentinel → NaN result; treat as unverifiable (fail closed).
        if (glCount < 0) {
          throw new AppError(
            `Unable to verify General Ledger state for transaction ${transactionId} before cancellation (invalid numeric result). Please try again.`,
            500,
          );
        }
        throw new AppError(
          `Transaction has ${glCount} General Ledger posting(s). Transactions with GL entries must be reversed using the reversal workflow, not cancelled.`,
          409,
        );
      }

      // Precheck 5: No settlement exists.
      // NOTE: previous code used `.catch(() => 0) ?? 0` → DB error → 0 count.
      // This was a fail-open bug: if settlement DB was unreachable we allowed
      // cancelling transactions that may already have been settled. Corrected
      // below to explicitly fail closed.
      let settlementCount: number;
      try {
        if (typeof (prisma.settlement as any)?.count !== 'function') {
          // Model may not exist in early-migration test databases. Treat as
          // unverifiable — fail closed with explicit 500.
          settlementCount = -1;
        } else {
          const rawSettle = await prisma.settlement.count({
            where: { transactionId },
          });
          settlementCount = Number(rawSettle ?? 0);
          if (Number.isNaN(settlementCount)) settlementCount = -1;
        }
      } catch (err: any) {
        const msg = (err && typeof err.message === 'string') ? err.message : String(err);
        throw new AppError(
          `Unable to confirm transaction ${transactionId} has no settlement records before cancellation (${msg.slice(0, 120)}). Please try again.`,
          500,
        );
      }
      if (settlementCount < 0 || settlementCount > 0) {
        if (settlementCount < 0) {
          throw new AppError(
            `Unable to verify settlement state for transaction ${transactionId} before cancellation. Cancellation aborted to avoid erasing settlement evidence. Please try again later.`,
            500,
          );
        }
        throw new AppError(
          `Transaction already has settlement record(s). Settled transactions cannot be cancelled.`,
          409,
        );
      }

      // Precheck 5B: Webhook event evidence (strongly typed Prisma query, no any cast).
      // If a stored webhook event already contains SUCCESS evidence for this
      // transaction (provider status = success/completed/paid via eventType or
      // payload), cancellation must be denied outright → reconciliation.
      // Non-terminal webhooks (eventType=charge.unknown, PENDING/PROCESSING
      // status inside payload, isProcessed=false without success evidence)
      // count as unverifiable audit trail → trigger the written+evidence gate
      // but do not outright deny.
      // Correlation paths (disjunction per OR clause):
      //   1. transactionReference matches initialTx.reference
      //   2. alatpayEventId matches initialTx.alatpayFinalTransactionId / initRef
      //   3. paystackEventId → exact match against *event id* only when we have
      //      one stored; otherwise fall back to JSON payload inspection below
      // Payload text-scan (case-insensitive substring) is SAFE secondary check
      // because: (a) we already correlate on refs first, (b) we only block
      // cancellation when we see SUCCESS evidence (never auto-fail an attempt).
      type WebhookEvidenceSummary = {
        total: number;
        successHooks: number;
        pendingHooks: number;
      };
      const SUCCESS_TOKENS = /success|completed|paid|successful/i;
      const PENDING_TOKENS = /pending|processing|received|queued|initiated/i;
      let webhookEvidence: WebhookEvidenceSummary = { total: 0, successHooks: 0, pendingHooks: 0 };
      try {
        const ref = initialTx.reference ? String(initialTx.reference) : null;
        const paystackTxRef =
          typeof (initialTx as any).paystackReference === 'string' ? String((initialTx as any).paystackReference) : null;
        const alatpayInitRef =
          typeof (initialTx as any).alatpayInitPaymentReference === 'string'
            ? String((initialTx as any).alatpayInitPaymentReference)
            : null;
        const alatpayFinalRef =
          typeof initialTx.alatpayFinalTransactionId === 'string'
            ? String(initialTx.alatpayFinalTransactionId)
            : null;

        // Build a type-safe where-clause.
        // Note: paystackEventId in the schema is the WEBHOOK event id, which
        // is distinct from a tx's paystackReference (the tx init reference).
        // So we only use alatpayEventId here (alatpay event id matches the
        // final tx UUID because alatpay webhook uses alatpayEventId = that UUID).
        // For reference-matching we rely on transactionReference column and
        // a safe JSON-string payload scan (for secondary verification).
        const whereOrList: Prisma.WebhookEventWhereInput['OR'] = [];
        if (ref != null) {
          whereOrList.push({ transactionReference: { equals: ref } });
        }
        if (alatpayFinalRef != null) {
          whereOrList.push({ alatpayEventId: { equals: alatpayFinalRef } });
        }
        // Initial alatpay init reference is the OrderId/Customer.TransactionId
        // stored on the tx; webhook ingestion stores that into transactionReference
        // already, but we also allow a direct alatpayEventId match if init ref
        // was ever promoted to an event id in a prior-version ingestion.
        if (alatpayInitRef != null && alatpayInitRef.length >= 6) {
          whereOrList.push({ transactionReference: { equals: alatpayInitRef } });
        }
        // If we have no where-clause at all (tx has no refs at all), skip the
        // DB call (there is nothing to correlate). Still fail-closed via
        // pendingHooks += 1 because we cannot verify webhook evidence.
        if (whereOrList.length === 0) {
          webhookEvidence = { total: -1, successHooks: 0, pendingHooks: 1 };
        } else {
          type WebhookRowForEvidence = Pick<
            (typeof prisma.webhookEvent) extends {
              findMany: (arg: infer _A) => Promise<infer R>;
            }
              ? R extends (infer Elem)[]
                ? Elem
                : never
              : never,
            never
          >;
          const rows = await prisma.webhookEvent.findMany({
            where: { OR: whereOrList },
            orderBy: { createdAt: 'desc' },
            take: 25,
            select: {
              id: true,
              eventType: true,
              transactionReference: true,
              alatpayEventId: true,
              paystackEventId: true,
              payload: true,
              isProcessed: true,
              lastError: true,
              attempts: true,
              createdAt: true,
            },
          });
          const hooks = rows as unknown as Array<{
            id: number;
            eventType: string;
            transactionReference: string | null;
            alatpayEventId: string | null;
            paystackEventId: string | null;
            payload: unknown;
            isProcessed: boolean;
            lastError: string | null;
            attempts: number;
            createdAt: Date;
          }>;
          let s = 0;
          let p = 0;
          // Optional SECONDARY scan: if tx has refs that don't match
          // transactionReference (rare legacy ingests where webhook row was
          // written with null transactionReference), do a JSON substring
          // search against the payload TEXT of already-matched rows.
          const additionalLookups: string[] = [];
          if (paystackTxRef != null && paystackTxRef.length >= 6) additionalLookups.push(paystackTxRef);
          if (alatpayInitRef != null && alatpayInitRef.length >= 6) additionalLookups.push(alatpayInitRef);
          const hasSecondary = additionalLookups.length > 0;
          for (const h of hooks) {
            // Build a normalized combined text for evidence scanning:
            //  eventType + (payload as JSON/text) + lastError
            const payloadText =
              typeof h.payload === 'string'
                ? h.payload
                : h.payload && typeof h.payload === 'object'
                  ? JSON.stringify(h.payload)
                  : '';
            const combined = [h.eventType, payloadText, h.lastError ?? ''].join('\n').toLowerCase();
            // Also enforce payload contains tx refs for secondary correlation.
            let correlated = true;
            if (hasSecondary && h.transactionReference == null) {
              // Row has no stored transactionReference — this can happen for
              // legacy or malformed ingests. Require that at least one of our
              // known tx refs actually APPEAR in the payload text, otherwise
              // this webhook row is "unrelated" and must not count.
              correlated = additionalLookups.some((lookup) => payloadText.includes(lookup));
            }
            if (!correlated) continue;
            // Classify
            const eventTypeTerminalSuccess = h.eventType === 'charge.success';
            const tokenSuccess = SUCCESS_TOKENS.test(combined);
            const terminalSuccess = eventTypeTerminalSuccess || tokenSuccess;
            if (terminalSuccess) {
              s += 1;
              continue;
            }
            // Pending / unverifiable classification:
            //   eventType = charge.unknown OR payload has pending/processing/
            //   received/queued OR (not success AND NOT explicitly charge.failed
            //   AND NOT isProcessed)
            const explicitFailed = h.eventType === 'charge.failed' || /failed|declined|rejected|expired|cancelled/i.test(h.eventType);
            const pendingByEventType = h.eventType === 'charge.unknown' || PENDING_TOKENS.test(h.eventType);
            const pendingByPayload = PENDING_TOKENS.test(combined);
            const pendingByState = !explicitFailed && !h.isProcessed && h.attempts < 10;
            if (pendingByEventType || pendingByPayload || pendingByState) {
              p += 1;
            }
          }
          webhookEvidence = { total: hooks.length, successHooks: s, pendingHooks: p };
        }
      } catch (err: any) {
        // FAIL CLOSED: any Prisma validation / DB transport error → 500 so
        // caller retries; we never silently interpret evidence as "zero hooks".
        const msg = (err && typeof err.message === 'string') ? err.message : String(err);
        throw new AppError(
          `Unable to inspect webhook evidence for transaction ${transactionId} before cancellation (${msg.slice(0, 120)}). Please try again.`,
          500,
        );
      }
      // Explicit success hook evidence → block entirely; reconciliation must handle.
      if (webhookEvidence.successHooks > 0) {
        throw new AppError(
          `Stored webhook records contain provider SUCCESS evidence for transaction ${transactionId}. Cancellation denied; use the reconciliation exception workflow to resolve with authoritative provider verification.`,
          409,
        );
      }
      const hasPendingOrUnverifiedWebhooks = webhookEvidence.total < 0 || webhookEvidence.pendingHooks > 0;

      // Precheck 6: Invoice amountPaid has not been credited by this tx
      if (initialTx.invoice) {
        if (Number(initialTx.invoice.amountPaid ?? 0) > 0) {
          if (Number(initialTx.amount ?? 0) > 0) {
            throw new AppError(
              `Invoice ${initialTx.invoice.invoiceNumber ?? initialTx.invoice.id} already has amountPaid > 0 and this attempt recorded an amount. Use refund/reversal workflow instead.`,
              409,
            );
          }
        }
      }

      // Precheck 7: Authoritative evidence requirements (C4 fail-closed).
      // CANCEL != FAILED. Unknown state MUST NOT be converted into cancellation.
      // The following cases each require explicit, documented audit evidence:
      //   a) tx status=PENDING or PROCESSING (still live attempt window)
      //   b) hasSuccessRef (provider returned SUCCESS but internal never transitioned)
      //   c) has pending/non-terminal webhook evidence OR webhook state unverifiable
      //   d) the provider UUID (ALATPAY final) or paystack reference is missing
      //      — by itself NOT PROOF of failure. Still requires evidence.
      // Elapsed time, closed popup, missing callback are NEVER sufficient.
      const txStatus: string = String(initialTx.status);
      const liveAttempt = txStatus === 'PENDING' || txStatus === 'PROCESSING';
      const providerRefMissing =
        (!initialTx.alatpayFinalTransactionId || String(initialTx.alatpayFinalTransactionId).length === 0) &&
        (!(initialTx as any).paystackReference || String((initialTx as any).paystackReference).length === 0);
      const hasSuccessRef =
        (initialTx.status === TransactionStatus.SUCCESS as any) ||
        (initialTx.alatpayFinalTransactionId && String(initialTx.alatpayFinalTransactionId).length > 0) ||
        ((initialTx as any).paystackReference && String((initialTx as any).paystackReference).length > 0 &&
          initialTx.status === TransactionStatus.SUCCESS);
      const requireEvidence =
        liveAttempt || hasSuccessRef || hasPendingOrUnverifiedWebhooks || providerRefMissing;

      if (requireEvidence) {
        const written = (writtenExplanation ?? '').trim().length;
        const ev = (evidenceReference ?? '').trim().length;
        const reasons: string[] = [];
        if (liveAttempt) reasons.push(`status=${initialTx.status} (still within provider processing window — time elapsed/popup closed are NOT proof of failure)`);
        if (hasSuccessRef) reasons.push('provider success references are present on the attempt');
        if (hasPendingOrUnverifiedWebhooks) reasons.push('pending/unverified webhook evidence exists');
        if (providerRefMissing) reasons.push('final provider transaction reference is unavailable (missing UUID ≠ failed payment)');
        if (written < 20 || ev < 6) {
          throw new AppError(
            `Cancellation requires documented audit evidence: ${reasons.join('; ')}. ` +
              `Provide both written explanation (≥20 characters) and evidence reference (≥6 characters) for the permanent cancellation record. ` +
              `Note: closed popup, elapsed time, missing callback, or missing provider UUID alone do not establish payment failure — use provider verifyPayment or reconciliation workflow first when possible.`,
            409,
          );
        }
      }

      const ipAddress =
        ((req as any)?.ip as string | undefined) ??
        (((req as any)?.headers?.['x-forwarded-for'] as string | undefined) ?? '').split(',')[0] ??
        null;
      const userAgent = ((req as any)?.headers?.['user-agent'] as string | undefined) ?? null;

      const writtenNow = new Date();
      const result = await prisma.$transaction(async (tx) => {
        if (process.env.NODE_ENV !== 'test') {
          try {
            const boundInvoiceId: number = Number(invoiceId);
            const boundTxId: number = Number(transactionId);
            // Two row locks for the two objects the cancel touches:
            // 1. Invoice FOR UPDATE prevents concurrent payment initialization
            //    posting amountPaid or status changes mid-cancel.
            // 2. Transaction FOR UPDATE prevents concurrent verifyPayment
            //    webhook or reconciler claiming the tx (updateMany status PENDING)
            //    while we're cancelling it.
            // Both use positional ? parameterized queries with bindings.
            const lockInvRes: any = await tx.$executeRawUnsafe(
              'SELECT id FROM invoices WHERE id = ? FOR UPDATE',
              boundInvoiceId,
            );
            const lockTxRes: any = await tx.$executeRawUnsafe(
              'SELECT id FROM transactions WHERE id = ? FOR UPDATE',
              boundTxId,
            );
            void lockInvRes; void lockTxRes;
          } catch (err: any) {
            // FAIL CLOSED. If we cannot obtain the required row locks for
            // either the invoice OR the transaction row we MUST NOT proceed —
            // a concurrent operation (verify, settlement, payment init, or
            // reconciliation) may hold one. Let caller retry.
            const msg: string = (err && typeof err.message === 'string') ? err.message : String(err);
            throw new AppError(
              `Unable to obtain database row locks for transaction ${transactionId} during cancellation (${msg.slice(0, 120)}). Please try again.`,
              500,
            );
          }
        }
        // Precheck 8: re-read tx inside tx for optimistic concurrency
        const liveTx = await tx.transaction.findUnique({
          where: { id: transactionId },
          include: { invoice: { select: { id: true, status: true, amountPaid: true } } },
        });
        if (!liveTx) throw new AppError('Transaction not found.', 404);
        if ((INELIGIBLE_STATUSES as TransactionStatus[]).includes(liveTx.status as any)) {
          throw new AppError(
            `Transaction state changed to ${liveTx.status} while cancellation was being processed. Refresh and try again.`,
            409,
          );
        }

        // Precheck 9: no receipt / GL row created concurrently between our
        // initial read above and this $tx. FAIL CLOSED on database errors.
        let receiptRecheck: number;
        try {
          receiptRecheck = await tx.receipt.count({ where: { transactionId } });
        } catch (err: any) {
          const msg = (err && typeof err.message === 'string') ? err.message : String(err);
          throw new AppError(
            `Unable to recheck receipts for transaction ${transactionId} inside cancellation transaction (${msg.slice(0, 120)}). Please try again.`,
            500,
          );
        }
        if (receiptRecheck > 0) {
          throw new AppError('A receipt was created concurrently. Cancellation aborted.', 409);
        }
        let glRecheck: number;
        try {
          const rawGl = await (tx as any).generalLedger.count({ where: { transactionId } });
          glRecheck = Number(rawGl ?? 0);
          if (Number.isNaN(glRecheck)) glRecheck = -1;
        } catch (err: any) {
          const msg = (err && typeof err.message === 'string') ? err.message : String(err);
          throw new AppError(
            `Unable to recheck General Ledger for transaction ${transactionId} inside cancellation transaction (${msg.slice(0, 120)}). Please try again.`,
            500,
          );
        }
        if (glRecheck < 0 || glRecheck > 0) {
          if (glRecheck < 0) {
            throw new AppError(
              `Unable to verify General Ledger state during cancellation (invalid numeric result). Cancellation aborted. Please try again.`,
              500,
            );
          }
          throw new AppError('General Ledger entries were posted concurrently. Cancellation aborted.', 409);
        }
        // Precheck 9b: settlement recheck inside transaction (also fail closed,
        // no catch→0 swallow).
        let settlementRecheck: number;
        try {
          if (typeof (tx.settlement as any)?.count !== 'function') {
            settlementRecheck = -1;
          } else {
            const rawSettle = await tx.settlement.count({ where: { transactionId } });
            settlementRecheck = Number(rawSettle ?? 0);
            if (Number.isNaN(settlementRecheck)) settlementRecheck = -1;
          }
        } catch (err: any) {
          const msg = (err && typeof err.message === 'string') ? err.message : String(err);
          throw new AppError(
            `Unable to recheck settlements for transaction ${transactionId} inside cancellation transaction (${msg.slice(0, 120)}). Please try again.`,
            500,
          );
        }
        if (settlementRecheck < 0 || settlementRecheck > 0) {
          if (settlementRecheck < 0) {
            throw new AppError(
              `Unable to verify settlements during cancellation transaction. Cancellation aborted. Please try again.`,
              500,
            );
          }
          throw new AppError('Settlement record(s) appeared concurrently. Cancellation aborted.', 409);
        }
        // Precheck 10: invoice amountPaid recheck (did another payment just post?)
        if (liveTx.invoice) {
          const invRecheck = await tx.invoice.findUnique({
            where: { id: liveTx.invoice.id },
            select: { id: true, status: true, amountPaid: true },
          });
          if (
            invRecheck &&
            Number(invRecheck.amountPaid ?? 0) > 0 &&
            Number(liveTx.amount ?? 0) > 0
          ) {
            throw new AppError(
              'Invoice amountPaid changed concurrently. Cancellation aborted.',
              409,
            );
          }
          // Invoice CANCELLED itself — allow cancelTransaction only if 0 posting
          if (
            invRecheck &&
            (invRecheck.status === InvoiceStatus.CANCELLED ||
              invRecheck.status === InvoiceStatus.REFUNDED ||
              invRecheck.status === InvoiceStatus.REVERSED) &&
            Number(liveTx.amount ?? 0) > 0
          ) {
            throw new AppError(
              `Invoice ${invRecheck.id} status changed to ${invRecheck.status} with a posted amount. Use reversal/refund workflow instead.`,
              409,
            );
          }
        }

        // Precheck 11: preserve original provider refs — store them in
        // metadata.cancellation, NOT overwrite columns.
        const existingMeta =
          liveTx.metadata && typeof liveTx.metadata === 'object'
            ? (liveTx.metadata as Record<string, any>)
            : {};
        const cancellationMeta = {
          at: writtenNow.toISOString(),
          reason,
          writtenExplanation: (writtenExplanation ?? '').trim().slice(0, 2000) || null,
          evidenceReference: (evidenceReference ?? '').trim().slice(0, 500) || null,
          actorId,
          statusBefore: String(liveTx.status),
          preservedReferences: {
            reference: liveTx.reference ?? null,
            paystackReference: (liveTx as any).paystackReference ?? null,
            alatpayReference: (liveTx as any).alatpayReference ?? null,
            alatpayFinalTransactionId: (liveTx as any).alatpayFinalTransactionId ?? null,
            alatpayOrderReference: (liveTx as any).alatpayOrderReference ?? null,
            alatpayInitPaymentReference: (liveTx as any).alatpayInitPaymentReference ?? null,
            alatpaySessionId: (liveTx as any).alatpaySessionId ?? null,
            gateway: (liveTx.gateway as PaymentGateway | null) ?? null,
            expectedAmount: liveTx.expectedAmount ? Number(liveTx.expectedAmount) : null,
            rawAmount: liveTx.amount ? Number(liveTx.amount) : null,
          },
        };
        const updatedMeta: Record<string, any> = {
          ...existingMeta,
          cancellation: cancellationMeta,
        };

        // Precheck 12: atomic updateMany WHERE status=eligible AND id=tx.id so
        // another process can't modify row between our read + write.
        const eligibleWhere: any[] = [
          TransactionStatus.PENDING,
          TransactionStatus.PROCESSING,
          TransactionStatus.FAILED,
          TransactionStatus.UNDERPAID,
          TransactionStatus.OVERPAID,
        ];
        const updateRes = await tx.transaction.updateMany({
          where: {
            id: transactionId,
            status: { in: eligibleWhere },
          },
          data: {
            status: TransactionStatus.CANCELLED,
            metadata: updatedMeta as Prisma.InputJsonValue,
            updatedAt: writtenNow,
          },
        });
        if (updateRes.count !== 1) {
          throw new AppError(
            'Transaction status changed concurrently between precheck and commit. Please refresh and try again.',
            409,
          );
        }

        // Audit TRANSACTION_CANCELLED (inside tx for atomicity with the
        // updateMany — either both persist, or neither does.)
        const audit = await tx.auditLog.create({
          data: {
            userId: actorId,
            action: 'TRANSACTION_CANCELLED',
            entityType: 'TRANSACTION',
            entityId: String(transactionId),
            oldValue: {
              id: liveTx.id,
              reference: liveTx.reference,
              status: liveTx.status,
              invoiceId: liveTx.invoiceId,
              expectedAmount: liveTx.expectedAmount ? Number(liveTx.expectedAmount) : null,
              amount: liveTx.amount ? Number(liveTx.amount) : null,
            } as Prisma.InputJsonValue,
            newValue: {
              status: TransactionStatus.CANCELLED,
              cancellation: cancellationMeta,
            } as Prisma.InputJsonValue,
            details: {
              code: 'MANUAL_TRANSACTION_CANCEL',
              invoiceId,
              invoiceNumber: initialTx.invoice?.invoiceNumber ?? null,
              reason,
              writtenExplanation: cancellationMeta.writtenExplanation,
              evidenceReference: cancellationMeta.evidenceReference,
              preservedReferences: cancellationMeta.preservedReferences,
              prechecks: {
                receiptCleared: receiptRecheck === 0,
                glCleared: Number(glRecheck ?? 0) === 0,
                statusEligible: true,
                invoiceAmountSafe: true,
              },
            } as Prisma.InputJsonValue,
            ipAddress,
            userAgent,
          },
        });

        // Explicitly DO NOT touch invoice amountPaid, DO NOT generate
        // receipts, DO NOT create settlements, DO NOT post GL. This
        // preserves the cancelled payment attempt for audit without any
        // financial side effects.
        return { audit, cancellationMeta };
      }, { timeout: 15000 });

      const finalTx = await prisma.transaction.findUnique({ where: { id: transactionId } });
      return {
        transaction: finalTx,
        auditId: result.audit.id,
        auditedAt: result.audit.createdAt,
        cancellation: result.cancellationMeta,
      };
    } finally {
      try {
        await releaseInvoiceOperationLockByToken(invoiceId, invLock.ok ? invLock.token : null, {
          acquiredAtMs: invLock.ok ? invLock.acquiredAtMs : undefined,
          ttlMs: invLock.ok ? invLock.ttlMs : undefined,
          opName: 'cancelTransaction',
        });
      } catch (err) {
        // CAS token release failed; never perform ownerless lock deletion
        // because a later caller may now legitimately own the lock after
        // our TTL expired. Warn and allow TTL auto-expiry.
        console.warn(
          '[transactionCancellation.ts:cancelTransaction] Safe CAS invoice lock release failed for invId='
            + String(invoiceId)
            + '; allowing TTL auto-expiry (ownerless release intentionally skipped). Details: '
            + String((err as Error)?.message ?? err).slice(0, 160),
        );
      }
    }
  }
}

type _JsonNullGuard = typeof JSON_DB_NULL;
void (undefined as unknown as _JsonNullGuard | undefined);
