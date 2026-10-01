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
import { z } from 'zod';
import { Prisma, TransactionType, TransactionStatus, Role, Invoice, PaymentGateway } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { PaystackService, computePaymentBreakdown } from './paystack';
import { generatePaymentReference, generateReceiptReference, generateVerificationToken, kobo, readPaystackMetadata } from '../utils/paystack';
import { i18n } from '../i18n/en';
import { dispatchEmail } from '../queues/emailQueue';
import { AdminNotificationService } from './adminNotification';
import { SystemSettingsService } from './systemSettings';
import { getPaymentProvider, getActiveGatewaySetting } from './payment/providerFactory';
import { gatewayLabel, decimalOrNull } from './payment/types';

type ReqLike = any;

const JSON_DB_NULL = Prisma.JsonNull;

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

async function writeAudit(req: ReqLike | undefined, data: { action: string; entityType: 'TRANSACTION' | 'RECEIPT' | 'INVOICE' | 'GENERAL_LEDGER' | 'WEBHOOK_EVENT'; entityId: string | number; oldValue?: any; newValue?: any; details?: any; }) {
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

    // A5.1 Idempotency guard (FR-A7): check for recent PENDING rows on this invoice
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    const existingPending = await prisma.transaction.findFirst({
      where: {
        invoiceId: inv.id,
        status: TransactionStatus.PENDING,
        userId: studentId,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, status: true },
    });
    if (existingPending) {
      const createdAtTime = existingPending.createdAt.getTime();
      const nowTime = Date.now();
      const ageMs = nowTime - createdAtTime;
      if (ageMs < FIVE_MINUTES_MS) {
        throw new AppError(
          'Payment already in progress. Please wait 5 minutes before retrying or check status.',
          425,
        );
      }
      await prisma.transaction.update({
        where: { id: existingPending.id },
        data: { status: TransactionStatus.FAILED, description: 'client-reinit-timeout' },
      });
    }

    // 3. Partial amount clamp
    let payable = balance;
    if (payload.partialAmount !== undefined && payload.partialAmount !== null) {
      const pa = money(Number(payload.partialAmount));
      if (pa <= 0) throw new AppError(i18n.errors.payment.invalidPartialAmount, 400);
      payable = pa > balance ? balance : pa;
    }

    // 4. Service charge breakdown — charge comes ON TOP of payable so the
    //    university always receives exactly `payable` to STUDENT_RECEIVABLE.
    const breakdown = computePaymentBreakdown(payable);
    const expectedAmount = breakdown.totalAmount;

    // 5. Create reference & pending Transaction
    const paymentRef = generatePaymentReference();
    const txRow = await prisma.transaction.create({
      data: {
        reference: paymentRef,
        userId: studentId,
        invoiceId: inv.id,
        type: TransactionType.FEE_PAYMENT,
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
      // 6. Determine active gateway (SystemSettings) and initialize through provider
      const activeGateway = await getActiveGatewaySetting();
      const provider = getPaymentProvider(activeGateway);
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

      // 7. Update Transaction row with gateway + provider ref + channel columns
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
        (gatewayData as any).alatpayReference = gatewayRef;
        (gatewayData as any).alatpaySessionId = init?.sessionId ?? null;
        const existingMeta =
          txRow.metadata && typeof txRow.metadata === 'object'
            ? (txRow.metadata as Record<string, any>)
            : {};
        (gatewayData as any).metadata = {
          ...existingMeta,
          alatpay: {
            checkout_url: init?.checkoutUrl ?? null,
            session_id: init?.sessionId ?? null,
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

      return {
        authorization_url: init?.checkoutUrl ?? init?.authorization_url ?? null,
        checkout_url: init?.checkoutUrl ?? init?.authorization_url ?? null,
        access_code: init?.access_code ?? init?.sessionId ?? null,
        payment_reference: paymentRef,
        expected_amount: expectedAmount,
        fee_breakdown: breakdown,
        gateway: activeGateway,
        gateway_label: gatewayLabel(activeGateway, gatewayChannel),
      };
    } catch (err) {
      const rawErrMsg = (err as Error)?.message ?? '';
      try {
        await prisma.transaction.update({
          where: { id: txRow.id },
          data: {
            status: TransactionStatus.FAILED,
            underpaidReason: rawErrMsg ? rawErrMsg.slice(0, 190) : null,
            description: rawErrMsg ? rawErrMsg.slice(0, 190) : null,
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
          newValue: { status: 'FAILED', error: rawErrMsg.slice(0, 500) },
        });
      } catch (auditErr) {
        console.warn('[initiatePayment:catch] audit write failed (ignored):', (auditErr as Error)?.message);
      }
      throw err;
    }
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
  static async verifyPayment(paystackOrPaymentRef: string, opts: { req?: ReqLike; assertStudentId?: number; } = {}) {
    const ref = paystackOrPaymentRef;
    if (!ref || !String(ref).trim()) throw new AppError(i18n.errors.paystack.verifyFailed, 400);

    // 0. Determine which provider + gateway this tx uses — pre-fetch the row
    const lookupWhere: Prisma.TransactionWhereInput = {
      OR: [
        { reference: ref },
        { paystackReference: ref },
        { alatpayReference: ref },
      ],
    };
    const preRows = await prisma.transaction.findMany({
      where: lookupWhere,
      orderBy: [{ updatedAt: 'desc' }],
      select: { id: true, gateway: true, reference: true, paystackReference: true, alatpayReference: true, metadata: true, status: true, updatedAt: true },
    });
    const preTx = PaymentService.pickAlatpayBestMatch(preRows, ref);
    if (!preTx) throw new AppError(i18n.errors.payment.transactionNotFound, 404);
    const txGateway: PaymentGateway = preTx.gateway ?? PaymentGateway.ALATPAY;
    const provider = getPaymentProvider(txGateway);
    // Pass the correct-looking ref to the provider:
    const providerRefToVerify =
      txGateway === PaymentGateway.PAYSTACK
        ? preTx.paystackReference ?? preTx.reference ?? ref
        : preTx.alatpayReference ?? preTx.reference ?? ref;

    // 1. Call provider verify (throws AppError on failure).
    const verifyResult = await provider.verify(providerRefToVerify);
    const providerRef = String(verifyResult.providerReference ?? providerRefToVerify);
    const paidMinor = Number(verifyResult.paidAmountMinor);
    const paidNaira = Number(verifyResult.paidAmountNaira);
    const channel = verifyResult.channel;
    const paidAt = verifyResult.paidAt;
    const providerStatus = String(verifyResult.providerStatus ?? '').toLowerCase();
    const rawPayload = verifyResult.raw ?? {};

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
    const txWhere: Prisma.TransactionWhereInput = {
      OR: [
        { reference: ref },
        { reference: providerRef },
        { paystackReference: ref },
        { paystackReference: providerRef },
        { alatpayReference: ref },
        { alatpayReference: providerRef },
        ...(transactionId && Number.isFinite(transactionId) ? [{ id: transactionId }] : []),
      ],
    };
    const initialRows: any[] = await prisma.transaction.findMany({
      where: txWhere,
      orderBy: [{ updatedAt: 'desc' }],
      select: {
        id: true, reference: true, status: true, userId: true, invoiceId: true,
        expectedAmount: true, amount: true, metadata: true, gateway: true,
        paystackReference: true, alatpayReference: true, updatedAt: true,
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
      const serviceCharge = money(Number(amountBreakdown.serviceCharge ?? 0));
      const gatewayFee = money(Number(amountBreakdown.gatewayFee ?? 0));

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
        const existingAlatMeta =
          existingMeta.alatpay && typeof existingMeta.alatpay === 'object'
            ? (existingMeta.alatpay as Record<string, any>)
            : {};
        (updateSuccessData.metadata as any).alatpay = {
          ...existingAlatMeta,
          paid_at: paidAt.toISOString(),
          paid_minor: paidMinor,
          paid_naira: paidNaira,
          channel,
          currency: verifyResult.currency ?? 'NGN',
          fee_amount: verifyResult.expectedGatewayFeeNaira ?? null,
          provider_status: providerStatus,
        };
      }
      await tx.transaction.update({
        where: { id: latest.id },
        data: updateSuccessData,
      });

      // 6. Update invoice
      let invoiceUpdated: any = null;
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
        if (balanceAfter === 0) newStatus = 'PAID';
        else if (newAmountPaid > 0 && balanceAfter > 0) newStatus = 'PARTIALLY_PAID';
        else newStatus = before.status;
        invoiceUpdated = await tx.invoice.update({
          where: { id: invoiceId },
          data: { amountPaid: newAmountPaid, status: newStatus },
        });
        writeAudit(opts.req, {
          action: i18n.auditActions.invoiceGenerated, // generic invoice update event
          entityType: 'INVOICE',
          entityId: invoiceId,
          oldValue: before,
          newValue: { amountPaid: newAmountPaid, balance: balanceAfter, status: newStatus },
          details: { transactionId: latest.id },
        });
      }

      // 7a. TASK B3 — Atomic receipt counter via dedicated Counter table
      //     (eliminates MAX(id)+1 race under concurrent verifyPayment/webhook calls).
      const counterRow = await (tx as any).counter.upsert({
        where: { id: 'receipt_number' },
        update: { value: { increment: 1 } },
        create: { id: 'receipt_number', value: 2 },
        select: { value: true },
      });
      const counterValue = Number(counterRow.value ?? 1);
      const sessionRaw =
        (latest.invoice?.session as string | undefined | null)
        ?? (latest.metadata?.session as string | undefined | null)
        ?? (latest.user as any)?.academicSession as string | undefined | null
        ?? '';
      const sessionYearMatch = /^(\d{4})\/\d{4}$/.exec(String(sessionRaw || ''));
      const academicYearShort = sessionYearMatch ? sessionYearMatch[1].slice(2) : String(new Date().getFullYear()).slice(2);
      const receiptNumber = `COUNTER-${counterValue}-${academicYearShort}`;

      const verificationToken = generateVerificationToken();
      const qrUrl = `${process.env.APP_BASE_URL ?? 'http://localhost:3001'}/public/verify-receipt/${verificationToken}`;
      const paystackRef = txGateway === PaymentGateway.PAYSTACK ? providerRef : latest.paystackReference ?? null;
      const methodDetail = paystackCardType ? paystackCardType : paystackBank ? paystackBank : (txGateway === PaymentGateway.ALATPAY ? (channel ?? 'ALAT Pay') : channel);

      // 7b. TASK H12 — Fee columns on Receipt (structural invariant)
      const convenienceFee = money(Number((amountBreakdown as any).convenienceFee ?? 0));
      const serviceChargeRow = money(Number(amountBreakdown.serviceCharge ?? 0));
      const gatewayFeeRow = money(Number(amountBreakdown.gatewayFee ?? 0));
      const totalAmount = money(baseAmount + convenienceFee + serviceChargeRow + gatewayFeeRow);

      // Structural invariant: receipt.totalAmount must equal tx.amount
      // (paidNaira is what provider verified; guard against drift)
      const invariantTxAmount = money(Number(paidNaira ?? latest.amount ?? totalAmount));
      const invariantOk = Math.abs(totalAmount - invariantTxAmount) <= 0.02;
      if (!invariantOk) {
        throw new AppError(
          `Receipt totalAmount invariant failed (${totalAmount.toFixed(2)} vs tx ${invariantTxAmount.toFixed(2)}); aborting receipt creation.`,
          500,
        );
      }

      const receiptRow = await tx.receipt.create({
        data: {
          receiptNumber,
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
        details: { transactionId: latest.id, counterValue, invariantTxAmount },
      });

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
