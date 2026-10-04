import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import { RefundService, RequestRefundSchema, RejectRefundSchema, ListRefundsSchema, ApproveRefundSchema } from '../services/refund';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';

// ------------------------------ BURSARY ----------------------------------
export const bursaryListRefunds = [
  validateQuery(ListRefundsSchema),
  catchAsync(async (req: Request, res: Response) => {
    const q = (req as any).validatedQuery ?? ListRefundsSchema.parse(req.query);
    const result = await RefundService.listRefunds(q);
    res.status(200).json({ status: 'success', data: result });
  }),
];

export const bursaryRequestRefund = [
  validateBody(RequestRefundSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req as any).validatedBody ?? RequestRefundSchema.parse(req.body);
      const refund = await RefundService.requestRefund(body, req as any);
      res.status(201).json({ status: 'success', data: refund });
    } catch (err) {
      next(err);
    }
  }),
];

// ------------------------------ ADMIN ------------------------------------
export const adminListRefunds = [
  validateQuery(ListRefundsSchema),
  catchAsync(async (req: Request, res: Response) => {
    const q = (req as any).validatedQuery ?? ListRefundsSchema.parse(req.query);
    const result = await RefundService.listRefunds(q);
    res.status(200).json({ status: 'success', data: result });
  }),
];

export const adminApproveRefund = [
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'fail', message: 'Invalid refund id' });
      }
      ApproveRefundSchema.parse(req.body ?? {});
      const result = await RefundService.approveRefund(id, req as any);
      res.status(200).json({ status: 'success', data: result });
    } catch (err) {
      next(err);
    }
  }),
];

export const adminRejectRefund = [
  validateBody(RejectRefundSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'fail', message: 'Invalid refund id' });
      }
      const body = (req as any).validatedBody ?? RejectRefundSchema.parse(req.body);
      const result = await RefundService.rejectRefund(id, body, req as any);
      res.status(200).json({ status: 'success', data: result });
    } catch (err) {
      next(err);
    }
  }),
];
