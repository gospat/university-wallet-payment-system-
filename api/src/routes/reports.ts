import express from 'express';
import { z } from 'zod';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import {
  dashboardSummaryCards, dailyCollections, monthlyCollections, monthlyPayersRegister,
  revenueByBill, paymentRegister, studentStatement, billCollectionPerformance,
  outstandingDebtors, hierarchicalRevenue, paymentGatewayReport, settlementReport,
  reconciliationExceptions, refundReport, chargesAndFeeIncome, generalLedger,
  receiptRegister, transactionStatusMix, comparativeReports,
} from '../services/reports/aggregates';
import {
  dispatchReportExport,
} from '../services/reportExport';
type ReportType = string;
type ReportExportFormat = 'XLSX' | 'PDF';
type Role = string;
import prisma from '../config/database';

const prismaAny = prisma as any;

const router = express.Router();
router.use(protect);
router.use(restrictTo('BURSARY', 'ADMIN'));

// ============================================================================
//  SHARED ZOD FILTER SCHEMA — all 14 filter dimensions coerced from query strings
// ============================================================================
const BaseFilterSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  provider: z.enum(['PAYSTACK', 'ALATPAY', 'TRANSFER', 'WALLET', 'MANUAL']).optional().or(z.string().max(30).optional()),
  session: z.string().max(30).optional(),
  semester: z.string().max(20).optional(),
  level: z.string().max(30).optional(),
  collegeId: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  programmeId: z.coerce.number().int().positive().optional(),
  feeCategoryId: z.coerce.number().int().positive().optional(),
  feeId: z.coerce.number().int().positive().optional(),
  studentId: z.coerce.number().int().positive().optional(),
  paymentStatus: z.enum(['PENDING','PROCESSING','SUCCESS','FAILED','UNDERPAID','OVERPAID','REVERSED']).optional(),
  reconciliationStatus: z.enum(['PENDING_SETTLEMENT','SETTLED','MATCHED','PARTIALLY_MATCHED','VARIANCE','UNMATCHED','UNDER_REVIEW']).optional(),
});

const PagedSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(50),
});

// ============================================================================
//  H15 SORT-INJECTION PROTECTION — per-endpoint literal ReadonlySet +
//  resolveSort*() function. NEVER use Record<string,string> bracket map with
//  an unvalidated user key. Every sort key is a literal union (checked via
//  ReadonlySet.has() literal allowlist).
//  Aggregators own their own internal SORT→DB field map; routes only validate
//  that the sort key is in the endpoint allowlist.
// ============================================================================
type ORDER = 'asc' | 'desc';
const ORDER_ALLOWED: ReadonlySet<ORDER> = new Set(['asc', 'desc']);

// ---- H15 per-endpoint sort allowlists --------------------------------------
// 1. R5 Payment Register sort keys (matches aggregates TXN_ALLOWED_SORTS)
type R5_SORT = 'createdAt'|'amount'|'status'|'reference'|'studentName'|'receiptNumber'|'paidAt'|'gateway'|'session'|'college';
const R5_ALLOWED_SORTS: ReadonlySet<R5_SORT> = new Set(['createdAt','amount','status','reference','studentName','receiptNumber','paidAt','gateway','session','college']);

// 2. R11 Settlement Report sort keys
type R11_SORT = 'paymentDate'|'settlementDate'|'provider'|'status'|'paymentAmount'|'expectedSettlement'|'actualSettlement'|'variance';
const R11_ALLOWED_SORTS: ReadonlySet<R11_SORT> = new Set(['paymentDate','settlementDate','provider','status','paymentAmount','expectedSettlement','actualSettlement','variance']);

// 3. R15 General Ledger sort keys
type R15_SORT = 'transactionDate'|'entryType'|'account'|'amount'|'transactionId';
const R15_ALLOWED_SORTS: ReadonlySet<R15_SORT> = new Set(['transactionDate','entryType','account','amount','transactionId']);

// 4. R16 Receipt Register sort keys
type R16_SORT = 'paidAt'|'paidAmount'|'receiptNumber'|'studentName'|'provider';
const R16_ALLOWED_SORTS: ReadonlySet<R16_SORT> = new Set(['paidAt','paidAmount','receiptNumber','studentName','provider']);

// Shared generic sort schema (q search + sort string + order)
const TxSortSchema = z.object({
  sort: z.string().max(40).optional(),
  order: z.enum(['asc','desc']).default('desc').optional(),
  q: z.string().max(255).trim().optional(),
});

// H15 Literal sort resolver — returns { sortKey, order } both strictly validated.
// Never returns a DB field path here; aggregators keep their own internal map.
function resolveSortR5(sort: string | undefined, order: string | undefined): { sortKey: R5_SORT; order: ORDER } {
  const sk = R5_ALLOWED_SORTS.has(sort as R5_SORT) ? (sort as R5_SORT) : 'paidAt';
  const od = ORDER_ALLOWED.has(order as ORDER) ? (order as ORDER) : 'desc';
  return { sortKey: sk, order: od };
}
function resolveSortR11(sort: string | undefined, order: string | undefined): { sortKey: R11_SORT; order: ORDER } {
  const sk = R11_ALLOWED_SORTS.has(sort as R11_SORT) ? (sort as R11_SORT) : 'paymentDate';
  const od = ORDER_ALLOWED.has(order as ORDER) ? (order as ORDER) : 'desc';
  return { sortKey: sk, order: od };
}
function resolveSortR15(sort: string | undefined, order: string | undefined): { sortKey: R15_SORT; order: ORDER } {
  const sk = R15_ALLOWED_SORTS.has(sort as R15_SORT) ? (sort as R15_SORT) : 'transactionDate';
  const od = ORDER_ALLOWED.has(order as ORDER) ? (order as ORDER) : 'desc';
  return { sortKey: sk, order: od };
}
function resolveSortR16(sort: string | undefined, order: string | undefined): { sortKey: R16_SORT; order: ORDER } {
  const sk = R16_ALLOWED_SORTS.has(sort as R16_SORT) ? (sort as R16_SORT) : 'paidAt';
  const od = ORDER_ALLOWED.has(order as ORDER) ? (order as ORDER) : 'desc';
  return { sortKey: sk, order: od };
}

// R5 payment register schema
const RegisterFilters = BaseFilterSchema.merge(PagedSchema).merge(TxSortSchema);

// ---- Filter parameter-name normalizer ---------------------------------------
// Routes zod schema exposes feeCategoryId / feeId / level per the 14-dim spec
// naming. Aggregates historically used billCategoryId / billId / levelValue —
// both accepted now. Explicit mapping here means callers always receive both.
type FilterInput = Record<string, any>;
function normalizeFilters(raw: FilterInput): FilterInput {
  const out: FilterInput = { ...raw };
  if (raw.feeCategoryId !== undefined && out.billCategoryId === undefined) out.billCategoryId = raw.feeCategoryId;
  if (raw.feeId !== undefined         && out.billId === undefined)         out.billId = raw.feeId;
  if (raw.level !== undefined         && out.levelValue === undefined)     out.levelValue = raw.level;
  return out;
}

// Export format validator (R19 — Excel + PDF only; CSV/JSON also accepted → mapped to XLSX)
const ExportBodySchema = BaseFilterSchema.merge(z.object({
  range: z.enum(['D','M','S']).optional(),
  tab: z.enum(['ALL','PARTIAL','NEVER']).optional(),
  kind: z.string().max(80).optional(),
  entryType: z.string().max(80).optional(),
  level: z.string().max(30).optional(),
  detail: z.string().max(30).optional(),
  matricNumber: z.string().max(80).trim().optional(),
  minOutstanding: z.coerce.number().min(0).optional(),
  maxOutstanding: z.coerce.number().min(0).optional(),
  isActive: z.union([z.boolean(), z.enum(['true','false','1','0'])]).optional(),
}));
const ExportQuerySchema = z.object({
  format: z.enum(['xlsx','pdf','XLSX','PDF','csv','json']).default('xlsx'),
});

function coerceFormat(f: string): ReportExportFormat {
  const up = f.toUpperCase();
  if (up === 'PDF') return 'PDF';
  return 'XLSX'; // xlsx, csv, json all use exceljs stream (csv/json = .xlsx for simple)
}

// Helper: resolve generator name/email for export audit
async function generatorFor(req: any): Promise<{ id: number; name: string; email: string }> {
  const uid = Number(req.user?.id);
  const fallback = { id: uid, name: 'Bursary User', email: 'bursary@bellsuniversity.edu.ng' };
  if (!uid) return fallback;
  try {
    const u = await prismaAny.user.findUnique({
      where: { id: uid },
      select: { id: true, firstName: true, middleName: true, lastName: true, email: true },
    });
    if (!u) return fallback;
    const full = [u.firstName, u.middleName, u.lastName].filter(Boolean).join(' ').trim();
    return { id: u.id, name: full || fallback.name, email: u.email || fallback.email };
  } catch {
    return fallback;
  }
}

// Helper: send export response (sync buffer OR queued JSON)
function sendExport(res: any, result: Awaited<ReturnType<typeof dispatchReportExport>>) {
  if (result.mode === 'queued') {
    return res.status(202).json({ status: 'queued', data: { jobId: result.jobId, message: result.message } });
  }
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', result.contentDisposition);
  res.setHeader('X-Report-UUID', result.reportUuid);
  res.setHeader('X-Row-Count', String(result.rowCount));
  return res.status(200).end(result.buffer);
}

// ============================================================================
//  REPORT ROUTE REGISTRATION (21 ReportTypes × (GET view + POST export) = 42 endpoints)
//  Each requirePermission() enforces RBAC. ADMIN bypasses requirePermission guard
//  via auth.ts L136 shortcut. Bursary excluded from REPORTS_SCHEDULE (per STAGE 3).
// ============================================================================

// ---------- R1 DASHBOARD_SUMMARY (Cards + Drilldown) ----------
const R1_VIEW_PERM = 'REPORTS_VIEW_COLLECTIONS';
router.get('/dashboard-summary',
  requirePermission(R1_VIEW_PERM),
  validateQuery(BaseFilterSchema),
  catchAsync(async (req: any, res) => {
    const cards = await dashboardSummaryCards(normalizeFilters(req.query));
    res.status(200).json({ status: 'success', data: { cards } });
  }),
);
router.post('/dashboard-summary/export',
  requirePermission(R1_VIEW_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'DASHBOARD_SUMMARY', reportName: 'R1_Dashboard_Summary', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R2 DAILY_COLLECTIONS ----------
router.get('/daily-collections',
  requirePermission(R1_VIEW_PERM),
  validateQuery(BaseFilterSchema.merge(PagedSchema.partial())),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const rows = await dailyCollections(f);
    const summary = await dashboardSummaryCards(f);
    res.status(200).json({ status: 'success', data: { rows, total: rows.length, page: f.page ?? 1, pageSize: f.pageSize ?? rows.length, summary } });
  }),
);
router.post('/daily-collections/export',
  requirePermission(R1_VIEW_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'DAILY_COLLECTIONS', reportName: 'R2_Daily_Collections', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R3 MONTHLY_COLLECTIONS + payers register drilldown ----------
const R3Filter = BaseFilterSchema.merge(z.object({ detail: z.enum(['summary','payers']).default('summary').optional(), month: z.coerce.number().int().min(1).max(12).optional() }));
router.get('/monthly-collections',
  requirePermission(R1_VIEW_PERM),
  validateQuery(R3Filter.merge(PagedSchema.partial())),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const raw = f.detail === 'payers' ? await monthlyPayersRegister(f) : await monthlyCollections(f);
    const isPaged = !Array.isArray(raw);
    const rowsArr = isPaged ? (raw as any).rows : raw as any[];
    const totalVal = isPaged ? (raw as any).total : rowsArr.length;
    const pageSizeVal = isPaged ? (raw as any).pageSize : (f.pageSize ?? rowsArr.length);
    const summary = await dashboardSummaryCards(f);
    res.status(200).json({ status: 'success', data: { rows: rowsArr, total: totalVal, page: f.page ?? 1, pageSize: pageSizeVal, summary, detail: f.detail ?? 'summary' } });
  }),
);
router.post('/monthly-collections/export',
  requirePermission(R1_VIEW_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'MONTHLY_COLLECTIONS', reportName: 'R3_Monthly_Collections', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R4 REVENUE_BY_BILL ----------
const R4_PERM = 'REPORTS_VIEW_REVENUE';
router.get('/revenue-by-bill',
  requirePermission(R4_PERM),
  validateQuery(BaseFilterSchema.merge(PagedSchema.partial())),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const rows = await revenueByBill(f);
    const summary = await dashboardSummaryCards(f);
    res.status(200).json({ status: 'success', data: { rows, total: rows.length, page: f.page ?? 1, pageSize: f.pageSize ?? rows.length, summary } });
  }),
);
router.post('/revenue-by-bill/export',
  requirePermission(R4_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'REVENUE_BY_BILL', reportName: 'R4_Revenue_by_Bill', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R5 PAYMENT_REGISTER (H15: resolveSortR5 per paged call) ----------
const R5_PERM = 'REPORTS_VIEW_COLLECTIONS';
router.get('/payment-register',
  requirePermission(R5_PERM),
  validateQuery(RegisterFilters),
  catchAsync(async (req: any, res) => {
    const base = normalizeFilters(req.query);
    const page = Number(base.page);
    const pageSize = Number(base.pageSize);
    const { sortKey, order } = resolveSortR5(req.query.sort, req.query.order);
    const data = await paymentRegister({ ...base, page, pageSize, sort: sortKey, order });
    res.status(200).json({ status: 'success', data });
  }),
);
router.post('/payment-register/export',
  requirePermission(R5_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'PAYMENT_REGISTER', reportName: 'R5_Payment_Register', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R6 STUDENT_STATEMENT ----------
const R6_PERM = 'REPORTS_VIEW_STUDENT_STATEMENT';
const R6Query = BaseFilterSchema.merge(z.object({
  matricNumber: z.string().max(80).trim().optional(),
  studentId: z.coerce.number().int().positive().optional(),
})).refine((f) => f.matricNumber || f.studentId, { message: "Either matricNumber or studentId required" });
router.get('/student-statement',
  requirePermission(R6_PERM),
  validateQuery(R6Query),
  catchAsync(async (req: any, res) => {
    const data = await studentStatement(normalizeFilters(req.query));
    if (!data.student) return res.status(404).json({ status: 'fail', message: 'Student not found for criteria' });
    res.status(200).json({ status: 'success', data });
  }),
);
router.post('/student-statement/export',
  requirePermission(R6_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema.merge(z.object({
    matricNumber: z.string().max(80).trim().optional(),
    studentId: z.coerce.number().int().positive().optional(),
  }))),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'STUDENT_STATEMENT', reportName: 'R6_Student_Statement', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R7 BILL_COLLECTION_PERFORMANCE (11 spec columns) ----------
const R7_PERM = 'REPORTS_VIEW_REVENUE';
router.get('/bill-collection-performance',
  requirePermission(R7_PERM),
  validateQuery(BaseFilterSchema.merge(PagedSchema.partial())),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const rows = await billCollectionPerformance(f);
    const summary = await dashboardSummaryCards(f);
    res.status(200).json({ status: 'success', data: { rows, total: rows.length, page: f.page ?? 1, pageSize: f.pageSize ?? rows.length, summary } });
  }),
);
router.post('/bill-collection-performance/export',
  requirePermission(R7_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'BILL_COLLECTION_PERFORMANCE', reportName: 'R7_Bill_Collection_Performance', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R8 OUTSTANDING_DEBTORS ----------
const R8_PERM = 'REPORTS_VIEW_OUTSTANDING';
const R8Query = BaseFilterSchema.merge(PagedSchema).merge(z.object({
  tab: z.enum(['ALL','PARTIAL','NEVER']).default('ALL').optional(),
  minOutstanding: z.coerce.number().min(0).optional(),
  maxOutstanding: z.coerce.number().min(0).optional(),
}));
router.get('/outstanding-debtors',
  requirePermission(R8_PERM),
  validateQuery(R8Query),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const data = await outstandingDebtors(f);
    res.status(200).json({ status: 'success', data: { ...data, page: f.page, pageSize: f.pageSize, tab: f.tab ?? 'ALL' } });
  }),
);
router.post('/outstanding-debtors/export',
  requirePermission(R8_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'OUTSTANDING_DEBTORS', reportName: 'R8_Outstanding_Debtors', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R9 HIERARCHICAL_REVENUE ----------
const R9_PERM = 'REPORTS_VIEW_REVENUE';
const R9Query = BaseFilterSchema.merge(z.object({ level: z.enum(['college','department','programme']).default('college').optional() }));
router.get('/hierarchical-revenue',
  requirePermission(R9_PERM),
  validateQuery(R9Query),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const rows = await hierarchicalRevenue(f);
    const summary = await dashboardSummaryCards(f);
    res.status(200).json({ status: 'success', data: { rows, total: rows.length, summary, level: f.level ?? 'college' } });
  }),
);
router.post('/hierarchical-revenue/export',
  requirePermission(R9_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'HIERARCHICAL_REVENUE', reportName: 'R9_Hierarchical_Revenue', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R10 PAYMENT_GATEWAY ----------
const R10_PERM = 'REPORTS_VIEW_RECONCILIATION';
router.get('/payment-gateway',
  requirePermission(R10_PERM),
  validateQuery(BaseFilterSchema.merge(PagedSchema.partial())),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const rows = await paymentGatewayReport(f);
    const summary = await dashboardSummaryCards(f);
    res.status(200).json({ status: 'success', data: { rows, total: rows.length, summary } });
  }),
);
router.post('/payment-gateway/export',
  requirePermission(R10_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'PAYMENT_GATEWAY', reportName: 'R10_Payment_Gateway', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R11 SETTLEMENT (H15: resolveSortR11 per paged call) ----------
const R11_PERM = 'REPORTS_VIEW_RECONCILIATION';
router.get('/settlement',
  requirePermission(R11_PERM),
  validateQuery(BaseFilterSchema.merge(PagedSchema).merge(TxSortSchema.partial())),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const { sortKey, order } = resolveSortR11(req.query.sort, req.query.order);
    const paged = await settlementReport({ ...f, sort: sortKey, order });
    const pagedAny = paged as any;
    const summary = await dashboardSummaryCards(f);
    res.status(200).json({ status: 'success', data: { rows: pagedAny.rows, total: pagedAny.total, page: f.page ?? 1, pageSize: pagedAny.pageSize ?? 50, summary } });
  }),
);
router.post('/settlement/export',
  requirePermission(R11_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'SETTLEMENT', reportName: 'R11_Settlement', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R12 RECONCILIATION_EXCEPTIONS (11 exception kinds per spec R12) ----------
const R12_PERM = 'REPORTS_VIEW_RECONCILIATION';
const R12Query = BaseFilterSchema.merge(PagedSchema.partial()).merge(z.object({ kind: z.string().max(80).optional() }));
router.get('/reconciliation-exceptions',
  requirePermission(R12_PERM),
  validateQuery(R12Query),
  catchAsync(async (req: any, res) => {
    const data = await reconciliationExceptions(normalizeFilters(req.query));
    const dataAny = data as any;
    const totalCount = dataAny.categories.reduce((s: number, g: any) => s + g.count, 0);
    res.status(200).json({ status: 'success', data: { ...dataAny, totalCount, attentionBadge: totalCount } });
  }),
);
router.post('/reconciliation-exceptions/export',
  requirePermission(R12_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'RECONCILIATION_EXCEPTIONS', reportName: 'R12_Reconciliation_Exceptions', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R13 REFUND ----------
const R13_PERM = 'REPORTS_VIEW_ACCOUNTING';
router.get('/refunds',
  requirePermission(R13_PERM),
  validateQuery(BaseFilterSchema.merge(PagedSchema.partial())),
  catchAsync(async (req: any, res) => {
    const data = await refundReport(normalizeFilters(req.query));
    res.status(200).json({ status: 'success', data: { rows: data.rows, total: data.rows.length, summary: data.summary } });
  }),
);
router.post('/refunds/export',
  requirePermission(R13_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'REFUND', reportName: 'R13_Refund_Report', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R14 CHARGES_FEE_INCOME (netRevenue = base+conv+svc−gw per spec R14) ----------
const R14_PERM = 'REPORTS_VIEW_ACCOUNTING';
router.get('/charges-fee-income',
  requirePermission(R14_PERM),
  validateQuery(BaseFilterSchema.merge(PagedSchema.partial())),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const rows = await chargesAndFeeIncome(f);
    const summary = await dashboardSummaryCards(f);
    res.status(200).json({ status: 'success', data: { rows, total: rows.length, summary } });
  }),
);
router.post('/charges-fee-income/export',
  requirePermission(R14_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'CHARGES_FEE_INCOME', reportName: 'R14_Charges_Fee_Income', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R15 GENERAL_LEDGER (H15: resolveSortR15 per paged call; 6 entry types zero-padded) ----------
const R15_PERM = 'REPORTS_VIEW_ACCOUNTING';
const R15Query = BaseFilterSchema.merge(PagedSchema).merge(z.object({
  entryType: z.enum(['PAYMENT_SUCCESS','REFUND_ISSUED','CONVENIENCE_FEE_INCOME','SERVICE_CHARGE_INCOME','GATEWAY_FEE_EXPENSE','WALLET_CREDIT']).optional(),
  sort: z.string().max(40).default('transactionDate').optional(),
  order: z.enum(['asc','desc']).default('desc').optional(),
}));
router.get('/general-ledger',
  requirePermission(R15_PERM),
  validateQuery(R15Query),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const { sortKey, order } = resolveSortR15(req.query.sort, req.query.order);
    const data = await generalLedger({ ...f, sort: sortKey, order });
    res.status(200).json({ status: 'success', data: { rows: data.rows, total: data.rows.length, page: f.page, pageSize: f.pageSize, totalsByEntry: data.totalsByEntry } });
  }),
);
router.post('/general-ledger/export',
  requirePermission(R15_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'GENERAL_LEDGER', reportName: 'R15_General_Ledger', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R16 RECEIPT_REGISTER (H15: resolveSortR16 per paged call) ----------
const R16_PERM = 'REPORTS_VIEW_ACCOUNTING';
router.get('/receipt-register',
  requirePermission(R16_PERM),
  validateQuery(BaseFilterSchema.merge(PagedSchema).merge(TxSortSchema.partial())),
  catchAsync(async (req: any, res) => {
    const f = normalizeFilters(req.query);
    const { sortKey, order } = resolveSortR16(req.query.sort, req.query.order);
    const paged = await receiptRegister({ ...f, sort: sortKey, order });
    const pagedAny = paged as any;
    res.status(200).json({ status: 'success', data: { rows: pagedAny.rows, total: pagedAny.total, page: f.page ?? 1, pageSize: pagedAny.pageSize ?? 50 } });
  }),
);
router.post('/receipt-register/export',
  requirePermission(R16_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'RECEIPT_REGISTER', reportName: 'R16_Receipt_Register', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R17 TRANSACTION_STATUS ----------
const R17_PERM = 'REPORTS_VIEW_OUTSTANDING';
router.get('/transaction-status',
  requirePermission(R17_PERM),
  validateQuery(BaseFilterSchema),
  catchAsync(async (req: any, res) => {
    const data = await transactionStatusMix(normalizeFilters(req.query));
    res.status(200).json({ status: 'success', data });
  }),
);
router.post('/transaction-status/export',
  requirePermission(R17_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'TRANSACTION_STATUS', reportName: 'R17_Transaction_Status_Mix', format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R18 COMPARATIVE (Fair-period D/M/S buckets per spec R18) ----------
const R18_PERM = 'REPORTS_VIEW_COLLECTIONS';
const R18Query = BaseFilterSchema.merge(z.object({ range: z.enum(['D','M','S']).default('D') }));
router.get('/comparative',
  requirePermission(R18_PERM),
  validateQuery(R18Query),
  catchAsync(async (req: any, res) => {
    const range = req.query.range as 'D' | 'M' | 'S';
    const f = normalizeFilters(req.query);
    const data = await comparativeReports(range, f);
    res.status(200).json({ status: 'success', data: { range, ...data } });
  }),
);
router.post('/comparative/export',
  requirePermission(R18_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema.merge(z.object({ range: z.enum(['D','M','S']).default('D') }))),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'COMPARATIVE', reportName: `R18_Comparative_${req.body.range ?? 'D'}`, format,
      filters: normalizeFilters(req.body), generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R19 EXPORT_CENTRE (catalog of recent exports) ----------
const R19_PERM = 'REPORTS_VIEW_ACCOUNTING';
router.get('/export-centre',
  requirePermission(R19_PERM),
  validateQuery(PagedSchema),
  catchAsync(async (req: any, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 50);
    const skip = (page - 1) * pageSize;
    const [rows, total] = await Promise.all([
      prismaAny.reportExport.findMany({
        skip, take: pageSize, orderBy: { createdAt: 'desc' },
        select: {
          id: true, reportUuid: true, reportType: true, reportName: true, format: true,
          status: true, generatedById: true, dateRangeStart: true, dateRangeEnd: true,
          rowCount: true, fileSizeBytes: true, downloadUrl: true, jobId: true,
          scheduledReportId: true, createdAt: true, expiresAt: true, errorMessage: true,
        },
      }),
      prismaAny.reportExport.count(),
    ]);
    res.status(200).json({ status: 'success', data: { rows, total, page, pageSize } });
  }),
);
router.post('/export-centre/export',
  requirePermission(R19_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'EXPORT_CENTRE', reportName: 'R19_Export_Centre_Catalog', format,
      filters: req.body, generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R20 SCHEDULED (ADMIN only — REPORTS_SCHEDULE; Bursary excluded) ----------
const R20_PERM = 'REPORTS_SCHEDULE';

const CRON_5_FIELD_REGEX = /^(\*|([0-5]?\d)(,[0-5]?\d)*|([0-5]?\d)-([0-5]?\d)|\*\/\d+)\s+(\*|([01]?\d|2[0-3])(,[01]?\d|,2[0-3])*|([01]?\d|2[0-3])-([01]?\d|2[0-3])|\*\/\d+)\s+(\*|([1-9]|[12]\d|3[01])(,[1-9]|,[12]\d|,3[01])*|([1-9]|[12]\d|3[01])-([1-9]|[12]\d|3[01])|\*\/\d+)\s+(\*|(1[0-2]|[1-9])(,1[0-2]|,[1-9])*|(1[0-2]|[1-9])-(1[0-2]|[1-9])|\*\/\d+)\s+(\*|[0-6](,[0-6])*|[0-6]-[0-6]|\*\/\d+)$/;

const R20BodyBase = z.object({
  name: z.string().min(3).max(160),
  reportType: z.string().max(80),
  description: z.string().max(1000).optional(),
  frequency: z.enum(['DAILY','WEEKLY','BIWEEKLY','MONTHLY','QUARTERLY','CUSTOM_CRON']),
  cronExpression: z.string().max(120).optional(),
  filters: z.record(z.any()).default({}),
  format: z.enum(['XLSX','PDF']).default('XLSX'),
  recipients: z.array(z.string().email()).min(1).max(50, { message: 'Maximum 50 recipients allowed' }),
  subjectLine: z.string().max(300).optional(),
  isActive: z.boolean().default(true),
});

const validateCronCustom = (val: any, ctx: z.RefinementCtx) => {
  if (val.frequency === 'CUSTOM_CRON') {
    if (!val.cronExpression || typeof val.cronExpression !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cronExpression'],
        message: 'cronExpression is required when frequency=CUSTOM_CRON',
      });
    } else {
      const trimmed = val.cronExpression.trim();
      const fields = trimmed.split(/\s+/).filter(Boolean);
      if (fields.length !== 5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cronExpression'],
          message: 'CUSTOM_CRON requires exactly 5 fields: minute hour day-of-month month day-of-week',
        });
      } else if (!CRON_5_FIELD_REGEX.test(trimmed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cronExpression'],
          message: 'CUSTOM_CRON expression failed validation. Use 5-field standard cron syntax.',
        });
      }
    }
  }
};

const R20Body = R20BodyBase.superRefine(validateCronCustom);
const R20BodyPatch = R20BodyBase.partial().superRefine((val, ctx) => {
  if (val.frequency !== undefined || val.cronExpression !== undefined) {
    validateCronCustom({
      frequency: val.frequency,
      cronExpression: val.cronExpression,
    }, ctx);
  }
  if (val.recipients !== undefined) {
    if (Array.isArray(val.recipients) && val.recipients.length > 50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipients'],
        message: 'Maximum 50 recipients allowed',
      });
    }
  }
});
router.get('/scheduled',
  requirePermission(R20_PERM),
  validateQuery(PagedSchema.merge(z.object({ isActive: z.union([z.boolean(), z.string()]).optional() }))),
  catchAsync(async (req: any, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 50);
    const skip = (page - 1) * pageSize;
    const where: any = {};
    if (req.query.isActive !== undefined && req.query.isActive !== null) {
      where.isActive = typeof req.query.isActive === 'boolean' ? req.query.isActive : ['true','1','TRUE'].includes(String(req.query.isActive));
    }
    const [rows, total] = await Promise.all([
      prismaAny.scheduledReport.findMany({ skip, take: pageSize, orderBy: { createdAt: 'desc' }, where }),
      prismaAny.scheduledReport.count({ where }),
    ]);
    res.status(200).json({ status: 'success', data: { rows, total, page, pageSize } });
  }),
);
router.post('/scheduled',
  requirePermission(R20_PERM),
  validateBody(R20Body),
  catchAsync(async (req: any, res) => {
    const body = { ...req.body };
    if (body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters)) {
      body.filters = normalizeFilters(body.filters);
    }
    const created = await prismaAny.scheduledReport.create({
      data: { ...body, createdById: Number(req.user?.id) },
    });
    // Best-effort: schedule BullMQ recurring job
    try {
      const { scheduleRecurring } = await import('../config/queue');
      if (typeof scheduleRecurring === 'function') {
        await scheduleRecurring(`scheduled-report:${created.id}`, created.frequency, created.cronExpression || undefined, {
          scheduledReportId: created.id,
        });
      }
    } catch { /* queue not configured — record stored, worker will pick up on next boot */ }
    res.status(201).json({ status: 'success', data: created });
  }),
);
const SchedById = z.object({ id: z.coerce.number().int().positive() });
router.patch('/scheduled/:id',
  requirePermission(R20_PERM),
  validateParams(SchedById),
  validateBody(R20BodyPatch),
  catchAsync(async (req: any, res) => {
    const id = Number(req.params.id);
    const patchData: any = { ...req.body };
    if (patchData.filters && typeof patchData.filters === 'object' && !Array.isArray(patchData.filters)) {
      patchData.filters = normalizeFilters(patchData.filters);
    }
    const existing = await prismaAny.scheduledReport.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('Scheduled report not found', 404);
    }
    const nextIsActive = patchData.isActive !== undefined ? Boolean(patchData.isActive) : existing.isActive;
    const userId = Number(req.user?.id);
    if (nextIsActive === false && existing.isActive === true) {
      patchData.pausedAt = new Date();
      if (userId) patchData.pausedById = userId;
    } else if (nextIsActive === true && existing.isActive === false) {
      patchData.pausedAt = null;
      patchData.pausedById = null;
    }
    const updated = await prismaAny.scheduledReport.update({ where: { id }, data: patchData });
    try {
      const { scheduleRecurring } = await import('../config/queue');
      if (typeof scheduleRecurring === 'function') {
        if (updated.isActive) {
          await scheduleRecurring(
            `scheduled-report:${updated.id}`,
            updated.frequency,
            updated.cronExpression || undefined,
            { scheduledReportId: updated.id },
          );
        }
      }
    } catch { /* best-effort re-sync */ }
    res.status(200).json({ status: 'success', data: updated });
  }),
);
router.delete('/scheduled/:id',
  requirePermission(R20_PERM),
  validateParams(SchedById),
  catchAsync(async (req: any, res) => {
    const id = Number(req.params.id);
    await prismaAny.scheduledReport.update({ where: { id }, data: { isActive: false, pausedAt: new Date() } });
    res.status(204).end();
  }),
);
router.post('/scheduled/export',
  requirePermission(R20_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'SCHEDULED', reportName: 'R20_Scheduled_Reports_Catalog', format,
      filters: req.body, generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- R21 AUDIT_TRAIL (all export audit rows) ----------
const R21_PERM = 'REPORTS_VIEW_ACCOUNTING';
router.get('/audit-trail',
  requirePermission(R21_PERM),
  validateQuery(BaseFilterSchema.merge(PagedSchema)),
  catchAsync(async (req: any, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 50);
    const skip = (page - 1) * pageSize;
    const where: any = {};
    if (req.query.dateFrom || req.query.dateTo) {
      where.createdAt = {};
      if (req.query.dateFrom) where.createdAt.gte = req.query.dateFrom;
      if (req.query.dateTo) where.createdAt.lte = req.query.dateTo;
    }
    const [rows, total] = await Promise.all([
      prismaAny.reportExport.findMany({ skip, take: pageSize, orderBy: { createdAt: 'desc' }, where }),
      prismaAny.reportExport.count({ where }),
    ]);
    res.status(200).json({ status: 'success', data: { rows, total, page, pageSize } });
  }),
);
router.post('/audit-trail/export',
  requirePermission(R21_PERM),
  validateQuery(ExportQuerySchema),
  validateBody(ExportBodySchema),
  catchAsync(async (req: any, res) => {
    const format = coerceFormat(req.query.format);
    const requiredExportPerm = format === 'XLSX' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    const userPerms: string[] = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (req.user?.role !== 'ADMIN' && !userPerms.includes(requiredExportPerm)) {
      throw new AppError('You are not authorized to perform this action', 403);
    }
    const result = await dispatchReportExport({
      reportType: 'AUDIT_TRAIL', reportName: 'R21_Report_Audit_Trail', format,
      filters: req.body, generatedBy: await generatorFor(req),
    });
    return sendExport(res, result);
  }),
);

// ---------- Download endpoint for queued exports (by reportUuid) ----------
// AC-5 / R21: creator OR ADMIN only (403 for everyone else). RBAC triple-gated:
//   1. router.use(restrictTo('BURSARY','ADMIN')) at top → STUDENT 403
//   2. requirePermission(REPORTS_VIEW_ACCOUNTING) here → BURSARY without export-audit perms denied
//   3. Inline creator==user || role==ADMIN check → other-bursary-non-admin 403
const UuidParam = z.object({ reportUuid: z.string().min(8).max(128) });
router.get('/download/:reportUuid',
  requirePermission('REPORTS_VIEW_ACCOUNTING'),
  validateParams(UuidParam),
  catchAsync(async (req: any, res, next) => {
    const rec = await prismaAny.reportExport.findUnique({
      where: { reportUuid: req.params.reportUuid },
    });
    if (!rec) return next(new AppError('Report export not found', 404));
    // Authorization: only creator OR ADMIN can download.
    // Any other non-ADMIN user attempting a different creator's UUID → 403.
    const uid = Number(req.user?.id);
    const role = req.user?.role as Role | undefined;
    if (role !== 'ADMIN' && rec.generatedById !== uid) {
      return next(new AppError('Not permitted to download this report (creator or ADMIN only)', 403));
    }
    if (rec.status !== 'COMPLETED' || !rec.storagePath) {
      return res.status(202).json({ status: rec.status, message: 'Report not ready or was generated in-memory; re-run export.' });
    }
    // NOTE: When BullMQ async exports are stored to disk, storagePath is set.
    // This skeleton returns JSON status. File streaming added when storage layer enabled.
    res.status(202).json({ status: rec.status, data: { id: rec.id, rowCount: rec.rowCount, format: rec.format, createdAt: rec.createdAt, expiresAt: rec.expiresAt } });
  }),
);

// 404 fallback
router.use((req: any, res: any) => {
  res.status(404).json({ status: 'fail', message: `Reports endpoint ${req.method} ${req.path} not mounted` });
});

export default router;
