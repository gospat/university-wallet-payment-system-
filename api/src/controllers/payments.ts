// =============================================================================
// Payments controllers — /students/payments/* (STUDENT self-service)
// -----------------------------------------------------------------------------
//   POST /students/payments/initiate         → initiate payment on an invoice
//   GET  /students/payments/verify/:ref      → verify a Paystack payment ref
// Both are mounted inside the STUDENT-only router (Role.STUDENT guard).
// =============================================================================
import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { ConfirmPayloadService, InitiatePaymentSchema, PaymentService } from '../services/payment';
import { z } from 'zod';
import { AlatpayPopupUnavailableError, isAlatpayUuid } from '../utils/alatpay';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { Role } from '@prisma/client';

export const initiatePaymentValidator = validateBody(InitiatePaymentSchema);

export const initiatePayment = catchAsync(async (req: Request, res: Response) => {
  const studentId = Number((req as any).user?.id);
  try {
    const result = await PaymentService.initiatePayment(studentId, req.body as any, req);
    res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    if (err instanceof AlatpayPopupUnavailableError) {
      res.status(502).json({
        status: 'error',
        code: 'ALATPAY_POPUP_UNAVAILABLE',
        message: 'ALATPay checkout is temporarily unavailable. Please retry shortly or use Paystack.',
      });
      return;
    }
    throw err;
  }
});

const VerifyParamSchema = z.object({ ref: z.string().min(1).max(255).trim() });
const VerifyQuerySchema = z.object({
  providerReference: z.string().min(1).max(255).trim().optional(),
});
export const verifyPaymentValidator = [
  validateParams(VerifyParamSchema),
  validateQuery(VerifyQuerySchema),
];

export const verifyPayment = catchAsync(async (req: Request, res: Response) => {
  const studentId = Number((req as any).user?.id);
  const ref = String(req.params.ref);
  const rawProviderRef = (req as any).query?.providerReference
    ? String((req as any).query.providerReference).trim()
    : undefined;

  const serviceOpts: {
    req?: any;
    assertStudentId: number;
    providerReference?: string;
    expectedTransactionId?: number;
  } = { req, assertStudentId: studentId };

  if (rawProviderRef !== undefined && rawProviderRef !== '') {
    if (!isAlatpayUuid(rawProviderRef)) {
      throw new AppError('Invalid provider reference format (expected strict UUID v4).', 400, {
        code: 'ALATPAY_FINAL_TXID_MALFORMED',
      });
    }
    const tx = await prisma.transaction.findFirst({
      where: { reference: ref },
      select: {
        id: true,
        gateway: true,
        userId: true,
        status: true,
        alatpayFinalTransactionId: true,
      },
      orderBy: [{ updatedAt: 'desc' }],
    });
    if (!tx) throw new AppError('Transaction not found.', 404);
    if (Number(tx.userId) !== Number(studentId)) {
      throw new AppError('Transaction not owned by authenticated student.', 403, {
        code: 'VERIFY_NOT_OWNER',
      });
    }
    if (tx.gateway !== 'ALATPAY') {
      throw new AppError(`Cannot verify non-ALATPAY transaction with provider reference (gateway=${tx.gateway}).`, 400, {
        code: 'VERIFY_WRONG_GATEWAY',
      });
    }
    if (tx.alatpayFinalTransactionId && tx.alatpayFinalTransactionId !== rawProviderRef) {
      throw new AppError('Conflicting stored final transaction identifier.', 409, {
        code: 'ALATPAY_FINAL_TXID_CONFLICT',
        stored: tx.alatpayFinalTransactionId,
      });
    }
    serviceOpts.providerReference = rawProviderRef;
    serviceOpts.expectedTransactionId = Number(tx.id);
  }

  const result = await PaymentService.verifyPayment(ref, serviceOpts);
  res.status(200).json({ status: 'success', data: result });
});

const ConfirmPayloadQuerySchema = z.object({
  invoiceId: z.coerce.number().int().positive(),
});
export const confirmPayloadValidator = validateQuery(ConfirmPayloadQuerySchema);

export const confirmPayload = catchAsync(async (req: Request, res: Response) => {
  const studentId = Number((req as any).user?.id);
  const invoiceId = Number((req as any).query?.invoiceId);
  const result = await ConfirmPayloadService.getConfirmPayload(studentId, invoiceId);
  res.status(200).json({ status: 'success', data: result });
});

const ContinueOptionTxParam = z.object({ transactionId: z.coerce.number().int().positive() });
export const getContinueOptionValidator = [validateParams(ContinueOptionTxParam)];

export const getContinueOption = catchAsync(async (req: Request, res: Response) => {
  const userId = Number((req as any).user?.id);
  const txId = Number(req.params.transactionId);

  const tx = await prisma.transaction.findUnique({
    where: { id: txId },
    select: {
      id: true,
      userId: true,
      status: true,
      gateway: true,
      reference: true,
      expectedAmount: true,
      paystackReference: true,
      alatpaySessionId: true,
      alatpayCheckoutUrl: true,
      alatpayOrderReference: true,
      alatpayInitPaymentReference: true,
      metadata: true,
    },
  });

  if (!tx) {
    throw new AppError('Transaction not found', 404);
  }
  if (Number(tx.userId) !== Number(userId)) {
    throw new AppError('Unauthorized access to this transaction', 403);
  }

  const nonTerminal = ['PENDING', 'PROCESSING'];
  const statusStr = String(tx.status ?? '').toUpperCase();

  if (!nonTerminal.includes(statusStr)) {
    return res.status(200).json({
      canResume: false,
      reason: 'Transaction is no longer in an unresolved pending state.',
      resumeMode: 'none',
      payload: null,
    });
  }

  const gateway = String(tx.gateway ?? '').toUpperCase();
  const expectedAmountNaira = tx.expectedAmount != null ? Number(tx.expectedAmount) : undefined;
  const bellsReference = tx.reference;
  const transactionStatus = String(tx.status);

  if (gateway === 'ALATPAY') {
    const checkoutFromMetadata = (tx.metadata as any)?.alatpay?.checkout_url ?? null;
    const storedCheckout = tx.alatpayCheckoutUrl || checkoutFromMetadata;
    const hasSession = !!tx.alatpaySessionId && String(tx.alatpaySessionId).trim().length > 0;
    const hasCheckout = !!storedCheckout && String(storedCheckout).trim().length > 0;
    const hasInitRef = !!tx.alatpayInitPaymentReference && String(tx.alatpayInitPaymentReference).trim().length > 0;
    const hasOrderRef = !!tx.alatpayOrderReference && String(tx.alatpayOrderReference).trim().length > 0;

    // ALATPay SDK setup is NOT a supposed "resume" mechanism unless it is
    // verified it reuses the SAME provider attempt. The server SDK
    // /initialize returns new sessions / new init refs. Therefore we can
    // only safely claim a resume when ALL of the required identifiers
    // (session + init ref + order ref + stored checkout URL) from the
    // original single initiation are present and match this transaction.
    // Otherwise, clearly explain that safe continuation is unavailable.
    const hasAllOriginalSessionArtifacts =
      hasSession && hasInitRef && hasOrderRef && hasCheckout;

    if (hasAllOriginalSessionArtifacts) {
      return res.status(200).json({
        canResume: true,
        reason: null,
        resumeMode: 'alatpay_native',
        payload: {
          alatpayCheckoutUrl: storedCheckout || null,
          alatpaySessionId: tx.alatpaySessionId || null,
          alatpayInitPaymentReference: tx.alatpayInitPaymentReference || null,
          alatpayOrderReference: tx.alatpayOrderReference || null,
          alatpayPublicKey: null,
          paystackAuthorizationUrl: null,
          paystackReference: null,
          bellsReference,
          transactionStatus,
          expectedAmountNaira,
          sdkSetupIsSameAttempt: false,
        },
      });
    }

    // Partial stored artifacts: do NOT claim resume; do NOT re-run SDK
    // setup. Direct to Status check / support.
    return res.status(200).json({
      canResume: false,
      reason: 'Stored ALATPay checkout session is not available for safe resume of the original provider attempt. Please use Check Payment Status or contact Support.',
      resumeMode: 'none',
      canCheckStatus: true,
      payload: null,
    });
  }

  if (gateway === 'PAYSTACK') {
    const hasPaystackRef = !!tx.paystackReference && String(tx.paystackReference).trim().length > 0;
    const authFromMeta = (tx.metadata as any)?.paystack?.authorization_url ?? null;
    if (hasPaystackRef || authFromMeta) {
      return res.status(200).json({
        canResume: true,
        reason: null,
        resumeMode: 'paystack_redirect',
        payload: {
          alatpayCheckoutUrl: null,
          alatpaySessionId: null,
          alatpayInitPaymentReference: null,
          alatpayOrderReference: null,
          alatpayPublicKey: null,
          paystackAuthorizationUrl: authFromMeta || null,
          paystackReference: tx.paystackReference || null,
          bellsReference,
          transactionStatus,
          expectedAmountNaira,
        },
      });
    }
  }

  return res.status(200).json({
    canResume: false,
    reason: 'Stored checkout session data not available for safe resume. Please Check Payment Status or contact Support.',
    resumeMode: 'none',
    payload: null,
  });
});

// =============================================================================
// ADMIN / BURSARY — Verify Payment workspace
// -----------------------------------------------------------------------------
// Shared controllers used by both /admin/payments and /bursary/payments.
//
// Security invariants:
//   • The transaction is loaded server-side. The browser is NEVER allowed to
//     substitute a gateway/provider identifier for the stored trusted reference.
//   • For ALATPay, provider verification is ONLY attempted when the stored
//     alatpayFinalTransactionId is a strict UUID v4. Order/init/WEMA-PAY
//     references are NEVER used as a fallback.
//   • For Paystack, the stored paystackReference is the only identifier used.
//   • PaymentService.verifyPayment performs the authoritative, idempotent
//     financial posting. Transport errors and non-terminal provider statuses
//     never move the transaction to FAILED.
//   • The GET lookup response is sanitized: no metadata, no ALATPay checkout
//     URL/session id, no raw provider payloads, no internal tokens.
// =============================================================================
const VERIFY_TX_SELECT = {
  id: true,
  reference: true,
  status: true,
  gateway: true,
  amount: true,
  expectedAmount: true,
  description: true,
  type: true,
  createdAt: true,
  updatedAt: true,
  paystackReference: true,
  paystackChannel: true,
  alatpayReference: true,
  alatpayOrderReference: true,
  alatpayInitPaymentReference: true,
  alatpayFinalTransactionId: true,
  underpaidReason: true,
  userId: true,
  invoiceId: true,
  user: {
    select: { id: true, firstName: true, lastName: true, email: true, matricNumber: true },
  },
  invoice: {
    select: {
      id: true,
      invoiceNumber: true,
      amountDue: true,
      amountPaid: true,
      status: true,
      fee: { select: { id: true, name: true, feeCode: true } },
    },
  },
  receipts: {
    select: { id: true, receiptNumber: true, verificationToken: true, isVoided: true, generatedAt: true },
    orderBy: { generatedAt: 'desc' },
    take: 1,
  },
} as const;

const buildVerifyPayload = async (tx: any) => {
  const gl = await prisma.generalLedger.findFirst({
    where: { transactionId: tx.id },
    select: { id: true, entryType: true, amount: true, createdAt: true },
  });
  const webhookEvidence = await prisma.webhookEvent
    .findFirst({
      where: { transactionReference: tx.reference },
      select: { id: true, eventType: true, isProcessed: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
    .catch(() => null);
  const settlementEvidence =
    (prisma.settlement as any)?.count
      ? await prisma.settlement
          .count({ where: { transactionId: tx.id } })
          .then((c: number) => (c > 0 ? { exists: true, count: c } : null))
          .catch(() => null)
      : null;
  let alatpayFinalTxIdValid = false;
  if (tx.gateway === 'ALATPAY' && tx.alatpayFinalTransactionId) {
    alatpayFinalTxIdValid = isAlatpayUuid(tx.alatpayFinalTransactionId);
  }
  return {
    transaction: tx,
    generalLedger: gl,
    webhookEvidence,
    settlementEvidence,
    alatpayFinalTxIdValid,
  };
};

export const getTransactionForVerify = catchAsync(async (req: Request, res: Response) => {
  const txId = Number(req.params.id);
  if (!Number.isFinite(txId) || txId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid transaction ID.' });
  }
  const tx = await prisma.transaction.findUnique({
    where: { id: txId },
    select: VERIFY_TX_SELECT as any,
  });
  if (!tx) {
    return res.status(404).json({ status: 'error', message: 'Transaction not found.' });
  }
  const data = await buildVerifyPayload(tx);
  return res.status(200).json({ status: 'success', data });
});

const LookupQuerySchema = z.object({
  type: z.enum(['reference', 'transactionId', 'paystackReference', 'alatpayFinalTransactionId']),
  value: z.string().min(1).max(255).trim(),
});

export const lookupTransactionForVerify = catchAsync(async (req: Request, res: Response) => {
  const parsed = LookupQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ status: 'error', message: 'Invalid lookup parameters.', issues: parsed.error.issues });
  }
  const { type, value } = parsed.data;
  let where: any = {};
  if (type === 'transactionId') {
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(404).json({ status: 'error', message: 'Transaction not found.' });
    }
    where = { id };
  } else if (type === 'reference') {
    where = { reference: value };
  } else if (type === 'paystackReference') {
    where = { paystackReference: value };
  } else if (type === 'alatpayFinalTransactionId') {
    if (!isAlatpayUuid(value)) {
      return res.status(404).json({ status: 'error', message: 'Transaction not found.' });
    }
    where = { alatpayFinalTransactionId: value };
  }
  const tx = await prisma.transaction.findFirst({
    where,
    select: VERIFY_TX_SELECT as any,
    orderBy: { createdAt: 'desc' },
  });
  if (!tx) {
    return res.status(404).json({ status: 'error', message: 'Transaction not found.' });
  }
  const data = await buildVerifyPayload(tx);
  return res.status(200).json({ status: 'success', data });
});

export const verifyPaymentByTransactionId = catchAsync(async (req: Request, res: Response) => {
  const txId = Number(req.params.id);
  if (!Number.isFinite(txId) || txId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid transaction ID.' });
  }

  const tx = await prisma.transaction.findUnique({
    where: { id: txId },
    select: {
      id: true,
      reference: true,
      status: true,
      gateway: true,
      paystackReference: true,
      alatpayFinalTransactionId: true,
      alatpayReference: true,
      alatpayOrderReference: true,
      alatpayInitPaymentReference: true,
      expectedAmount: true,
      amount: true,
      invoiceId: true,
    },
  });
  if (!tx) {
    return res.status(404).json({ status: 'error', message: 'Transaction not found.' });
  }

  // Idempotency for already-successful transactions: do not call the provider
  // again and do not create duplicate receipt/GL/invoice-credit.
  if (String(tx.status) === 'SUCCESS') {
    const receipt = await prisma.receipt.findFirst({
      where: { transactionId: tx.id, isVoided: false },
      select: { id: true, receiptNumber: true, verificationToken: true },
    });
    const gl = await prisma.generalLedger.findFirst({ where: { transactionId: tx.id } });
    return res.status(200).json({
      status: 'success',
      data: {
        alreadyVerified: true,
        verified: true,
        bellsStatus: tx.status,
        providerStatus: null,
        provider: tx.gateway,
        amountExpected: tx.expectedAmount,
        amountConfirmed: tx.amount,
        providerTransactionId: tx.gateway === 'PAYSTACK' ? tx.paystackReference : tx.alatpayFinalTransactionId,
        verifiedAt: new Date().toISOString(),
        receipt: receipt ?? null,
        generalLedger: gl ? { id: gl.id } : null,
        message: 'Already verified and financially posted.',
      },
    });
  }

  // Resolve the trusted provider reference server-side. NEVER accept one from
  // the request body.
  let providerReference: string | null = null;
  let unableReason: string | null = null;

  if (tx.gateway === 'ALATPAY') {
    if (tx.alatpayFinalTransactionId && isAlatpayUuid(tx.alatpayFinalTransactionId)) {
      providerReference = String(tx.alatpayFinalTransactionId).trim();
    } else {
      unableReason = 'ALATPAY_FINAL_TXID_REQUIRED';
    }
  } else if (tx.gateway === 'PAYSTACK') {
    if (tx.paystackReference && typeof tx.paystackReference === 'string' && String(tx.paystackReference).trim()) {
      providerReference = String(tx.paystackReference).trim();
    } else {
      unableReason = 'PAYSTACK_REFERENCE_REQUIRED';
    }
  } else {
    unableReason = 'UNSUPPORTED_GATEWAY';
  }

  if (unableReason) {
    return res.status(200).json({
      status: 'unable_to_verify',
      data: {
        verified: false,
        bellsStatus: tx.status,
        provider: tx.gateway,
        reason: unableReason,
        providerReferenceUsed: null,
        message:
          unableReason === 'ALATPAY_FINAL_TXID_REQUIRED'
            ? 'Provider verification unavailable because the final ALATPay transaction identifier was not captured. The payment remains unresolved. Check webhook/reconciliation evidence or use the authorized cancellation/reconciliation workflow.'
            : 'Provider verification unavailable: trusted provider reference not stored. No financial status was changed.',
      },
    });
  }

  // PaymentService.verifyPayment internally handles provider transport
  // failures and non-terminal statuses safely (they never become FAILED).
  // We do NOT blanket-catch every error as a provider outage: application,
  // database or financial-processing errors must propagate as 500s so they
  // are not misrepresented as provider unavailability.
  const result: any = await PaymentService.verifyPayment(tx.reference, {
    providerReference: providerReference ?? undefined,
    expectedTransactionId: tx.id,
    req,
  });

  const bellsStatus = result?.status ?? tx.status;
  const verified = result?.verified === true || bellsStatus === 'SUCCESS';
  const providerStatus = result?.providerStatus ?? result?.reason ?? null;

  // Detect provider transport / non-terminal results returned by
  // PaymentService (verified=false, status still non-terminal) so the UI can
  // show "Provider unavailable" rather than claiming failure.
  const isTransportOrNonTerminal =
    !verified &&
    result?.verified === false &&
    bellsStatus !== 'FAILED' &&
    (result?.reason?.toLowerCase().includes('transport') ||
      result?.reason?.toLowerCase().includes('non-terminal') ||
      ['PENDING', 'PROCESSING'].includes(String(bellsStatus)));

  return res.status(200).json({
    status: verified ? 'success' : isTransportOrNonTerminal ? 'provider_unavailable' : 'pending',
    data: {
      verified,
      bellsStatus,
      providerStatus,
      provider: tx.gateway,
      amountExpected: tx.expectedAmount,
      amountConfirmed: result?.amount_paid_kobo != null ? Number(result.amount_paid_kobo) / 100 : tx.amount,
      providerTransactionId: providerReference,
      verifiedAt: new Date().toISOString(),
      reason: result?.reason ?? null,
      reconciliationException: result?.reconciliationException === true,
      reconciliationExceptionKind: result?.reconciliationExceptionKind ?? null,
    },
  });
});

export default {
  initiatePayment,
  verifyPayment,
  confirmPayload,
  getContinueOption,
  getTransactionForVerify,
  lookupTransactionForVerify,
  verifyPaymentByTransactionId,
};
