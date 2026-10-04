import prisma from '../../config/database';
import { generateXlsxReport, xlsxContentType } from './xlsx';
import {
  generatePdfReport, pdfContentType, rowsToTableHtml,
  summaryToHtml, buildFiltersSummaryString, PdfReportInput,
} from './pdf';
import {
  MAX_EXPORT_ROWS,
  dashboardSummaryCards,
  dailyCollections,
  monthlyCollections,
  monthlyPayersRegister,
  revenueByBill,
  paymentRegister,
  studentStatement,
  billCollectionPerformance,
  outstandingDebtors,
  hierarchicalRevenue,
  paymentGatewayReport,
  settlementReport,
  reconciliationExceptions,
  refundReport,
  chargesAndFeeIncome,
  generalLedger,
  receiptRegister,
  transactionStatusMix,
  comparativeReports,
} from '../reports/aggregates';
type ReportType = string;
type ReportExportFormat = 'XLSX' | 'PDF';
type ReportExportStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'QUEUED' | 'EXPIRED';
import type { ReportColumnsCatalogKey, Column } from './catalog';
import { EXPORT_COLUMN_CATALOG } from './catalog';
import { AppError } from '../../utils/AppError';
import { v4 as uuidv4 } from 'uuid';

const prismaAny = prisma as any;

export const SYNC_ROWS_THRESHOLD = Number(process.env.REPORT_SYNC_ROWS ?? 5000);

export interface ExportRequestCtx {
  reportType: ReportType;
  reportName: string;
  format: ReportExportFormat;
  filters: any;
  generatedBy: { id: number; name: string; email: string };
  scheduledReportId?: number;
}

export interface SyncExportResult {
  mode: 'sync';
  buffer: Buffer;
  contentType: string;
  contentDisposition: string;
  auditId?: number;
  rowCount: number;
  fileSizeBytes: number;
  reportUuid: string;
}

export interface QueuedExportResult {
  mode: 'queued';
  jobId: string;
  message: string;
}

export type ExportResult = SyncExportResult | QueuedExportResult;

// ----------------------------------------------------------------------------
// Audit helpers: safe writes that NEVER throw (swallow + WARN log only)
// ----------------------------------------------------------------------------
function auditWarn(step: string, err: unknown, reportUuid: string) {
  try {
    const msg = String((err as any)?.message ?? err ?? 'unknown').slice(0, 220);
    // eslint-disable-next-line no-console
    console.warn(`[reportExport:audit:${step}] uuid=${reportUuid} err=${msg}`);
  } catch { /* noop */ }
}

async function safeUpdateAuditStatus(reportUuid: string, patch: Partial<{
  status: ReportExportStatus;
  rowCount: number;
  fileSizeBytes: number;
  errorMessage: string;
  storagePath: string;
  downloadUrl: string;
}>) {
  if (!reportUuid) return;
  try {
    const data: any = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.rowCount !== undefined) data.rowCount = patch.rowCount;
    if (patch.fileSizeBytes !== undefined) data.fileSizeBytes = BigInt(patch.fileSizeBytes);
    if (patch.errorMessage !== undefined) data.errorMessage = patch.errorMessage;
    if (patch.storagePath !== undefined) data.storagePath = patch.storagePath;
    if (patch.downloadUrl !== undefined) data.downloadUrl = patch.downloadUrl;
    if (Object.keys(data).length === 0) return;
    await prismaAny.reportExport.update({ where: { reportUuid }, data });
  } catch (err) {
    auditWarn('update', err, reportUuid);
  }
}

// ----------------------------------------------------------------------------
// Fetch rows + summary for a ReportType (central dispatcher).
// ReportType matches Prisma schema enum verbatim: 21 values.
// ----------------------------------------------------------------------------
export async function fetchReportDataForExport(
  reportType: ReportType,
  filters: any,
): Promise<{ rows: any[]; summary: Record<string, number | string>; columnsKey: ReportColumnsCatalogKey }> {
  const f = filters ?? {};
  switch (reportType) {
    case 'DASHBOARD_SUMMARY': {
      const data = await dashboardSummaryCards(f);
      const rows = Object.entries(data).map(([k, v]) => ({ metric: k, value: typeof v === 'number' ? Number(v.toFixed(2)) : String(v ?? '') }));
      return { rows, summary: data as any, columnsKey: 'key_value' };
    }
    case 'DAILY_COLLECTIONS': return { rows: await dailyCollections(f), summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'daily' };
    case 'MONTHLY_COLLECTIONS': {
      if (f.detail === 'payers') {
        const paged = await monthlyPayersRegister({ ...f, page: 1, pageSize: MAX_EXPORT_ROWS });
        return { rows: (paged as any).rows, summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'payers_register' };
      }
      return { rows: await monthlyCollections(f), summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'monthly' };
    }
    case 'REVENUE_BY_BILL': return { rows: await revenueByBill(f), summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'revenue_by_bill' };
    case 'PAYMENT_REGISTER': {
      const reg = await paymentRegister({ ...f, page: 1, pageSize: MAX_EXPORT_ROWS });
      return { rows: (reg as any).rows, summary: (reg as any).summary as any, columnsKey: 'payment_register' };
    }
    case 'STUDENT_STATEMENT': {
      const st = await studentStatement(f);
      const s = st.student as any;
      const studentFull = s
        ? [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ').trim()
        : '—';
      return { rows: (st as any).ledger, summary: {
        Matric: s?.matricNumber ?? '—',
        Student: studentFull,
        Billed: (st.financialSummary as any).billed,
        Paid: (st.financialSummary as any).paid,
        Outstanding: (st.financialSummary as any).outstanding,
        Refunds: (st.financialSummary as any).refunds,
        TotalCharges: (st.financialSummary as any).totalCharges,
        BillsAssigned: (st.financialSummary as any).billsAssigned,
        Wallet: (st.financialSummary as any).wallet,
      }, columnsKey: 'student_ledger' };
    }
    case 'BILL_COLLECTION_PERFORMANCE': return { rows: await billCollectionPerformance(f), summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'bill_performance' };
    case 'OUTSTANDING_DEBTORS': {
      const d = await outstandingDebtors({ ...f, page: 1, pageSize: MAX_EXPORT_ROWS });
      const dAny = d as any;
      return { rows: dAny.rows, summary: dAny.summary as any, columnsKey: 'debtors' };
    }
    case 'HIERARCHICAL_REVENUE': return { rows: await hierarchicalRevenue(f), summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'hierarchical' };
    case 'PAYMENT_GATEWAY': return { rows: await paymentGatewayReport(f), summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'gateway' };
    case 'SETTLEMENT': {
      const paged = await settlementReport({ ...f, page: 1, pageSize: MAX_EXPORT_ROWS });
      return { rows: (paged as any).rows, summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'settlement' };
    }
    case 'RECONCILIATION_EXCEPTIONS': {
      const ex = await reconciliationExceptions(f);
      const exAny = ex as any;
      const rows = exAny.categories.flatMap((g: any) => g.rows.map((r: any) => ({ exceptionKind: g.kind, exceptionLabel: g.label, ...r })));
      const summary: Record<string, number | string> = {};
      for (const g of exAny.categories) summary[`${g.label} (count)`] = g.count;
      summary['Total Exceptions'] = exAny.totalCount ?? exAny.categories.reduce((s: number, g: any) => s + g.count, 0);
      return { rows, summary, columnsKey: 'exceptions' };
    }
    case 'REFUND': {
      const r = await refundReport(f);
      const rAny = r as any;
      return { rows: rAny.rows, summary: {
        TodayCount: rAny.summary.todayCount,
        MonthCount: rAny.summary.monthCount,
        PendingCount: rAny.summary.pendingCount,
        CompleteCount: rAny.summary.completeCount,
        FailedCount: rAny.summary.failedCount,
        TotalRefunded: rAny.summary.totalRefunded,
      }, columnsKey: 'refunds' };
    }
    case 'CHARGES_FEE_INCOME': return { rows: await chargesAndFeeIncome(f), summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'charges' };
    case 'GENERAL_LEDGER': {
      const gl = await generalLedger({ ...f, page: 1, pageSize: MAX_EXPORT_ROWS });
      const glAny = gl as any;
      const summary: Record<string, number | string> = {};
      for (const [k, v] of Object.entries<any>(glAny.totalsByEntry ?? {})) {
        summary[`${k} Total`] = v.total;
        summary[`${k} Count`] = v.count;
      }
      return { rows: glAny.rows, summary, columnsKey: 'gl' };
    }
    case 'RECEIPT_REGISTER': {
      const paged = await receiptRegister({ ...f, page: 1, pageSize: MAX_EXPORT_ROWS });
      return { rows: (paged as any).rows, summary: (await dashboardSummaryCards(f)) as any, columnsKey: 'receipts' };
    }
    case 'TRANSACTION_STATUS': {
      const arr = await transactionStatusMix(f);
      const rows = Array.isArray(arr) ? arr : [];
      const summary: Record<string, number | string> = {};
      for (const r of rows) summary[`${(r as any).status} (count)`] = (r as any).count;
      const rev = rows.find((r: any) => r.includedInRevenue);
      summary['Included In Revenue'] = rev ? (rev as any).amount : 0;
      return { rows, summary, columnsKey: 'status_mix' };
    }
    case 'COMPARATIVE': {
      const range = (f.range === 'M' || f.range === 'S' || f.range === 'D') ? (f.range as 'D' | 'M' | 'S') : 'D';
      const c = await comparativeReports(range, f);
      const cAny = c as any;
      const rows: any[] = [
        { metric: `${cAny.rangeA?.label ?? 'Range A'} (Net)`, value: cAny.rangeA?.data?.net ?? 0, period: 'A' },
        { metric: `${cAny.rangeB?.label ?? 'Range B'} (Net)`, value: cAny.rangeB?.data?.net ?? 0, period: 'B' },
        { metric: 'Delta Net', value: cAny.delta?.net ?? 0, period: 'Δ' },
        { metric: 'Delta Net %', value: cAny.delta?.netPct ?? 0, period: 'Δ' },
        { metric: 'Delta Tx Count', value: cAny.delta?.txCount ?? 0, period: 'Δ' },
        { metric: 'Delta Gross', value: cAny.delta?.gross ?? 0, period: 'Δ' },
      ];
      const summary: Record<string, number | string> = {
        RangeA: cAny.rangeA?.label ?? '',
        RangeANet: cAny.rangeA?.data?.net ?? 0,
        RangeAGross: cAny.rangeA?.data?.gross ?? 0,
        RangeAPayers: cAny.rangeA?.data?.uniquePayers ?? 0,
        RangeB: cAny.rangeB?.label ?? '',
        RangeBNet: cAny.rangeB?.data?.net ?? 0,
        RangeBGross: cAny.rangeB?.data?.gross ?? 0,
        RangeBPayers: cAny.rangeB?.data?.uniquePayers ?? 0,
        DeltaNet: cAny.delta?.net ?? 0,
        DeltaNetPct: cAny.delta?.netPct ?? 0,
      };
      return { rows, summary, columnsKey: 'comparative' };
    }
    case 'EXPORT_CENTRE': {
      const rows = await prismaAny.reportExport.findMany({
        take: 50, orderBy: { createdAt: 'desc' },
        select: {
          id: true, reportUuid: true, reportType: true, reportName: true, format: true,
          status: true, generatedById: true, rowCount: true, fileSizeBytes: true,
          createdAt: true, expiresAt: true,
        },
      }) as any;
      return { rows, summary: { RecentExports: rows.length }, columnsKey: 'export_audit' };
    }
    case 'SCHEDULED': {
      const rows = await prismaAny.scheduledReport.findMany({
        where: f.isActive === true ? { isActive: true } : undefined,
        orderBy: { createdAt: 'desc' },
        take: MAX_EXPORT_ROWS,
        select: {
          id: true, name: true, reportType: true, frequency: true, cronExpression: true,
          format: true, subjectLine: true, lastRunAt: true, nextRunAt: true,
          isActive: true, createdAt: true, createdById: true,
        },
      }) as any;
      return { rows, summary: { TotalScheduled: rows.length, ActiveNow: rows.filter((r: any) => r.isActive).length }, columnsKey: 'scheduled' };
    }
    case 'AUDIT_TRAIL': {
      const rows = await prismaAny.reportExport.findMany({
        where: { createdAt: { gte: f.dateFrom ?? new Date(0), lte: f.dateTo ?? new Date(Date.now() + 86_400_000) } },
        orderBy: { createdAt: 'desc' },
        take: MAX_EXPORT_ROWS,
        select: {
          id: true, reportUuid: true, reportType: true, reportName: true, format: true, status: true,
          generatedById: true, dateRangeStart: true, dateRangeEnd: true, filters: true, rowCount: true,
          fileSizeBytes: true, downloadUrl: true, jobId: true, scheduledReportId: true, createdAt: true, expiresAt: true, errorMessage: true,
        },
      }) as any;
      return { rows, summary: { TotalExports: rows.length, TotalRowsExported: rows.reduce((s: number, r: any) => s + (r.rowCount ?? 0), 0) }, columnsKey: 'export_audit' };
    }
    default:
      throw new AppError(`Unsupported report type: ${reportType}`, 400);
  }
}

// ----------------------------------------------------------------------------
// Main dispatch
//   • Every path writes EXACTLY ONE ReportExport row (unified UUID).
//   • Status transitions: PENDING → PROCESSING → COMPLETED / FAILED.
//   • Any audit write failure → WARN + user response still returned.
//   • SYNC_ROWS_THRESHOLD 5000 → 202 + BullMQ
//   • MAX_EXPORT_ROWS 250000 → 413
// ----------------------------------------------------------------------------
export async function dispatchReportExport(ctx: ExportRequestCtx): Promise<ExportResult> {
  if (ctx.format !== 'XLSX' && ctx.format !== 'PDF') {
    throw new AppError(`Invalid export format: ${ctx.format} (expected XLSX or PDF)`, 400);
  }

  // Step 0: Allocate the audit UUID first. This is the single canonical UUID
  // for this export. It will appear in DB, PDF header/footer, and XLSX Summary.
  const reportUuid = uuidv4();

  // ---- (A) Hard cap check BEFORE fetch to protect OOM on absurdly wide filters.
  // We can't know exact count yet; we enforce again post-fetch below and in each
  // aggregator via `take: MAX_EXPORT_ROWS`. This throw is the user-facing 413.
  // MAX_EXPORT_ROWS is enforced both here and at the aggregator findMany() level.
  // Any report that can exceed this in aggregation will be clipped by the
  // aggregator take; we still throw here if the returned slice is already over.
  // ----------------------------------------------------------------------------

  // Step A': PENDING audit row (try/catch — never blocks).
  let auditWasCreated = false;
  try {
    await prismaAny.reportExport.create({
      data: {
        reportUuid,
        reportType: ctx.reportType,
        reportName: ctx.reportName ?? null,
        format: ctx.format,
        status: 'PENDING' as ReportExportStatus,
        generatedById: ctx.generatedBy.id,
        dateRangeStart: ctx.filters?.dateFrom ?? null,
        dateRangeEnd: ctx.filters?.dateTo ?? null,
        filters: ctx.filters ?? (null as any),
        rowCount: 0,
        fileSizeBytes: null,
        scheduledReportId: ctx.scheduledReportId ?? undefined,
      },
    });
    auditWasCreated = true;
  } catch (err) {
    auditWarn('create-pending', err, reportUuid);
  }

  // Step 1: Fetch data
  let estRowCount = 0;
  let rows: any[] = [];
  let summary: Record<string, number | string> = {};
  let columnsKey: ReportColumnsCatalogKey = 'key_value';
  try {
    const fetched = await fetchReportDataForExport(ctx.reportType, ctx.filters);
    rows = fetched.rows;
    summary = fetched.summary;
    columnsKey = fetched.columnsKey;
    estRowCount = rows.length;
  } catch (fetchErr: any) {
    // Record failure then rethrow (user should see the data error)
    if (auditWasCreated) {
      await safeUpdateAuditStatus(reportUuid, {
        status: 'FAILED' as ReportExportStatus,
        errorMessage: `fetchReportDataForExport failed: ${String(fetchErr?.message ?? fetchErr).slice(0, 1800)}`,
      });
    }
    throw fetchErr;
  }

  // Step 2: Enforce hard cap MAX_EXPORT_ROWS (HTTP 413 "Payload Too Large" semantic)
  if (estRowCount > MAX_EXPORT_ROWS) {
    if (auditWasCreated) {
      await safeUpdateAuditStatus(reportUuid, {
        status: 'FAILED' as ReportExportStatus,
        rowCount: estRowCount,
        errorMessage: `Exceeded hard cap MAX_EXPORT_ROWS=${MAX_EXPORT_ROWS}; got ${estRowCount}. Narrow filters.`,
      });
    }
    throw new AppError(
      `Please narrow filters, dataset too large (max ${MAX_EXPORT_ROWS.toLocaleString()} rows). Got ${estRowCount.toLocaleString()}.`,
      413,
    );
  }

  // Step 3: SYNC_ROWS_THRESHOLD 5000 → BullMQ async queue.
  if (estRowCount > SYNC_ROWS_THRESHOLD) {
    let jobId: string | null = null;
    try {
      const { dispatchJob } = await import('../../config/queue');
      jobId = `report-export:${ctx.reportType}:${ctx.generatedBy.id}:${Date.now()}`;
      await dispatchJob(
        'reports.export' as any,
        {
          reportType: ctx.reportType, reportName: ctx.reportName,
          format: ctx.format, filters: ctx.filters,
          generatedBy: ctx.generatedBy, scheduledReportId: ctx.scheduledReportId,
          preassignedReportUuid: reportUuid,
        },
        { jobId, retries: 2, priority: 'normal', deduplicate: true },
      );
      if (auditWasCreated) {
        // Queued case: remains PENDING (worker will transition PROCESSING → COMPLETED/FAILED)
        await safeUpdateAuditStatus(reportUuid, {
          rowCount: estRowCount,
        } as any);
        if (jobId) {
          try { await prismaAny.reportExport.update({ where: { reportUuid }, data: { jobId } }); } catch (_) { auditWarn('update-jobid', _, reportUuid); }
        }
      }
      return {
        mode: 'queued',
        jobId,
        message: `Export too large (${estRowCount.toLocaleString()} rows) — queued as job ${jobId}. Results will be emailed when ready.`,
      } satisfies QueuedExportResult;
    } catch (queueErr: any) {
      auditWarn('queue-enqueue', queueErr, reportUuid);
      // Queue not configured → fall through to sync if still ≤ MAX_EXPORT_ROWS.
      // (We already validated ≤ MAX above.)
    }
  }

  // ---- SYNC GENERATION PATH -----------------------------------------------
  // Status transition: PENDING → PROCESSING
  if (auditWasCreated) {
    await safeUpdateAuditStatus(reportUuid, { status: 'PROCESSING' as ReportExportStatus, rowCount: estRowCount });
  }

  const columns = EXPORT_COLUMN_CATALOG[columnsKey];
  let result: SyncExportResult;

  try {
    if (ctx.format === 'XLSX') {
      const cfg = xlsxContentType();
      const { buffer, rowCount, fileSizeBytes } = await generateXlsxReport(ctx.reportName, [{
        sheetName: ctx.reportName.slice(0, 28),
        columns: columns.map((c: Column) => ({
          header: c.header,
          key: c.key,
          width: ('width' in c ? c.width : undefined),
          isMoney: c.isMoney === true,
          isDate: false,
        })),
        summary,
        filters: ctx.filters ?? {},
        rowsPromise: async (_cap: number) => rows,
      }], { reportUuid, reportType: ctx.reportType });
      result = {
        mode: 'sync',
        buffer,
        contentType: cfg.contentType,
        contentDisposition: `attachment; filename="${cfg.filename(ctx.reportName, reportUuid)}"`,
        rowCount,
        fileSizeBytes,
        reportUuid,
      };
    } else {
      const cfg = pdfContentType();
      const pdfInput: PdfReportInput = {
        reportName: ctx.reportName,
        reportType: ctx.reportType,
        reportUuid,
        generatedBy: { name: ctx.generatedBy.name, email: ctx.generatedBy.email },
        dateRange: { start: ctx.filters?.dateFrom ?? null, end: ctx.filters?.dateTo ?? null },
        filtersSummary: buildFiltersSummaryString(ctx.filters ?? {}),
        filtersRaw: ctx.filters ?? {},
        summaryHtml: summaryToHtml(summary),
        detailedHtml: rowsToTableHtml(rows, columns.map((c: Column) => ({
          key: c.key, header: c.header,
          isMoney: c.isMoney === true,
          isNum: c.isMoney === true || c.isNum === true,
          isMonospace: c.isMonospace === true,
        }))),
      };
      const { buffer, fileSizeBytes } = await generatePdfReport(pdfInput);
      result = {
        mode: 'sync',
        buffer,
        contentType: cfg.contentType,
        contentDisposition: `attachment; filename="${cfg.filename(ctx.reportName, reportUuid)}"`,
        rowCount: rows.length,
        fileSizeBytes,
        reportUuid,
      };
    }
  } catch (genErr: any) {
    if (auditWasCreated) {
      await safeUpdateAuditStatus(reportUuid, {
        status: 'FAILED' as ReportExportStatus,
        errorMessage: `generate${ctx.format} failed: ${String(genErr?.message ?? genErr).slice(0, 1800)}`,
      });
    }
    throw genErr;
  }

  // Step D: COMPLETED status on the single audit row.
  // Do NOT call recordReportExport() here — that helper calls create() on the same
  // reportUuid; reportUuid has @unique DB constraint → duplicate write.
  if (auditWasCreated) {
    await safeUpdateAuditStatus(reportUuid, {
      status: 'COMPLETED' as ReportExportStatus,
      rowCount: result.rowCount,
      fileSizeBytes: result.fileSizeBytes,
    });
    // Best-effort: resolve the created row id for response headers.
    try {
      await (prisma as any).user.findUnique({ where: { id: ctx.generatedBy.id } }); // touch relation keep warm
      const row = await prismaAny.reportExport.findUnique({ where: { reportUuid }, select: { id: true } });
      if (row) result.auditId = row.id;
    } catch (err) {
      auditWarn('final-metadata', err, reportUuid);
    }
  }
  return result;
}

export default {
  dispatchReportExport,
  fetchReportDataForExport,
  buildFiltersSummaryString,
  SYNC_ROWS_THRESHOLD,
};
