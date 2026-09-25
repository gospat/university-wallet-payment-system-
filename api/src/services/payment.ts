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
    const preTx = await prisma.transaction.findFirst({
      where: lookupWhere,
      select: { id: true, gateway: true, reference: true, paystackReference: true, alatpayReference: true, metadata: true },
    });
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
    const initialTx: any = await prisma.transaction.findFirst({
      where: txWhere,
      select: {
        id: true, reference: true, status: true, userId: true, invoiceId: true,
        expectedAmount: true, amount: true, metadata: true, gateway: true,
        paystackReference: true, alatpayReference: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true, matricNumber: true, role: true } },
      },
    });
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

      // 7. Receipt row creation
      //    - Receipt counter: max(id)+1
      const receiptCounter = await (tx.receipt.aggregate({ _max: { id: true } }) as Promise<{ _max: { id: number | null } }>);
      const nextId = (receiptCounter._max.id ?? 0) + 1;
      const receiptNumber = generateReceiptReference(nextId);
      const verificationToken = generateVerificationToken();
      const qrUrl = `${process.env.APP_BASE_URL ?? 'http://localhost:3001'}/public/verify-receipt/${verificationToken}`;
      const paystackRef = txGateway === PaymentGateway.PAYSTACK ? providerRef : latest.paystackReference ?? null;
      const methodDetail = paystackCardType ? paystackCardType : paystackBank ? paystackBank : (txGateway === PaymentGateway.ALATPAY ? (channel ?? 'ALAT Pay') : channel);
      const receiptRow = await tx.receipt.create({
        data: {
          receiptNumber,
          verificationToken,
          transactionId: latest.id,
          invoiceId: latest.invoiceId ?? null,
          studentId: latest.userId,
          paidAmount: baseAmount,
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
        newValue: { receiptNumber, paidAmount: baseAmount, studentId: latest.userId, gateway: txGateway },
        details: { transactionId: latest.id },
      });

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
