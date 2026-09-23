import express from 'express';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import { z } from 'zod';
import { validateParams, validateQuery, validateBody } from '../middlewares/validate';
import { catchAsync } from '../utils/catchAsync';
import prisma from '../config/database';
import { bursaryListRefunds, bursaryRequestRefund } from '../controllers/refunds';
import { RefundService } from '../services/refund';
import { Prisma } from '@prisma/client';
import { buildBranding } from '../utils/branding';

const router = express.Router();

router.use(protect);
router.use(restrictTo('BURSARY', 'ADMIN'));

// ---------------------------------------------------------------------------
// Refunds:
//   BURSARY: list + create request
//   ADMIN also has access to list (shared same restrictTo 'BURSARY'|'ADMIN' on router)
//   Full approve/reject lives on routes/admin.ts (ADMIN only).
// ---------------------------------------------------------------------------
// Refund endpoints return 400 "disabled" via RefundService guard (endpoints mounted for backwards-compat API surface audit trails)
router.get('/refunds', bursaryListRefunds);
router.post('/refunds', bursaryRequestRefund as any);

const withdrawalIdParams = z.object({ id: z.coerce.number().int().positive() });

// ---------------------------------------------------------------------------
// FR-S3 immutability guard: PATCH /bursary/transactions/:id — never
// allow edits to amount/reference/status/paystackReference on SUCCESS/REVERSED
// transactions. Only metadata fields (description etc.) are allowed; any
// attempt to modify protected fields → 403 (TR-16.3).
// ---------------------------------------------------------------------------
const TxUpdatePatchBody = z.record(z.any());
router.patch('/transactions/:id',
  validateParams(withdrawalIdParams),
  validateBody(TxUpdatePatchBody),
  catchAsync(async (req: any, res) => {
    const txId = Number(req.params.id);
    const tx = await prisma.transaction.findUnique({
      where: { id: txId },
      select: { id: true, status: true },
    });
    RefundService.assertTransactionMutable(tx, req.body ?? {});
    const allowed = new Set(['description', 'metadata']);
    const data: Record<string, any> = {};
    for (const k of Object.keys(req.body ?? {})) {
      if (allowed.has(k)) data[k] = (req.body as any)[k];
    }
    if (Object.keys(data).length === 0) {
      return res.status(200).json({ status: 'success', data: { id: txId, changed: false } });
    }
    const updated = await prisma.transaction.update({ where: { id: txId }, data });
    res.status(200).json({ status: 'success', data: updated });
  }),
);

const WebhookListSchema = z.object({
  eventType: z.string().max(50).trim().optional(),
  isProcessed: z.union([z.boolean(), z.enum(['true', 'false', '1', '0', 'TRUE', 'FALSE'])]).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(1).optional(),
  pageSize: z.coerce.number().int().positive().max(200).default(50).optional(),
  sort: z.enum(['createdAt', 'processedAt', 'eventType']).default('createdAt').optional(),
  order: z.enum(['asc', 'desc']).default('desc').optional(),
  q: z.string().max(255).trim().optional(),
});

router.get('/webhooks/events', validateQuery(WebhookListSchema), catchAsync(async (req: any, res) => {
  const query = req.query as any;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const skip = (page - 1) * pageSize;
  const where: any = {};
  if (query.eventType) where.eventType = String(query.eventType);
  if (query.isProcessed !== undefined && query.isProcessed !== null) {
    const v = typeof query.isProcessed === 'boolean' ? query.isProcessed : ['1','true','TRUE'].includes(String(query.isProcessed));
    where.isProcessed = v;
  }
  if (query.dateFrom || query.dateTo) {
    where.createdAt = {};
    if (query.dateFrom) where.createdAt.gte = query.dateFrom;
    if (query.dateTo) where.createdAt.lte = query.dateTo;
  }
  if (query.q) {
    where.OR = [
      { paystackEventId: { contains: query.q } },
      { transactionReference: { contains: query.q } },
      { lastError: { contains: query.q } },
    ];
  }
  const sortKey = (query.sort ?? 'createdAt') as 'createdAt' | 'processedAt' | 'eventType';
  const order = (query.order ?? 'desc') as 'asc' | 'desc';
  const [rows, total] = await Promise.all([
    prisma.webhookEvent.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { [sortKey]: order },
      select: {
        id: true, paystackEventId: true, eventType: true, transactionReference: true,
        isProcessed: true, processedAt: true, attempts: true, lastError: true,
        createdAt: true,
      },
    }),
    prisma.webhookEvent.count({ where }),
  ]);
  res.status(200).json({
    status: 'success',
    data: { events: rows, total, page, pageSize },
  });
}));

const WebhookEventParam = z.object({ id: z.coerce.number().int().positive() });
router.post('/webhooks/events/:id/reprocess', validateParams(WebhookEventParam), catchAsync(async (req: any, res) => {
  const id = Number(req.params.id);
  const ev = await prisma.webhookEvent.findUnique({ where: { id } });
  if (!ev) return res.status(404).json({ status: 'fail', message: 'Webhook event not found' });
  const { dispatchJob } = await import('../config/queue');
  await dispatchJob(
    'paystack.webhook',
    { paystackEventId: ev.paystackEventId, eventType: ev.eventType, receivedAt: ev.createdAt.toISOString(), forceReprocess: true },
    { jobId: `paystack-webhook:${ev.paystackEventId}:retry:${Date.now()}`, deduplicate: false, retries: 4, priority: 'high' },
  );
  res.status(200).json({ status: 'success', data: { queued: true, id, paystackEventId: ev.paystackEventId } });
}));

const DashboardSummarySchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

router.get('/dashboard/summary', validateQuery(DashboardSummarySchema), catchAsync(async (req: any, res) => {
  const { dateFrom, dateTo } = req.query as any;
  const paidWhere: any = { status: 'SUCCESS', type: 'FEE_PAYMENT' };
  const invoiceTxWhere: any = {};
  if (dateFrom) { paidWhere.createdAt = { ...(paidWhere.createdAt || {}), gte: dateFrom }; invoiceTxWhere.createdAt = { ...(invoiceTxWhere.createdAt || {}), gte: dateFrom }; }
  if (dateTo) { paidWhere.createdAt = { ...(paidWhere.createdAt || {}), lte: dateTo }; invoiceTxWhere.createdAt = { ...(invoiceTxWhere.createdAt || {}), lte: dateTo }; }

  const [
    totalPaidAgg,
    outstandingAgg,
    expectedAgg,
    studentCount,
    invoiceCountAgg,
  ] = await Promise.all([
      prisma.transaction.aggregate({ _sum: { amount: true }, _count: { id: true }, where: paidWhere }),
      prisma.invoice.aggregate({ _sum: { amountDue: true } }),
      prisma.invoice.aggregate({ _sum: { amountPaid: true } }),
      prisma.user.count({ where: { role: 'STUDENT' as any } }),
      prisma.invoice.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

  const totalPaid = Number(totalPaidAgg._sum.amount ?? 0);
  const totalExpectedAllInvoices = Number(outstandingAgg._sum.amountDue ?? 0);
  const totalCollectedInvoices = Number(expectedAgg._sum.amountPaid ?? 0);
  const outstanding = Math.max(0, totalExpectedAllInvoices - totalCollectedInvoices);

  const invoiceStatusCounts: Record<string, number> = {};
  for (const g of invoiceCountAgg) invoiceStatusCounts[g.status] = Number(g._count._all);

  const txPaid = Number(totalPaidAgg._count.id || 0);

  const recentTransactions = await prisma.transaction.findMany({
    where: paidWhere,
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: {
      user: { select: { firstName: true, lastName: true, matricNumber: true } },
      invoice: { include: { fee: { select: { name: true } } } },
    },
  });

  res.status(200).json({
    status: 'success',
    data: {
      cards: {
        totalRevenue: totalPaid,
        totalRevenueTransactions: txPaid,
        totalOutstanding: outstanding,
        expectedInvoicesTotal: totalExpectedAllInvoices,
        collectedInvoicesTotal: totalCollectedInvoices,
        totalStudents: studentCount,
        invoiceStatusCounts,
      },
      recentTransactions: recentTransactions.map((t: any) => ({
        id: t.id,
        reference: t.reference,
        amount: Number(t.amount),
        createdAt: t.createdAt,
        type: t.type,
        channel: t.paystackChannel,
        student: t.user ? { name: `${t.user.firstName} ${t.user.lastName}`.trim(), matricNumber: t.user.matricNumber } : null,
        invoice: t.invoice ? { id: t.invoice.id, invoiceNumber: (t.invoice as any).invoiceNumber, feeName: t.invoice.fee?.name ?? null } : null,
      })),
      filters: { dateFrom: dateFrom || null, dateTo: dateTo || null },
    },
  });
}));

const DashboardStatsSchema = z.object({});

router.get('/dashboard/stats', validateQuery(DashboardStatsSchema), catchAsync(async (_req: any, res) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - (((now.getDay() + 6) % 7)));
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const basePaid: any = { status: 'SUCCESS', type: 'FEE_PAYMENT' };
  const [
    todayAgg, weekAgg, monthAgg, pendingWithdrawAgg, unpaidAgg, refundsSuccessAgg,
  ] = await Promise.all([
    prisma.transaction.aggregate({ _sum: { amount: true }, _count: { id: true }, where: { ...basePaid, createdAt: { gte: startOfToday } } }),
    prisma.transaction.aggregate({ _sum: { amount: true }, _count: { id: true }, where: { ...basePaid, createdAt: { gte: startOfWeek } } }),
    prisma.transaction.aggregate({ _sum: { amount: true }, _count: { id: true }, where: { ...basePaid, createdAt: { gte: startOfMonth } } }),
    Promise.resolve({ _sum: { amount: null }, _count: { id: 0 } }),
    prisma.$queryRawUnsafe<[{ outstanding: string | number }]>(`
      SELECT COALESCE(SUM(amountDue - amountPaid), 0) AS outstanding
      FROM invoices
      WHERE (amountDue - amountPaid) > 0 AND status <> 'PAID'
    `) as Promise<[{ outstanding: string | number }]>,
    prisma.refund.count({ where: { status: 'PAID' as any } }),
  ]);

  const receivablesRow = Array.isArray(unpaidAgg) && unpaidAgg.length > 0 ? unpaidAgg[0] : { outstanding: 0 };
  const pendingReceivables = Number(receivablesRow.outstanding ?? 0);

  res.status(200).json({
    status: 'success',
    data: {
      today: {
        collectionsTotal: Number(todayAgg._sum.amount ?? 0),
        transactionsCount: Number(todayAgg._count.id ?? 0),
      },
      week: {
        collectionsTotal: Number(weekAgg._sum.amount ?? 0),
        transactionsCount: Number(weekAgg._count.id ?? 0),
      },
      month: {
        collectionsTotal: Number(monthAgg._sum.amount ?? 0),
        transactionsCount: Number(monthAgg._count.id ?? 0),
      },
      pendingWithdrawals: {
        count: Number(pendingWithdrawAgg._count.id ?? 0),
        total: Number(pendingWithdrawAgg._sum.amount ?? 0),
      },
      pendingFeeReceivables: pendingReceivables,
      successfulRefundsCount: Number(refundsSuccessAgg ?? 0),
      windows: {
        startOfToday: startOfToday.toISOString(),
        startOfWeek: startOfWeek.toISOString(),
        startOfMonth: startOfMonth.toISOString(),
      },
    },
  });
}));

const DashboardByCategorySchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

router.get('/dashboard/by-category', validateQuery(DashboardByCategorySchema), catchAsync(async (req: any, res) => {
  const { dateFrom, dateTo } = req.query as any;
  const where: any = { status: 'SUCCESS', type: 'FEE_PAYMENT' };
  if (dateFrom) where.createdAt = { ...(where.createdAt || {}), gte: dateFrom };
  if (dateTo) where.createdAt = { ...(where.createdAt || {}), lte: dateTo };

  const txs = await prisma.transaction.findMany({
    where,
    include: { invoice: { include: { fee: { include: { category: { select: { id: true, name: true, code: true } } } } } } },
  });
  const byCategory = new Map<number, { id: number; name: string; code: string; total: number; count: number }>();
  for (const t of txs) {
    const cat = (t.invoice as any)?.fee?.category;
    const key = cat?.id ?? 0;
    const existing = byCategory.get(key) || { id: key, name: cat?.name ?? (key === 0 ? 'Uncategorized' : 'Unknown'), code: cat?.code ?? (key === 0 ? 'UNCAT' : ''), total: 0, count: 0 };
    existing.total += Number(t.amount);
    existing.count += 1;
    byCategory.set(key, existing);
  }
  const rows = Array.from(byCategory.values()).sort((a, b) => b.total - a.total);
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  res.status(200).json({
    status: 'success',
    data: {
      rows,
      grandTotal,
      filters: { dateFrom: dateFrom || null, dateTo: dateTo || null },
    },
  });
}));

const DashboardTrendSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  groupBy: z.enum(['day', 'week', 'month']).default('day').optional(),
});

router.get('/dashboard/trend', validateQuery(DashboardTrendSchema), catchAsync(async (req: any, res) => {
  const { dateFrom, dateTo, groupBy } = req.query as any;
  const unit: 'day' | 'week' | 'month' = groupBy || 'day';

  const to = dateTo ? new Date(dateTo) : new Date();
  const from = dateFrom
    ? new Date(dateFrom)
    : (() => {
        const d = new Date(to);
        if (unit === 'day') d.setDate(d.getDate() - 29);
        else if (unit === 'week') d.setDate(d.getDate() - 13 * 7);
        else d.setMonth(d.getMonth() - 11);
        return d;
      })();

  const points: Array<{ label: string; start: Date; end: Date }> = [];
  let cur = new Date(from);
  while (cur <= to) {
    const start = new Date(cur);
    const end = new Date(cur);
    if (unit === 'day') end.setDate(end.getDate() + 1);
    else if (unit === 'week') end.setDate(end.getDate() + 7);
    else end.setMonth(end.getMonth() + 1);
    const label = (() => {
      if (unit === 'day') return start.toISOString().slice(0, 10);
      if (unit === 'week') return `W/C ${start.toISOString().slice(0, 10)}`;
      return start.toISOString().slice(0, 7);
    })();
    points.push({ label, start, end });
    cur = new Date(end);
  }

  const where: any = { status: 'SUCCESS', type: 'FEE_PAYMENT' };
  where.createdAt = { gte: from, lt: new Date(to) };
  const rows = await prisma.transaction.findMany({ where, select: { createdAt: true, amount: true } });

  const buckets: Array<{ label: string; value: number; count: number; date: string }> = points.map((p) => {
    let value = 0;
    let count = 0;
    for (const r of rows) {
      if (r.createdAt >= p.start && r.createdAt < p.end) {
        value += Number(r.amount);
        count += 1;
      }
    }
    return { label: p.label, value, count, date: p.start.toISOString().slice(0, 10) };
  });

  const total = buckets.reduce((s, b) => s + b.value, 0);
  const totalCount = buckets.reduce((s, b) => s + b.count, 0);

  res.status(200).json({
    status: 'success',
    data: {
      buckets,
      total,
      totalCount,
      unit,
      filters: { dateFrom: from.toISOString(), dateTo: to.toISOString(), groupBy: unit },
    },
  });
}));

const CollectionsReportSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  format: z.enum(['json', 'csv']).default('json').optional(),
});

router.get('/reports/collections', validateQuery(CollectionsReportSchema), catchAsync(async (req: any, res) => {
  const { dateFrom, dateTo, format } = req.query as any;
  const where: any = { status: 'SUCCESS', type: 'FEE_PAYMENT' };
  if (dateFrom) where.createdAt = { ...(where.createdAt || {}), gte: dateFrom };
  if (dateTo) where.createdAt = { ...(where.createdAt || {}), lte: dateTo };
  const rows = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: {
      user: { select: { firstName: true, lastName: true, matricNumber: true, email: true } },
      invoice: { include: { fee: { include: { category: { select: { id: true, name: true, code: true } } } } } },
      receipts: { select: { receiptNumber: true, verificationToken: true } },
    },
  });

  const flat = rows.map((t: any) => {
    const inv = t.invoice as any;
    const fee = inv?.fee;
    const cat = fee?.category;
    return {
      date: new Date(t.createdAt).toISOString(),
      receiptNumber: t.receipts?.[0]?.receiptNumber ?? '',
      transactionReference: t.reference,
      paystackReference: t.paystackReference ?? '',
      channel: t.paystackChannel ?? '',
      studentName: t.user ? `${t.user.firstName} ${t.user.lastName}`.trim() : '',
      matricNumber: t.user?.matricNumber ?? '',
      studentEmail: t.user?.email ?? '',
      invoiceNumber: inv?.invoiceNumber ?? '',
      feeName: fee?.name ?? '',
      categoryName: cat?.name ?? '',
      categoryCode: cat?.code ?? '',
      academicSession: inv?.session ?? '',
      semester: inv?.semester ?? '',
      amountNGN: Number(t.amount).toFixed(2),
    };
  });

  const totals = flat.reduce((acc: any, r: any) => {
    acc.count += 1;
    acc.total += Number(r.amountNGN);
    const key = `${r.categoryCode || 'UNCAT'}`;
    acc.byCat[key] = acc.byCat[key] || { name: r.categoryName || key, total: 0, count: 0 };
    acc.byCat[key].total += Number(r.amountNGN);
    acc.byCat[key].count += 1;
    return acc;
  }, { count: 0, total: 0, byCat: {} as Record<string, { name: string; total: number; count: number }> });

  if (format === 'csv') {
    const Papa = require('papaparse');
    const header = [
      'Date', 'Receipt Number', 'Transaction Reference', 'Paystack Reference', 'Channel',
      'Student Name', 'Matric Number', 'Student Email', 'Invoice Number',
      'Fee Name', 'Category Name', 'Category Code',
      'Academic Session', 'Semester', 'Amount (NGN)',
    ];
    const rows: any = flat.map((r: any) => [
      r.date, r.receiptNumber, r.transactionReference, r.paystackReference, r.channel,
      r.studentName, r.matricNumber, r.studentEmail, r.invoiceNumber,
      r.feeName, r.categoryName, r.categoryCode, r.academicSession, r.semester, r.amountNGN,
    ]);
    let csvRows: any[][] = [header, ...(rows as any)];
    csvRows.push([]);
    csvRows.push(['', '', '', '', '', '', '', '', '', '', '', 'Subtotal by Category']);
    for (const key of Object.keys(totals.byCat)) {
      const c = totals.byCat[key];
      csvRows.push(['', '', '', '', '', '', '', '', '', '', c.name, key, '', '', Number(c.total).toFixed(2)]);
    }
    csvRows.push([]);
    csvRows.push(['', '', '', '', '', '', '', '', '', '', '', 'GRAND TOTAL', '', '', Number(totals.total).toFixed(2)]);
    const csv = Papa.unparse(csvRows, { delimiter: ',' });
    const ts = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `collections_${ts(dateFrom ?? new Date())}_${ts(dateTo ?? new Date())}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send('\uFEFF' + csv);
    return;
  }

  res.status(200).json({
    status: 'success',
    data: {
      rows: flat,
      count: totals.count,
      grandTotal: totals.total,
      byCategory: Object.entries(totals.byCat).map(([code, vUnk]) => {
        const v = vUnk as { name: string; total: number; count: number };
        return { code, name: v.name, total: v.total, count: v.count };
      }),
      filters: { dateFrom: dateFrom || null, dateTo: dateTo || null, format: format || 'json' },
    },
  });
}));

// ---------------------------------------------------------------------------
// Bursary (shared with ADMIN via router restrictTo): Payments list
// ---------------------------------------------------------------------------
const BursaryPaymentListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  sort: z.string().optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  q: z.string().trim().max(200).optional(),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'REVERSED']).optional(),
  gateway: z.enum(['PAYSTACK', 'ALATPAY']).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  studentId: z.coerce.number().int().positive().optional(),
  feeId: z.coerce.number().int().positive().optional(),
  invoiceId: z.coerce.number().int().positive().optional(),
});

router.get(
  '/payments',
  requirePermission('VIEW_PAYMENTS'),
  validateQuery(BursaryPaymentListQuery),
  catchAsync(async (req: any, res) => {
    const q = req.query as z.infer<typeof BursaryPaymentListQuery>;
    const page = q.page;
    const pageSize = q.pageSize;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (q.status) where.status = q.status;
    if (q.gateway) where.gateway = q.gateway;
    if (q.studentId) where.userId = q.studentId;
    if (q.invoiceId) where.invoiceId = q.invoiceId;
    if (q.feeId) where.invoice = { feeId: q.feeId };
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {};
      if (q.dateFrom) where.createdAt.gte = new Date(q.dateFrom);
      if (q.dateTo) where.createdAt.lte = new Date(q.dateTo + 'T23:59:59.999Z');
    }
    if (q.q) {
      where.OR = [
        { reference: { contains: q.q, mode: 'insensitive' } },
        { paystackReference: { contains: q.q, mode: 'insensitive' } },
        { user: { OR: [
          { firstName: { contains: q.q, mode: 'insensitive' } },
          { lastName: { contains: q.q, mode: 'insensitive' } },
          { email: { contains: q.q, mode: 'insensitive' } },
          { matricNumber: { contains: q.q, mode: 'insensitive' } },
        ]}},
        { invoice: { OR: [
          { invoiceNumber: { contains: q.q, mode: 'insensitive' } },
          { fee: { OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { feeCode: { contains: q.q, mode: 'insensitive' } },
          ]}},
        ]}},
      ];
    }

    const orderBy: any = {};
    const allowedSorts: Record<string, string> = {
      createdAt: 'createdAt', amount: 'amount', status: 'status',
    };
    orderBy[allowedSorts[q.sort as string] || 'createdAt'] = q.order || 'desc';

    const [items, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        skip, take: pageSize,
        orderBy,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, matricNumber: true } },
          invoice: { select: { id: true, invoiceNumber: true, fee: { select: { id: true, name: true, feeCode: true } } } },
          receipts: { take: 1, orderBy: { generatedAt: 'desc' }, select: { id: true, receiptNumber: true, verificationToken: true, isVoided: true } },
        },
      }),
      prisma.transaction.count({ where }),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Bursary: Receipts list
// ---------------------------------------------------------------------------
const BursaryReceiptListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  sort: z.string().optional().default('paidAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  q: z.string().trim().max(200).optional(),
  isVoided: z.enum(['true', 'false']).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  studentId: z.coerce.number().int().positive().optional(),
  feeId: z.coerce.number().int().positive().optional(),
});

router.get(
  '/receipts',
  requirePermission('VIEW_RECEIPTS'),
  validateQuery(BursaryReceiptListQuery),
  catchAsync(async (req: any, res) => {
    const q = req.query as z.infer<typeof BursaryReceiptListQuery>;
    const page = q.page;
    const pageSize = q.pageSize;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (q.isVoided === 'true') where.isVoided = true;
    if (q.isVoided === 'false') where.isVoided = false;
    if (q.studentId) where.studentId = q.studentId;
    if (q.feeId) where.invoice = { feeId: q.feeId };
    if (q.dateFrom || q.dateTo) {
      where.paidAt = {};
      if (q.dateFrom) where.paidAt.gte = new Date(q.dateFrom);
      if (q.dateTo) where.paidAt.lte = new Date(q.dateTo + 'T23:59:59.999Z');
    }
    if (q.q) {
      where.OR = [
        { receiptNumber: { contains: q.q, mode: 'insensitive' } },
        { verificationToken: { contains: q.q, mode: 'insensitive' } },
        { student: { OR: [
          { firstName: { contains: q.q, mode: 'insensitive' } },
          { lastName: { contains: q.q, mode: 'insensitive' } },
          { email: { contains: q.q, mode: 'insensitive' } },
          { matricNumber: { contains: q.q, mode: 'insensitive' } },
        ]}},
        { invoice: { OR: [
          { invoiceNumber: { contains: q.q, mode: 'insensitive' } },
          { fee: { OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { feeCode: { contains: q.q, mode: 'insensitive' } },
          ]}},
        ]}},
      ];
    }

    const orderBy: any = {};
    const allowedSorts: Record<string, string> = {
      paidAt: 'paidAt', paidAmount: 'paidAmount', receiptNumber: 'receiptNumber',
    };
    orderBy[allowedSorts[q.sort as string] || 'paidAt'] = q.order || 'desc';

    const [items, total] = await Promise.all([
      prisma.receipt.findMany({
        where,
        skip, take: pageSize,
        orderBy,
        include: {
          student: { select: { id: true, firstName: true, lastName: true, email: true, matricNumber: true } },
          invoice: { select: { id: true, invoiceNumber: true, fee: { select: { id: true, name: true, feeCode: true } } } },
          transaction: { select: { reference: true, paystackChannel: true, gateway: true, type: true, amount: true, status: true, createdAt: true } },
          voidedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
      prisma.receipt.count({ where }),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Bursary: Download formal receipt PDF by id
// ---------------------------------------------------------------------------
const BursaryReceiptIdParam = z.object({ id: z.coerce.number().int().positive() });
router.get(
  '/receipts/:id/download',
  requirePermission('GENERATE_RECEIPT'),
  validateParams(BursaryReceiptIdParam),
  catchAsync(async (req: any, res: any, next: any) => {
    const { downloadFormalReceipt } = await import('../controllers/receipt');
    return downloadFormalReceipt(req, res, next);
  }),
);

// ---------------------------------------------------------------------------
// Bursary: Verify receipt by verificationToken OR receiptNumber (inline panel)
// ---------------------------------------------------------------------------
router.get(
  '/receipts/verify/:tokenOrNumber',
  requirePermission('VIEW_RECEIPTS'),
  catchAsync(async (req: any, res) => {
    const tokenOrNumber = String(req.params.tokenOrNumber || '').trim();
    const row: any = await prisma.receipt.findFirst({
      where: { OR: [
        { verificationToken: tokenOrNumber },
        { receiptNumber: tokenOrNumber },
      ]},
      include: {
        student: { select: { id: true, firstName: true, lastName: true, email: true, matricNumber: true } },
        invoice: { include: { fee: { select: { id: true, name: true, feeCode: true } } } },
        transaction: { select: { reference: true, paystackReference: true, paystackChannel: true, gateway: true, type: true, amount: true, status: true, createdAt: true } },
      },
    });

    const brand = await buildBranding();

    if (!row) {
      res.status(404).json({
        status: 'fail',
        verified: false,
        message: 'Receipt not found or verification token invalid',
        branding: brand,
      });
      return;
    }

    res.status(200).json({
      status: 'success',
      verified: !row.isVoided,
      data: {
        id: row.id,
        receiptNumber: row.receiptNumber,
        verificationToken: row.verificationToken,
        paidAmount: Number(row.paidAmount),
        paidAt: row.paidAt,
        isVoided: row.isVoided,
        voidedAt: row.voidedAt || null,
        paymentChannel: row.paymentChannel,
        paymentMethodDetail: row.paymentMethodDetail,
        paystackReference: row.paystackReference || null,
        student: row.student,
        invoice: row.invoice ? {
          id: row.invoice.id,
          invoiceNumber: row.invoice.invoiceNumber || null,
          dueDate: row.invoice.dueDate || null,
          session: row.invoice.session || null,
          semester: row.invoice.semester || null,
          fee: row.invoice.fee ? { name: row.invoice.fee.name, feeCode: row.invoice.fee.feeCode } : null,
        } : null,
        transaction: row.transaction,
      },
      branding: brand,
    });
  }),
);

export default router;
