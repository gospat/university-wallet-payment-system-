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

export default {
  initiatePayment,
  verifyPayment,
  confirmPayload,
};
