import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { i18n } from '../../i18n/en';
import { downloadBlob } from '../../services/api';
import {
  getReconciliationItems,
  buildReportCsvUrl,
  type ReconciliationSummary,
  type ReconciliationItem,
  type ReconciliationPagination,
  type Classification,
  type ChargeSource,
} from '../../services/reconciliationApi';
import {
  RefreshCw, Download, Filter as FilterIcon,
  ChevronLeft, ChevronRight, Loader2, AlertTriangle,
  CheckCircle2, XCircle, Clock, HelpCircle,
  Database, Building2, CreditCard, Link2Off, Copy, RotateCcw, FileQuestion, FileText,
} from 'lucide-react';

type Role = 'BURSARY' | 'ADMIN';

const PAGE_SIZES = [25, 50, 100, 200];

const CLASSIFICATION_LABELS: Record<Classification, string> = {
  MATCHED: 'Matched',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  MISSING_INTERNAL: 'Missing Internal Record',
  MISSING_GATEWAY: 'Missing Gateway Record',
  DUPLICATE_REFERENCE: 'Duplicate Reference',
  REVERSED_TXN: 'Reversed Transaction',
  MISSING_RECEIPT: 'Missing Receipt',
  PENDING_ATTEMPT: 'Pending Attempt',
  FAILED_ATTEMPT: 'Failed Attempt',
  UNABLE_TO_VERIFY: 'Unable to Verify',
};

const CLASSIFICATION_OPTIONS: Classification[] = [
  'MATCHED',
  'AMOUNT_MISMATCH',
  'MISSING_INTERNAL',
  'MISSING_GATEWAY',
  'DUPLICATE_REFERENCE',
  'REVERSED_TXN',
  'MISSING_RECEIPT',
  'PENDING_ATTEMPT',
  'FAILED_ATTEMPT',
  'UNABLE_TO_VERIFY',
];

function classificationBadge(c: Classification): { cls: string; icon: React.ElementType } {
  switch (c) {
    case 'MATCHED':
      return { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 };
    case 'AMOUNT_MISMATCH':
      return { cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: AlertTriangle };
    case 'MISSING_INTERNAL':
      return { cls: 'bg-rose-50 text-rose-700 border-rose-200', icon: Link2Off };
    case 'MISSING_GATEWAY':
      return { cls: 'bg-orange-50 text-orange-700 border-orange-200', icon: Database };
    case 'DUPLICATE_REFERENCE':
      return { cls: 'bg-purple-50 text-purple-700 border-purple-200', icon: Copy };
    case 'REVERSED_TXN':
      return { cls: 'bg-slate-100 text-slate-700 border-slate-300', icon: RotateCcw };
    case 'MISSING_RECEIPT':
      return { cls: 'bg-sky-50 text-sky-700 border-sky-200', icon: FileQuestion };
    case 'PENDING_ATTEMPT':
      return { cls: 'bg-blue-50 text-blue-700 border-blue-200', icon: Clock };
    case 'FAILED_ATTEMPT':
      return { cls: 'bg-red-50 text-red-700 border-red-200', icon: XCircle };
    case 'UNABLE_TO_VERIFY':
      return { cls: 'bg-gray-100 text-gray-700 border-gray-300', icon: HelpCircle };
    default:
      return { cls: 'bg-gray-50 text-gray-700 border-gray-200', icon: AlertTriangle };
  }
}

const fmtNgn = (n: number | null | undefined): string => {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n));
};

const fmtDate = (d?: string | null): string => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const toISODate = (d: Date): string => d.toISOString().slice(0, 10);

interface ReconciliationDashboardPageProps {
  role: Role;
  brand: string;
  userText: string;
  onLogout: () => void;
  dashboardTo: string;
}

const ReconciliationDashboardPage: React.FC<ReconciliationDashboardPageProps> = ({
  role, brand, userText, onLogout,
}) => {
  const { user } = useAuth();
  const userPerms = (user?.permissions as string[] | undefined) ?? [];
  // Flag-aware: only a PROTECTED SUPER ADMIN bypasses; a NORMAL ADMIN is
  // governed by its effective permissions exactly like BURSARY.
  const isSuperAdmin = user?.role === 'ADMIN' && (user as any)?.isSuperAdmin === true;
  const canView = isSuperAdmin || userPerms.includes('VIEW_RECONCILIATION');
  const canExport = isSuperAdmin || userPerms.includes('VIEW_RECONCILIATION_REPORTS');

  const today = useMemo(() => new Date(), []);
  const firstOfMonth = useMemo(() => new Date(today.getFullYear(), today.getMonth(), 1), [today]);

  const [dateFrom, setDateFrom] = useState<string>(toISODate(firstOfMonth));
  const [dateTo, setDateTo] = useState<string>(toISODate(today));
  const [gateway, setGateway] = useState<'' | 'PAYSTACK' | 'ALATPAY'>('');
  const [chargeSource, setChargeSource] = useState<ChargeSource>('ALL');
  const [classification, setClassification] = useState<'' | Classification>('');
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState<number>(1);

  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [summary, setSummary] = useState<ReconciliationSummary | null>(null);
  const [items, setItems] = useState<ReconciliationItem[]>([]);
  const [pagination, setPagination] = useState<ReconciliationPagination | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emptyState, setEmptyState] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const dateValid = dateFrom && dateTo && dateFrom <= dateTo;

  const itemsFilters = useMemo(() => ({
    dateFrom,
    dateTo,
    page,
    limit: pageSize,
    classification: classification || undefined,
    gateway: gateway || undefined,
    chargeSource,
  }), [dateFrom, dateTo, page, pageSize, classification, gateway, chargeSource]);

  // Single reconciliation request lifecycle.
  // /items already returns { items, pagination, filters, summary }, so the
  // summary cards and the table are populated from the SAME response — one
  // gateway comparison per refresh. Do not fire a separate /summary request.
  const loadReconciliation = useCallback(async () => {
    if (!canView) return;
    if (!dateValid) return;
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    setEmptyState(false);
    try {
      const resp = await getReconciliationItems(itemsFilters, ac.signal);
      if (ac.signal.aborted) return;
      setItems(resp.items ?? []);
      setPagination(resp.pagination ?? null);
      setSummary(resp.summary ?? null);
      setEmptyState((resp.items?.length ?? 0) === 0);
    } catch (e: unknown) {
      const err = e as { code?: string; name?: string; payload?: { error?: string }; message?: string };
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      const msg = err?.payload?.error || err?.message || 'Failed to load reconciliation records.';
      setError(msg);
      setItems([]);
      setPagination(null);
      setSummary(null);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [itemsFilters, dateValid, canView]);

  const refresh = useCallback(() => {
    loadReconciliation();
  }, [loadReconciliation]);

  // Load on mount and when filters change. Only fire if the user has
  // VIEW_RECONCILIATION (backend remains authoritative regardless).
  useEffect(() => {
    if (canView && dateValid) {
      loadReconciliation();
    }
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, gateway, chargeSource, classification, pageSize, page, canView]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [dateFrom, dateTo, gateway, chargeSource, classification, pageSize]);

  const handleExportCsv = async () => {
    if (!canExport) return;
    setExporting(true);
    try {
      const url = buildReportCsvUrl(itemsFilters);
      await downloadBlob(url, `reconciliation-${dateFrom}_to_${dateTo}.csv`);
    } catch (e: unknown) {
      const err = e as { payload?: { error?: string }; message?: string };
      const msg = err?.payload?.error || err?.message || 'Export failed.';
      setError(msg);
    } finally {
      setExporting(false);
    }
  };

  const summaryCards: { label: string; value: number; icon: React.ElementType; cls: string }[] = summary
    ? [
        { label: 'System Records', value: summary.systemRecords, icon: Database, cls: 'text-slate-700' },
        { label: 'Gateway Records', value: summary.gatewayRecords, icon: Building2, cls: 'text-blue-700' },
        { label: 'Matched', value: summary.matched, icon: CheckCircle2, cls: 'text-emerald-600' },
        { label: 'Amount Mismatch', value: summary.amountMismatch, icon: AlertTriangle, cls: 'text-amber-600' },
        { label: 'Missing Internal', value: summary.missingInternal, icon: Link2Off, cls: 'text-rose-600' },
        { label: 'Missing Gateway', value: summary.missingGateway, icon: Database, cls: 'text-orange-600' },
        { label: 'Missing Receipt', value: summary.missingReceipt, icon: FileQuestion, cls: 'text-sky-600' },
        { label: 'Reversed', value: summary.reversedTxn, icon: RotateCcw, cls: 'text-slate-500' },
        { label: 'Duplicate Refs', value: summary.duplicateReference, icon: Copy, cls: 'text-purple-600' },
        { label: 'Pending Attempts', value: summary.pendingAttempts, icon: Clock, cls: 'text-blue-600' },
        { label: 'Failed Attempts', value: summary.failedAttempts, icon: XCircle, cls: 'text-red-600' },
        { label: 'Unable to Verify', value: summary.unableToVerify, icon: HelpCircle, cls: 'text-gray-600' },
      ]
    : [];

  return (
    <PortalShell
      role={role}
      activePath="/bursary/reconciliation"
      brand={brand}
      userText={userText}
      userEmail={user?.email ?? undefined}
      onLogout={onLogout}
      userPermissions={userPerms}
    >
      <div className="p-6 max-w-[1600px] mx-auto space-y-6">
        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Reconciliation</h1>
            <p className="text-sm text-slate-500 mt-1">
              Compare internal payment records with payment gateway records.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {canExport && (
              <button
                onClick={handleExportCsv}
                disabled={exporting || loading || !dateValid}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-md border border-emerald-700"
                title="Download reconciliation report as CSV"
              >
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Export CSV
              </button>
            )}
            <button
              onClick={refresh}
              disabled={loading || !dateValid}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50 rounded-md border border-slate-300"
              title="Refresh reconciliation data"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Date range + filters */}
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <FilterIcon className="w-4 h-4" />
            Filters
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Date From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Date To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Gateway</label>
              <select
                value={gateway}
                onChange={(e) => setGateway(e.target.value as '' | 'PAYSTACK' | 'ALATPAY')}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white"
              >
                <option value="">All</option>
                <option value="PAYSTACK">Paystack</option>
                <option value="ALATPAY">ALATPay</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Charge Source</label>
              <select
                value={chargeSource}
                onChange={(e) => setChargeSource(e.target.value as ChargeSource)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white"
              >
                <option value="ALL">All</option>
                <option value="CATALOGUE">Catalogue</option>
                <option value="DIRECT_BILL">Direct Bill</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Classification</label>
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value as '' | Classification)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white"
              >
                <option value="">All</option>
                {CLASSIFICATION_OPTIONS.map((c) => (
                  <option key={c} value={c}>{CLASSIFICATION_LABELS[c]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Page Size</label>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white"
              >
                {PAGE_SIZES.map((s) => (
                  <option key={s} value={s}>{s} per page</option>
                ))}
              </select>
            </div>
          </div>
          {!dateValid && (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              <AlertTriangle className="inline w-4 h-4 mr-1 align-text-bottom" />
              Date From must be on or before Date To.
            </div>
          )}
        </div>

        {/* Permission / error states */}
        {!canView && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-6 text-center">
            <XCircle className="w-8 h-8 text-rose-500 mx-auto mb-2" />
            <p className="text-sm text-rose-800 font-medium">Access denied</p>
            <p className="text-xs text-rose-600 mt-1">
              You do not have the VIEW_RECONCILIATION permission.
            </p>
          </div>
        )}

        {canView && error && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-6 flex items-start gap-3">
            <XCircle className="w-5 h-5 text-rose-500 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-rose-800">Failed to load reconciliation data</p>
              <p className="text-xs text-rose-600 mt-1">{error}</p>
            </div>
            <button
              onClick={refresh}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-rose-700 bg-white border border-rose-300 rounded-md hover:bg-rose-100"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          </div>
        )}

        {/* Provider availability warning */}
        {canView && summary && summary.incompleteCoverage && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-800">
                  Incomplete gateway coverage — reconciliation totals are not fully reconciled
                </p>
                <ul className="mt-1 text-xs text-amber-700 space-y-0.5">
                  {summary.providerAvailability.paystack === 'UNAVAILABLE' && (
                    <li>
                      Paystack transaction listing is unavailable. Some Paystack payments
                      could not be independently reconciled.
                    </li>
                  )}
                  {summary.providerAvailability.paystack === 'PARTIALLY_AVAILABLE' && (
                    <li>
                      Paystack transaction listing is unavailable; individual transaction
                      lookups are available. Gateway-only Paystack transactions cannot be
                      discovered.
                    </li>
                  )}
                  {summary.providerAvailability.alatpay === 'UNAVAILABLE' && (
                    <li>
                      ALATPay transaction listing is unavailable. Some ALATPay payments
                      could not be independently reconciled.
                    </li>
                  )}
                  {summary.providerAvailability.alatpay === 'PARTIALLY_AVAILABLE' && (
                    <li>
                      ALATPay transaction listing is unavailable; individual transaction
                      lookups are available. Gateway-only ALATPay transactions cannot be
                      discovered.
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Summary cards */}
        {canView && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {summaryCards.map((card) => (
              <div key={card.label} className="bg-white rounded-lg border border-slate-200 shadow-sm p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                    {card.label}
                  </span>
                  <card.icon className={`w-4 h-4 ${card.cls}`} />
                </div>
                <div className="text-xl font-bold text-slate-900 mt-1">
                  {loading ? '—' : card.value.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Table */}
        {canView && (
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Date</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Gateway</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Gateway Ref</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Internal Ref</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Student</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Charge Source</th>
                    <th className="px-3 py-3 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Bells Amount</th>
                    <th className="px-3 py-3 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Provider Gross</th>
                    <th className="px-3 py-3 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Provider Fee</th>
                    <th className="px-3 py-3 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Provider Effective</th>
                    <th className="px-3 py-3 text-right text-xs font-semibold text-slate-600 uppercase tracking-wider">Variance</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Classification</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {loading && (
                    <tr>
                      <td colSpan={12} className="px-3 py-12 text-center text-slate-500">
                        <Loader2 className="w-5 h-5 animate-spin inline mr-2 align-text-bottom" />
                        Loading reconciliation records…
                      </td>
                    </tr>
                  )}
                  {!loading && emptyState && (
                    <tr>
                      <td colSpan={12} className="px-3 py-12 text-center text-slate-500">
                        <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                        No reconciliation records found for the selected period.
                      </td>
                    </tr>
                  )}
                  {!loading && !emptyState && items.map((it, idx) => {
                    const badge = classificationBadge(it.classification);
                    // Variance and provider figures are calculated by the backend
                    // (single authoritative source shared with the CSV export).
                    const variance = it.variance;
                    const varianceCls =
                      variance == null ? 'text-slate-400' : variance === 0 ? 'text-slate-600' : variance < 0 ? 'text-rose-600' : 'text-emerald-600';
                    return (
                      <tr key={`${it.gatewayReference ?? ''}-${it.paymentReference ?? ''}-${idx}`} className="hover:bg-slate-50">
                        <td className="px-3 py-2.5 whitespace-nowrap text-slate-700">{fmtDate(it.date)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${
                            it.gateway === 'PAYSTACK'
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : 'bg-amber-50 text-amber-700 border-amber-200'
                          }`}>
                            <CreditCard className="w-3 h-3" />
                            {it.gateway}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-slate-600">
                          {it.gatewayReference ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-slate-600">
                          {it.paymentReference ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-slate-700">
                          {it.studentName ?? (it.studentId != null ? `#${it.studentId}` : '—')}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-xs text-slate-600">
                          {it.chargeSource === 'DIRECT_BILL' ? 'Direct Bill' : it.chargeSource === 'CATALOGUE' ? 'Catalogue' : '—'}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right text-slate-700">{fmtNgn(it.bellsAmount)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right text-slate-700">{fmtNgn(it.providerGross)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right text-slate-700">
                          {it.providerFee == null ? 'unavailable' : fmtNgn(it.providerFee)}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right text-slate-700">{fmtNgn(it.providerEffective)}</td>
                        <td className={`px-3 py-2.5 whitespace-nowrap text-right font-medium ${varianceCls}`}>
                          {variance == null ? '—' : variance === 0 ? '0.00' : (variance > 0 ? '+' : '') + fmtNgn(variance)}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${badge.cls}`}>
                            <badge.icon className="w-3 h-3" />
                            {CLASSIFICATION_LABELS[it.classification]}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pagination && pagination.total > 0 && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-slate-200 bg-slate-50">
                <div className="text-xs text-slate-600">
                  Showing page {pagination.page} of {pagination.totalPages} · {pagination.total} record{pagination.total !== 1 ? 's' : ''}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={pagination.page <= 1 || loading}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-100 disabled:opacity-40"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> Previous
                  </button>
                  <span className="text-xs text-slate-600 px-2">
                    {pagination.page} / {pagination.totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                    disabled={pagination.page >= pagination.totalPages || loading}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-100 disabled:opacity-40"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </PortalShell>
  );
};

const ReconciliationDashboardBase: React.FC<{ role: Role }> = ({ role }) => {
  const { user, logout } = useAuth();
  const dashboardTo = role === 'ADMIN' ? '/admin/dashboard' : '/bursary/dashboard';
  const brand = role === 'ADMIN' ? i18n.portals.admin.dashboardBrand : i18n.portals.bursary.dashboardBrand;
  const userText = role === 'ADMIN'
    ? i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin')
    : `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
  return (
    <ReconciliationDashboardPage
      role={role}
      brand={brand}
      userText={userText}
      onLogout={logout}
      dashboardTo={dashboardTo}
    />
  );
};

export const BursaryReconciliationDashboard = () => <ReconciliationDashboardBase role="BURSARY" />;
export const AdminReconciliationDashboard = () => <ReconciliationDashboardBase role="ADMIN" />;
export default ReconciliationDashboardPage;
