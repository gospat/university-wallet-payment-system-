// STAGE 5 — Bursary Reports API Client.
// Matches routes/reports.ts endpoint surface. All 21 reports × GET + POST export.
// Uses shared axios instance from api.ts with 401 refresh interceptor.

import api from './api';

export type ReportFormat = 'xlsx' | 'pdf';

export type ReportsBaseFilters = {
  dateFrom?: string | Date;
  dateTo?: string | Date;
  provider?: string;
  session?: string;
  semester?: string;
  level?: string;
  collegeId?: number;
  departmentId?: number;
  programmeId?: number;
  feeCategoryId?: number;
  feeId?: number;
  studentId?: number;
  paymentStatus?: string;
  reconciliationStatus?: string;
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
};

export type DashboardFacetName =
  | 'GROSS_ALL'
  | 'UNIQUE_PAYERS'
  | 'BY_PAYSTACK'
  | 'BY_ALATPAY'
  | 'BY_CONVENIENCE'
  | 'BY_SERVICE'
  | 'BY_GATEWAY'
  | 'BY_REFUND'
  | 'BY_NET'
  | 'RECONCILED'
  | 'UNRECONCILED';

export const DASHBOARD_FACETS: Record<DashboardFacetName, Partial<ReportsBaseFilters> & { status?: string }> = {
  GROSS_ALL: {},
  UNIQUE_PAYERS: {},
  BY_PAYSTACK: { provider: 'PAYSTACK' },
  BY_ALATPAY: { provider: 'ALATPAY' },
  BY_CONVENIENCE: {},
  BY_SERVICE: {},
  BY_GATEWAY: {},
  BY_REFUND: { paymentStatus: 'REFUNDED' },
  BY_NET: {},
  RECONCILED: { reconciliationStatus: 'RECONCILED' },
  UNRECONCILED: { reconciliationStatus: 'PENDING_SETTLEMENT' },
};

const ENDPOINT_BASE = '/reports';

// ----------------- Generic helpers -----------------
async function getReportJson<T = any>(path: string, params?: any): Promise<{ status: string; data: T }> {
  const resp = await api.get(`${ENDPOINT_BASE}${path}`, { params });
  return resp.data;
}

async function postExportBlob(
  path: string,
  format: ReportFormat,
  body: any,
): Promise<Blob | { queued: boolean; jobId?: string; message?: string }> {
  const resp = await api.post(`${ENDPOINT_BASE}${path}/export?format=${format}`, body ?? {}, {
    responseType: 'blob',
    timeout: 120000,
  });
  // If queue response (202), the response is JSON even though blob was requested
  const ct = String(resp.headers?.['content-type'] ?? '');
  if (ct.includes('application/json') || resp.status === 202) {
    // Convert Blob → text → JSON
    const text = await (resp.data as Blob).text();
    try {
      return JSON.parse(text) as any;
    } catch {
      return { queued: true, message: text };
    }
  }
  return resp.data as Blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ----------------- R1 Dashboard summary cards -----------------
export async function getDashboardSummary(filters: ReportsBaseFilters) {
  return (await getReportJson('/dashboard-summary', filters)).data;
}
export async function exportDashboardSummary(filters: any, format: ReportFormat) {
  return postExportBlob('/dashboard-summary', format, filters);
}

// ----------------- R2 Daily Collections -----------------
export async function getDailyCollections(filters: ReportsBaseFilters) {
  return (await getReportJson('/daily-collections', filters)).data;
}
export async function exportDailyCollections(filters: any, format: ReportFormat) {
  return postExportBlob('/daily-collections', format, filters);
}

// ----------------- R3 Monthly Collections -----------------
export async function getMonthlyCollections(filters: ReportsBaseFilters & { detail?: 'summary'|'payers'; month?: number }) {
  return (await getReportJson('/monthly-collections', filters)).data;
}
export async function exportMonthlyCollections(filters: any, format: ReportFormat) {
  return postExportBlob('/monthly-collections', format, filters);
}

// ----------------- R4 Revenue by Bill -----------------
export async function getRevenueByBill(filters: ReportsBaseFilters) {
  return (await getReportJson('/revenue-by-bill', filters)).data;
}
export async function exportRevenueByBill(filters: any, format: ReportFormat) {
  return postExportBlob('/revenue-by-bill', format, filters);
}

// ----------------- R5 Payment Register -----------------
export async function getPaymentRegister(filters: ReportsBaseFilters) {
  return (await getReportJson('/payment-register', filters)).data;
}
export async function exportPaymentRegister(filters: any, format: ReportFormat) {
  return postExportBlob('/payment-register', format, filters);
}

// ----------------- R6 Student Statement -----------------
export async function getStudentStatement(filters: ReportsBaseFilters & { matricNumber?: string; studentId?: number }) {
  return (await getReportJson('/student-statement', filters)).data;
}
export async function exportStudentStatement(filters: any, format: ReportFormat) {
  return postExportBlob('/student-statement', format, filters);
}

// ----------------- R7 Bill Collection Performance -----------------
export async function getBillCollectionPerformance(filters: ReportsBaseFilters) {
  return (await getReportJson('/bill-collection-performance', filters)).data;
}
export async function exportBillCollectionPerformance(filters: any, format: ReportFormat) {
  return postExportBlob('/bill-collection-performance', format, filters);
}

// ----------------- R8 Outstanding Debtors -----------------
export async function getOutstandingDebtors(filters: ReportsBaseFilters & { tab?: 'ALL'|'PARTIAL'|'NEVER'; minOutstanding?: number; maxOutstanding?: number }) {
  return (await getReportJson('/outstanding-debtors', filters)).data;
}
export async function exportOutstandingDebtors(filters: any, format: ReportFormat) {
  return postExportBlob('/outstanding-debtors', format, filters);
}

// ----------------- R9 Hierarchical Revenue -----------------
export async function getHierarchicalRevenue(filters: ReportsBaseFilters & { level?: 'college'|'department'|'programme' }) {
  return (await getReportJson('/hierarchical-revenue', filters)).data;
}
export async function exportHierarchicalRevenue(filters: any, format: ReportFormat) {
  return postExportBlob('/hierarchical-revenue', format, filters);
}

// ----------------- R10 Payment Gateway -----------------
export async function getPaymentGatewayReport(filters: ReportsBaseFilters) {
  return (await getReportJson('/payment-gateway', filters)).data;
}
export async function exportPaymentGatewayReport(filters: any, format: ReportFormat) {
  return postExportBlob('/payment-gateway', format, filters);
}

// ----------------- R11 Settlement -----------------
export async function getSettlementReport(filters: ReportsBaseFilters) {
  return (await getReportJson('/settlement', filters)).data;
}
export async function exportSettlementReport(filters: any, format: ReportFormat) {
  return postExportBlob('/settlement', format, filters);
}

// ----------------- R12 Reconciliation Exceptions -----------------
export async function getReconciliationExceptions(filters: ReportsBaseFilters & { kind?: string }) {
  return (await getReportJson('/reconciliation-exceptions', filters)).data;
}
export async function exportReconciliationExceptions(filters: any, format: ReportFormat) {
  return postExportBlob('/reconciliation-exceptions', format, filters);
}

// ----------------- R13 Refunds -----------------
export async function getRefundReport(filters: ReportsBaseFilters) {
  return (await getReportJson('/refunds', filters)).data;
}
export async function exportRefundReport(filters: any, format: ReportFormat) {
  return postExportBlob('/refunds', format, filters);
}

// ----------------- R14 Charges & Fee Income -----------------
export async function getChargesFeeIncome(filters: ReportsBaseFilters) {
  return (await getReportJson('/charges-fee-income', filters)).data;
}
export async function exportChargesFeeIncome(filters: any, format: ReportFormat) {
  return postExportBlob('/charges-fee-income', format, filters);
}

// ----------------- R15 General Ledger -----------------
export async function getGeneralLedger(filters: ReportsBaseFilters & { entryType?: string }) {
  return (await getReportJson('/general-ledger', filters)).data;
}
export async function exportGeneralLedger(filters: any, format: ReportFormat) {
  return postExportBlob('/general-ledger', format, filters);
}

// ----------------- R16 Receipt Register -----------------
export async function getReceiptRegister(filters: ReportsBaseFilters) {
  return (await getReportJson('/receipt-register', filters)).data;
}
export async function exportReceiptRegister(filters: any, format: ReportFormat) {
  return postExportBlob('/receipt-register', format, filters);
}

// ----------------- R17 Transaction Status -----------------
export async function getTransactionStatus(filters: ReportsBaseFilters) {
  return (await getReportJson('/transaction-status', filters)).data;
}
export async function exportTransactionStatus(filters: any, format: ReportFormat) {
  return postExportBlob('/transaction-status', format, filters);
}

// ----------------- R18 Comparative -----------------
export async function getComparative(filters: ReportsBaseFilters & { range?: 'D'|'M'|'S' }) {
  return (await getReportJson('/comparative', filters)).data;
}
export async function exportComparative(filters: any, format: ReportFormat) {
  return postExportBlob('/comparative', format, filters);
}

// ----------------- R19 Export Centre -----------------
export async function getExportCentre(filters: { page?: number; pageSize?: number }) {
  return (await getReportJson('/export-centre', filters)).data;
}
export async function exportExportCentre(filters: any, format: ReportFormat) {
  return postExportBlob('/export-centre', format, filters);
}

// ----------------- R20 Scheduled Reports -----------------
export async function listScheduledReports(filters?: { page?: number; pageSize?: number; isActive?: boolean }) {
  return (await getReportJson('/scheduled', filters)).data;
}
export async function createScheduledReport(body: any) {
  return (await api.post(`${ENDPOINT_BASE}/scheduled`, body)).data;
}
export async function updateScheduledReport(id: number, body: any) {
  return (await api.patch(`${ENDPOINT_BASE}/scheduled/${id}`, body)).data;
}
export async function pauseScheduledReport(id: number) {
  return (await api.delete(`${ENDPOINT_BASE}/scheduled/${id}`)).data;
}

// ----------------- R21 Audit Trail -----------------
export async function getReportsAuditTrail(filters: ReportsBaseFilters) {
  return (await getReportJson('/audit-trail', filters)).data;
}
export async function exportReportsAuditTrail(filters: any, format: ReportFormat) {
  return postExportBlob('/audit-trail', format, filters);
}

// ----------------- H15 Literal Sort Allowlist -----------------
export const TXN_ALLOWED_SORTS: Record<string, string[]> = {
  'payment-register': ['createdAt', 'studentName', 'matricNumber', 'provider', 'billName', 'baseAmount', 'totalAmount', 'status', 'receiptNumber'],
  'daily-collections': ['date', 'txCount', 'studentCount', 'gross', 'net', 'refunds'],
  'monthly-collections': ['month', 'txCount', 'uniquePayers', 'gross', 'net', 'refunds'],
  'revenue-by-bill': ['revenueItem', 'numPayers', 'expectedAmount', 'collected', 'outstanding', 'collectionPct'],
  'bill-performance': ['billName', 'category', 'assigned', 'expectedAmount', 'collected', 'outstanding', 'collectionPct'],
  'outstanding-debtors': ['matricNumber', 'studentName', 'billName', 'paymentStatus', 'dueAmount', 'paidAmount', 'outstanding'],
  'hierarchical-revenue': ['level', 'nodeName', 'txCount', 'uniquePayers', 'gross', 'net'],
  'charges-fee-income': ['period', 'basePayment', 'convFee', 'svcCharge', 'gwFee', 'totalCharged', 'netRevenue'],
  'general-ledger': ['transactionDate', 'entryType', 'account', 'debit', 'credit', 'transactionId'],
  'receipt-register': ['receiptNumber', 'date', 'studentName', 'matricNumber', 'billName', 'baseAmount', 'totalAmount', 'provider'],
  'transaction-status': ['status', 'count', 'amount', 'sharePct'],
  'payment-gateway': ['provider', 'successCount', 'failCount', 'pendingCount', 'gross', 'gatewayFees', 'expectedSettlement', 'variance'],
  'settlement': ['transactionReference', 'provider', 'paymentDate', 'paymentAmount', 'expectedSettlement', 'settlementDate', 'actualSettlement', 'variance', 'reconciliationStatus'],
  'refunds': ['refundDate', 'studentName', 'matricNumber', 'originalAmount', 'refundAmount', 'provider', 'status'],
  'comparative': ['bucket', 'period', 'txCount', 'uniquePayers', 'gross', 'net', 'deltaNet', 'deltaNetPct'],
  'reports-audit-trail': ['createdAt', 'reportType', 'reportName', 'format', 'generatedById', 'status', 'rowCount'],
  'fee-waivers': ['createdAt', 'studentName', 'matricNumber', 'billName', 'amount', 'reason', 'approvedBy'],
  'journal-vouchers': ['voucherDate', 'voucherNumber', 'entryType', 'account', 'debit', 'credit', 'createdBy'],
  'settlement-variance': ['transactionReference', 'provider', 'expectedSettlement', 'actualSettlement', 'variance', 'variancePct', 'reconciliationStatus'],
};

// ----------------- Drill-down Facet → Filters mapper -----------------
export type FacetName =
  | 'GROSS_ALL' | 'UNIQUE_PAYERS'
  | 'BY_PAYSTACK' | 'BY_ALATPAY'
  | 'BY_CONVENIENCE' | 'BY_SERVICE' | 'BY_GATEWAY'
  | 'BY_REFUND' | 'BY_NET'
  | 'RECONCILED' | 'UNRECONCILED';

export const FACET_LABELS: Record<FacetName, string> = {
  GROSS_ALL: 'All Successful Transactions',
  UNIQUE_PAYERS: 'Unique Payers',
  BY_PAYSTACK: 'Paystack Only',
  BY_ALATPAY: 'ALATPay Only',
  BY_CONVENIENCE: 'Convenience Fee Breakdown',
  BY_SERVICE: 'Service Charge Breakdown',
  BY_GATEWAY: 'Gateway Fee Breakdown',
  BY_REFUND: 'Refunded Payments',
  BY_NET: 'Net Revenue View',
  RECONCILED: 'Reconciled Transactions',
  UNRECONCILED: 'Unreconciled Transactions',
};

export function applyFacetToFilters(facet: string, base: any = {}): any {
  const f = { ...(base ?? {}) };
  switch (facet) {
    case 'BY_PAYSTACK':
      f.provider = 'PAYSTACK';
      break;
    case 'BY_ALATPAY':
      f.provider = 'ALATPAY';
      break;
    case 'UNRECONCILED':
      f.reconciliationStatus = ['PENDING_SETTLEMENT', 'VARIANCE', 'UNMATCHED', 'UNDER_REVIEW'];
      break;
    case 'RECONCILED':
      f.reconciliationStatus = ['MATCHED', 'SETTLED', 'PARTIALLY_MATCHED'];
      break;
    case 'BY_REFUND':
      f.paymentStatus = 'REFUNDED';
      f.status = 'REFUNDED';
      break;
    case 'BY_CONVENIENCE':
    case 'BY_SERVICE':
    case 'BY_GATEWAY':
      f.breakdown = facet;
      break;
    case 'BY_NET':
      f.view = 'NET';
      break;
    case 'GROSS_ALL':
    case 'UNIQUE_PAYERS':
    default:
      break;
  }
  return f;
}

// ----------------- Report Library catalog (frontend used) -----------------
export const REPORT_LIBRARY: Array<{
  key: string;
  group: 'Collections' | 'Revenue' | 'Accounting' | 'Reconciliation';
  title: string;
  subtitle: string;
  viewPermission: string;
  pageRoute: string;
}> = [
  { key: 'daily-collections',          group: 'Collections',    title: 'Daily Collections',                   subtitle: 'Per-day collection totals with gross, charges, refunds, net',                  viewPermission: 'REPORTS_VIEW_COLLECTIONS',         pageRoute: '/bursary/reports/view/daily-collections' },
  { key: 'monthly-collections',        group: 'Collections',    title: 'Monthly Collections & Payers',       subtitle: 'Month rollups + per-payer detailed register',                                 viewPermission: 'REPORTS_VIEW_COLLECTIONS',         pageRoute: '/bursary/reports/view/monthly-collections' },
  { key: 'payment-register',           group: 'Collections',    title: 'Master Payment Register',            subtitle: 'Full payment transaction register with search + filter + sort',               viewPermission: 'REPORTS_VIEW_COLLECTIONS',         pageRoute: '/bursary/reports/view/payment-register' },
  { key: 'comparative',                group: 'Collections',    title: 'Comparative Reports',                subtitle: 'Today↔Yesterday, This↔Last Month, This↔Prev Session equiv periods',          viewPermission: 'REPORTS_VIEW_COLLECTIONS',         pageRoute: '/bursary/reports/view/comparative' },
  { key: 'revenue-by-bill',            group: 'Revenue',        title: 'Revenue by Bill',                    subtitle: 'Revenue analysis per bill/category: expected vs collected, collection%',     viewPermission: 'REPORTS_VIEW_REVENUE',             pageRoute: '/bursary/reports/view/revenue-by-bill' },
  { key: 'bill-performance',           group: 'Revenue',        title: 'Bill Collection Performance',        subtitle: 'Per bill: assigned/expected/full/partial/unpaid counts + collection%',        viewPermission: 'REPORTS_VIEW_REVENUE',             pageRoute: '/bursary/reports/view/bill-performance' },
  { key: 'hierarchical-revenue',       group: 'Revenue',        title: 'College / Dept / Programme',         subtitle: '3-level hierarchical revenue rollup, drilldown to register',                 viewPermission: 'REPORTS_VIEW_REVENUE',             pageRoute: '/bursary/reports/view/hierarchical-revenue' },
  { key: 'outstanding-debtors',        group: 'Revenue',        title: 'Outstanding Debtors',                subtitle: 'Students with unpaid balances: ALL / PARTIAL / NEVER paid views',             viewPermission: 'REPORTS_VIEW_OUTSTANDING',         pageRoute: '/bursary/reports/view/outstanding-debtors' },
  { key: 'fee-waivers',                group: 'Revenue',        title: 'Fee Waivers & Write-offs',           subtitle: 'Track waived fees, write-offs, approvals with reason & audit trail',          viewPermission: 'REPORTS_VIEW_REVENUE',             pageRoute: '/bursary/reports/view/fee-waivers' },
  { key: 'refunds',                    group: 'Accounting',     title: 'Refund Report',                      subtitle: 'All refunds with Today/Month buckets + Pending/Complete/Failed counts',      viewPermission: 'REPORTS_VIEW_ACCOUNTING',          pageRoute: '/bursary/reports/view/refunds' },
  { key: 'charges-fee-income',         group: 'Accounting',     title: 'Charges & Fee Income',               subtitle: 'Period base payment + conv/svc/gw charges breakdown + net revenue',           viewPermission: 'REPORTS_VIEW_ACCOUNTING',          pageRoute: '/bursary/reports/view/charges-fee-income' },
  { key: 'general-ledger',             group: 'Accounting',     title: 'General Ledger',                     subtitle: '6-entryType double-entry GL drilldown + totals by entryType',                 viewPermission: 'REPORTS_VIEW_ACCOUNTING',          pageRoute: '/bursary/reports/view/general-ledger' },
  { key: 'receipt-register',           group: 'Accounting',     title: 'Receipt Register',                   subtitle: 'Full receipt register with voided/duplicate/no-payment exception flags',      viewPermission: 'REPORTS_VIEW_ACCOUNTING',          pageRoute: '/bursary/reports/view/receipt-register' },
  { key: 'transaction-status',         group: 'Accounting',     title: 'Transaction Status Mix',             subtitle: 'Canonical 6 statuses, SUCCESSFUL only counts in revenue',                     viewPermission: 'REPORTS_VIEW_OUTSTANDING',         pageRoute: '/bursary/reports/view/transaction-status' },
  { key: 'export-centre',              group: 'Accounting',     title: 'Export Centre',                      subtitle: 'Recent report exports: status, filesize, generated-by, download',             viewPermission: 'REPORTS_VIEW_ACCOUNTING',          pageRoute: '/bursary/reports/export-centre' },
  { key: 'student-statement',          group: 'Accounting',     title: 'Student Statement',                  subtitle: 'Per-student financial ledger: bills, receipts, refunds, running balance',     viewPermission: 'REPORTS_VIEW_STUDENT_STATEMENT',   pageRoute: '/bursary/reports/student-statement' },
  { key: 'scheduled-reports',          group: 'Accounting',     title: 'Scheduled Reports',                  subtitle: 'ADMIN-only CRUD: recurring bursary emails (Daily/Weekly/Monthly + custom)',   viewPermission: 'REPORTS_SCHEDULE',                 pageRoute: '/bursary/reports/scheduled' },
  { key: 'reports-audit-trail',        group: 'Accounting',     title: 'Reports Audit Trail',                subtitle: 'Complete audit of every report generated, export, schedule change, download', viewPermission: 'REPORTS_VIEW_ACCOUNTING',          pageRoute: '/bursary/reports/view/reports-audit-trail' },
  { key: 'journal-vouchers',           group: 'Accounting',     title: 'Journal Vouchers',                   subtitle: 'Manual GL adjustment vouchers, approvals, audit trail',                      viewPermission: 'REPORTS_VIEW_ACCOUNTING',          pageRoute: '/bursary/reports/view/journal-vouchers' },
  { key: 'payment-gateway',            group: 'Reconciliation', title: 'Payment Gateway Report',             subtitle: 'Per provider success/fail counts + gw fees + settlement variance',            viewPermission: 'REPORTS_VIEW_RECONCILIATION',      pageRoute: '/bursary/reports/view/payment-gateway' },
  { key: 'settlement',                 group: 'Reconciliation', title: 'Settlement Report',                  subtitle: 'Per-transaction expected vs actual settlement amount + recon status',         viewPermission: 'REPORTS_VIEW_RECONCILIATION',      pageRoute: '/bursary/reports/view/settlement' },
  { key: 'reconciliation-exceptions',  group: 'Reconciliation', title: 'Reconciliation Exceptions',          subtitle: '11 exception kinds: duplicates, mismatches, unmatched items + drilldown',     viewPermission: 'REPORTS_VIEW_RECONCILIATION',      pageRoute: '/bursary/reports/exceptions' },
  { key: 'settlement-variance',        group: 'Reconciliation', title: 'Settlement Variances',               subtitle: 'Deep-dive variance report: expected vs actual settlement, root causes',       viewPermission: 'REPORTS_VIEW_RECONCILIATION',      pageRoute: '/bursary/reports/view/settlement-variance' },
];

// Date preset helpers used by Reports Centre chips
export function applyDatePreset(preset: 'TODAY'|'YESTERDAY'|'THIS_WEEK'|'THIS_MONTH'|'LAST_MONTH'|'THIS_SESSION'|'CUSTOM', customStart?: Date, customEnd?: Date): { dateFrom: Date|undefined; dateTo: Date|undefined } {
  const now = new Date();
  const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
  const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  switch (preset) {
    case 'TODAY':       return { dateFrom: startOfDay(now), dateTo: endOfDay(now) };
    case 'YESTERDAY':   return { dateFrom: startOfDay(yesterday), dateTo: endOfDay(yesterday) };
    case 'THIS_WEEK': {
      const s = new Date(now); const d = s.getDay(); const diff = s.getDate() - d + (d === 0 ? -6 : 1); // Mon-start
      s.setDate(diff); s.setHours(0,0,0,0);
      const e = new Date(s); e.setDate(e.getDate() + 6); e.setHours(23,59,59,999);
      return { dateFrom: s, dateTo: e };
    }
    case 'THIS_MONTH': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      const e = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      return { dateFrom: s, dateTo: e };
    }
    case 'LAST_MONTH': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { dateFrom: s, dateTo: e };
    }
    case 'THIS_SESSION': {
      // Heuristic: Aug present → current session Aug to Dec; else Jan–Jul → last Aug to Dec, else current year
      const year = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
      return { dateFrom: startOfDay(new Date(year, 7, 1)), dateTo: endOfDay(now) };
    }
    case 'CUSTOM': return { dateFrom: customStart, dateTo: customEnd };
    default: return { dateFrom: undefined, dateTo: undefined };
  }
}

export default {
  REPORT_LIBRARY,
  applyDatePreset,
  downloadBlob,
  getDashboardSummary, exportDashboardSummary,
  getDailyCollections, exportDailyCollections,
  getMonthlyCollections, exportMonthlyCollections,
  getRevenueByBill, exportRevenueByBill,
  getPaymentRegister, exportPaymentRegister,
  getStudentStatement, exportStudentStatement,
  getBillCollectionPerformance, exportBillCollectionPerformance,
  getOutstandingDebtors, exportOutstandingDebtors,
  getHierarchicalRevenue, exportHierarchicalRevenue,
  getPaymentGatewayReport, exportPaymentGatewayReport,
  getSettlementReport, exportSettlementReport,
  getReconciliationExceptions, exportReconciliationExceptions,
  getRefundReport, exportRefundReport,
  getChargesFeeIncome, exportChargesFeeIncome,
  getGeneralLedger, exportGeneralLedger,
  getReceiptRegister, exportReceiptRegister,
  getTransactionStatus, exportTransactionStatus,
  getComparative, exportComparative,
  getExportCentre,
  listScheduledReports, createScheduledReport, updateScheduledReport, pauseScheduledReport,
  getReportsAuditTrail, exportReportsAuditTrail,
};
