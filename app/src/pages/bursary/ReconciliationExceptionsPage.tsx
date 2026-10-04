import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { navCounters, NavCounters } from '../../services/api';
import { i18n } from '../../i18n/en';
import {
  AlertTriangle, AlertOctagon, ShieldAlert, FileSpreadsheet, FileText,
  Loader2, ArrowLeft, ChevronDown, ChevronRight, ExternalLink, Calendar, Filter,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  getReconciliationExceptions,
  exportReconciliationExceptions,
  downloadBlob,
  applyDatePreset,
  type ReportsBaseFilters,
} from '../../services/reportsApi';
import TxnDetailsDrawer from '../../components/TxnDetailsDrawer';

type Role = 'BURSARY' | 'ADMIN';
type Preset = 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'LAST_MONTH' | 'THIS_SESSION' | 'CUSTOM';

export interface ExceptionsPageProps { role: Role; activePath: string; }

const hasPerm = (p: string, perms?: string[], role?: Role) => {
  if (role === 'ADMIN') return true;
  return perms?.includes(p) ?? false;
};

const fmtNGN = (v: any) => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: 'TODAY', label: 'Today' },
  { key: 'YESTERDAY', label: 'Yesterday' },
  { key: 'THIS_WEEK', label: 'This Week' },
  { key: 'THIS_MONTH', label: 'This Month' },
  { key: 'LAST_MONTH', label: 'Last Month' },
  { key: 'THIS_SESSION', label: 'This Session' },
  { key: 'CUSTOM', label: 'Custom' },
];

const EXCEPTION_KINDS: Array<{
  kind: string;
  defaultLabel: string;
  facet: string;
  descriptionHint: string;
}> = [
  { kind: 'SUCCESS_NO_RECEIPT', defaultLabel: 'Successful tx without receipt', facet: 'BY_SUCCESS_NO_RECEIPT', descriptionHint: 'Payment succeeded at provider but no receipt was minted locally.' },
  { kind: 'RECEIPT_NO_PAYMENT', defaultLabel: 'Receipt without matching payment', facet: 'BY_RECEIPT_NO_PAYMENT', descriptionHint: 'Receipt exists locally but no corresponding SUCCESS payment tx found.' },
  { kind: 'DUPLICATE_PAYMENT_REF', defaultLabel: 'Duplicate payment reference', facet: 'BY_DUPLICATE_PAYMENT_REF', descriptionHint: 'Same provider reference linked to multiple local transactions.' },
  { kind: 'DUPLICATE_RECEIPT', defaultLabel: 'Duplicate receipt number', facet: 'BY_DUPLICATE_RECEIPT', descriptionHint: 'Receipt number collision — same number on multiple receipts.' },
  { kind: 'PROVIDER_MISSING_LOCALLY', defaultLabel: 'Provider tx missing locally', facet: 'BY_PROVIDER_MISSING_LOCALLY', descriptionHint: 'Webhook/provider list reports a transaction not present in local DB.' },
  { kind: 'LOCAL_MISSING_AT_PROVIDER', defaultLabel: 'Local tx missing at provider', facet: 'BY_LOCAL_MISSING_AT_PROVIDER', descriptionHint: 'Local SUCCESS tx not reflected on provider settlement/verification.' },
  { kind: 'SETTLEMENT_MISMATCH', defaultLabel: 'Settlement amount mismatch', facet: 'BY_SETTLEMENT_MISMATCH', descriptionHint: 'Provider settled amount differs from expected net settlement.' },
  { kind: 'UNEXPECTED_GATEWAY_CHARGE', defaultLabel: 'Unexpected gateway charge', facet: 'BY_UNEXPECTED_GATEWAY_CHARGE', descriptionHint: 'Gateway fee deducted but not matched to any configured charge schedule.' },
  { kind: 'REFUND_UNRECONCILED', defaultLabel: 'Refund unreconciled', facet: 'BY_REFUND_UNRECONCILED', descriptionHint: 'Refund processed offline/provider but GL/receipt state not updated.' },
  { kind: 'AWAITING_SETTLEMENT', defaultLabel: 'Awaiting settlement overdue', facet: 'BY_AWAITING_SETTLEMENT', descriptionHint: 'Successful payment older than SLA window but not yet settled by provider.' },
  { kind: 'GL_IMBALANCE', defaultLabel: 'General Ledger imbalance', facet: 'BY_GL_IMBALANCE', descriptionHint: 'Double-entry GL row has debit ≠ credit for the same transactionId.' },
];

const ExceptionsPage: React.FC<ExceptionsPageProps> = ({ role, activePath }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const userPerms = (user?.permissions as string[] | undefined) ?? [];
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{
    totalCount?: number;
    categories?: Array<{
      kind: string;
      label?: string;
      description?: string;
      count?: number;
      rows?: any[];
    }>;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'xlsx' | 'pdf' | null>(null);

  const [kindFilter, setKindFilter] = useState<string>('ALL');
  const [preset, setPreset] = useState<Preset>('THIS_MONTH');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [expandedKinds, setExpandedKinds] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTx, setDrawerTx] = useState<any>(null);

  useEffect(() => { navCounters().then(setNavCounts).catch(() => {}); }, []);

  const dateFilters = useMemo<{ dateFrom?: string; dateTo?: string }>(() => {
    const r = applyDatePreset(
      preset,
      customFrom ? new Date(customFrom) : undefined,
      customTo ? new Date(customTo) : undefined,
    );
    return {
      dateFrom: r.dateFrom ? new Date(r.dateFrom).toISOString().slice(0, 10) : undefined,
      dateTo: r.dateTo ? new Date(r.dateTo).toISOString().slice(0, 10) : undefined,
    };
  }, [preset, customFrom, customTo]);

  const fetchExceptions = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const params: ReportsBaseFilters & { kind?: string } = { ...dateFilters };
    if (kindFilter !== 'ALL') params.kind = kindFilter;
    try {
      const d = await getReconciliationExceptions(params);
      setData(d ?? null);
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 250));
    } finally {
      setLoading(false);
    }
  }, [kindFilter, dateFilters]);

  useEffect(() => { fetchExceptions(); }, [fetchExceptions]);

  const totalCount = useMemo(() => {
    if (data?.totalCount != null) return Number(data.totalCount);
    return (data?.categories ?? []).reduce((s: number, g: any) => s + Number(g.count ?? 0), 0);
  }, [data]);

  const categories = useMemo(() => {
    const raw = data?.categories ?? [];
    if (kindFilter === 'ALL') return raw;
    return raw.filter((g: any) => g.kind === kindFilter);
  }, [data, kindFilter]);

  const toggleKind = (kind: string) => {
    setExpandedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const deepLinkFacet = (kind: string) => {
    const spec = EXCEPTION_KINDS.find((e) => e.kind === kind);
    const facet = spec?.facet ?? `BY_${kind}`;
    return `/bursary/reports/view/payment-register?facet=${encodeURIComponent(facet)}`;
  };

  const openTxDrawer = (row: any) => {
    setDrawerTx(row);
    setDrawerOpen(true);
  };

  const brand = role === 'BURSARY' ? i18n.portals.bursary.dashboardBrand : i18n.portals.admin.dashboardBrand;
  const userText = role === 'BURSARY'
    ? `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()
    : i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin');

  const runExport = async (fmt: 'xlsx' | 'pdf') => {
    if (!hasPerm(fmt === 'xlsx' ? 'REPORTS_EXPORT_EXCEL' : 'REPORTS_EXPORT_PDF', userPerms, role)) return;
    try {
      setExporting(fmt);
      const body: any = { ...dateFilters };
      if (kindFilter !== 'ALL') body.kind = kindFilter;
      const result = await exportReconciliationExceptions(body, fmt);
      if (result instanceof Blob) {
        downloadBlob(result, `RECONCILIATION_EXCEPTIONS_${Date.now()}.${fmt === 'xlsx' ? 'xlsx' : 'pdf'}`);
      } else if (result && typeof result === 'object' && 'queued' in (result as any)) {
        alert((result as any).message || 'Export queued — you will receive an email when ready.');
      }
    } catch (e: any) {
      alert('Export failed: ' + String(e?.message ?? e).slice(0, 150));
    } finally { setExporting(null); }
  };

  const content = (
    <div className="px-6 py-6 md:px-8 lg:px-10">
      {totalCount > 0 && (
        <div className="mb-6 w-full rounded-xl border-2 border-red-300 bg-red-50 px-5 py-4 flex items-center justify-between gap-4 shadow-sm">
          <div className="flex items-center gap-3 min-w-0">
            <AlertTriangle className="h-7 w-7 shrink-0 text-red-700" />
            <div className="min-w-0">
              <span className="font-black text-red-800 text-lg md:text-xl tracking-tight leading-none">
                ⚠️ Exceptions Requiring Attention: {totalCount.toLocaleString()}
              </span>
              <p className="text-xs text-red-700 mt-1 opacity-90">
                Click category cards below to inspect offending rows. All totals computed server-side.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/bursary/reports/view/payment-register?facet=UNRECONCILED')}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border border-red-300 bg-white text-red-800 hover:bg-red-100 transition-colors"
          >
            Open Payment Register <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={() => navigate('/bursary/reports/centre')}
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 mb-2"
          >
            <ArrowLeft className="h-3 w-3" /> Back to Reports Centre
          </button>
          <div className="text-xs text-red-700 font-semibold tracking-widest mb-1">RECONCILIATION • EXCEPTIONS</div>
          <h1 className="text-2xl font-extrabold text-gray-900">Reconciliation Exception Report</h1>
          <p className="text-sm text-gray-500 mt-1">
            {EXCEPTION_KINDS.length} exception classes · Expand each card to view offending records with deep-links.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => runExport('xlsx')}
            disabled={!!exporting || !hasPerm('REPORTS_EXPORT_EXCEL', userPerms, role)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50"
          >
            {exporting === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            Excel
          </button>
          <button
            type="button"
            onClick={() => runExport('pdf')}
            disabled={!!exporting || !hasPerm('REPORTS_EXPORT_PDF', userPerms, role)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-rose-700 hover:bg-rose-800 text-white disabled:opacity-50"
          >
            {exporting === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            PDF
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 font-mono">{err}</div>
      )}

      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 mb-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 min-w-[260px]">
            <Filter className="h-4 w-4 text-gray-500 shrink-0" />
            <label className="text-xs font-semibold text-gray-600 tracking-wider">EXCEPTION KIND</label>
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
            >
              <option value="ALL">All Exception Classes ({EXCEPTION_KINDS.length})</option>
              {EXCEPTION_KINDS.map((spec) => {
                const cat = (data?.categories ?? []).find((c: any) => c.kind === spec.kind);
                const count = cat?.count ?? 0;
                const label = cat?.label ?? spec.defaultLabel;
                return (
                  <option key={spec.kind} value={spec.kind}>
                    {label} {count != null ? `(${Number(count).toLocaleString()})` : ''}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="ml-auto text-xs text-gray-500 font-mono">
            {loading && !data ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />Loading…
              </span>
            ) : (
              <>Total: <span className="font-bold text-gray-800">{totalCount.toLocaleString()}</span> rows across <span className="font-bold text-gray-800">{categories.length}</span> class{categories.length === 1 ? '' : 'es'}</>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          <Calendar className="h-4 w-4 text-gray-500 shrink-0" />
          <span className="text-xs font-semibold text-gray-600 tracking-wider mr-1">DATE RANGE</span>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                preset === p.key
                  ? 'bg-amber-600 text-white border-amber-600 shadow-sm'
                  : 'bg-white text-gray-700 border-gray-300 hover:border-amber-400'
              }`}
            >
              {p.label}
            </button>
          ))}
          {preset === 'CUSTOM' && (
            <div className="flex items-center gap-2 ml-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="border border-gray-300 rounded-md px-2 py-1 text-xs bg-white"
              />
              <span className="text-gray-500 text-xs">→</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="border border-gray-300 rounded-md px-2 py-1 text-xs bg-white"
              />
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {loading && !data && (
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-10 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-amber-600 mx-auto mb-3" />
            <p className="text-sm text-gray-500">Loading reconciliation exceptions…</p>
          </div>
        )}

        {!loading && categories.length === 0 && !err && (
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-10 text-center">
            <ShieldAlert className="h-10 w-10 text-emerald-300 mx-auto mb-3" />
            <p className="text-lg font-semibold text-emerald-800">🎉 No exceptions match current filters</p>
            <p className="text-sm text-gray-500 mt-1">Reconciliation is clean. Relax the date range or Kind filter to view historical issues.</p>
          </div>
        )}

        {categories.map((g: any, idx: number) => {
          const spec = EXCEPTION_KINDS.find((e) => e.kind === g.kind) ?? EXCEPTION_KINDS[idx % EXCEPTION_KINDS.length];
          const label = g.label ?? spec?.defaultLabel ?? g.kind;
          const description = g.description ?? spec?.descriptionHint ?? '';
          const count = Number(g.count ?? 0);
          const rows: any[] = g.rows ?? [];
          const isExpanded = expandedKinds.has(g.kind);
          return (
            <div
              key={g.kind}
              className={`bg-white border rounded-2xl shadow-sm overflow-hidden transition-colors ${
                count > 0 ? 'border-red-200' : 'border-gray-200'
              }`}
            >
              <button
                type="button"
                onClick={() => toggleKind(g.kind)}
                className="w-full text-left px-5 py-4 flex flex-wrap items-center gap-3 hover:bg-gray-50 transition-colors"
              >
                <div className={`inline-flex items-center justify-center w-9 h-9 rounded-xl shrink-0 ${
                  count > 0 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  <ShieldAlert className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`font-bold ${count > 0 ? 'text-red-800' : 'text-gray-700'}`}>
                      <AlertOctagon className="h-3.5 w-3.5 inline mr-1 opacity-70" />
                      {label}
                    </span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-black ${
                      count > 0 ? 'bg-red-100 text-red-800' : 'bg-gray-200 text-gray-600'
                    }`}>
                      {count.toLocaleString()}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider font-mono text-gray-400">{g.kind}</span>
                  </div>
                  <p className="text-xs text-gray-600 mt-0.5 truncate">{description}</p>
                </div>
                <a
                  href={deepLinkFacet(g.kind)}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold border border-gray-200 text-gray-700 bg-white hover:bg-amber-50 hover:border-amber-300 transition-colors"
                >
                  Drill-down <ExternalLink className="h-3 w-3" />
                </a>
                {isExpanded ? (
                  <ChevronDown className="h-5 w-5 text-gray-500 shrink-0" />
                ) : (
                  <ChevronRight className="h-5 w-5 text-gray-500 shrink-0" />
                )}
              </button>

              {isExpanded && (
                <div className="border-t border-gray-100 bg-gray-50/50">
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Ref / ID</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Student</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Matric</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Receipt</th>
                          <th className="px-3 py-2 text-right font-semibold text-gray-700 border-b">Amount</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Note / Detail</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 && (
                          <tr>
                            <td colSpan={7} className="p-8 text-center text-gray-500">
                              No rows in this exception class — try expanding the date range filter above.
                            </td>
                          </tr>
                        )}
                        {rows.map((r: any, i: number) => (
                          <tr key={i} className="border-b border-gray-100 hover:bg-amber-50/40 transition-colors">
                            <td className="px-3 py-1.5 font-mono whitespace-nowrap">
                              {r.transactionReference ?? r.transactionId ?? r.id ?? r.reference ?? '—'}
                            </td>
                            <td className="px-3 py-1.5">
                              {r.studentName ?? ([r.firstName, r.lastName].filter(Boolean).join(' ') || '—')}
                            </td>
                            <td className="px-3 py-1.5 font-mono">{r.matricNumber ?? '—'}</td>
                            <td className="px-3 py-1.5 font-mono">{r.receiptNumber ?? '—'}</td>
                            <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                              {r.amount != null ? fmtNGN(r.amount) : r.totalAmount != null ? fmtNGN(r.totalAmount) : '—'}
                            </td>
                            <td className="px-3 py-1.5 text-gray-600 max-w-xs truncate">
                              {r.note ?? r.message ?? r.detail ?? r.description ?? '—'}
                            </td>
                            <td className="px-3 py-1.5 whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => openTxDrawer(r)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-amber-50 hover:border-amber-300 text-[11px] font-semibold"
                                  title="Open transaction details drawer"
                                >
                                  Details
                                </button>
                                {r.studentId && (
                                  <a
                                    href={`/bursary/reports/student-statement?studentId=${encodeURIComponent(r.studentId)}`}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-blue-50 hover:border-blue-300 text-[11px] font-semibold"
                                    title="View student statement"
                                  >
                                    Student <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                                <a
                                  href={deepLinkFacet(g.kind)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-300 bg-white text-gray-700 hover:bg-emerald-50 hover:border-emerald-300 text-[11px] font-semibold"
                                  title="Drill down to payment register facet"
                                >
                                  Register <ExternalLink className="h-3 w-3" />
                                </a>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <TxnDetailsDrawer
        isOpen={drawerOpen}
        onClose={() => { setDrawerOpen(false); setDrawerTx(null); }}
        transaction={drawerTx}
      />
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

export default ExceptionsPage;
