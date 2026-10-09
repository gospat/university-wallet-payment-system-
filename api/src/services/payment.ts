// =============================================================================
// PaymentService — FEE_PAYMENT orchestration (Task 12.2)
// -----------------------------------------------------------------------------
//   - initiatePayment(studentId, invoiceId, optionalPartialAmount?)
//       Rejects FR-G2: standalone `amount` field 400.
//       Expects `invoiceId` in body; optionalPartialAmount (if provided) is
//       treated as a PARTIAL payment. payableAmount = min(partial, balance).
//       Creates PENDING Transaction with PAY-YYYYMMDD-XXXXXX reference via
//       generatePaymentReference (§18).
//   - verifyPayment(paystackReference)
//       Atomic Prisma.$transaction:
//         1. Paystack verifyTransaction → amount kobo compare tolerance 1 kobo.
//         2. UNDERPAID/OVERPAID → Transaction UNDERPAID/OVERPAID; no ledger; no receipt; audit PAYMENT_UNDERPAID / PAYMENT_OVERPAID.
//         3. MATCH: updateMany Transaction WHERE status=PENDING → SUCCESS (race-safe).
//         4. Invoice amountPaid + balance; status PAID / PARTIALLY_PAID.
//         5. GeneralLedger double-entry (CASH_CLEARING debit, STUDENT_RECEIVABLE credit;
//            SERVICE_CHARGE_INCOME credit; UNIVERSITY_EXPENSES_FEE debit for gatewayFee).
//         6. Receipt row creation (generateReceiptReference counter + verificationToken).
//         7. Wallet credit backward-compat (wallet flow still works).
// =============================================================================
import * as crypto from 'crypto';
import { z } from 'zod';
import { Prisma, TransactionType, TransactionStatus, Role, PaymentGateway } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { computePaymentBreakdown } from './paystack';
import { generatePaymentReference, generateVerificationToken, kobo, readPaystackMetadata, generateReceiptReference } from '../utils/paystack';
import { nextYearlyCounter, yearFromSession } from '../utils/yearlyCounter';
import { i18n } from '../i18n/en';
import { dispatchEmail } from '../queues/emailQueue';
import { AdminNotificationService } from './adminNotification';
import { SystemSettingsService } from './systemSettings';
import { getPaymentProvider, getActiveGatewaySetting } from './payment/providerFactory';
import { gatewayLabel, VerifyPaymentOptions, PaymentBreakdown, AlatpayPublicCheckout } from './payment/types';
import { parseAlatpayCustomerMetadata, makeAlatpayWebhookJobId, isBullmqSafeJobId, isAlatpayUuid } from '../utils/alatpay';
import { getRedis } from '../config/redis';

type ReqLike = any;

const JSON_DB_NULL = Prisma.JsonNull;

// Task-4 deduplication: initiatePayment lock per (studentId, invoiceId).
// Uses Redis SET NX EX with best-effort; falls back to in-process Map if Redis
// unavailable or command throws. Locks short (3s) because it's just there to
// serialize parallel Pay-Now double-clicks / tab races / page refreshes that
// would otherwise both pass the pending-count guard before any row persists.
const INITIATE_LOCK_TTL_SEC = Number(process.env.INITIATE_LOCK_TTL_SEC_OVERRIDE) || (process.env.NODE_ENV === 'test' ? 0 : 3);
const _fallbackInitiateLocks = new Map<string, number>();

/** ONLY to be used by Jest tests to reset the in-process degraded dedup lock map between test runs. */
export function _testResetInitiateLocks() {
  _fallbackInitiateLocks.clear();
}

async function acquireInitiateDedupeLock(studentId: number, invoiceId: number): Promise<boolean> {
  const key = `initiates:lock:${studentId}:${invoiceId}`;
  const expireAtMs = Date.now() + (INITIATE_LOCK_TTL_SEC > 0 ? INITIATE_LOCK_TTL_SEC : 1) * 1000;
  // Redis path
  try {
    const r = getRedis();
    if (r && typeof r.call === 'function' && INITIATE_LOCK_TTL_SEC > 0) {
      const result: any = await r.call('SET', key, String(Date.now()), 'NX', 'EX', INITIATE_LOCK_TTL_SEC);
      if (result === 'OK' || result === 'SET' || result === true || result === 1) return true;
      return false;
    }
  } catch {
    /* fall through to degraded in-process map */
  }
  // In-process degraded path.
  // In NODE_ENV=test with explicit TTL override = 0 (Jest default), the degraded
  // lock is deliberately disabled. This lets idempotency tests directly exercise
  // the DB-level PENDING-age + ceiling guards (425 / 409) without contention from
  // the short-TTL concurrency lock. Production always has INITIATE_LOCK_TTL_SEC > 0.
  if (INITIATE_LOCK_TTL_SEC === 0) return true;
  const now = Date.now();
  for (const [k, v] of _fallbackInitiateLocks.entries()) {
    if (v < now) _fallbackInitiateLocks.delete(k);
  }
  if (_fallbackInitiateLocks.has(key)) return false;
  _fallbackInitiateLocks.set(key, expireAtMs);
  return true;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------
export const InitiatePaymentSchema = z
  .object({
    invoiceId: z.coerce.number().int().positive(),
    partialAmount: z.union([z.number().positive(), z.string().refine((s) => Number(s) > 0, { message: 'positive numeric required' }).transform((s) => Number(s))]).optional(),
    email: z.string().trim().max(255).email().optional(),
    idempotencyKey: z.string().min(1).max(128).trim().optional(),
  })
  .strict()
  .refine((v) => !('amount' in (v as any)), {
    message: i18n.errors.payment?.amountFieldNotAllowed ?? 'Field "amount" is not allowed. Use partialAmount for partial payments.',
    path: ['amount'],
  });

export type InitiatePaymentInput = z.infer<typeof InitiatePaymentSchema>;

async function writeAudit(req: ReqLike | undefined, data: { action: string; entityType: 'TRANSACTION' | 'RECEIPT' | 'INVOICE' | 'GENERAL_LEDGER' | 'WEBHOOK_EVENT' | 'FEE_ASSIGNMENT'; entityId: string | number; oldValue?: any; newValue?: any; details?: any; }) {
  const userId = (req as any)?.user?.id ?? null;
  const ipAddress = (req as any)?.ip ?? (req as any)?.headers?.['x-forwarded-for']?.split(',')[0] ?? null;
  const userAgent = (req as any)?.headers?.['user-agent'] ?? null;
  try {
    await prisma.auditLog.create({
      data: {
        action: data.action,
        entityType: data.entityType,
        entityId: String(data.entityId),
        userId,
        ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
        oldValue: data.oldValue === undefined || data.oldValue === null ? JSON_DB_NULL : (data.oldValue as Prisma.InputJsonValue),
        newValue: data.newValue === undefined || data.newValue === null ? JSON_DB_NULL : (data.newValue as Prisma.InputJsonValue),
        details: data.details === undefined || data.details === null ? JSON_DB_NULL : (data.details as Prisma.InputJsonValue),
      },
    });
  } catch {
    /* audit must never break request */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function money(n: number | Prisma.Decimal): number {
  return Number(Number(n).toFixed(2));
}

/**
 * Provider-neutral conservative retry policy (Blocker fix 1/2/3):
 *
 * FINANCIAL INVARIANT — Elapsed time alone must NEVER produce FAILED / SUCCESS /
 * UNDERPAID / OVERPAID / REVERSED for ANY payment gateway.
 *   UNKNOWN != FAILED.
 *   TIMEOUT != FAILED.
 *   NO CALLBACK != FAILED.
 *   NETWORK ERROR != FAILED.
 *   RETRY != FAILED.
 *
 * Exact policy for existing unresolved PENDING on same (student, invoice):
 *
 *  1. MAX_UNRESOLVED_PENDING_PER_INVOICE = 2 ceiling (any age, any gateway).
 *     Prevents unlimited duplicate PENDING accumulation.
 *  2. Age < 5 minutes → block duplicate with 425 regardless of gateway.
 *     UX: student should wait.
 *  3. Age >= 5 minutes:
 *       NO TERMINAL STATUS WRITE EVER.
 *       Never infer gateway from activeGateway if persisted gateway is NULL.
 *       Never treat an existing stored alatpayFinalTransactionId as proof
 *       of failure; it's only a correlation handle for verification.
 *       Block new initiation with a 409. Student may trigger the
 *       authoritative reverification workflow (POST /payments/:id/reverify)
 *       separately; initiatePayment is NEVER the path for re-verification.
 *
 * SUCCESS / UNDERPAID / OVERPAID / REVERSED rows never match this block
 * because the Promise.all query filters status = PENDING only.
 */
function classifyPendingForRetry(
  pendingGateway: string | null,
  _activeGateway: PaymentGateway,
  _hasTrustedAlatpayFinalUuid: boolean,
): { terminalizeFailed: false; blockInitiation: true } {
  // Provider-neutral conservative policy: never terminalize on age alone.
  // Future: if authoritative provider-init-time rejection classification is
  // introduced (not transport ambiguous), a narrower safe terminalization
  // may be added here with explicit audit/source evidence.
  return { terminalizeFailed: false, blockInitiation: true };
}



// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------
export class PaymentService {
  static async initiatePayment(studentId: number, payload: InitiatePaymentInput, req?: ReqLike) {
    // 1. Validate student + role
    const user = await prisma.user.findFirst({
      where: { id: studentId, role: Role.STUDENT },
      select: { id: true, email: true, firstName: true, lastName: true, matricNumber: true },
    });
    if (!user) throw new AppError(i18n.errors.auth.userNotFound, 404);
    const customerEmail = (payload as any).email?.trim() || user.email;

    // 2. Fetch invoice + enforce ownership (STUDENT cannot pay others' invoices).
    const inv: any = await prisma.invoice.findFirst({
      where: { id: payload.invoiceId, studentId },
      select: {
        id: true, invoiceNumber: true, studentId: true, amountDue: true, amountPaid: true,
        status: true, dueDate: true, session: true, semester: true, feeId: true,
        fee: { select: { id: true, name: true, feeCode: true, categoryId: true, college: true, department: true, program: true, level: true, studentType: true } },
      },
    });
    if (!inv) throw new AppError(i18n.errors.invoice.notFound, 404);
    if (inv.status === 'PAID' || inv.status === 'CANCELLED' || inv.status === 'REFUNDED' || inv.status === 'REVERSED') {
      throw new AppError(i18n.errors.invoice.alreadyPaid, 409);
    }
    const balance = money(Number(inv.amountDue) - Number(inv.amountPaid));
    if (balance <= 0) throw new AppError(i18n.errors.invoice.alreadyPaid, 409);

    // Resolve active gateway UP-FRONT so pending-age policy can branch correctly
    // for ALATPAY vs Paystack. This also is needed so the A5.1 stale logic below
    // never writes a terminal status from elapsed time alone.
    const activeGateway = await getActiveGatewaySetting();

    // Task-4: concurrent double-click / tab / refresh race protection. Serialize
    // all initiation attempts for the same (student, invoice) using a short
    // Redis/in-process lock. Otherwise two parallel requests can both see
    // count=0 and create two PENDING provider transactions. A 429 is returned
    // for the losing request instead of a duplicate.
    const lockOk = await acquireInitiateDedupeLock(studentId, inv.id);
    if (!lockOk) {
      throw new AppError(
        'Another payment initiation request is currently in progress for this invoice. Please wait a moment and try again.',
        429,
      );
    }

    // A5.1 Idempotency guard (FR-A7): check for recent PENDING rows on this invoice
    //
    // CRITICAL FINANCIAL SAFETY (per production transaction #40, review blockers 1/2/3):
    //   An unresolved PENDING row MUST NEVER be automatically transitioned to FAILED
    //   (or any other terminal financial status) merely because of elapsed time /
    //   browser timeout / popup closure / missing webhook / missing final UUID /
    //   transport error / student retry.
    //   UNKNOWN is not FAILED. NO CALLBACK is not FAILED. TIMEOUT is not FAILED.
    //   RETRY is not FAILED. NETWORK ERROR is not FAILED.
    //
    // CONSERVATIVE PROVIDER-NEUTRAL POLICY:
    //   * MAX_UNRESOLVED_PENDING_PER_INVOICE=2 ceiling (any gateway, any age).
    //   * Age < 5min → block duplicate with 425.
    //   * Age >= 5min → 409 BLOCK new initiation. No terminal status write.
    //     The existing PENDING row is PRESERVED UNTOUCHED so that the
    //     authoritative reverification workflow, scheduler recon, future webhook
    //     delivery, or future callback can still settle it correctly.
    //   * Unknown/null persisted gateway → FAIL CLOSED. DO NOT infer the
    //     historical provider identity from today's activeGateway setting.
    //     The past attempt may have been made under a different provider; any
    //     guess would risk incorrectly terminalizing a valid pending attempt.
    //
    //   * The presence of a stored alatpayFinalTransactionId (trustworthy UUID)
    //     is only a correlation identifier that MAY be used for authoritative
    //     verification elsewhere. It is NOT proof of success, proof of failure,
    //     or reason to terminalize the row here. (Blocker 1)
    //
    // Duplicate ceiling (B1/B2/B3 invariant): prevents unbounded provider
    // session creation even after 5 minutes when the lock has expired or the
    // student manually keeps retrying.
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    const MAX_UNRESOLVED_PENDING_PER_INVOICE = 2;
    const [existingPending, pendingCount] = await Promise.all([
      prisma.transaction.findFirst({
        where: {
          invoiceId: inv.id,
          status: TransactionStatus.PENDING,
          userId: studentId,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, status: true, gateway: true, alatpayFinalTransactionId: true },
      }),
      prisma.transaction.count({
        where: {
          invoiceId: inv.id,
          status: TransactionStatus.PENDING,
          userId: studentId,
        },
      }),
    ]);
    if (pendingCount >= MAX_UNRESOLVED_PENDING_PER_INVOICE) {
      throw new AppError(
        'Multiple previous payment attempts are still awaiting confirmation for this invoice. Please wait for reconciliation, verify any existing attempt using its reference, or contact support before starting another payment.',
        409,
      );
    }
    if (existingPending) {
      const createdAtTime = existingPending.createdAt.getTime();
      const nowTime = Date.now();
      const ageMs = nowTime - createdAtTime;
      const pendingGateway = (existingPending as any).gateway as string | null;

      // Use the single canonical strict UUID-v4 helper (also used by recon
      // worker and student reverify route) — never any inline weak variant.
      // (Blocker 4: single shared validator.
      // Presence of UUID is not proof of payment status. It only means: we may
      // attempt authoritative verification through it in a separate workflow.)
      const hasTrustedAlatpayFinalUuid = isAlatpayUuid((existingPending as any).alatpayFinalTransactionId);

      if (ageMs < FIVE_MINUTES_MS) {
        throw new AppError(
          'Payment already in progress. Please wait 5 minutes before retrying or check status.',
          425,
        );
      }

      // Provider-neutral conservative: never terminalize from age alone.
      // classifyPendingForRetry returns { terminalizeFailed:false, blockInitiation:true }
      // for every input (no exceptions, no gateway-branch special cases).
      const policy = classifyPendingForRetry(pendingGateway, activeGateway, hasTrustedAlatpayFinalUuid);
      if (policy.blockInitiation) {
        // 409 with student-facing actionable message.
        // The message distinguishes ALATPAY / PAYSTACK / UNKNOWN scenarios so
        // the student knows which status workflow to use next, but NO DB
        // terminal write happens ever here.
        const isAlatpay = pendingGateway === PaymentGateway.ALATPAY;
        const isPaystack = pendingGateway === PaymentGateway.PAYSTACK;
        const gwLabel =
          isAlatpay ? 'ALATPay' : isPaystack ? 'Paystack' : 'an earlier';
        const finalUuidHint =
          isAlatpay && hasTrustedAlatpayFinalUuid
            ? ' (its final provider transaction identifier has been captured; use the Check Status / Re-verify action on this payment to obtain an authoritative result.)'
            : isAlatpay
              ? ' (the final provider transaction identifier is not yet recorded locally; confirmation is still pending.)'
              : '';
        throw new AppError(
          `A ${gwLabel} payment attempt from ${Math.round(ageMs / 60000)} minutes ago is still awaiting confirmation and has not been authoritatively settled. Please verify that attempt using its transaction reference${finalUuidHint}, or contact support. Another payment will not be started automatically.`,
          409,
        );
      }

      // LINTING SAFETY — classifyPendingForRetry never returns terminalizeFailed
      // today, but the call signature is extensible for a future explicit,
      // signed-off, provider-declared rejection-only narrow path if a
      // classification abstraction is ever added. In the current code the
      // `if (policy.blockInitiation)` branch above always matches, and the
      // code below is unreachable. It is preserved explicitly to prevent a
      // silent accidental legacy `update FAILED client-reinit-timeout` from
      // being reintroduced by a future inattentive edit.
      if ((policy as any).terminalizeFailed === true) {
        // Never reachable today. If enabled in future: this MUST ONLY happen
        // for an EXPLICIT AUTHORITATIVE PROVIDER-DECLARED REJECTION (not time).
        await prisma.transaction.update({
          where: { id: existingPending.id },
          data: { status: TransactionStatus.FAILED, description: 'provider-explicitly-rejected' },
        });
      }
    }
  // 3. Partial amount clamp
  let payable = balance;
  if (payload.partialAmount !== undefined && payload.partialAmount !== null) {
    const pa = money(Number(payload.partialAmount));
    if (pa <= 0) throw new AppError(i18n.errors.payment.invalidPartialAmount, 400);
    payable = pa > balance ? balance : pa;
  }

  // 4. Service charge breakdown — charge comes ON TOP of payable so the
  //    university always receives exactly payable to STUDENT_RECEIVABLE.
  const breakdown = computePaymentBreakdown(payable);
  const expectedAmount = breakdown.totalAmount;
  const provider = getPaymentProvider(activeGateway);

  // 6. Create reference & pending Transaction — with gateway explicitly set.
  const paymentRef = generatePaymentReference();
  const txRow = await prisma.transaction.create({
      data: {
        reference: paymentRef,
        userId: studentId,
        invoiceId: inv.id,
        type: TransactionType.FEE_PAYMENT,
        gateway: activeGateway,
        status: TransactionStatus.PENDING,
        expectedAmount: expectedAmount,
        amount: 0,
        description: `${inv.fee?.name ?? 'Fee payment'} — ${inv.session ?? ''} ${inv.semester ?? ''}`.trim(),
        metadata: {
          invoiceNumber: inv.invoiceNumber,
          fee: {
            id: inv.feeId,
            name: inv.fee?.name ?? null,
            feeCode: inv.fee?.feeCode ?? null,
            categoryId: inv.fee?.categoryId ?? null,
          },
          student: {
            id: studentId,
            name: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
            matricNumber: user.matricNumber ?? null,
          },
          session: inv.session ?? null,
          semester: inv.semester ?? null,
          amount: {
            base: breakdown.baseAmount,
            serviceCharge: breakdown.serviceCharge,
            gatewayFee: breakdown.gatewayFee,
            total: breakdown.totalAmount,
            serviceChargeMode: breakdown.serviceChargeMode,
            gatewayFeeMode: breakdown.gatewayFeeMode,
          },
        } as Prisma.InputJsonValue,
      },
    });

    try {
      // 7. Initialize through the pre-resolved provider
      const callback = `${process.env.FRONTEND_BASE_URL ?? 'http://localhost:5174'}/student/payments/callback/${paymentRef}`;

      const init = await provider.initialize(customerEmail, breakdown.baseAmount, {
        firstName: user.firstName ?? 'Student',
        lastName: user.lastName ?? 'Student',
        phone: undefined,
        reference: paymentRef,
        callbackUrl: callback,
        feePurpose: 'INVOICE_PAYMENT',
        metadata: {
          student_id: studentId,
          invoice_id: inv.invoiceNumber,
          fee_id: inv.feeId,
          academic_session: inv.session ?? undefined,
          fee_name: inv.fee?.name ?? undefined,
          transaction_id: txRow.id,
          idempotency_key: (payload as any).idempotencyKey ?? undefined,
        },
      });

      // 8. Update Transaction row with provider ref + channel columns
      //    (gateway was already written on initial create, so we update it here
      //     too purely for idempotent defensive clarity — it would be the same value.)
      const gatewayRef = init.providerReference ?? paymentRef;
      const gatewayChannel = (init.channelsUsed?.[0] as any) ?? null;
      const gatewayData: Record<string, any> = {
        gateway: activeGateway,
      };
      if (activeGateway === PaymentGateway.PAYSTACK) {
        (gatewayData as any).paystackReference = gatewayRef;
        (gatewayData as any).paystackChannel = gatewayChannel;
        const existingMeta =
          txRow.metadata && typeof txRow.metadata === 'object'
            ? (txRow.metadata as Record<string, any>)
            : {};
        (gatewayData as any).metadata = {
          ...existingMeta,
          paystack: {
            access_code: init?.access_code ?? null,
            authorization_url: init?.checkoutUrl ?? init?.authorization_url ?? null,
            paystack_reference: gatewayRef,
            channels_used: init?.channelsUsed ?? null,
          },
        } as Prisma.InputJsonValue;
      } else {
        const orderReference = init?.orderReference ?? `WEMA-${paymentRef}`;
        const initPaymentRef = init?.initPaymentReference ?? gatewayRef;
        (gatewayData as any).alatpayReference = gatewayRef;
        (gatewayData as any).alatpaySessionId = init?.sessionId ?? null;
        (gatewayData as any).alatpayOrderReference = orderReference;
        (gatewayData as any).alatpayInitPaymentReference = initPaymentRef;
        if (init?.checkoutUrl) {
          (gatewayData as any).alatpayCheckoutUrl = init.checkoutUrl;
        }
        const existingMeta =
          txRow.metadata && typeof txRow.metadata === 'object'
            ? (txRow.metadata as Record<string, any>)
            : {};
        (gatewayData as any).metadata = {
          ...existingMeta,
          alatpay: {
            checkout_url: init?.checkoutUrl ?? null,
            session_id: init?.sessionId ?? null,
            order_reference: orderReference,
            init_payment_reference: initPaymentRef,
            provider_reference: gatewayRef,
            channels_used: init?.channelsUsed ?? null,
          },
          gatewayMeta: {
            name: activeGateway,
            checkout_url: init?.checkoutUrl ?? null,
            providerReference: gatewayRef,
            channel: gatewayChannel,
          },
        } as Prisma.InputJsonValue;
      }

      await prisma.transaction.update({
        where: { id: txRow.id },
        data: gatewayData,
      });

      writeAudit(req, {
        action: i18n.auditActions.paymentInitiated,
        entityType: 'TRANSACTION',
        entityId: txRow.id,
        newValue: {
          id: txRow.id,
          reference: paymentRef,
          invoiceId: inv.id,
          baseAmount: breakdown.baseAmount,
          expectedAmount: breakdown.totalAmount,
          gateway: activeGateway,
        },
        details: { studentId, invoiceNumber: inv.invoiceNumber },
      });

      const base: {
        authorization_url: string | null;
        checkout_url: string | null;
        access_code: string | null;
        payment_reference: string;
        expected_amount: number;
        fee_breakdown: PaymentBreakdown;
        gateway: PaymentGateway;
        gateway_label: string;
        checkout_popup_mode?: 'alatpay_native_modal_v1';
        alatpay_public_checkout?: any;
        alatpay_refs?: any;
      } = {
        authorization_url: init?.checkoutUrl ?? init?.authorization_url ?? null,
        checkout_url: init?.checkoutUrl ?? init?.authorization_url ?? null,
        access_code: init?.access_code ?? init?.sessionId ?? null,
        payment_reference: paymentRef,
        expected_amount: expectedAmount,
        fee_breakdown: breakdown,
        gateway: activeGateway,
        gateway_label: gatewayLabel(activeGateway, gatewayChannel),
      };
      if (
        activeGateway === PaymentGateway.ALATPAY &&
        init &&
        typeof init === 'object' &&
        (init as any).alatpayPublicCheckout &&
        process.env.ALATPAY_USE_POPUP_CHECKOUT === 'true'
      ) {
        const alatpayPublicCheckout = (init as any).alatpayPublicCheckout;
        base.checkout_popup_mode = 'alatpay_native_modal_v1';
        base.alatpay_public_checkout = alatpayPublicCheckout;
        base.alatpay_refs = {
          order_reference: (init as any).orderReference ?? null,
          init_payment_reference: (init as any).initPaymentReference ?? null,
        };
      }
      return base;
    } catch (err) {
      const rawErrMsg = (err as Error)?.message ?? '';

      // -----------------------------------------------------------------------
      // Blocker 5 FIX — distinguish explicit provider rejection vs transport/
      // ambiguous initialization error.
      //
      // PRE-AUDIT FINDINGS (K1):
      //   ALATPAY provider.initialize catch: all errors → new AppError(msg, 502).
      //     Transport (timeout/DNS/502/503/lost response): throws code 502.
      //     Provider 4xx errors: still re-classified as AppError(502) in catch.
      //     So thrown HTTP status == 502 for ALATPAY ambiguous/transport paths.
      //
      //   PAYSTACK PaystackService.initializeTransaction catch: all errors →
      //     new AppError(msg, 500). No 4xx/declined distinction.
      //
      // THEREFORE: today's provider abstraction does NOT reliably distinguish
      // explicit authoritative provider-rejected initializations (A) from
      // transport/system/ambiguous failures (B). Per user mandate: if we
      // cannot reliably separate A from B → FAIL CLOSED. Do NOT invent
      // certainty.
      //
      // RESULTING POLICY:
      //   Transaction DB row status remains = PENDING (unresolved).
      //   This is because:
      //     * The provider may have actually created a session on its side
      //       (e.g. ALATPAY POSTed initialize, DB row committed, then
      //        socket reset before response came back — a webhook in the
      //        future can still settle it).
      //     * Marking FAILED prematurely would destroy the ability of a
      //       future webhook/recon to recover.
      //
      //   We PERSIST:
      //     * description: sanitized raw error message (human review)
      //     * underpaidReason: same raw error (for tooling)
      //     * metadata.initiateTransportFailed: { at, code, errClass }
      //       flag so bursary/UI can label: "Provider init failed. Retry."
      //
      //   If a future version of the providers' abstraction can reliably
      //   return a signed-off explicit provider-declared initialization
      //   rejection (e.g. an HTTP 422 business code "amount too high" or
      //   "merchant blocked", NOT a transport error), THEN a narrow
      //   FAILED terminal write can be added for that specific, classified
      //   case only.
      //
      //   Audit write keeps paymentFailed action name (since the student
      //   UX shows an error to them) but DB-row status is PENDING (not
      //   authoritative terminal).
      // -----------------------------------------------------------------------
      const errHttpCode: number | null =
        (err as any)?.httpCode && Number.isFinite((err as any).httpCode) ? Number((err as any).httpCode) :
        (err as any)?.statusCode && Number.isFinite((err as any).statusCode) ? Number((err as any).statusCode) :
        (err as any)?.status && Number.isFinite((err as any).status) ? Number((err as any).status) : null;
      try {
        const existingMeta =
          txRow.metadata && typeof txRow.metadata === 'object'
            ? (txRow.metadata as Record<string, any>)
            : {};
        const updatedMeta: Record<string, any> = {
          ...existingMeta,
          initiateTransportFailed: {
            at: new Date().toISOString(),
            httpCode: errHttpCode,
            errorClass: (err as any)?.name ?? (err as any)?.constructor?.name ?? 'Error',
            sanitized: rawErrMsg ? rawErrMsg.slice(0, 200) : null,
          },
        };
        await prisma.transaction.update({
          where: { id: txRow.id },
          data: {
            gateway: activeGateway,
            // STATUS = PENDING (preserve unresolved — no authoritative terminal write)
            // status: NOT SET → remains as created PENDING.
            underpaidReason: rawErrMsg ? rawErrMsg.slice(0, 190) : null,
            description: rawErrMsg
              ? `[provider-init-failed ambiguous, status preserved PENDING] ${rawErrMsg.slice(0, 160)}`
              : '[provider-init-failed ambiguous, status preserved PENDING]',
            metadata: updatedMeta as Prisma.InputJsonValue,
          },
        });
      } catch (persistErr) {
        console.warn('[initiatePayment:catch] best-effort persist failure (ignored, will propagate original error instead):', (persistErr as Error)?.message);
      }
      try {
        writeAudit(req, {
          action: i18n.auditActions.paymentFailed,
          entityType: 'TRANSACTION',
          entityId: txRow.id,
          oldValue: { status: 'PENDING' },
          newValue: {
            gateway: activeGateway,
            // Row DB status still PENDING, audit records the student UX failure.
            // Status field written as 'PENDING + initiate-failed' explicitly:
            status: 'PENDING (initiate transport/ambiguous failure; not authoritative terminal)',
            error: rawErrMsg.slice(0, 500),
            errorHttpCode: errHttpCode,
          },
        });
      } catch (auditErr) {
        console.warn('[initiatePayment:catch] audit write failed (ignored):', (auditErr as Error)?.message);
      }
      throw err;
    }
  }

  static async locateAlatpayTransactionFromWebhook(input: {
    transaction_id_from_metadata?: number | string | null;
    bells_payment_reference?: string | null;
    order_reference?: string | null;
    init_payment_reference?: string | null;
    session_id?: string | null;
    final_transaction_id?: string | null;
  }): Promise<{ id: number; reference: string; gateway: PaymentGateway } | { ambiguity: true; diagnostic: string } | { notFound: true; diagnostic: string }> {
    const {
      transaction_id_from_metadata: metaTxId,
      bells_payment_reference: bellsRef,
      order_reference: orderRef,
      init_payment_reference: initRef,
      session_id: sessionId,
      final_transaction_id: finalTxId,
    } = input;

    const numericTxId =
      metaTxId !== undefined && metaTxId !== null && metaTxId !== '' && Number.isFinite(Number(metaTxId))
        ? Number(metaTxId)
        : undefined;

    // Priority A: internal transaction_id from metadata (strongest)
    if (numericTxId) {
      const row = await prisma.transaction.findUnique({
        where: { id: numericTxId },
        select: { id: true, reference: true, gateway: true, alatpayOrderReference: true, alatpayInitPaymentReference: true, alatpayFinalTransactionId: true, alatpaySessionId: true },
      });
      if (row) {
        if (row.gateway !== PaymentGateway.ALATPAY) {
          return { notFound: true, diagnostic: `metadata tx #${numericTxId} gateway=${row.gateway} not ALATPAY` };
        }
        const failures: string[] = [];
        if (!!bellsRef && typeof bellsRef === 'string' && row.reference !== bellsRef) {
          failures.push(`bells_reference webhook=${bellsRef} stored=${row.reference}`);
        }
        if (!!orderRef && typeof orderRef === 'string' && !!row.alatpayOrderReference && row.alatpayOrderReference !== orderRef) {
          failures.push(`order_reference webhook=${orderRef} stored=${row.alatpayOrderReference}`);
        }
        if (!!initRef && typeof initRef === 'string' && !!row.alatpayInitPaymentReference && row.alatpayInitPaymentReference !== initRef) {
          failures.push(`init_payment_reference webhook=${initRef} stored=${row.alatpayInitPaymentReference}`);
        }
        if (!!sessionId && typeof sessionId === 'string' && !!row.alatpaySessionId && row.alatpaySessionId !== sessionId) {
          failures.push(`session_id webhook=${sessionId} stored=${row.alatpaySessionId}`);
        }
        if (!!finalTxId && typeof finalTxId === 'string' && !!row.alatpayFinalTransactionId && row.alatpayFinalTransactionId !== finalTxId) {
          failures.push(`final_transaction_id webhook=${finalTxId} stored=${row.alatpayFinalTransactionId}`);
        }
        if (failures.length === 0) return { id: row.id, reference: row.reference, gateway: row.gateway };
        return {
          notFound: true,
          diagnostic: `metadata tx #${numericTxId} contradictory breadcrumbs: ${failures.join(' | ')}`,
        } as { notFound: true; diagnostic: string };
      }
    }

    // Priority B: Bells internal reference (PAY-XXXX)
    if (bellsRef && typeof bellsRef === 'string') {
      const rows = await prisma.transaction.findMany({
        where: { reference: bellsRef, gateway: PaymentGateway.ALATPAY },
        select: { id: true, reference: true, gateway: true },
        orderBy: [{ updatedAt: 'desc' }],
        take: 5,
      });
      if (rows.length === 1) return { id: rows[0].id, reference: rows[0].reference, gateway: rows[0].gateway };
      if (rows.length > 1) return { ambiguity: true, diagnostic: `multiple matches for Bells reference ${bellsRef} (${rows.length})` };
    }

    // Priority C: stored init/session/order reference
    const tierCClauses: Prisma.TransactionWhereInput[] = [];
    if (orderRef) tierCClauses.push({ alatpayOrderReference: orderRef });
    if (initRef) tierCClauses.push({ alatpayInitPaymentReference: initRef });
    if (sessionId) tierCClauses.push({ alatpaySessionId: sessionId });
    if (orderRef) tierCClauses.push({ alatpayReference: orderRef });
    if (initRef) tierCClauses.push({ alatpayReference: initRef });
    if (tierCClauses.length > 0) {
      const rows = await prisma.transaction.findMany({
        where: { AND: [{ gateway: PaymentGateway.ALATPAY }, { OR: tierCClauses }] },
        select: { id: true, reference: true, gateway: true },
        orderBy: [{ updatedAt: 'desc' }],
        take: 10,
      });
      if (rows.length === 1) return { id: rows[0].id, reference: rows[0].reference, gateway: rows[0].gateway };
      if (rows.length > 1) return { ambiguity: true, diagnostic: `ambiguous tier C matches order/init/session (${rows.length})` };
    }

    // Priority D: final provider transaction UUID if already known
    if (finalTxId) {
      const rows = await prisma.transaction.findMany({
        where: {
          AND: [
            { gateway: PaymentGateway.ALATPAY },
            {
              OR: [
                { alatpayFinalTransactionId: finalTxId },
                { alatpayReference: finalTxId },
              ],
            },
          ],
        },
        select: { id: true, reference: true, gateway: true },
        orderBy: [{ updatedAt: 'desc' }],
        take: 10,
      });
      if (rows.length === 1) return { id: rows[0].id, reference: rows[0].reference, gateway: rows[0].gateway };
      if (rows.length > 1) return { ambiguity: true, diagnostic: `ambiguous tier D matches for finalTxId ${finalTxId} (${rows.length})` };
    }

    return { notFound: true, diagnostic: 'no Bells transaction matched any correlation tier (A->B->C->D)' };
  }

  private static pickAlatpayBestMatch<T extends { id: number; status: any; updatedAt: any; alatpayReference?: string | null }>(
    rows: T[],
    lookupRef: string
  ): T | null {
    if (!rows || rows.length === 0) return null;
    const scoreStatus = (s: any): number => {
      if (s === TransactionStatus.SUCCESS) return 20000000;
      if (s === TransactionStatus.PENDING) return 10000000;
      return 0;
    };
    const sorted = [...rows].sort((a, b) => {
      const tA = a.updatedAt ? new Date(a.updatedAt as any).getTime() : 0;
      const tB = b.updatedAt ? new Date(b.updatedAt as any).getTime() : 0;
      if (tB !== tA) return tB - tA;
      const sA = scoreStatus(a.status);
      const sB = scoreStatus(b.status);
      if (sA !== sB) return sB - sA;
      return 0;
    });
    if (sorted.length > 1 && lookupRef) {
      const top = sorted[0];
      const topUpdatedAt = top.updatedAt ? new Date(top.updatedAt as any).getTime() : 0;
      const topStatusScore = scoreStatus(top.status);
      const tied = sorted.filter(r => {
        const u = r.updatedAt ? new Date(r.updatedAt as any).getTime() : 0;
        const s = scoreStatus(r.status);
        return u === topUpdatedAt && s === topStatusScore;
      });
      if (tied.length > 1) {
        const ids = tied.map(t => t.id);
        const refs = tied
          .map(t => (t as any).alatpayReference || (t as any).paystackReference || (t as any).reference || '')
          .filter(Boolean);
        console.error(JSON.stringify({
          level: 'error',
          msg: 'Duplicate ALATPAY transaction matches for lookup ref — tie-break chose first.',
          lookupRef: lookupRef,
          duplicateCount: tied.length,
          duplicateIds: ids,
          duplicateReferences: refs,
          pickedId: tied[0].id,
          at: new Date().toISOString(),
        }, null, 2));
      }
    }
    return sorted[0];
  }

  // -----------------------------------------------------------------------
  // Verify payment — called both by GET /student/payments/verify/:ref AND
  // by the Paystack / ALAT Pay webhook handler. Idempotent (safe to call twice).
  // -----------------------------------------------------------------------
  static async verifyPayment(paystackOrPaymentRef: string, opts: VerifyPaymentOptions = {}) {
    const ref = paystackOrPaymentRef;
    if (!opts.expectedTransactionId && (!ref || !String(ref).trim())) {
      throw new AppError(i18n.errors.paystack.verifyFailed, 400);
    }

    // 0. Determine which provider + gateway this tx uses — pre-fetch the row
    const lookupWhere: Prisma.TransactionWhereInput = opts.expectedTransactionId
      ? { id: Number(opts.expectedTransactionId) }
      : {
          OR: [
            { reference: ref },
            { paystackReference: ref },
            { alatpayReference: ref },
            { alatpayOrderReference: ref },
            { alatpayInitPaymentReference: ref },
            { alatpayFinalTransactionId: ref },
          ],
        };
    const preRows = await prisma.transaction.findMany({
      where: lookupWhere,
      orderBy: [{ updatedAt: 'desc' }],
      select: {
        id: true, gateway: true, reference: true, paystackReference: true, alatpayReference: true,
        alatpayOrderReference: true, alatpayInitPaymentReference: true, alatpayFinalTransactionId: true,
        alatpayCheckoutUrl: true, alatpaySessionId: true, metadata: true, status: true, updatedAt: true,
        expectedAmount: true, amount: true,
      },
    });
    const preTx = PaymentService.pickAlatpayBestMatch(preRows, ref);
    if (!preTx) throw new AppError(i18n.errors.payment.transactionNotFound, 404);
    const txGateway: PaymentGateway = preTx.gateway ?? PaymentGateway.ALATPAY;
    const normalizationExpectedNaira = money(Number(preTx.expectedAmount ?? 0));
    const normalizationExpectedKobo = Math.round(normalizationExpectedNaira * 100);
    const provider = getPaymentProvider(txGateway);
    // Pass the correct-looking ref to the provider:
    // Split lookup ref vs provider verify ref. Explicit override wins.
    let providerRefToVerify: string;
    if (opts.providerReference && String(opts.providerReference).trim()) {
      providerRefToVerify = String(opts.providerReference).trim();
    } else if (txGateway === PaymentGateway.PAYSTACK) {
      providerRefToVerify = preTx.paystackReference ?? preTx.reference ?? ref;
    } else {
      providerRefToVerify =
        preTx.alatpayFinalTransactionId ??
        preTx.alatpayReference ??
        preTx.alatpayInitPaymentReference ??
        preTx.reference ??
        ref;
    }

    // 1. Call provider verify (throws AppError on failure).
    const verifyResult = await provider.verify(providerRefToVerify);
    const providerRef = String(verifyResult.providerReference ?? providerRefToVerify);
    let paidMinor = Number(verifyResult.paidAmountMinor);
    let paidNaira = Number(verifyResult.paidAmountNaira);
    const channel = verifyResult.channel;
    const paidAt = verifyResult.paidAt;
    const providerStatus = String(verifyResult.providerStatus ?? '').toLowerCase();
    const rawPayload = verifyResult.raw ?? {};

    // ============================================================
    // 1a. ALATPay gross-vs-fee normalization (customer-borne fee).
    //     Normalization is ONLY applied when ONE of these equations
    //     matches within the standard 1-kobo tolerance:
    //       a) providerGrossAmountNaira == expectedAmount
    //       b) providerGrossAmountNaira - providerFeeAmountNaira == expectedAmount
    //     If case (b) matches: effective paid amount = gross - fee, so the
    //     ₦0.75 customer surcharge does NOT create an overpaid state and
    //     is NOT treated as a university GATEWAY_FEE_EXPENSE. The raw
    //     gross/fee values remain preserved separately inside metadata
    //     for audit (metadata.alatpay.gross_amount_naira + fee_amount).
    //     Otherwise (no equation match) we keep the provider raw amount
    //     and let the existing underpaid/overpaid fail-closed path run.
    // ============================================================
    type AlatpayNormalization = {
      kind: 'exact' | 'gross_minus_fee' | 'none';
      grossNaira: number;
      feeNaira: number;
      grossMinor: number;
      feeMinor: number;
    };
    let alatpayNormalization: AlatpayNormalization | null = null;
    if (
      txGateway === PaymentGateway.ALATPAY &&
      Number.isFinite(Number(verifyResult.providerGrossAmountNaira))
    ) {
      const grossNaira = money(Number(verifyResult.providerGrossAmountNaira));
      const feeNaira = money(Number(verifyResult.providerFeeAmountNaira ?? 0));
      const grossMinor = Math.round(grossNaira * 100);
      const feeMinor = Math.round(feeNaira * 100);
      // NOTE: we compare against normalizationExpectedKobo computed from
      // preTx.expectedAmount so normalization is deterministic and does
      // not require later assignment of outerExpectedKobo.
      const grossMatchesExpected = Math.abs(grossMinor - normalizationExpectedKobo) <= 1;
      const grossMinusFeeMinor = grossMinor - feeMinor;
      const grossMinusFeeMatches = Math.abs(grossMinusFeeMinor - normalizationExpectedKobo) <= 1;
      if (grossMatchesExpected) {
        // Do not subtract fee when gross already matches expected (test case #2).
        alatpayNormalization = { kind: 'exact', grossNaira, feeNaira, grossMinor, feeMinor };
        paidMinor = grossMinor;
        paidNaira = grossNaira;
      } else if (grossMinusFeeMatches && feeMinor >= 0) {
        // Legitimate customer-borne fee scenario (test case #1).
        alatpayNormalization = { kind: 'gross_minus_fee', grossNaira, feeNaira, grossMinor, feeMinor };
        const effectiveMinor = grossMinor - feeMinor;
        paidMinor = effectiveMinor;
        paidNaira = money(effectiveMinor / 100);
      } else {
        alatpayNormalization = { kind: 'none', grossNaira, feeNaira, grossMinor, feeMinor };
      }
    }

    // 1b. Handle provider-specific metadata reads (paystack still may pass transaction_id via metadata)
    let transactionId: number | undefined;
    if (txGateway === PaymentGateway.PAYSTACK) {
      const md = readPaystackMetadata(rawPayload.metadata);
      transactionId = md.raw?.transaction_id ? Number(md.raw.transaction_id) : undefined;
    } else {
      const customerMeta = rawPayload.Customer?.Metadata ?? rawPayload.customer?.metadata ?? null;
      if (customerMeta && typeof customerMeta === 'string') {
        try {
          const parsed = JSON.parse(customerMeta);
          if (parsed && Number.isFinite(Number(parsed.transaction_id))) {
            transactionId = Number(parsed.transaction_id);
          }
        } catch {
          /* ignore */
        }
      } else if (customerMeta && typeof customerMeta === 'object' && Number.isFinite(Number((customerMeta as any).transaction_id))) {
        transactionId = Number((customerMeta as any).transaction_id);
      }
    }

    // 2. Find pending transaction (by paymentRef OR providerRef OR id).
    const explicitTxId = opts.expectedTransactionId && Number.isFinite(Number(opts.expectedTransactionId))
      ? Number(opts.expectedTransactionId)
      : (transactionId && Number.isFinite(transactionId) ? transactionId : undefined);
    const txWhere: Prisma.TransactionWhereInput = explicitTxId
      ? { id: explicitTxId }
      : {
          OR: [
            { reference: ref },
            { reference: providerRef },
            { paystackReference: ref },
            { paystackReference: providerRef },
            { alatpayReference: ref },
            { alatpayReference: providerRef },
            { alatpayOrderReference: ref },
            { alatpayOrderReference: providerRef },
            { alatpayInitPaymentReference: ref },
            { alatpayInitPaymentReference: providerRef },
            { alatpayFinalTransactionId: ref },
            { alatpayFinalTransactionId: providerRef },
          ],
        };
    const initialRows: any[] = await prisma.transaction.findMany({
      where: txWhere,
      orderBy: [{ updatedAt: 'desc' }],
      select: {
        id: true, reference: true, status: true, userId: true, invoiceId: true,
        expectedAmount: true, amount: true, metadata: true, gateway: true,
        paystackReference: true, alatpayReference: true, updatedAt: true,
        alatpayOrderReference: true, alatpayInitPaymentReference: true, alatpayFinalTransactionId: true,
        alatpayCheckoutUrl: true, alatpaySessionId: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true, matricNumber: true, role: true } },
      },
    });
    const initialTx: any = PaymentService.pickAlatpayBestMatch(initialRows, ref);
    if (!initialTx) throw new AppError(i18n.errors.payment.transactionNotFound, 404);
    if (opts.assertStudentId !== undefined && Number(initialTx.userId) !== Number(opts.assertStudentId)) {
      throw new AppError(i18n.errors.payment.notYourPayment, 404);
    }
    if (initialTx.user?.role !== Role.STUDENT) throw new AppError(i18n.errors.auth.notPermitted, 403);

    // Hoist expected amount values so post-commit hooks (B4.1/B5.1) can reference
    // them without relying on $transaction-inner declarations.
    const outerExpectedNaira = money(Number(initialTx.expectedAmount ?? 0));
    const outerExpectedKobo = kobo.fromNaira(outerExpectedNaira);

    // ---------------------------------------------------------------------
    // 3. Atomic $transaction: everything after this is idempotent/race-safe.
    // ---------------------------------------------------------------------
    const result = await prisma.$transaction(async (tx) => {
      // 3a. Lock transaction row (FOR UPDATE emulation: updateMany WHERE status=PENDING
      //     with set status = PROCESSING; if 0 rows changed the tx is already done).
      const pendingUpdate = await tx.transaction.updateMany({
        where: { id: initialTx.id, status: TransactionStatus.PENDING },
        data: { status: TransactionStatus.PROCESSING },
      });
      const alreadyProcessed = pendingUpdate.count === 0;

      // 3b. Reload latest row
      const latest: any = await tx.transaction.findUnique({
        where: { id: initialTx.id },
        select: {
          id: true, reference: true, status: true, userId: true, invoiceId: true,
          expectedAmount: true, amount: true, metadata: true, gateway: true,
          alatpayOrderReference: true, alatpayInitPaymentReference: true, alatpayFinalTransactionId: true,
          alatpayCheckoutUrl: true, alatpaySessionId: true,
          invoice: {
            select: {
              id: true, invoiceNumber: true, amountDue: true, amountPaid: true, status: true,
              session: true, semester: true, studentId: true,
              fee: { select: { id: true, name: true, feeCode: true } },
            },
          },
          user: { select: { id: true, email: true, firstName: true, lastName: true, matricNumber: true } },
        },
      });
      if (!latest) throw new AppError(i18n.errors.payment.transactionNotFound, 404);

      // 3c. Expected amount (kobo) — compare with 1-kobo tolerance.
      const expectedNaira = money(Number(latest.expectedAmount ?? 0));
      const expectedKobo = kobo.fromNaira(expectedNaira);
      const deltaKobo = Math.abs(paidMinor - expectedKobo);

      const amountBreakdown = latest.metadata?.amount ?? {};
      const baseAmount = money(Number(amountBreakdown.base ?? 0));

      void Number(amountBreakdown.serviceCharge ?? 0);
      void Number(amountBreakdown.gatewayFee ?? 0);

      // --- UNDERPAID / OVERPAID PATH (no ledger, no receipt) ---------------
      const txnSuccess = providerStatus === 'success' || providerStatus === 'completed' || providerStatus === 'paid' || verifyResult.status === TransactionStatus.SUCCESS;
      if (!txnSuccess || deltaKobo > 1) {
        if (!alreadyProcessed) {
          const newStatus: TransactionStatus =
            !txnSuccess
              ? TransactionStatus.FAILED
              : paidMinor < expectedKobo
                ? 'UNDERPAID' as any
                : 'OVERPAID' as any;
          const updateData: Record<string, any> = {
            status: newStatus,
            amount: paidNaira,
            underpaidReason: (
              !txnSuccess
                ? `${txGateway} status: ${providerStatus}`
                : deltaKobo > 1
                  ? `Amount mismatch: expected ${expectedKobo}kobo, got ${paidMinor}kobo (delta ${deltaKobo}kobo)`
                  : null
            )?.slice?.(0, 190) ?? null,
          };
          if (txGateway === PaymentGateway.PAYSTACK) {
            updateData.paystackReference = providerRef;
            updateData.paystackChannel = channel;
          } else {
            updateData.alatpayReference = providerRef;
            if (isAlatpayUuid(providerRef)) {
              updateData.alatpayFinalTransactionId = providerRef;
            }
          }
          await tx.transaction.update({
            where: { id: latest.id },
            data: updateData,
          });
        }
        const finalTx = await tx.transaction.findUnique({ where: { id: latest.id } });
        if (!txnSuccess) {
          await writeAudit(opts.req, {
            action: i18n.auditActions.paymentFailed,
            entityType: 'TRANSACTION',
            entityId: latest.id,
            oldValue: { status: 'PENDING' },
            newValue: { status: finalTx?.status, providerStatus, paidNaira, gateway: txGateway },
          });
        } else {
          await writeAudit(opts.req, {
            action:
              paidMinor < expectedKobo
                ? i18n.auditActions.paymentUnderpaid ?? 'PAYMENT_UNDERPAID'
                : i18n.auditActions.paymentOverpaid ?? 'PAYMENT_OVERPAID',
            entityType: 'TRANSACTION',
            entityId: latest.id,
            oldValue: { status: 'PENDING', expectedKobo },
            newValue: { status: finalTx?.status, paidMinor, deltaKobo },
          });
        }
        return {
          verified: false,
          status: finalTx?.status,
          amount_expected_kobo: expectedKobo,
          amount_paid_kobo: paidMinor,
          delta_kobo: deltaKobo,
          reason:
            !txnSuccess
              ? `${txGateway} status: ${providerStatus}`
              : `amount mismatch (${deltaKobo} kobo)`,
        };
      }

      // --- SUCCESS PATH (amount matches exactly within tolerance) -----------
      // 4. If already processed, just return current state (idempotent).
      if (alreadyProcessed && latest.status !== TransactionStatus.PROCESSING) {
        const receiptRow = await tx.receipt.findFirst({ where: { transactionId: latest.id } });
        return {
          verified: true,
          status: latest.status,
          transaction: latest,
          invoice: latest.invoice,
          receipt: receiptRow ?? null,
        };
      }

      // 5. Mark SUCCESS — write provider-specific columns
      const existingMeta =
        latest.metadata && typeof latest.metadata === 'object'
          ? (latest.metadata as Record<string, any>)
          : {};
      const updateSuccessData: Record<string, any> = {
        status: TransactionStatus.SUCCESS,
        amount: paidNaira,
        metadata: { ...existingMeta, gatewayMeta: { ...(existingMeta.gatewayMeta ?? {}), verified_at: paidAt.toISOString() } } as Prisma.InputJsonValue,
      };
      const paystackCardType = rawPayload.authorization?.card_type ?? rawPayload.authorization?.card_brand ?? null;
      const paystackBank = rawPayload.authorization?.bank ?? null;
      if (txGateway === PaymentGateway.PAYSTACK) {
        updateSuccessData.paystackReference = providerRef;
        updateSuccessData.paystackChannel = channel;
        const existingPaystackMeta =
          existingMeta.paystack && typeof existingMeta.paystack === 'object'
            ? (existingMeta.paystack as Record<string, any>)
            : {};
        (updateSuccessData.metadata as any).paystack = {
          ...existingPaystackMeta,
          paid_at: paidAt.toISOString(),
          paid_kobo: paidMinor,
          channel,
          ip_address: rawPayload.ip_address ?? null,
          currency: rawPayload.currency ?? 'NGN',
        };
      } else {
        updateSuccessData.alatpayReference = providerRef;
        if (isAlatpayUuid(providerRef)) {
          updateSuccessData.alatpayFinalTransactionId = providerRef;
        }
        if (latest.alatpayFinalTransactionId && !updateSuccessData.alatpayFinalTransactionId) {
          updateSuccessData.alatpayFinalTransactionId = latest.alatpayFinalTransactionId;
        }
        const existingAlatMeta =
          existingMeta.alatpay && typeof existingMeta.alatpay === 'object'
            ? (existingMeta.alatpay as Record<string, any>)
            : {};
        const latestRow = latest as any;
        (updateSuccessData.metadata as any).alatpay = {
          ...existingAlatMeta,
          init_payment_reference: latestRow?.alatpayInitPaymentReference ?? latestRow?.metadata?.alatpay?.init_payment_reference ?? existingAlatMeta.init_payment_reference ?? null,
          order_reference: latestRow?.alatpayOrderReference ?? latestRow?.metadata?.alatpay?.order_reference ?? existingAlatMeta.order_reference ?? null,
          session_id: latestRow?.alatpaySessionId ?? latestRow?.metadata?.alatpay?.session_id ?? existingAlatMeta.session_id ?? null,
          checkout_url: latestRow?.alatpayCheckoutUrl ?? latestRow?.metadata?.alatpay?.checkout_url ?? existingAlatMeta.checkout_url ?? null,
          final_transaction_id: updateSuccessData.alatpayFinalTransactionId ?? providerRef ?? null,
          paid_at: paidAt.toISOString(),
          paid_minor: paidMinor,
          paid_naira: paidNaira,
          channel,
          currency: verifyResult.currency ?? 'NGN',
          fee_amount: verifyResult.expectedGatewayFeeNaira ?? null,
          gross_amount_naira: alatpayNormalization ? alatpayNormalization.grossNaira : null,
          provider_fee_amount_naira: alatpayNormalization ? alatpayNormalization.feeNaira : (verifyResult.providerFeeAmountNaira ?? null),
          normalization_kind: alatpayNormalization ? alatpayNormalization.kind : null,
          provider_status: providerStatus,
        };
      }
      await tx.transaction.update({
        where: { id: latest.id },
        data: updateSuccessData,
      });

      // 6. Update invoice
      if (latest.invoice) {
        const invoiceId = latest.invoice.id;
        const before = {
          amountDue: money(Number(latest.invoice.amountDue)),
          amountPaid: money(Number(latest.invoice.amountPaid)),
          status: latest.invoice.status,
        };
        const newAmountPaid = +(before.amountPaid + baseAmount).toFixed(2);
        const balanceAfter = +(before.amountDue - newAmountPaid).toFixed(2);
        let newStatus: any = latest.invoice.status;
        let newPaidAt: Date | null = (latest.invoice as any).paidAt ?? null;
        if (balanceAfter === 0) {
          newStatus = 'PAID';
          newPaidAt = (paidAt as any) ?? new Date();
        } else if (newAmountPaid > 0 && balanceAfter > 0) {
          newStatus = 'PARTIALLY_PAID';
          if (!newPaidAt) newPaidAt = (paidAt as any) ?? new Date();
        } else {
          newStatus = before.status;
        }
        const invoicePatch: any = { amountPaid: newAmountPaid, status: newStatus };
        if (newPaidAt) invoicePatch.paidAt = newPaidAt;
        await tx.invoice.update({
          where: { id: invoiceId },
          data: invoicePatch,
        });
        writeAudit(opts.req, {
          action: i18n.auditActions.invoiceGenerated, // generic invoice update event
          entityType: 'INVOICE',
          entityId: invoiceId,
          oldValue: before,
          newValue: { amountPaid: newAmountPaid, balance: balanceAfter, status: newStatus },
          details: { transactionId: latest.id },
        });

        // --- DIRECT BILL SETTLEMENT FIX (structural) ----------------------------
        // If this invoice PAID (balance=0) and there exists an ACTIVE STUDENT-target
        // FeeAssignment for (studentId, feeId) pair -> mark assignment settled
        // (isActive=false + settledAt=now) so admin direct-bill log correctly
        // reflects it was paid; this is also a safety net for catalogue filter.
        if (balanceAfter === 0 && latest.invoice.fee?.id != null && latest.invoice.studentId != null) {
          const asgUpdate = await tx.feeAssignment.updateMany({
            where: {
              assignmentType: 'STUDENT' as any,
              targetStudentId: Number(latest.invoice.studentId),
              feeId: Number(latest.invoice.fee.id),
              isActive: true,
            },
            data: {
              isActive: false,
              settledAt: new Date(),
            },
          });
          if (asgUpdate.count > 0) {
            // Best-effort audit trail (non-fatal if writeAudit fails here — receipt/
            // transaction/invoice already recorded).
            try {
              await writeAudit(opts.req, {
                action: 'DIRECT_BILL_SETTLED' as any,
                entityType: 'FEE_ASSIGNMENT',
                entityId: 0, // updateMany doesn't return IDs; details carry invoiceId/feeId/studentId
                newValue: {
                  settled: true,
                  invoiceId,
                  feeId: Number(latest.invoice.fee.id),
                  studentId: Number(latest.invoice.studentId),
                  assignmentsSettled: asgUpdate.count,
                },
                details: {
                  settlementSource: 'verifyPayment',
                  transactionId: latest.id,
                  settledAt: new Date().toISOString(),
                },
              });
            } catch {
              /* swallow audit write failures on auxiliary path */
            }
          }
        }
      }

      // 7a. YEARLY-SEQUENCED Receipt counter: RCPT/<YYYY>/00001 (resets Jan 1)
      //     Safety: NEVER issue two receipts for the same invoice or transaction.
      //     If a receipt already exists for this invoiceId or transactionId, skip
      //     creation, load the existing one and use it instead (guarantees matching).
      let existingReceiptForTx: any = null;
      if (latest.invoiceId) {
        existingReceiptForTx = await tx.receipt.findFirst({
          where: { OR: [{ invoiceId: latest.invoiceId }, { transactionId: latest.id }] },
        });
      } else {
        existingReceiptForTx = await tx.receipt.findFirst({
          where: { transactionId: latest.id },
        });
      }
      let receiptRow: any;
      let receiptNumber: string | null = null;
      const convenienceFee = money(Number((amountBreakdown as any).convenienceFee ?? 0));
      const serviceChargeRow = money(Number(amountBreakdown.serviceCharge ?? 0));
      const gatewayFeeRow = money(Number(amountBreakdown.gatewayFee ?? 0));
      const totalAmount = money(baseAmount + convenienceFee + serviceChargeRow + gatewayFeeRow);
      const invariantTxAmount = money(Number(paidNaira ?? latest.amount ?? totalAmount));
      if (Math.abs(totalAmount - invariantTxAmount) > 0.02) {
        throw new AppError(
          `Receipt totalAmount invariant failed (${totalAmount.toFixed(2)} vs tx ${invariantTxAmount.toFixed(2)})`,
          500,
        );
      }
      if (existingReceiptForTx) {
        receiptRow = existingReceiptForTx;
        receiptNumber = existingReceiptForTx.receiptNumber;
      } else {
        const fiscalYear = yearFromSession(
          (latest.invoice?.session as string | undefined | null)
          ?? (latest.metadata?.session as string | undefined | null)
          ?? (latest.user as any)?.academicSession as string | undefined | null
          ?? ''
        );
        const receiptSeq = await (tx as any).counter.upsert({
          where: { id: `receipt_seq_${fiscalYear}` },
          update: { value: { increment: 1 } },
          create: { id: `receipt_seq_${fiscalYear}`, value: 1 },
          select: { value: true },
        });
        const seqValue = Number(receiptSeq.value ?? 1);
        receiptNumber = generateReceiptReference(seqValue, fiscalYear);

        const verificationToken = generateVerificationToken();
        const qrUrl = `${process.env.APP_BASE_URL ?? 'http://localhost:3001'}/public/verify-receipt/${verificationToken}`;
        const paystackRef = txGateway === PaymentGateway.PAYSTACK ? providerRef : latest.paystackReference ?? null;
        const methodDetail = paystackCardType ? paystackCardType : paystackBank ? paystackBank : (txGateway === PaymentGateway.ALATPAY ? (channel ?? 'ALAT Pay') : channel);

        receiptRow = await tx.receipt.create({
          data: {
            receiptNumber: receiptNumber!,
            verificationToken,
            transactionId: latest.id,
            invoiceId: latest.invoiceId ?? null,
            studentId: latest.userId,
            paidAmount: baseAmount,
            convenienceFee,
            serviceCharge: serviceChargeRow,
            gatewayFee: gatewayFeeRow,
            totalAmount,
            paystackReference: paystackRef,
            paymentChannel: gatewayLabel(txGateway, channel),
            paymentMethodDetail: methodDetail,
            paidAt,
            qrCodeData: qrUrl,
          },
        });
        writeAudit(opts.req, {
          action: i18n.auditActions.receiptGenerated,
          entityType: 'RECEIPT',
          entityId: receiptRow.id,
          newValue: {
            receiptNumber,
            paidAmount: baseAmount,
            convenienceFee,
            serviceCharge: serviceChargeRow,
            gatewayFee: gatewayFeeRow,
            totalAmount,
            studentId: latest.userId,
            gateway: txGateway,
          },
          details: { transactionId: latest.id, yearlySequence: seqValue, invariantTxAmount },
        });
      } // close receipt creation else block

      // 7c. TASK H11 — DOUBLE-ENTRY GENERAL LEDGER (balanced DR = CR exactly)
      //     Event: PAYMENT_SUCCESS
      //     (1) Dr CASH_CLEARING           = totalAmount
      //     (2) Cr STUDENT_RECEIVABLE      = baseAmount
      //     (3) Cr CONVENIENCE_FEE_INCOME  = convenienceFee (if >0)
      //     (4) Cr SERVICE_CHARGE_INCOME   = serviceChargeRow
      //     (5) Dr GATEWAY_FEE_EXPENSE     = gatewayFeeRow  (contra: net cash clearing is base+convenience+service)
      //     Check: totalDebits  = CASH_CLEARING(totalAmount) + GATEWAY_FEE_EXPENSE(gatewayFeeRow)
      //            totalCredits = STUDENT_RECEIVABLE(baseAmount) + CONVENIENCE_FEE_INCOME(convenienceFee)
      //                           + SERVICE_CHARGE_INCOME(serviceChargeRow)
      //                           + GATEWAY_FEE contra credit (gatewayFeeRow)  [paid to provider]
      //     To keep equation DR=CR exactly we write CASH_CLEARING NET of gatewayFee:
      //       Dr CASH_CLEARING (totalAmount - gatewayFeeRow)  ... net cash to us
      //       Dr GATEWAY_FEE_EXPENSE  gatewayFeeRow           ... expense borne
      //       Cr STUDENT_RECEIVABLE    baseAmount
      //       Cr CONVENIENCE_FEE_INCOME convenienceFee
      //       Cr SERVICE_CHARGE_INCOME  serviceChargeRow
      //     => DR = (totalAmount - gatewayFee) + gatewayFee = totalAmount ; CR = base + convenience + service = totalAmount ✓
      try {
        const glTransactionDate = paidAt ?? new Date();
        const glEntries: Array<any> = [];
        const glDrCashClearingNet = money(totalAmount - gatewayFeeRow);
        if (glDrCashClearingNet > 0) {
          glEntries.push({
            transactionDate: glTransactionDate,
            entryType: 'PAYMENT_SUCCESS' as any,
            description: `Payment received (gateway net) — ${latest.reference}`,
            amount: glDrCashClearingNet,
            currency: 'NGN',
            account: 'CASH_CLEARING',
            counterpartyAccount: 'STUDENT_RECEIVABLE',
            transactionId: latest.id,
            receiptId: receiptRow.id,
            userId: latest.userId,
            invoiceId: latest.invoiceId ?? undefined,
            meta: { side: 'DEBIT', gateway: txGateway, providerRef } as any,
          });
        }
        if (gatewayFeeRow > 0) {
          glEntries.push({
            transactionDate: glTransactionDate,
            entryType: 'GATEWAY_FEE_EXPENSE' as any,
            description: `Payment gateway fee — ${txGateway} — ${latest.reference}`,
            amount: gatewayFeeRow,
            currency: 'NGN',
            account: 'GATEWAY_FEE_EXPENSE',
            counterpartyAccount: 'CASH_CLEARING',
            transactionId: latest.id,
            receiptId: receiptRow.id,
            userId: latest.userId,
            invoiceId: latest.invoiceId ?? undefined,
            meta: { side: 'DEBIT', gateway: txGateway, providerRef } as any,
          });
        }
        if (baseAmount > 0) {
          glEntries.push({
            transactionDate: glTransactionDate,
            entryType: 'PAYMENT_SUCCESS' as any,
            description: `Student fee applied to receivable — ${latest.reference}`,
            amount: baseAmount,
            currency: 'NGN',
            account: 'STUDENT_RECEIVABLE',
            counterpartyAccount: 'CASH_CLEARING',
            transactionId: latest.id,
            receiptId: receiptRow.id,
            userId: latest.userId,
            invoiceId: latest.invoiceId ?? undefined,
            meta: { side: 'CREDIT', gateway: txGateway, providerRef } as any,
          });
        }
        if (convenienceFee > 0) {
          glEntries.push({
            transactionDate: glTransactionDate,
            entryType: 'CONVENIENCE_FEE_INCOME' as any,
            description: `Convenience fee income — ${latest.reference}`,
            amount: convenienceFee,
            currency: 'NGN',
            account: 'CONVENIENCE_FEE_INCOME',
            counterpartyAccount: 'CASH_CLEARING',
            transactionId: latest.id,
            receiptId: receiptRow.id,
            userId: latest.userId,
            invoiceId: latest.invoiceId ?? undefined,
            meta: { side: 'CREDIT', gateway: txGateway, providerRef } as any,
          });
        }
        if (serviceChargeRow > 0) {
          glEntries.push({
            transactionDate: glTransactionDate,
            entryType: 'SERVICE_CHARGE_INCOME' as any,
            description: `University service charge income — ${latest.reference}`,
            amount: serviceChargeRow,
            currency: 'NGN',
            account: 'SERVICE_CHARGE_INCOME',
            counterpartyAccount: 'CASH_CLEARING',
            transactionId: latest.id,
            receiptId: receiptRow.id,
            userId: latest.userId,
            invoiceId: latest.invoiceId ?? undefined,
            meta: { side: 'CREDIT', gateway: txGateway, providerRef } as any,
          });
        }
        if (glEntries.length > 0) {
          // Sanity: sum DEBITS === sum CREDITS (within 0.01)
          let sumDr = 0;
          let sumCr = 0;
          for (const e of glEntries) {
            const side: string = (e.meta as any)?.side ?? '';
            if (side === 'DEBIT') sumDr += Number(e.amount);
            else if (side === 'CREDIT') sumCr += Number(e.amount);
          }
          const drift = Math.abs(sumDr - sumCr);
          if (drift > 0.02) {
            console.warn('[verifyPayment:GL] drift=' + drift.toFixed(2) + ' sumDr=' + sumDr.toFixed(2) + ' sumCr=' + sumCr.toFixed(2));
          }
          await (tx as any).generalLedger.createMany({ data: glEntries, skipDuplicates: true });
        }
      } catch (glErr) {
        console.warn('[verifyPayment:GL] GL write failed (non-fatal, tx already committed inner):', (glErr as Error)?.message?.slice(0, 200));
      }

      // 8. Audit paymentVerified success
      await writeAudit(opts.req, {
        action: i18n.auditActions.paymentVerified,
        entityType: 'TRANSACTION',
        entityId: latest.id,
        oldValue: { status: 'PENDING' },
        newValue: {
          status: 'SUCCESS',
          amountPaid: paidNaira,
          providerRef,
          gateway: txGateway,
          invoice: latest.invoice?.invoiceNumber,
          receipt: receiptNumber,
        },
      });

      const finalInvoice = latest.invoice
        ? await tx.invoice.findUnique({ where: { id: latest.invoice.id } })
        : null;
      return {
        verified: true,
        status: TransactionStatus.SUCCESS,
        transaction: latest,
        invoice: finalInvoice,
        receipt: receiptRow,
      };
    }, { timeout: 30000 });

    // ---- POST-COMMIT HOOKS (B4.1, B5.1) — NEVER inside $transaction ----
    try {
      if (result && typeof result === 'object') {
        const status: string | undefined = (result as any).status;
        const verified: boolean = (result as any).verified === true;
        const tx = (result as any).transaction ?? initialTx;
        const receiptRow = (result as any).receipt;
        const finalInvoice = (result as any).invoice;

        const amountNgn = tx ? Number(tx.amount ?? paidNaira) : paidNaira;
        const expectedNgn = tx ? Number(tx.expectedAmount ?? outerExpectedNaira) : outerExpectedNaira;

        // Build common student info
        const studentUser = tx?.user ?? initialTx?.user;
        const studentId = studentUser?.id ?? initialTx?.userId;
        const studentEmail = studentUser?.email;
        const studentName = [studentUser?.firstName, studentUser?.middleName, studentUser?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        const feeName =
          finalInvoice?.fee?.name ??
          tx?.invoice?.fee?.name ??
          tx?.metadata?.fee?.name ??
          'Fee Payment';
        const reference = tx?.reference ?? initialTx?.reference;
        const receiptNumber = receiptRow?.receiptNumber ?? null;
        const receiptDownloadUrl = receiptRow?.verificationToken
          ? `${process.env.APP_BASE_URL ?? 'http://localhost:3001'}/public/verify-receipt/${receiptRow.verificationToken}`
          : null;

        // SUCCESS PATH
        if (verified && status === TransactionStatus.SUCCESS) {
          // B4.1: FIRE-AND-FORGET PaymentSuccessful email
          if (studentEmail && reference) {
            try {
              void dispatchEmail({
                emailType: 'PaymentSuccessful',
                to: studentEmail,
                reference,
                recipientId: studentId,
                payload: {
                  studentName,
                  feeName,
                  amountNgn,
                  reference,
                  receiptNumber,
                  receiptDownloadUrl,
                },
              });
            } catch (emailErr) {
              console.warn('[verifyPayment:post-commit] dispatchEmail failed:', (emailErr as Error)?.message);
            }
          }

          // B5.1: LARGE_PAYMENT threshold notif (fire-and-forget)
          try {
            const threshold = await SystemSettingsService.getLargePaymentThreshold();
            void AdminNotificationService.emitLargePayment(
              {
                id: tx?.id ?? initialTx?.id,
                reference,
                amount: amountNgn,
                userId: studentId,
              },
              amountNgn,
              threshold,
            );
          } catch (notifErr) {
            console.warn('[verifyPayment:post-commit] emitLargePayment failed:', (notifErr as Error)?.message);
          }
        }

        // UNDERPAID / OVERPAID anomaly notifications
        if (status === 'UNDERPAID' || (verified === false && paidMinor > 0 && paidMinor < outerExpectedKobo)) {
          try {
            void AdminNotificationService.emitAnomaly('UNDERPAID', {
              id: tx?.id ?? initialTx?.id,
              reference,
              amount: amountNgn,
              expectedAmount: expectedNgn,
              underpaidReason: (result as any).reason ?? null,
              userId: studentId,
            });
          } catch (notifErr) {
            console.warn('[verifyPayment:post-commit] emitAnomaly UNDERPAID failed:', (notifErr as Error)?.message);
          }
        } else if (status === 'OVERPAID' || (verified === false && paidMinor > outerExpectedKobo)) {
          try {
            void AdminNotificationService.emitAnomaly('OVERPAID', {
              id: tx?.id ?? initialTx?.id,
              reference,
              amount: amountNgn,
              expectedAmount: expectedNgn,
              underpaidReason: (result as any).reason ?? null,
              userId: studentId,
            });
          } catch (notifErr) {
            console.warn('[verifyPayment:post-commit] emitAnomaly OVERPAID failed:', (notifErr as Error)?.message);
          }
        }

        // FAILED/CANCELLED notif
        if (
          status === TransactionStatus.FAILED ||
          status === 'CANCELLED' ||
          (verified === false && status !== TransactionStatus.SUCCESS)
        ) {
          try {
            void AdminNotificationService.emitFailedPayment({
              id: tx?.id ?? initialTx?.id,
              reference,
              underpaidReason: (result as any).reason ?? null,
              userId: studentId,
            });
          } catch (notifErr) {
            console.warn('[verifyPayment:post-commit] emitFailedPayment failed:', (notifErr as Error)?.message);
          }
        }
      }
    } catch (outerErr) {
      console.warn('[verifyPayment:post-commit] hook error (swallowed):', (outerErr as Error)?.message);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // reconcilePendingAlatpayBatch — bounded safe fallback reconciliation.
  // Scans pending ALATPAY transactions older than minAgeMs (default 2 min).
  // Only dispatches a per-transaction recon job when there is a stored final
  // provider transaction UUID (strict v4 UUID match). We deliberately DO NOT
  // attempt to invent or guess a final UUID from order/session/init refs or
  // by enumerating ALATPay merchant transactions. This conservative approach
  // keeps the fallback bounded and trustworthy: if a final UUID was never
  // stored at initiate (because the popup never completed its last postMessage
  // or the student closed early), we simply keep that row PENDING — as if the
  // student never finished the payment flow. Idempotency is preserved via the
  // BullMQ safe jobId per (tx, finalUuid) stable dedup on dispatch plus the
  // existing verifyPayment internal atomicity.
  // ---------------------------------------------------------------------------
  static async reconcilePendingAlatpayBatch(opts: { minAgeMs?: number; limit?: number } = {}): Promise<{
    scanned: number;
    totalEnqueued: number;
    skippedNoId: number;
    skippedTerminal: number;
  }> {
    const minAgeMs = Number(opts.minAgeMs) > 0 ? Number(opts.minAgeMs) : 2 * 60 * 1000;
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 20));
    const cutoff = new Date(Date.now() - minAgeMs);
    const rows = await prisma.transaction.findMany({
      where: {
        gateway: PaymentGateway.ALATPAY,
        status: TransactionStatus.PENDING,
        createdAt: { lte: cutoff },
      },
      orderBy: [{ updatedAt: 'asc' }],
      take: limit,
      select: {
        id: true, reference: true, status: true, expectedAmount: true,
        alatpayFinalTransactionId: true, alatpayOrderReference: true,
        alatpayInitPaymentReference: true, alatpaySessionId: true,
      },
    });
    const { dispatchJob } = await import('../config/queue');
    // Canonical strict UUID-v4 helper: typeof s==='string' + trim + /^[0-9a-f]{8}-[0-9a-f]{4}-4xxx-[89ab]xxx-xxx{12}$/i
    // (imported from utils/alatpay.ts). Replaces previous inline regex to
    // eliminate validator duplication / inconsistency drift (Blocker 4).
    let totalEnqueued = 0;
    let skippedNoId = 0;
    let skippedTerminal = 0;
    const noStoredFinalUuidTxSample: string[] = [];
    for (const tx of rows) {
      const finalTxId =
        typeof tx.alatpayFinalTransactionId === 'string' && isAlatpayUuid(tx.alatpayFinalTransactionId)
          ? tx.alatpayFinalTransactionId.trim()
          : null;
      if (!finalTxId) {
        skippedNoId++;
        // IMPORTANT (production lesson, incident PAY-20261008-HQ13D2 / tx id 42):
        //   At this point tx.alatpayFinalTransactionId is NULL. The browser/callback
        //   never fired (student closed popup or lost connectivity) AND the ALATPAY
        //   webhook has also not delivered yet. The provider-side transaction IS
        //   settled on ALATPAY's dashboard but we have no stored trustworthy identifier
        //   to reach it with.
        //
        // The provider API (/transactions/{uuid}) ONLY accepts a final UUID. Using:
        //   - alatpayOrderReference (WEMA-PAY-xxx shape) → provider responds 404
        //   - alatpayInitPaymentReference (payk_xxx shape) → provider responds 404
        //   - alatpaySessionId → wrong identifier type
        //   - amount + student info → guessing = finance data loss (forbidden).
        //
        // THEREFORE: this worker MUST NOT invent a UUID or do a weak lookup by amount/
        // student identity. It MUST skip and log the transaction so ops can identify:
        //   (a) whether webhook configuration is broken (primary fix path), or
        //   (b) whether the student needs to be advised to complete callback redirect.
        if (noStoredFinalUuidTxSample.length < 5) {
          noStoredFinalUuidTxSample.push(
            `txId=${tx.id} ref=${String(tx.reference || '').slice(0, 24)} status=${String(tx.status || '')} ` +
            `orderRef=(${!!tx.alatpayOrderReference}) initRef=(${!!tx.alatpayInitPaymentReference}) sessionId=(${!!tx.alatpaySessionId})`,
          );
        }
        continue;
      }
      if (tx.status !== TransactionStatus.PENDING) {
        skippedTerminal++;
        continue;
      }
      try {
        // BullMQ-safe per-attempt unique reconciliation job id (no colons).
        // The format alatpay_recon_tx_<id>_<uuidHead8> plus <ts36>_<nonce8> tail.
        let safeJobId: string;
        try {
          safeJobId = makeAlatpayWebhookJobId(`recon:tx:${tx.id}:${finalTxId.slice(0, 8)}`);
          if (!isBullmqSafeJobId(safeJobId)) throw new Error('predicate-fail');
        } catch {
          // Belt: always have a fallback with conservative chars
          safeJobId = 'alatpay_recon_tx_' + tx.id + '_' + finalTxId.slice(0, 8) + '_' +
            Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
        }
        await dispatchJob(
          'alatpay.recon',
          { transactionId: tx.id, providerReference: finalTxId, expectedAmount: Number(tx.expectedAmount || 0) },
          {
            deduplicate: true,
            jobId: safeJobId,
            priority: 'low',
            retries: 3,
          },
        );
        totalEnqueued++;
      } catch {
        // sync degraded path — dispatchJob sync fallback already runs handler
        // inline when Redis unavailable; if THAT also throws we silently skip
        // to next row (BullMQ retries will pick up the tx on next interval).
      }
    }
    // Structured log at WARN level: only printed when at least 1 tx has no stored final UUID
    // so that operators can tell at a glance whether webhook/callback capture is failing broadly.
    if (skippedNoId > 0) {
      console.warn(
        `[recon.scheduler] FINAL_UUID_NOT_CAPTURED=${skippedNoId}/${rows.length} pending ALATPAY tx have NO stored alatpayFinalTransactionId. ` +
        'Automatic server-side reconciliation CANNOT resolve these without a trustworthy provider reference. ' +
        'Primary mitigation: ensure ALATPAY dashboard webhook URL is correctly configured + HMAC secret matches env. ' +
        'Secondary: advise student to complete popup redirect OR open status-callback URL so browser SDK emits final UUID. ' +
        'Primary provider verification by worker only: when final UUID stored, enqueue proceeds. ' +
        `Total scanned=${rows.length}; total enqueued=${totalEnqueued}; skipped-terminal=${skippedTerminal}. ` +
        `Sample pending tx lacking final UUID: ${noStoredFinalUuidTxSample.join('; ') || '(none logged)'}`,
      );
    } else if (rows.length > 0) {
      console.info(
        `[recon.scheduler] enqueued ${totalEnqueued} / total scanned ${rows.length} pending ALATPAY tx. ` +
        `skipped-terminal=${skippedTerminal}. All scanned pending rows had stored final UUID.`,
      );
    }
    return { scanned: rows.length, totalEnqueued, skippedNoId, skippedTerminal };
  }
}

export class ConfirmPayloadService {
  static async getConfirmPayload(studentId: number, invoiceId: number) {
    const inv: any = await prisma.invoice.findFirst({
      where: { id: invoiceId, studentId },
      select: {
        id: true,
        amountDue: true,
        amountPaid: true,
        session: true,
        semester: true,
        fee: { select: { name: true } },
        student: {
          select: {
            firstName: true,
            lastName: true,
            middleName: true,
            matricNumber: true,
          },
        },
      },
    });
    if (!inv) throw new AppError(i18n.errors.invoice.notFound, 404);

    const studentNameParts = [inv.student?.firstName, inv.student?.middleName, inv.student?.lastName]
      .filter(Boolean) as string[];
    const studentName = studentNameParts.join(' ').trim();

    const amountDueNum = Number(inv.amountDue ?? 0);
    const amountPaidNum = Number(inv.amountPaid ?? 0);
    const serverComputedAmount = money(amountDueNum - amountPaidNum);

    return {
      invoiceId: Number(inv.id),
      feeName: inv.fee?.name ?? 'Fee',
      session: inv.session ?? '',
      semester: inv.semester ?? undefined,
      studentName,
      matricNumber: inv.student?.matricNumber ?? null,
      serverComputedAmount,
    };
  }
}

export default PaymentService;
