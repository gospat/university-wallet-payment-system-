import express from 'express';
import { z } from 'zod';
import { PaymentGateway } from '@prisma/client';
import { protect, restrictTo } from '../middlewares/auth';
import { validateParams, validateQuery, validateBody } from '../middlewares/validate';
import { catchAsync } from '../utils/catchAsync';
import {
  ReconciliationService,
  Classification,
  PaystackTxRow,
  AlatpayTxRow,
} from '../services/reconciliation';

const router = express.Router();

router.use(protect);
router.use(restrictTo('BURSARY', 'ADMIN'));

const GatewayEnum = z.enum([PaymentGateway.PAYSTACK, PaymentGateway.ALATPAY]);

const ChargeSourceEnum = z.enum(['ALL', 'CATALOGUE', 'DIRECT_BILL']).default('ALL');

const SummaryQuery = z.object({
  dateFrom: z.coerce.date(),
  dateTo: z.coerce.date(),
  feeId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  gateway: GatewayEnum.optional(),
  chargeSource: ChargeSourceEnum.optional(),
});

router.get(
  '/summary',
  validateQuery(SummaryQuery),
  catchAsync(async (req: any, res) => {
    const { dateFrom, dateTo, feeId, gateway, chargeSource } = req.query as any;
    const { summary } = await ReconciliationService.runCompare({
      dateFrom: new Date(dateFrom),
      dateTo: new Date(dateTo),
      feeId: feeId !== undefined && feeId !== null ? Number(feeId) : undefined,
      gateway: gateway ?? undefined,
      chargeSource: chargeSource ?? 'ALL',
    });
    res.status(200).json({ status: 'success', data: { summary } });
  }),
);

const ItemsQuery = z.object({
  dateFrom: z.coerce.date(),
  dateTo: z.coerce.date(),
  page: z.coerce.number().int().positive().default(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(50).optional(),
  classification: z
    .enum([
      'MATCHED',
      'AMOUNT_MISMATCH',
      'MISSING_INTERNAL',
      'MISSING_GATEWAY',
      'DUPLICATE_REFERENCE',
      'REVERSED_TXN',
      'MISSING_RECEIPT',
    ])
    .optional(),
  feeId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  gateway: GatewayEnum.optional(),
  chargeSource: ChargeSourceEnum.optional(),
});

router.get(
  '/items',
  validateQuery(ItemsQuery),
  catchAsync(async (req: any, res) => {
    const q = req.query as any;
    const page = Number(q.page ?? 1);
    const limit = Number(q.limit ?? 50);
    const skip = (page - 1) * limit;
    const { items, summary } = await ReconciliationService.runCompare({
      dateFrom: new Date(q.dateFrom),
      dateTo: new Date(q.dateTo),
      feeId: q.feeId !== undefined && q.feeId !== null ? Number(q.feeId) : undefined,
      gateway: q.gateway ?? undefined,
      chargeSource: q.chargeSource ?? 'ALL',
    });
    let filtered = items;
    if (q.classification) {
      filtered = items.filter((it) => it.classification === (q.classification as Classification));
    }
    if (q.gateway) {
      filtered = filtered.filter((it) => it.gateway === q.gateway);
    }
    const total = filtered.length;
    const pageItems = filtered.slice(skip, skip + limit);
    res.status(200).json({
      status: 'success',
      data: {
        items: pageItems,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        filters: {
          classification: q.classification ?? null,
          gateway: q.gateway ?? null,
          chargeSource: q.chargeSource ?? 'ALL',
          dateFrom: q.dateFrom,
          dateTo: q.dateTo,
        },
        summary,
      },
    });
  }),
);

const ReportQuery = z.object({
  dateFrom: z.coerce.date(),
  dateTo: z.coerce.date(),
  format: z.enum(['csv', 'json']).default('json').optional(),
  feeId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  gateway: GatewayEnum.optional(),
  chargeSource: ChargeSourceEnum.optional(),
});

router.get(
  '/report',
  validateQuery(ReportQuery),
  catchAsync(async (req: any, res) => {
    const q = req.query as any;
    const format = (q.format ?? 'json') as 'csv' | 'json';
    const result = await ReconciliationService.exportReport({
      format,
      dateFrom: new Date(q.dateFrom),
      dateTo: new Date(q.dateTo),
      feeId: q.feeId !== undefined && q.feeId !== null ? Number(q.feeId) : undefined,
      gateway: q.gateway ?? undefined,
      chargeSource: q.chargeSource ?? 'ALL',
    });
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=${result.filename}`,
      );
      res.send(result.payload as string);
      return;
    }
    res.status(200).json({
      status: 'success',
      data: result.payload,
      meta: { filename: result.filename },
    });
  }),
);

const ReferenceParam = z.object({
  reference: z.string().min(1).max(200),
});

const MarkReconciledBody = z.object({
  notes: z.string().max(2000).optional(),
});

router.post(
  '/items/:reference/mark-reconciled',
  validateParams(ReferenceParam),
  validateBody(MarkReconciledBody),
  catchAsync(async (req: any, res) => {
    const userId = Number(req.user?.id);
    const ipAddress =
      req.ip ?? (req.headers?.['x-forwarded-for'] as string)?.split(',')[0] ?? null;
    const userAgent = (req.headers?.['user-agent'] as string) ?? null;
    const result = await ReconciliationService.markReconciled({
      paystackReference: String(req.params.reference),
      userId,
      notes: req.body?.notes,
      ipAddress,
      userAgent,
    });
    res.status(200).json({ status: 'success', data: result });
  }),
);

const CreateInternalBody = z.object({
  paystackData: z.record(z.any()).optional(),
  alatpayData: z.record(z.any()).optional(),
  gatewayData: z.object({ gateway: z.enum([PaymentGateway.PAYSTACK, PaymentGateway.ALATPAY]) }).passthrough().optional(),
});

router.post(
  '/items/:reference/create-internal',
  validateParams(ReferenceParam),
  validateBody(CreateInternalBody),
  catchAsync(async (req: any, res) => {
    const userId = Number(req.user?.id);
    const ipAddress =
      req.ip ?? (req.headers?.['x-forwarded-for'] as string)?.split(',')[0] ?? null;
    const userAgent = (req.headers?.['user-agent'] as string) ?? null;
    const reference = String(req.params.reference);

    const callParams: any = { userId, ipAddress, userAgent };
    if (req.body?.paystackData) {
      let pd: PaystackTxRow = req.body.paystackData;
      if (!pd.reference) pd = { ...pd, reference };
      callParams.paystackData = pd;
    }
    if (req.body?.alatpayData) {
      let ad: AlatpayTxRow = req.body.alatpayData;
      if (!ad.Id && !ad.id && !ad.transactionId && !ad.reference && !ad.orderId) {
        ad = { ...ad, reference };
      }
      callParams.alatpayData = ad;
    }
    if (req.body?.gatewayData) {
      callParams.gatewayData = req.body.gatewayData;
    }
    if (!callParams.paystackData && !callParams.alatpayData && !callParams.gatewayData) {
      callParams.paystackData = { reference };
    }
    const result = await ReconciliationService.createInternalFromMissing(callParams);
    res.status(result.created ? 201 : 200).json({ status: 'success', data: result });
  }),
);

export default router;
