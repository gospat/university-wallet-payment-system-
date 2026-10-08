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
import { csvLineSafe, appendCsvIntegrityTrailer } from '../utils/security';

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
router.get('/refunds', requirePermission('PROCESS_REFUND'), bursaryListRefunds);
router.post('/refunds', requirePermission('PROCESS_REFUND'), bursaryRequestRefund as any);

const withdrawalIdParams = z.object({ id: z.coerce.number().int().positive() });

// ---------------------------------------------------------------------------
// FR-S3 immutability guard: PATCH /bursary/transactions/:id — never
// allow edits to amount/reference/status/paystackReference on SUCCESS/REVERSED
// transactions. Only metadata fields (description etc.) are allowed; any
// attempt to modify protected fields → 403 (TR-16.3).
// ---------------------------------------------------------------------------
const TxUpdatePatchBody = z.record(z.any());
router.patch('/transactions/:id',
  requirePermission('VERIFY_PAYMENT'),
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

router.get('/webhooks/events', requirePermission('VIEW_PAYMENTS'), validateQuery(WebhookListSchema), catchAsync(async (req: any, res) => {
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
  type WhAllowedSort = 'createdAt' | 'processedAt' | 'eventType';
  type WhAllowedOrder = 'asc' | 'desc';
  const WH_ALLOWED_SORTS: ReadonlySet<WhAllowedSort> = new Set(['createdAt', 'processedAt', 'eventType']);
  const WH_ALLOWED_ORDERS: ReadonlySet<WhAllowedOrder> = new Set(['asc', 'desc']);
  const WH_SORT_TO_FIELD: Record<WhAllowedSort, 'createdAt' | 'processedAt' | 'eventType'> = {
    createdAt: 'createdAt',
    processedAt: 'processedAt',
    eventType: 'eventType',
  };
  const rawSortWh = query.sort as WhAllowedSort | string | undefined;
  const rawOrderWh = query.order as WhAllowedOrder | string | undefined;
  const sortWh: WhAllowedSort = WH_ALLOWED_SORTS.has(rawSortWh as WhAllowedSort)
    ? (rawSortWh as WhAllowedSort)
    : 'createdAt';
  const orderWh: WhAllowedOrder = WH_ALLOWED_ORDERS.has(rawOrderWh as WhAllowedOrder)
    ? (rawOrderWh as WhAllowedOrder)
    : 'desc';
  const sortKey = WH_SORT_TO_FIELD[sortWh];
  const order = orderWh;
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
router.post('/webhooks/events/:id/reprocess', requirePermission('VIEW_PAYMENTS'), validateParams(WebhookEventParam), catchAsync(async (req: any, res) => {
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

router.get('/dashboard/summary', requirePermission('VIEW_DASHBOARD'), validateQuery(DashboardSummarySchema), catchAsync(async (req: any, res) => {
  const { dateFrom, dateTo } = req.query as any;
  const paidWhere: any = { status: 'SUCCESS', type: 'FEE_PAYMENT' };
  if (dateFrom) paidWhere.createdAt = { ...(paidWhere.createdAt || {}), gte: dateFrom };
  if (dateTo) paidWhere.createdAt = { ...(paidWhere.createdAt || {}), lte: dateTo };

  const [
    totalPaidAgg,
    studentCount,
    receiptsCountAgg,
    uniquePayingStudentsAgg,
    feesPublishedCountAgg,
  ] = await Promise.all([
      prisma.transaction.aggregate({ _sum: { amount: true }, _count: { id: true }, where: paidWhere }),
      prisma.user.count({ where: { role: 'STUDENT' as any } }),
      prisma.receipt.count({
        where: {
          isVoided: false,
          paidAt: dateFrom || dateTo ? {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(dateTo + 'T23:59:59.999Z') } : {}),
          } as any : undefined,
        },
      }),
      prisma.transaction.groupBy({
        by: ['userId'],
        where: paidWhere,
        _count: { userId: true },
      }),
      prisma.fee.count({ where: { isActive: true } }),
    ]);

  const totalPaid = Number(totalPaidAgg._sum.amount ?? 0);
  const txPaid = Number(totalPaidAgg._count.id || 0);
  const uniquePayingStudents = Number(uniquePayingStudentsAgg?.length ?? 0);
  const averageTransaction = txPaid ? totalPaid / txPaid : 0;
  const receiptsIssued = Number(receiptsCountAgg || 0);

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
        totalCollected: totalPaid,
        totalRevenue: totalPaid,
        totalRevenueTransactions: txPaid,
        transactionsCount: txPaid,
        receiptsIssued,
        uniquePayingStudents,
        averageTransaction,
        totalStudents: studentCount,
        feesPublishedCount: Number(feesPublishedCountAgg || 0),
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

router.get('/dashboard/stats', requirePermission('VIEW_DASHBOARD'), validateQuery(DashboardStatsSchema), catchAsync(async (_req: any, res) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - (((now.getDay() + 6) % 7)));
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const basePaid: any = { status: 'SUCCESS', type: 'FEE_PAYMENT' };
  const [
    todayAgg, weekAgg, monthAgg, pendingWithdrawAgg, refundsSuccessAgg,
    invoiceDueAgg, invoicePaidAgg,
  ] = await Promise.all([
    prisma.transaction.aggregate({ _sum: { amount: true }, _count: { id: true }, where: { ...basePaid, createdAt: { gte: startOfToday } } }),
    prisma.transaction.aggregate({ _sum: { amount: true }, _count: { id: true }, where: { ...basePaid, createdAt: { gte: startOfWeek } } }),
    prisma.transaction.aggregate({ _sum: { amount: true }, _count: { id: true }, where: { ...basePaid, createdAt: { gte: startOfMonth } } }),
    Promise.resolve({ _sum: { amount: null }, _count: { id: 0 } }),
    prisma.refund.count({ where: { status: 'PAID' as any } }),
    prisma.invoice.aggregate({ _sum: { amountDue: true } }),
    prisma.invoice.aggregate({ _sum: { amountPaid: true } }),
  ]);

  const totalDue = Number(invoiceDueAgg._sum.amountDue ?? 0);
  const totalPaid = Number(invoicePaidAgg._sum.amountPaid ?? 0);
  const pendingFeeReceivables = Math.max(0, +(totalDue - totalPaid).toFixed(2));

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
      pendingFeeReceivables,
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

router.get('/dashboard/by-category', requirePermission('VIEW_DASHBOARD'), validateQuery(DashboardByCategorySchema), catchAsync(async (req: any, res) => {
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

router.get('/dashboard/trend', requirePermission('VIEW_DASHBOARD'), validateQuery(DashboardTrendSchema), catchAsync(async (req: any, res) => {
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
  categoryId: z.coerce.number().int().positive().optional(),
  college: z.string().max(120).trim().optional(),
  level: z.coerce.number().int().positive().max(1000).optional(),
  studentId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().default(1).optional(),
  pageSize: z.coerce.number().int().positive().max(500).default(100).optional(),
});

router.get('/reports/collections', requirePermission('VIEW_RECONCILIATION_REPORTS'), validateQuery(CollectionsReportSchema), catchAsync(async (req: any, res) => {
  const { dateFrom, dateTo, format, categoryId, college, level, studentId, page, pageSize } = req.query as any;
  const where: any = { status: 'SUCCESS', type: 'FEE_PAYMENT' };
  if (dateFrom) where.createdAt = { ...(where.createdAt || {}), gte: dateFrom };
  if (dateTo) where.createdAt = { ...(where.createdAt || {}), lte: dateTo };
  if (studentId) where.userId = Number(studentId);
  if (categoryId || college || level) {
    where.AND = [];
    if (categoryId) where.AND.push({ invoice: { fee: { categoryId: Number(categoryId) } } });
    if (college) where.AND.push({ invoice: { fee: { college } } });
    if (level) where.AND.push({ invoice: { fee: { level: Number(level) } } });
  }

  const findManyOpts: any = {
    where,
    orderBy: { createdAt: 'asc' },
    include: {
      user: { select: { firstName: true, lastName: true, matricNumber: true, email: true, college: true, department: true, program: true, level: true } },
      invoice: { include: { fee: { include: { category: { select: { id: true, name: true, code: true } } } } } },
      receipts: { select: { receiptNumber: true, verificationToken: true, paidAt: true } },
    },
  };

  const rows = format === 'csv'
    ? await prisma.transaction.findMany(findManyOpts)
    : await prisma.transaction.findMany({
      ...findManyOpts,
      skip: (Number(page) - 1) * Number(pageSize),
      take: Number(pageSize),
    });
  const totalRows = format === 'csv' ? rows.length : await prisma.transaction.count({ where });

  const flat = rows.map((t: any) => {
    const inv = t.invoice as any;
    const fee = inv?.fee;
    const cat = fee?.category;
    const student = t.user;
    const paidAt = t.receipts?.[0]?.paidAt || t.createdAt;
    return {
      receiptNumber: t.receipts?.[0]?.receiptNumber ?? '',
      paidAt: new Date(paidAt).toISOString(),
      studentName: student ? `${student.firstName} ${student.lastName}`.trim() : '',
      matricNumber: student?.matricNumber ?? '',
      college: student?.college ?? '',
      department: student?.department ?? '',
      program: student?.program ?? '',
      level: student?.level ?? null,
      feeName: fee?.name ?? '',
      feeCode: fee?.feeCode ?? '',
      categoryName: cat?.name ?? '',
      categoryCode: cat?.code ?? '',
      academicSession: inv?.session ?? '',
      semester: inv?.semester ?? '',
      paidAmount: Number(t.amount).toFixed(2),
      gateway: (t.gateway ?? '') as string,
      channel: t.paystackChannel ?? (t.gateway ? String(t.gateway).toLowerCase() : '') ?? '',
      transactionReference: t.reference ?? '',
      status: t.status ?? 'SUCCESS',
    };
  });

  const totals = flat.reduce((acc: any, r: any) => {
    acc.count += 1;
    acc.total += Number(r.paidAmount);
    const key = `${r.categoryCode || 'UNCAT'}`;
    acc.byCat[key] = acc.byCat[key] || { name: r.categoryName || key, total: 0, count: 0 };
    acc.byCat[key].total += Number(r.paidAmount);
    acc.byCat[key].count += 1;
    const fkey = r.college || 'No Faculty';
    acc.byFaculty[fkey] = acc.byFaculty[fkey] || { name: fkey, total: 0, count: 0 };
    acc.byFaculty[fkey].total += Number(r.paidAmount);
    acc.byFaculty[fkey].count += 1;
    return acc;
  }, {
    count: 0, total: 0,
    byCat: {} as Record<string, { name: string; total: number; count: number }>,
    byFaculty: {} as Record<string, { name: string; total: number; count: number }>,
  });

  if (format === 'csv') {
    const Papa = require('papaparse');
    const header = [
      'Receipt No.', 'Date', 'Student Name', 'Matric No.',
      'College', 'Department', 'Program', 'Level',
      'Fee Name', 'Fee Code', 'Category',
      'Academic Session', 'Semester',
      'Amount (NGN)', 'Gateway', 'Channel', 'Reference', 'Status',
    ];
    const dataRows: any = flat.map((r: any) => [
      r.receiptNumber, r.paidAt, r.studentName, r.matricNumber,
      r.college, r.department, r.program, r.level ?? '',
      r.feeName, r.feeCode, r.categoryName ? `${r.categoryName} (${r.categoryCode})` : r.categoryCode,
      r.academicSession, r.semester,
      r.paidAmount, r.gateway, r.channel, r.transactionReference, r.status,
    ]);
    let csvRows: any[][] = [header, ...(dataRows as any)];
    csvRows.push([]);
    csvRows.push(['', '', '', '', '', '', '', '', '', '', 'Subtotal by Category', '', '', '', '', '', '']);
    for (const key of Object.keys(totals.byCat)) {
      const c = totals.byCat[key];
      csvRows.push(['', '', '', '', '', '', '', '', '', '', c.name, key, '', '', Number(c.total).toFixed(2), '', `(${c.count} tx)`]);
    }
    csvRows.push([]);
    csvRows.push(['', '', '', '', 'Subtotal by College', '', '', '', '', '', '', '', '', '', '', '', '']);
    for (const key of Object.keys(totals.byFaculty)) {
      const f = totals.byFaculty[key];
      csvRows.push(['', '', '', '', f.name, '', '', '', '', '', '', '', '', '', Number(f.total).toFixed(2), '', `(${f.count} tx)`]);
    }
    csvRows.push([]);
    csvRows.push(['', '', '', '', '', '', '', '', '', '', '', '', 'GRAND TOTAL', '', Number(totals.total).toFixed(2), '', `(${totals.count} tx)`]);

    const csv = Papa.unparse(csvRows, { delimiter: ',' });
    const ts = (d: any) => (d ? new Date(d).toISOString().slice(0, 10).replace(/-/g, '') : 'all');
    const rawFilename = `collections_report_${ts(dateFrom)}_${ts(dateTo)}_${Date.now()}.csv`;
    const safeFn = String(rawFilename ?? 'collections_report.csv').replace(/[\/\\:*?"<>|\x00-\x1f%]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'collections_report.csv';
    const cdSafeQ = safeFn.replace(/"/g, '\\"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${cdSafeQ}"; filename*=UTF-8''${encodeURIComponent(safeFn)}`);
    res.send('\uFEFF' + csv);
    return;
  }

  res.status(200).json({
    status: 'success',
    data: {
      rows: flat,
      total: totalRows,
      count: totals.count,
      grandTotal: +totals.total.toFixed(2),
      byCategory: Object.entries(totals.byCat).map(([code, vUnk]) => {
        const v = vUnk as { name: string; total: number; count: number };
        return { code, name: v.name, total: +v.total.toFixed(2), count: v.count };
      }),
      byFaculty: Object.entries(totals.byFaculty).map(([code, vUnk]) => {
        const v = vUnk as { name: string; total: number; count: number };
        return { code, name: v.name, total: +v.total.toFixed(2), count: v.count };
      }),
      filters: {
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        format: format || 'json',
        categoryId: categoryId || null,
        college: college || null,
        level: level || null,
        studentId: studentId || null,
      },
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.max(1, Math.ceil(totalRows / Number(pageSize))),
    },
  });
}));

// ---------------------------------------------------------------------------
// Bursary (shared with ADMIN via router restrictTo): Payments list
// ---------------------------------------------------------------------------
const BursaryPaymentListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  sort: z.string().trim().max(255).optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  q: z.string().trim().max(200).optional(),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'REVERSED']).optional(),
  gateway: z.enum(['PAYSTACK', 'ALATPAY']).optional(),
  dateFrom: z.string().trim().max(32).optional(),
  dateTo: z.string().trim().max(32).optional(),
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
    if (q.status) {
      where.status = q.status;
    } else {
      // Default collections-only: SUCCESS transactions only.
      where.status = 'SUCCESS';
    }
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

    type BurTxnAllowedSort = 'createdAt' | 'amount' | 'status';
    type BurTxnAllowedOrder = 'asc' | 'desc';
    const BUR_TXN_ALLOWED_SORTS: ReadonlySet<BurTxnAllowedSort> = new Set(['createdAt', 'amount', 'status']);
    const BUR_TXN_ALLOWED_ORDERS: ReadonlySet<BurTxnAllowedOrder> = new Set(['asc', 'desc']);
    const BUR_TXN_SORT_TO_FIELD: Record<BurTxnAllowedSort, 'createdAt' | 'amount' | 'status'> = {
      createdAt: 'createdAt',
      amount: 'amount',
      status: 'status',
    };
    const rawSortBurTxn = q.sort as BurTxnAllowedSort | string | undefined;
    const rawOrderBurTxn = q.order as BurTxnAllowedOrder | string | undefined;
    const sortBurTxn: BurTxnAllowedSort = BUR_TXN_ALLOWED_SORTS.has(rawSortBurTxn as BurTxnAllowedSort)
      ? (rawSortBurTxn as BurTxnAllowedSort)
      : 'createdAt';
    const orderBurTxn: BurTxnAllowedOrder = BUR_TXN_ALLOWED_ORDERS.has(rawOrderBurTxn as BurTxnAllowedOrder)
      ? (rawOrderBurTxn as BurTxnAllowedOrder)
      : 'desc';
    const orderBy = { [BUR_TXN_SORT_TO_FIELD[sortBurTxn]]: orderBurTxn };

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
  sort: z.string().trim().max(255).optional().default('paidAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  q: z.string().trim().max(200).optional(),
  isVoided: z.enum(['true', 'false']).optional(),
  dateFrom: z.string().trim().max(32).optional(),
  dateTo: z.string().trim().max(32).optional(),
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

    type BurRcpAllowedSort = 'paidAt' | 'paidAmount' | 'receiptNumber';
    type BurRcpAllowedOrder = 'asc' | 'desc';
    const BUR_RCP_ALLOWED_SORTS: ReadonlySet<BurRcpAllowedSort> = new Set(['paidAt', 'paidAmount', 'receiptNumber']);
    const BUR_RCP_ALLOWED_ORDERS: ReadonlySet<BurRcpAllowedOrder> = new Set(['asc', 'desc']);
    const BUR_RCP_SORT_TO_FIELD: Record<BurRcpAllowedSort, 'paidAt' | 'paidAmount' | 'receiptNumber'> = {
      paidAt: 'paidAt',
      paidAmount: 'paidAmount',
      receiptNumber: 'receiptNumber',
    };
    const rawSortBurRcp = q.sort as BurRcpAllowedSort | string | undefined;
    const rawOrderBurRcp = q.order as BurRcpAllowedOrder | string | undefined;
    const sortBurRcp: BurRcpAllowedSort = BUR_RCP_ALLOWED_SORTS.has(rawSortBurRcp as BurRcpAllowedSort)
      ? (rawSortBurRcp as BurRcpAllowedSort)
      : 'paidAt';
    const orderBurRcp: BurRcpAllowedOrder = BUR_RCP_ALLOWED_ORDERS.has(rawOrderBurRcp as BurRcpAllowedOrder)
      ? (rawOrderBurRcp as BurRcpAllowedOrder)
      : 'desc';
    const orderBy = { [BUR_RCP_SORT_TO_FIELD[sortBurRcp]]: orderBurRcp };

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

router.get(
  '/receipts/export.csv',
  requirePermission('VIEW_RECEIPTS'),
  validateQuery(BursaryReceiptListQuery),
  catchAsync(async (req: any, res) => {
    const q = req.query as z.infer<typeof BursaryReceiptListQuery>;
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
    const rows = await prisma.receipt.findMany({
      where,
      take: 50000,
      orderBy: { paidAt: 'desc' },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, email: true, matricNumber: true } },
        invoice: { select: { id: true, invoiceNumber: true, fee: { select: { id: true, name: true, feeCode: true } } } },
        transaction: { select: { reference: true, paystackChannel: true, gateway: true, type: true, amount: true, status: true, createdAt: true } },
      },
    });
    const header = ['receiptNumber', 'verificationToken', 'paidAt', 'paidAmount', 'studentName', 'studentEmail', 'matricNumber', 'invoiceNumber', 'feeName', 'feeCode', 'gateway', 'channel', 'txReference', 'status', 'voided'];
    let csv = '\uFEFF' + csvLineSafe(header);
    for (const r of rows) {
      const stu = r.student as any;
      const stuName = [stu?.firstName, stu?.lastName].filter(Boolean).join(' ');
      const inv = r.invoice as any;
      const tx = r.transaction as any;
      csv += csvLineSafe([
        r.receiptNumber,
        r.verificationToken,
        r.paidAt?.toISOString() ?? '',
        String(r.paidAmount ?? ''),
        stuName,
        stu?.email ?? '',
        stu?.matricNumber ?? '',
        inv?.invoiceNumber ?? '',
        inv?.fee?.name ?? '',
        inv?.fee?.feeCode ?? '',
        tx?.gateway ?? '',
        tx?.paystackChannel ?? '',
        tx?.reference ?? '',
        tx?.status ?? '',
        r.isVoided ? 'YES' : 'NO',
      ]);
    }
    const ts = (d: any) => (d ? new Date(String(d)).toISOString().slice(0, 10).replace(/-/g, '') : 'all');
    const rawCsvFn = `receipts_${ts(q.dateFrom)}_${ts(q.dateTo)}_${Date.now()}.csv`;
    const safeCsvFn = String(rawCsvFn ?? 'receipts_export.csv').replace(/[\/\\:*?"<>|\x00-\x1f%]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'receipts_export.csv';
    const csvQuoted = safeCsvFn.replace(/"/g, '\\"');
    const rawJsonFn = `receipts_${ts(q.dateFrom)}_${ts(q.dateTo)}.json`;
    const safeJsonFn = String(rawJsonFn ?? 'receipts_export.json').replace(/[\/\\:*?"<>|\x00-\x1f%]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'receipts_export.json';
    const jsonQuoted = safeJsonFn.replace(/"/g, '\\"');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvQuoted}"; filename*=UTF-8''${encodeURIComponent(safeCsvFn)}`);
    if (((q as any).format ?? 'csv') === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${jsonQuoted}"; filename*=UTF-8''${encodeURIComponent(safeJsonFn)}`);
      return res.status(200).json({ status: 'success', data: { rows } });
    }
    const csvWithIntegrity = appendCsvIntegrityTrailer(csv);
    res.status(200).send(csvWithIntegrity);
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
const BursaryReceiptVerifyParam = z.object({ tokenOrNumber: z.string().min(1).max(100).trim() });
router.get(
  '/receipts/verify/:tokenOrNumber',
  requirePermission('VERIFY_RECEIPT'),
  validateParams(BursaryReceiptVerifyParam),
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
        transaction: { select: { reference: true, paystackReference: true, alatpayReference: true, paystackChannel: true, gateway: true, type: true, amount: true, status: true, createdAt: true } },
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
        alatpayReference: (row.transaction?.alatpayReference) || null,
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
