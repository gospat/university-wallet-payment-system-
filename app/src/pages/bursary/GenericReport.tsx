// STAGE 5 F3 — Generic Reusable Report Page.
// Takes reportKey via URL useParams(); resolves via REPORT_LIBRARY metadata;
// calls correct reportsApi GET endpoint; renders summary + drilldown paginated
// table + "Export Excel" / "Export PDF" buttons (R19). Drilldown cells hyperlinked.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { navCounters, NavCounters } from '../../services/api';
import { i18n } from '../../i18n/en';
import {
  ArrowLeft, ChevronRight, FileSpreadsheet, FileText,
  Loader2, AlertTriangle, ChevronLeft, ChevronDown, Filter, X,
  ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2,
} from 'lucide-react';
import {
  REPORT_LIBRARY,
  downloadBlob,
  applyFacetToFilters,
  FACET_LABELS,
  TXN_ALLOWED_SORTS,
  getDailyCollections, getMonthlyCollections,
  getRevenueByBill, getPaymentRegister, getBillCollectionPerformance,
  getOutstandingDebtors, getHierarchicalRevenue, getPaymentGatewayReport,
  getSettlementReport, getRefundReport, getChargesFeeIncome, getGeneralLedger,
  getReceiptRegister, getTransactionStatus, getComparative,
  getReportsAuditTrail,
  exportDailyCollections, exportMonthlyCollections,
  exportRevenueByBill, exportPaymentRegister, exportBillCollectionPerformance,
  exportOutstandingDebtors, exportHierarchicalRevenue, exportPaymentGatewayReport,
  exportSettlementReport, exportRefundReport, exportChargesFeeIncome,
  exportGeneralLedger, exportReceiptRegister, exportTransactionStatus,
  exportComparative,
  exportReportsAuditTrail,
} from '../../services/reportsApi';

type Role = 'BURSARY' | 'ADMIN';

export interface GenericReportPageProps { role: Role; activePath: string; }

const hasPermission = (perm: string, perms?: string[], role?: Role): boolean => {
  if (role === 'ADMIN') {
    const auto = new Set(['MANAGE_USERS','MANAGE_ROLES','SYSTEM_SETTINGS','PAYSTACK_CONFIG','AUDIT_LOGS_VIEW_FULL','REPORTS_SCHEDULE']);
    if (auto.has(perm)) return true;
  }
  if (!perms || perms.length === 0) return false;
  return perms.includes(perm);
};

const fmtNGN = (v: any) => {
  if (v === null || v === undefined || v === '') return '';
  const num = Number(v);
  if (Number.isNaN(num)) return String(v);
  return `₦${num.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

type ReportsMap = {
  [key: string]: {
    get: (filters: any) => Promise<any>;
    export: (filters: any, format: 'xlsx'|'pdf') => Promise<any>;
    title: string;
    drilldownAccessor: (data: any) => any[];
    summaryAccessor?: (data: any) => Record<string, any> | null;
    columns: Array<{ key: string; header: string; isMoney?: boolean; isNum?: boolean; href?: (row: any) => string | undefined; isMonospace?: boolean }>;
    tabs?: Array<{ key: string; label: string; filter?: Record<string, any> }>;
  };
};

const COLS: any = {
  daily: [
    { key: 'date', header: 'Date' },
    { key: 'txCount', header: 'Tx Count', isNum: true },
    { key: 'studentCount', header: 'Payers', isNum: true },
    { key: 'gross', header: 'Gross', isMoney: true },
    { key: 'convenienceFee', header: 'Conv Fee', isMoney: true },
    { key: 'serviceCharge', header: 'Svc Chg', isMoney: true },
    { key: 'gatewayFee', header: 'GW Fee', isMoney: true },
    { key: 'refunds', header: 'Refunds', isMoney: true },
    { key: 'net', header: 'Net', isMoney: true },
  ],
  monthly: [
    { key: 'month', header: 'Month' },
    { key: 'txCount', header: 'Tx Count', isNum: true },
    { key: 'uniquePayers', header: 'Payers', isNum: true },
    { key: 'gross', header: 'Gross', isMoney: true },
    { key: 'charges', header: 'Charges', isMoney: true },
    { key: 'refunds', header: 'Refunds', isMoney: true },
    { key: 'net', header: 'Net', isMoney: true },
  ],
  payment_register: [
    { key: 'createdAt', header: 'Date' },
    { key: 'studentName', header: 'Student', href: (r: any) => r.studentId ? `/bursary/reports/student-statement?studentId=${r.studentId}` : undefined },
    { key: 'matricNumber', header: 'Matric', isMonospace: true, href: (r: any) => r.matricNumber ? `/bursary/reports/student-statement?matricNumber=${encodeURIComponent(r.matricNumber)}` : undefined },
    { key: 'provider', header: 'Provider' },
    { key: 'billName', header: 'Bill' },
    { key: 'baseAmount', header: 'Base', isMoney: true },
    { key: 'convenienceFee', header: 'Conv', isMoney: true },
    { key: 'gatewayFee', header: 'GW', isMoney: true },
    { key: 'totalAmount', header: 'Total', isMoney: true },
    { key: 'status', header: 'Status' },
    { key: 'receiptNumber', header: 'Receipt', isMonospace: true },
  ],
  revenue_bill: [
    { key: 'revenueItem', header: 'Revenue Item' },
    { key: 'numPayers', header: 'Payers', isNum: true },
    { key: 'expectedAmount', header: 'Expected', isMoney: true },
    { key: 'collected', header: 'Collected', isMoney: true },
    { key: 'outstanding', header: 'Outstanding', isMoney: true },
    { key: 'collectionPct', header: 'Collection %', isNum: true },
  ],
  bill_perf: [
    { key: 'billName', header: 'Bill' },
    { key: 'category', header: 'Category' },
    { key: 'assigned', header: 'Assigned', isNum: true },
    { key: 'expectedAmount', header: 'Expected', isMoney: true },
    { key: 'fullPaidCount', header: 'Fully Paid', isNum: true },
    { key: 'partialPaidCount', header: 'Partial', isNum: true },
    { key: 'unpaidCount', header: 'Unpaid', isNum: true },
    { key: 'collected', header: 'Collected', isMoney: true },
    { key: 'outstanding', header: 'Outstanding', isMoney: true },
    { key: 'collectionPct', header: 'Collection %', isNum: true },
  ],
  debtors: [
    { key: 'matricNumber', header: 'Matric', isMonospace: true, href: (r: any) => r.matricNumber ? `/bursary/reports/student-statement?matricNumber=${encodeURIComponent(r.matricNumber)}` : undefined },
    { key: 'studentName', header: 'Student' },
    { key: 'billName', header: 'Bill' },
    { key: 'paymentStatus', header: 'Status' },
    { key: 'dueAmount', header: 'Due', isMoney: true },
    { key: 'paidAmount', header: 'Paid', isMoney: true },
    { key: 'outstanding', header: 'Outstanding', isMoney: true },
  ],
  hierarchical: [
    { key: 'level', header: 'Level' },
    { key: 'nodeName', header: 'Node' },
    { key: 'parentName', header: 'Parent' },
    { key: 'txCount', header: 'Tx', isNum: true },
    { key: 'uniquePayers', header: 'Payers', isNum: true },
    { key: 'gross', header: 'Gross', isMoney: true },
    { key: 'net', header: 'Net', isMoney: true },
  ],
  gateway: [
    { key: 'provider', header: 'Provider' },
    { key: 'successCount', header: 'Success', isNum: true },
    { key: 'failCount', header: 'Fail', isNum: true },
    { key: 'pendingCount', header: 'Pending', isNum: true },
    { key: 'gross', header: 'Gross', isMoney: true },
    { key: 'gatewayFees', header: 'GW Fees', isMoney: true },
    { key: 'expectedSettlement', header: 'Exp. Sett.', isMoney: true },
    { key: 'variance', header: 'Variance', isMoney: true },
  ],
  settlement: [
    { key: 'transactionReference', header: 'Tx Ref', isMonospace: true },
    { key: 'provider', header: 'Provider' },
    { key: 'paymentDate', header: 'Payment Date' },
    { key: 'paymentAmount', header: 'Payment', isMoney: true },
    { key: 'gatewayFee', header: 'GW Fee', isMoney: true },
    { key: 'expectedSettlement', header: 'Expected', isMoney: true },
    { key: 'settlementDate', header: 'Sett. Date' },
    { key: 'settlementRef', header: 'Sett. Ref', isMonospace: true },
    { key: 'actualSettlement', header: 'Actual', isMoney: true },
    { key: 'variance', header: 'Variance', isMoney: true },
    { key: 'reconciliationStatus', header: 'Recon Status' },
  ],
  refunds: [
    { key: 'refundDate', header: 'Date' },
    { key: 'studentName', header: 'Student' },
    { key: 'matricNumber', header: 'Matric', isMonospace: true },
    { key: 'originalTxRef', header: 'Orig Tx', isMonospace: true },
    { key: 'originalAmount', header: 'Orig Amt', isMoney: true },
    { key: 'refundAmount', header: 'Refund Amt', isMoney: true },
    { key: 'reason', header: 'Reason' },
    { key: 'provider', header: 'Provider' },
    { key: 'status', header: 'Status' },
  ],
  charges: [
    { key: 'period', header: 'Period' },
    { key: 'basePayment', header: 'Base Payment', isMoney: true },
    { key: 'convFee', header: 'Conv Fee', isMoney: true },
    { key: 'svcCharge', header: 'Svc Chg', isMoney: true },
    { key: 'gwFee', header: 'GW Fee', isMoney: true },
    { key: 'totalCharged', header: 'Total Chg', isMoney: true },
    { key: 'netRevenue', header: 'Net Rev', isMoney: true },
  ],
  gl: [
    { key: 'transactionDate', header: 'Date' },
    { key: 'entryType', header: 'Entry Type' },
    { key: 'account', header: 'Account' },
    { key: 'counterparty', header: 'Counterparty' },
    { key: 'description', header: 'Description' },
    { key: 'debit', header: 'Debit', isMoney: true },
    { key: 'credit', header: 'Credit', isMoney: true },
    { key: 'transactionId', header: 'Tx ID', isNum: true },
  ],
  receipts: [
    { key: 'receiptNumber', header: 'Receipt', isMonospace: true },
    { key: 'date', header: 'Date' },
    { key: 'studentName', header: 'Student' },
    { key: 'matricNumber', header: 'Matric', isMonospace: true },
    { key: 'billName', header: 'Bill' },
    { key: 'baseAmount', header: 'Base', isMoney: true },
    { key: 'charges', header: 'Charges', isMoney: true },
    { key: 'totalAmount', header: 'Total', isMoney: true },
    { key: 'provider', header: 'Provider' },
    { key: 'voidedFlag', header: 'Voided' },
    { key: 'duplicateFlag', header: 'Duplicate' },
    { key: 'exceptionReceiptNoPayment', header: 'No Pay Match' },
  ],
  status_mix: [
    { key: 'status', header: 'Status' },
    { key: 'count', header: 'Count', isNum: true },
    { key: 'amount', header: 'Amount', isMoney: true },
    { key: 'includedInRevenue', header: 'In Revenue?' },
    { key: 'sharePct', header: 'Share %', isNum: true },
  ],
  comparative: [
    { key: 'bucket', header: 'Bucket' },
    { key: 'period', header: 'Period' },
    { key: 'txCount', header: 'Tx', isNum: true },
    { key: 'uniquePayers', header: 'Payers', isNum: true },
    { key: 'gross', header: 'Gross', isMoney: true },
    { key: 'refunds', header: 'Refunds', isMoney: true },
    { key: 'net', header: 'Net', isMoney: true },
    { key: 'deltaNet', header: 'Δ Net', isMoney: true },
    { key: 'deltaNetPct', header: 'Δ %', isNum: true },
  ],
  audit_trail: [
    { key: 'createdAt', header: 'Timestamp' },
    { key: 'reportType', header: 'Report Key' },
    { key: 'reportName', header: 'Report Name' },
    { key: 'format', header: 'Format' },
    { key: 'generatedByName', header: 'Generated By' },
    { key: 'rowCount', header: 'Rows', isNum: true },
    { key: 'fileSizeBytes', header: 'Size', isNum: true },
    { key: 'status', header: 'Status' },
  ],
  fee_waivers: [
    { key: 'createdAt', header: 'Date' },
    { key: 'studentName', header: 'Student' },
    { key: 'matricNumber', header: 'Matric', isMonospace: true },
    { key: 'billName', header: 'Bill' },
    { key: 'amount', header: 'Amount', isMoney: true },
    { key: 'reason', header: 'Reason' },
    { key: 'approvedBy', header: 'Approved By' },
  ],
  journal_vouchers: [
    { key: 'voucherDate', header: 'Date' },
    { key: 'voucherNumber', header: 'Voucher #', isMonospace: true },
    { key: 'entryType', header: 'Entry Type' },
    { key: 'account', header: 'Account' },
    { key: 'debit', header: 'Debit', isMoney: true },
    { key: 'credit', header: 'Credit', isMoney: true },
    { key: 'createdBy', header: 'Posted By' },
  ],
  settlement_variance: [
    { key: 'transactionReference', header: 'Tx Ref', isMonospace: true },
    { key: 'provider', header: 'Provider' },
    { key: 'expectedSettlement', header: 'Expected', isMoney: true },
    { key: 'actualSettlement', header: 'Actual', isMoney: true },
    { key: 'variance', header: 'Variance', isMoney: true },
    { key: 'variancePct', header: 'Var %', isNum: true },
    { key: 'reconciliationStatus', header: 'Recon Status' },
  ],
};

const REPORTS: ReportsMap = {
  'daily-collections': {
    title: 'R2 Daily Collection Report',
    get: getDailyCollections, export: exportDailyCollections,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.daily,
  },
  'monthly-collections': {
    title: 'R3 Monthly Collection Report',
    get: getMonthlyCollections, export: exportMonthlyCollections,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.monthly,
  },
  'payment-register': {
    title: 'R5 Master Payment Register',
    get: getPaymentRegister, export: exportPaymentRegister,
    drilldownAccessor: (d) => d.rows ?? [], summaryAccessor: (d) => d.summary ?? null, columns: COLS.payment_register,
  },
  'revenue-by-bill': {
    title: 'R4 Revenue by Bill',
    get: getRevenueByBill, export: exportRevenueByBill,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.revenue_bill,
  },
  'bill-performance': {
    title: 'R7 Bill Collection Performance',
    get: getBillCollectionPerformance, export: exportBillCollectionPerformance,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.bill_perf,
  },
  'outstanding-debtors': {
    title: 'R8 Outstanding Debtors Report',
    get: getOutstandingDebtors, export: exportOutstandingDebtors,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.debtors,
    tabs: [
      { key: 'ALL', label: 'All Debtors' },
      { key: 'PARTIAL', label: 'Partial Payers', filter: { paymentStatus: 'PARTIAL' } },
      { key: 'NEVER', label: 'Never Paid', filter: { paymentStatus: 'UNPAID' } },
    ],
  },
  'hierarchical-revenue': {
    title: 'R9 Hierarchical College/Dept/Programme Revenue',
    get: getHierarchicalRevenue, export: exportHierarchicalRevenue,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.hierarchical,
  },
  'payment-gateway': {
    title: 'R10 Payment Gateway Report',
    get: getPaymentGatewayReport, export: exportPaymentGatewayReport,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.gateway,
  },
  'settlement': {
    title: 'R11 Settlement Report',
    get: getSettlementReport, export: exportSettlementReport,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.settlement,
  },
  'refunds': {
    title: 'R13 Refund Report',
    get: getRefundReport, export: exportRefundReport,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.refunds,
  },
  'charges-fee-income': {
    title: 'R14 Charges & Fee Income',
    get: getChargesFeeIncome, export: exportChargesFeeIncome,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.charges,
  },
  'general-ledger': {
    title: 'R15 General Ledger',
    get: getGeneralLedger, export: exportGeneralLedger,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.totalsByEntry ?? d.summary ?? null, columns: COLS.gl,
  },
  'receipt-register': {
    title: 'R16 Receipt Register',
    get: getReceiptRegister, export: exportReceiptRegister,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.receipts,
  },
  'transaction-status': {
    title: 'R17 Transaction Status Mix',
    get: getTransactionStatus, export: exportTransactionStatus,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.status_mix,
  },
  'comparative': {
    title: 'R18 Comparative Reports',
    get: (f) => getComparative(f), export: exportComparative,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.comparative,
  },
  'reports-audit-trail': {
    title: 'R21 Reports Audit Trail',
    get: getReportsAuditTrail, export: exportReportsAuditTrail,
    drilldownAccessor: (d) => d.rows ?? d, summaryAccessor: (d) => d.summary ?? null, columns: COLS.audit_trail,
  },
  'fee-waivers': {
    title: 'Fee Waivers & Write-offs Register',
    get: () => Promise.resolve({ rows: [], summary: null }),
    export: () => Promise.resolve(new Blob([])),
    drilldownAccessor: (d) => d.rows ?? [], summaryAccessor: () => null, columns: COLS.fee_waivers,
  },
  'journal-vouchers': {
    title: 'Journal Vouchers Register',
    get: () => Promise.resolve({ rows: [], summary: null }),
    export: () => Promise.resolve(new Blob([])),
    drilldownAccessor: (d) => d.rows ?? [], summaryAccessor: () => null, columns: COLS.journal_vouchers,
  },
  'settlement-variance': {
    title: 'Settlement Variance Deep-Dive',
    get: () => Promise.resolve({ rows: [], summary: null }),
    export: () => Promise.resolve(new Blob([])),
    drilldownAccessor: (d) => d.rows ?? [], summaryAccessor: () => null, columns: COLS.settlement_variance,
  },
};

type ToastKind = 'ok' | 'err' | 'info';
interface ToastState { kind: ToastKind; text: string; }

const GenericReportPage: React.FC<GenericReportPageProps> = ({ role, activePath }) => {
  const { reportKey } = useParams();
  const [sp, setSp] = useSearchParams();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const userPerms = (user?.permissions as string[] | undefined) ?? [];
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'xlsx' | 'pdf' | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [activeTab, setActiveTab] = useState<string>('ALL');

  useEffect(() => { navCounters().then(setNavCounts).catch(() => {}); }, []);

  const meta = reportKey ? REPORTS[reportKey] : undefined;
  const libMeta = useMemo(() => REPORT_LIBRARY.find(r => r.key === reportKey), [reportKey]);

  const facet = sp.get('facet');
  const facetLabel = facet ? (FACET_LABELS as any)[facet] ?? facet : null;

  const allowedSorts: string[] = useMemo(() => {
    if (!reportKey) return [];
    return TXN_ALLOWED_SORTS[reportKey] ?? [];
  }, [reportKey]);

  const sortKey: string | undefined = sp.get('sort') ?? undefined;
  const sortOrder: 'asc' | 'desc' = (sp.get('order') as any) ?? 'asc';

  const filters = useMemo(() => {
    let f: any = {};
    for (const [k, v] of sp.entries()) {
      if (['page', 'pageSize', 'sort', 'order', 'q', 'facet'].includes(k)) continue;
      if (v === '' || v === undefined) continue;
      (f as any)[k] = v;
    }
    if (facet) {
      f = applyFacetToFilters(facet, f);
    }
    const tabsDef = meta?.tabs;
    if (tabsDef && activeTab) {
      const t = tabsDef.find((x: any) => x.key === activeTab);
      if (t?.filter) Object.assign(f, t.filter);
    }
    return f;
  }, [sp, facet, meta, activeTab]);

  const pagination = useMemo(() => ({
    page: Number(sp.get('page') ?? 1),
    pageSize: Number(sp.get('pageSize') ?? 50),
  }), [sp]);

  useEffect(() => {
    if (!meta) return;
    let mounted = true;
    setLoading(true); setErr(null);
    const pg = { page: pagination.page, pageSize: pagination.pageSize };
    const srt: any = {};
    if (sortKey && allowedSorts.includes(sortKey)) {
      srt.sort = sortKey;
      srt.order = sortOrder;
    }
    meta.get({ ...filters, ...pg, ...srt }).then((d) => { if (mounted) setData(d); })
      .catch((e) => { if (mounted) setErr(String(e?.message ?? e).slice(0, 250)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [reportKey, filters, pagination.page, pagination.pageSize, sortKey, sortOrder, allowedSorts.length ? allowedSorts.join(',') : '']);

  const permMissing = libMeta?.viewPermission && !hasPermission(libMeta.viewPermission, userPerms, role);

  const brand = role === 'BURSARY' ? i18n.portals.bursary.dashboardBrand : i18n.portals.admin.dashboardBrand;
  const userText = role === 'BURSARY'
    ? `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()
    : i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin');

  const fireToast = (kind: ToastKind, text: string, ms = 4500) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), ms);
  };

  const clearFacet = () => {
    const x = new URLSearchParams(sp);
    x.delete('facet');
    setSp(x);
  };

  const runExport = async (format: 'xlsx' | 'pdf') => {
    if (!meta) return;
    const perm = format === 'xlsx' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF';
    if (!hasPermission(perm, userPerms, role)) {
      fireToast('err', `Missing permission ${perm}`);
      return;
    }
    try {
      setExporting(format);
      const result = await meta.export(filters, format);
      if (result && typeof result === 'object' && 'queued' in (result as any)) {
        const r: any = result;
        const jobId = r.jobId ? ` JobId: ${r.jobId}` : '';
        fireToast('ok', `Queued! You will receive an email when ready.${jobId}`, 6500);
      } else if (result instanceof Blob) {
        downloadBlob(result, `${reportKey}_${Date.now()}.${format === 'xlsx' ? 'xlsx' : 'pdf'}`);
        fireToast('info', `Downloaded ${format.toUpperCase()} report.`);
      }
    } catch (e: any) {
      fireToast('err', 'Export failed: ' + String(e?.message ?? e).slice(0, 150));
    } finally {
      setExporting(null);
    }
  };

  const cycleSort = (colKey: string) => {
    if (!allowedSorts.includes(colKey)) return;
    const x = new URLSearchParams(sp);
    if (!sortKey || sortKey !== colKey) {
      x.set('sort', colKey);
      x.set('order', 'asc');
    } else if (sortKey === colKey && sortOrder === 'asc') {
      x.set('sort', colKey);
      x.set('order', 'desc');
    } else {
      x.delete('sort');
      x.delete('order');
    }
    x.set('page', '1');
    setSp(x);
  };

  const goPage = (delta: number) => {
    const x = new URLSearchParams(sp);
    x.set('page', String(Math.max(1, pagination.page + delta)));
    setSp(x);
  };

  const rows = meta ? meta.drilldownAccessor(data ?? {}) : [];
  const summary = meta ? meta.summaryAccessor?.(data ?? {}) : null;
  const total = data?.total;

  const canXlsx = hasPermission('REPORTS_EXPORT_EXCEL', userPerms, role);
  const canPdf = hasPermission('REPORTS_EXPORT_PDF', userPerms, role);

  const SortIcon: React.FC<{ col: string }> = ({ col }) => {
    if (!allowedSorts.includes(col)) return null;
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 inline ml-1 opacity-40" />;
    return sortOrder === 'asc'
      ? <ArrowUp className="h-3 w-3 inline ml-1 text-amber-700" />
      : <ArrowDown className="h-3 w-3 inline ml-1 text-amber-700" />;
  };

  const content = (
    <div className="px-6 py-6 md:px-8 lg:px-10">
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] inline-flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg max-w-md ${
          toast.kind === 'ok' ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
          : toast.kind === 'err' ? 'bg-red-50 text-red-800 border-red-200'
          : 'bg-sky-50 text-sky-800 border-sky-200'
        }`}>
          {toast.kind === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
          <span className="font-medium">{toast.text}</span>
          <button type="button" onClick={() => setToast(null)} className="ml-1 opacity-60 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <button type="button" onClick={() => navigate('/bursary/reports/centre')} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 mb-2">
            <ArrowLeft className="h-3 w-3" /> Back to Reports Centre
          </button>
          <div className="text-xs text-amber-700 font-semibold tracking-widest mb-1">{libMeta?.group?.toUpperCase() ?? 'REPORT'}</div>
          <h1 className="text-2xl font-extrabold text-gray-900">{meta?.title ?? `Report: ${reportKey ?? ''}`}</h1>
          <p className="text-sm text-gray-500 mt-1">{libMeta?.subtitle ?? ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => runExport('xlsx')}
            disabled={!!exporting || !canXlsx}
            title={canXlsx ? 'Download Excel' : 'Missing REPORTS_EXPORT_EXCEL permission'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exporting === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            Download Excel
          </button>
          <button
            type="button"
            onClick={() => runExport('pdf')}
            disabled={!!exporting || !canPdf}
            title={canPdf ? 'Download PDF' : 'Missing REPORTS_EXPORT_PDF permission'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-rose-700 hover:bg-rose-800 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exporting === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            Download PDF
          </button>
        </div>
      </div>

      {facetLabel && (
        <div className="mb-5 rounded-2xl border border-sky-200 bg-gradient-to-r from-sky-50 to-white p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center gap-3 text-sm">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-sky-100 text-sky-700 shrink-0">
              <Filter className="h-4 w-4" />
            </span>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-sky-600 font-bold">Facet Filter Applied</div>
              <div className="font-semibold text-sky-900">Filter applied: {facetLabel}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={clearFacet}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        </div>
      )}

      {meta?.tabs && meta.tabs.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {meta.tabs.map((t: any) => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                  active ? 'bg-amber-600 text-white border-amber-600 shadow-sm' : 'bg-white text-gray-700 border-gray-300 hover:border-amber-400'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 mb-5 text-xs flex flex-wrap items-center gap-2">
        <Filter className="h-4 w-4 text-gray-500 shrink-0 mr-2" />
        <span className="text-gray-500 font-semibold tracking-wide">ACTIVE FILTERS:</span>
        {Object.entries(filters).length === 0 && !facet && <span className="text-gray-400">None (all records)</span>}
        {facet && (
          <span className="inline-flex items-center gap-1 px-2 py-1 bg-sky-100 text-sky-800 rounded-full font-mono">
            facet=<span className="max-w-[200px] truncate">{facet}</span>
          </span>
        )}
        {Object.entries(filters).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-full font-mono">
            {k}=<span className="text-gray-800 max-w-[240px] truncate">{Array.isArray(v) ? `[${v.join(',')}]` : String(v)}</span>
          </span>
        ))}
      </div>

      {permMissing ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          <AlertTriangle className="h-5 w-5 mb-2" />
          You do not have the required permission: <code className="bg-white px-1.5 py-0.5 rounded">{libMeta?.viewPermission}</code>.
        </div>
      ) : !meta ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-sm text-gray-600">
          Unknown report key: <code>{reportKey ?? ''}</code>. <a href="/bursary/reports/centre" className="text-amber-700 underline">Return to Reports Centre</a>
        </div>
      ) : (
        <>
          {summary && Object.keys(summary).length > 0 && (
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm mb-5 p-5">
              <div className="text-xs font-bold tracking-wider text-gray-500 mb-3">SUMMARY</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {Object.entries(summary).slice(0, 24).map(([k, v]) => {
                  const isMoney = /(amount|fee|charge|balance|collected|refund|net|gross|settlement|variance|billed|paid|outstanding)/i.test(k);
                  return (
                    <div key={k} className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-3 overflow-hidden">
                      <div className="text-[10px] uppercase tracking-wider font-semibold text-gray-500 truncate" title={k}>{k}</div>
                      <div className={`text-sm font-bold mt-1 ${isMoney ? 'text-gray-900 font-mono' : 'text-gray-800'}`}>
                        {isMoney ? fmtNGN(v) : (typeof v === 'number' ? Number.isInteger(v) ? v : Number(v).toFixed(2) : String(v ?? '—'))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
              <div className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                <span className="text-gray-400 mr-1">Detailed</span>
                <span className="inline-flex items-center rounded-full bg-gray-100 text-gray-700 px-2 py-0.5 text-xs font-mono">
                  {Array.isArray(rows) ? rows.length.toLocaleString() : 0} rows
                </span>
                {loading && <span className="inline-flex items-center gap-1 text-xs text-gray-500"><Loader2 className="h-3 w-3 animate-spin" />Loading…</span>}
              </div>
            </div>
            {err ? (
              <div className="p-5 text-sm text-red-700 font-mono">{err}</div>
            ) : !Array.isArray(rows) || rows.length === 0 ? (
              <div className="p-10 text-center text-gray-500 text-sm">
                <ChevronDown className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                No rows match the current filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      {meta.columns.map((c: any) => {
                        const canSort = allowedSorts.includes(c.key);
                        return (
                          <th
                            key={c.key}
                            onClick={() => cycleSort(c.key)}
                            className={`px-3 py-2 font-semibold text-gray-700 text-left border-b border-gray-200 whitespace-nowrap ${canSort ? 'cursor-pointer hover:bg-gray-100 select-none' : ''}`}
                            title={canSort ? `Click to sort by ${c.header}` : c.header}
                          >
                            {c.header}
                            <SortIcon col={c.key} />
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 500).map((row: any, i: number) => (
                      <tr key={i} className="border-b border-gray-50 hover:bg-amber-50/40">
                        {meta.columns.map((c: any) => {
                          const raw = row?.[c.key];
                          let display: any = raw ?? '';
                          if (c.isMoney) display = fmtNGN(raw);
                          else if (c.isNum && typeof raw === 'number' && !Number.isInteger(raw)) display = Number(raw).toFixed(2);
                          else if (raw instanceof Date) display = raw.toISOString().slice(0, 10);
                          const href = c.href?.(row);
                          return (
                            <td key={c.key} className={`px-3 py-1.5 border-b border-gray-50 whitespace-nowrap ${c.isMonospace ? 'font-mono' : ''} ${c.isMoney || c.isNum ? 'text-right tabular-nums' : ''}`}>
                              {href ? (
                                <a href={href} className="text-amber-700 hover:underline inline-flex items-center gap-0.5">
                                  {display} <ChevronRight className="h-3 w-3 opacity-60" />
                                </a>
                              ) : display}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {rows.length > 500 && (
                      <tr><td colSpan={meta.columns.length} className="px-3 py-2 text-center text-gray-500">
                        Only first 500 rows shown inline. Export Excel/PDF for the full dataset of {rows.length.toLocaleString()} rows.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {pagination.page && pagination.pageSize && (total || data?.page) && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 text-xs text-gray-600 font-medium">
                <span>
                  Page {pagination.page} • {pagination.pageSize} / page
                  {total != null ? ` • ${Number(total).toLocaleString()} total` : ''}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                    disabled={pagination.page <= 1}
                    onClick={() => goPage(-1)}
                  >
                    <ChevronLeft className="h-3 w-3" />
                  </button>
                  <span className="px-2 font-mono tabular-nums">{pagination.page}</span>
                  <button
                    className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                    disabled={total != null ? pagination.page * pagination.pageSize >= Number(total) : !data?.hasMore}
                    onClick={() => goPage(+1)}
                  >
                    <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <PortalShell
      role={role}
      activePath={activePath}
      brand={brand}
      userText={userText}
      userEmail={user?.email}
      onLogout={logout}
      userPermissions={userPerms}
      navCounters={navCounts}
      showGlobalSearch
    >
      {content}
    </PortalShell>
  );
};

export default GenericReportPage;
