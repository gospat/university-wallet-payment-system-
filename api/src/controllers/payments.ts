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

export const initiatePaymentValidator = validateBody(InitiatePaymentSchema);

export const initiatePayment = catchAsync(async (req: Request, res: Response) => {
  const studentId = Number((req as any).user?.id);
  const result = await PaymentService.initiatePayment(studentId, req.body as any, req);
  res.status(200).json({ status: 'success', data: result });
});

const VerifyParamSchema = z.object({ ref: z.string().min(1).trim() });
export const verifyPaymentValidator = [validateParams(VerifyParamSchema)];

export const verifyPayment = catchAsync(async (req: Request, res: Response) => {
  const studentId = Number((req as any).user?.id);
  const ref = String(req.params.ref);
  const result = await PaymentService.verifyPayment(ref, { req, assertStudentId: studentId });
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
