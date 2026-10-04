// STAGE 5 F2 — Reports Centre Page (Bursary & Admin).
// Layout:
//   Header: Page title + period badge
//   Top row: Date preset chips (Today | Yesterday | ThisWeek | ThisMonth | LastMonth | ThisSession | Custom) + optional Custom From/To
//   12+ Summary Cards grid (clickable → Payment Register R5 pre-filtered by facet name)
//   Provider facet chips row: [All] [Paystack] [ALATPay]
//   Quick-links bar: Student Statement + Reconciliation Exceptions with N badge
//   Report Library grid: Collections | Revenue | Accounting | Reconciliation groups, each with cards
// All RBAC enforced: lock icon if !hasPermission(viewPermission).

import React, { useEffect, useMemo, useState } from 'react';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { navCounters, NavCounters } from '../../services/api';
import { i18n } from '../../i18n/en';
import { Link, useNavigate } from 'react-router-dom';
import {
  Calendar, FileSpreadsheet, TrendingUp, CreditCard, Banknote,
  Wallet, ArrowRightLeft, Receipt, Landmark, BarChart3, PieChart,
  Users, FileText, AlertTriangle, Filter, LayoutGrid,
  ChevronRight, CircleDollarSign, Activity, Building2,
  Loader2, Search, Lock, ExternalLink,
} from 'lucide-react';
import {
  REPORT_LIBRARY,
  applyDatePreset,
  getDashboardSummary,
  getReconciliationExceptions,
  type ReportsBaseFilters,
  type DashboardFacetName,
} from '../../services/reportsApi';

type Role = 'BURSARY' | 'ADMIN';
type Preset = 'TODAY'|'YESTERDAY'|'THIS_WEEK'|'THIS_MONTH'|'LAST_MONTH'|'THIS_SESSION'|'CUSTOM';
type ProviderChip = 'ALL' | 'PAYSTACK' | 'ALATPAY';

const hasPermission = (perm: string | undefined, perms?: string[], role?: Role): boolean => {
  if (!perm) return true;
  if (role === 'ADMIN') {
    const adminAuto = new Set(['MANAGE_USERS','MANAGE_ROLES','SYSTEM_SETTINGS','PAYSTACK_CONFIG','AUDIT_LOGS_VIEW_FULL','REPORTS_SCHEDULE']);
    if (adminAuto.has(perm)) return true;
    if (!perms || perms.length === 0) return false;
    return perms.includes(perm);
  }
  if (!perms || perms.length === 0) return false;
  return perms.includes(perm);
};

const fmtNGN = (v: number | string | null | undefined): string => {
  if (v === null || v === undefined || v === '') return '₦0.00';
  const num = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  if (Number.isNaN(num)) return '₦0.00';
  return `₦${num.toLocaleString('en-NG', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
};

const fmtInt = (v: number | string | null | undefined): string => {
  if (v === null || v === undefined || v === '') return '0';
  const num = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  if (Number.isNaN(num)) return '0';
  return num.toLocaleString('en-NG', { maximumFractionDigits: 0 });
};

const formatPeriodBadge = (dateFromStr?: string, dateToStr?: string): string => {
  if (!dateFromStr && !dateToStr) return 'All time';
  const fmt = (s: string) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };
  if (dateFromStr && dateToStr) return `${fmt(dateFromStr)} — ${fmt(dateToStr)}`;
  if (dateFromStr) return `From ${fmt(dateFromStr)}`;
  return `Until ${fmt(dateToStr!)}`;
};

export interface ReportsCentreProps { role: Role; activePath: string; }

const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: 'TODAY', label: 'Today' },
  { key: 'YESTERDAY', label: 'Yesterday' },
  { key: 'THIS_WEEK', label: 'This Week' },
  { key: 'THIS_MONTH', label: 'This Month' },
  { key: 'LAST_MONTH', label: 'Last Month' },
  { key: 'THIS_SESSION', label: 'This Session' },
  { key: 'CUSTOM', label: 'Custom Range' },
];

const PROVIDER_CHIPS: Array<{ key: ProviderChip; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'PAYSTACK', label: 'Paystack' },
  { key: 'ALATPAY', label: 'ALATPay' },
];

type DashboardCardDef = {
  key: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  bg: string;
  permission?: string;
  facetName: DashboardFacetName;
  accessor: (cards: any) => number | string | null | undefined;
  isMoney?: boolean;
  microcopy: string;
};

const DashboardCardsDef: DashboardCardDef[] = [
  {
    key: 'totalCollected',
    title: 'Total Collected',
    icon: CircleDollarSign,
    accent: 'text-emerald-700',
    bg: 'bg-emerald-50 border-emerald-200',
    permission: 'REPORTS_VIEW_COLLECTIONS',
    facetName: 'GROSS_ALL',
    accessor: (c) => c?.totalCollected,
    isMoney: true,
    microcopy: 'All successful gross receipts',
  },
  {
    key: 'numSuccessfulPayments',
    title: 'Successful Payments',
    icon: CreditCard,
    accent: 'text-blue-700',
    bg: 'bg-blue-50 border-blue-200',
    permission: 'REPORTS_VIEW_COLLECTIONS',
    facetName: 'GROSS_ALL',
    accessor: (c) => c?.numSuccessfulPayments,
    microcopy: 'Count of SUCCESS status txs',
  },
  {
    key: 'uniquePayers',
    title: 'Unique Payers',
    icon: Users,
    accent: 'text-indigo-700',
    bg: 'bg-indigo-50 border-indigo-200',
    permission: 'REPORTS_VIEW_COLLECTIONS',
    facetName: 'UNIQUE_PAYERS',
    accessor: (c) => c?.uniquePayers,
    microcopy: 'Distinct student/staff payers',
  },
  {
    key: 'avgPayment',
    title: 'Avg Payment',
    icon: Banknote,
    accent: 'text-purple-700',
    bg: 'bg-purple-50 border-purple-200',
    permission: 'REPORTS_VIEW_COLLECTIONS',
    facetName: 'GROSS_ALL',
    accessor: (c) => c?.avgPayment,
    isMoney: true,
    microcopy: 'Mean of successful payments',
  },
  {
    key: 'paystackCollected',
    title: 'Paystack',
    icon: Activity,
    accent: 'text-teal-700',
    bg: 'bg-teal-50 border-teal-200',
    permission: 'REPORTS_VIEW_COLLECTIONS',
    facetName: 'BY_PAYSTACK',
    accessor: (c) => c?.paystackCollected,
    isMoney: true,
    microcopy: 'Gross via Paystack gateway',
  },
  {
    key: 'alatpayCollected',
    title: 'ALATPay',
    icon: Building2,
    accent: 'text-cyan-700',
    bg: 'bg-cyan-50 border-cyan-200',
    permission: 'REPORTS_VIEW_COLLECTIONS',
    facetName: 'BY_ALATPAY',
    accessor: (c) => c?.alatpayCollected,
    isMoney: true,
    microcopy: 'Gross via ALATPay gateway',
  },
  {
    key: 'convenienceFee',
    title: 'Convenience Fee',
    icon: Wallet,
    accent: 'text-amber-700',
    bg: 'bg-amber-50 border-amber-200',
    permission: 'REPORTS_VIEW_ACCOUNTING',
    facetName: 'BY_CONVENIENCE',
    accessor: (c) => c?.convenienceFee,
    isMoney: true,
    microcopy: 'Convenience fees collected',
  },
  {
    key: 'serviceCharge',
    title: 'Service Charge',
    icon: FileSpreadsheet,
    accent: 'text-orange-700',
    bg: 'bg-orange-50 border-orange-200',
    permission: 'REPORTS_VIEW_ACCOUNTING',
    facetName: 'BY_SERVICE',
    accessor: (c) => c?.serviceCharge,
    isMoney: true,
    microcopy: 'Service charges retained',
  },
  {
    key: 'gatewayFees',
    title: 'Gateway Fees',
    icon: ArrowRightLeft,
    accent: 'text-rose-700',
    bg: 'bg-rose-50 border-rose-200',
    permission: 'REPORTS_VIEW_ACCOUNTING',
    facetName: 'BY_GATEWAY',
    accessor: (c) => c?.gatewayFees,
    isMoney: true,
    microcopy: 'Provider processing fees',
  },
  {
    key: 'refunds',
    title: 'Refunds',
    icon: Receipt,
    accent: 'text-red-700',
    bg: 'bg-red-50 border-red-200',
    permission: 'REPORTS_VIEW_ACCOUNTING',
    facetName: 'BY_REFUND',
    accessor: (c) => c?.refunds,
    isMoney: true,
    microcopy: 'Refunds issued this period',
  },
  {
    key: 'netCollection',
    title: 'Net Collection',
    icon: TrendingUp,
    accent: 'text-green-800',
    bg: 'bg-green-50 border-green-200',
    permission: 'REPORTS_VIEW_COLLECTIONS',
    facetName: 'BY_NET',
    accessor: (c) => c?.netCollection,
    isMoney: true,
    microcopy: 'Gross − refunds − charges',
  },
  {
    key: 'reconciledAmount',
    title: 'Reconciled Amount',
    icon: Landmark,
    accent: 'text-emerald-800',
    bg: 'bg-emerald-50 border-emerald-200',
    permission: 'REPORTS_VIEW_RECONCILIATION',
    facetName: 'RECONCILED',
    accessor: (c) => c?.reconciledAmount ?? c?.totalCollected,
    isMoney: true,
    microcopy: 'Matched + settled in bank',
  },
  {
    key: 'unreconciledAmount',
    title: 'Unreconciled Amount',
    icon: AlertTriangle,
    accent: 'text-amber-800',
    bg: 'bg-amber-50 border-amber-200',
    permission: 'REPORTS_VIEW_RECONCILIATION',
    facetName: 'UNRECONCILED',
    accessor: (c) => {
      const total = Number(c?.totalCollected ?? 0);
      const recon = Number(c?.reconciledAmount ?? 0);
      if (!total) return c?.unreconciledAmount;
      const diff = total - recon;
      return c?.unreconciledAmount ?? (diff > 0 ? diff : 0);
    },
    isMoney: true,
    microcopy: 'Awaiting settlement / variance',
  },
];

const ReportsCentre: React.FC<ReportsCentreProps> = ({ role, activePath }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [preset, setPreset] = useState<Preset>('THIS_MONTH');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [provider, setProvider] = useState<ProviderChip>('ALL');
  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [excLoading, setExcLoading] = useState(false);
  const [excTotalCount, setExcTotalCount] = useState<number | null>(null);

  const userPerms = (user?.permissions as string[] | undefined) ?? [];

  useEffect(() => { navCounters().then(setNavCounts).catch(() => {}); }, []);

  const filters = useMemo<ReportsBaseFilters>(() => {
    const r = applyDatePreset(
      preset,
      customFrom ? new Date(customFrom) : undefined,
      customTo ? new Date(customTo) : undefined,
    );
    const out: ReportsBaseFilters = {
      dateFrom: r.dateFrom ? r.dateFrom.toISOString().slice(0, 10) : undefined,
      dateTo: r.dateTo ? r.dateTo.toISOString().slice(0, 10) : undefined,
    };
    if (provider !== 'ALL') out.provider = provider;
    return out;
  }, [preset, customFrom, customTo, provider]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setLoadError(null);
    getDashboardSummary(filters)
      .then((d: any) => { if (mounted) setCards(d?.cards ?? d ?? null); })
      .catch((e: any) => { if (mounted) setLoadError(String(e?.message ?? e).slice(0, 200)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [filters]);

  useEffect(() => {
    let mounted = true;
    setExcLoading(true);
    const ef: ReportsBaseFilters = {};
    if (filters.dateFrom) ef.dateFrom = filters.dateFrom;
    if (filters.dateTo) ef.dateTo = filters.dateTo;
    getReconciliationExceptions(ef)
      .then((d: any) => { if (mounted) setExcTotalCount(Number(d?.totalCount ?? 0)); })
      .catch(() => { if (mounted) setExcTotalCount(0); })
      .finally(() => { if (mounted) setExcLoading(false); });
    return () => { mounted = false; };
  }, [filters.dateFrom, filters.dateTo]);

  const brand = role === 'BURSARY' ? i18n.portals.bursary.dashboardBrand : i18n.portals.admin.dashboardBrand;
  const userText = role === 'BURSARY'
    ? `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()
    : i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin');

  const periodBadge = formatPeriodBadge(filters.dateFrom as string | undefined, filters.dateTo as string | undefined);

  const openRegisterWithFacet = (facetName: DashboardFacetName) => {
    const params = new URLSearchParams();
    params.set('facet', facetName);
    if (filters.dateFrom) params.set('dateFrom', String(filters.dateFrom));
    if (filters.dateTo) params.set('dateTo', String(filters.dateTo));
    navigate(`/bursary/reports/view/payment-register?${params.toString()}`);
  };

  const groups: Array<'Collections'|'Revenue'|'Accounting'|'Reconciliation'> = ['Collections','Revenue','Accounting','Reconciliation'];

  const groupCounts: Record<string, number> = {
    Collections: REPORT_LIBRARY.filter(r => r.group === 'Collections').length,
    Revenue: REPORT_LIBRARY.filter(r => r.group === 'Revenue').length,
    Accounting: REPORT_LIBRARY.filter(r => r.group === 'Accounting').length,
    Reconciliation: REPORT_LIBRARY.filter(r => r.group === 'Reconciliation').length,
  };

  const content = (
    <div className="px-4 sm:px-6 py-6 md:px-8 lg:px-10 max-w-[100%] mx-auto">
      {/* PageHeader */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs text-amber-700 font-semibold tracking-widest mb-1">BURSARY • REPORTS CENTRE</div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-extrabold text-gray-900 tracking-tight">Bursary Reports</h1>
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200 whitespace-nowrap">
              <Calendar className="h-3 w-3 mr-1 text-gray-500" />
              {periodBadge}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">Collections, revenue, accounting and reconciliation — all aggregated server-side with immutable audit trails.</p>
        </div>
      </div>

      {/* Date selector chips */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <Filter className="h-4 w-4 text-gray-500 shrink-0" />
            <span className="text-xs font-semibold text-gray-500 tracking-wide mr-2">DATE PRESET</span>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={`px-3 py-1.5 rounded-full text-xs md:text-sm font-medium border transition-all ${
                  preset === p.key
                    ? 'bg-amber-600 text-white border-amber-600 shadow-sm'
                    : 'bg-white text-gray-700 border-gray-300 hover:border-amber-400 hover:text-amber-700'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'CUSTOM' && (
            <div className="flex items-center gap-2 text-xs md:text-sm">
              <Calendar className="h-4 w-4 text-gray-500 shrink-0" />
              <label className="text-gray-600 font-medium">From</label>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
              />
              <label className="text-gray-600 font-medium">To</label>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
              />
            </div>
          )}
        </div>
      </div>

      {/* Quick-links bar */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold text-gray-500 tracking-wide mr-1">QUICK LINKS</span>
          <Link
            to="/bursary/reports/student-statement"
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-sm font-medium border border-gray-300 bg-white hover:bg-gray-50 text-gray-800 shadow-sm transition-all ${!hasPermission('REPORTS_VIEW_STUDENT_STATEMENT', userPerms, role) ? 'hidden' : ''}`}
          >
            <Search className="h-4 w-4" />
            <span>Student Statement</span>
          </Link>
          <Link
            to="/bursary/reports/exceptions"
            className={`relative inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-sm font-semibold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 shadow-sm transition-all ${!hasPermission('REPORTS_VIEW_RECONCILIATION', userPerms, role) ? 'hidden' : ''}`}
          >
            <AlertTriangle className="h-4 w-4" />
            <span>Reconciliation Exceptions</span>
            {excLoading ? (
              <span className="inline-flex items-center justify-center ml-0.5">
                <Loader2 className="h-3 w-3 animate-spin text-amber-600" />
              </span>
            ) : (excTotalCount ?? 0) > 0 ? (
              <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold ml-0.5 ${
                (excTotalCount ?? 0) >= 10
                  ? 'bg-red-600 text-white'
                  : 'bg-amber-600 text-white'
              }`}>
                {fmtInt(excTotalCount)}
              </span>
            ) : null}
          </Link>
        </div>
      </div>

      {/* Error banner */}
      {loadError && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div className="font-semibold mb-0.5">Failed to load summary cards</div>
          <div className="font-mono text-xs">{loadError}</div>
        </div>
      )}

      {/* 12+ Summary Cards Grid */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-amber-700" />
            <h2 className="text-lg font-bold text-gray-900">Summary Cards</h2>
            <span className="text-xs text-gray-500">Click any card → drill into Payment Register</span>
          </div>
          {loading && <span className="inline-flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</span>}
        </div>

        {/* Provider facet chips */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs font-semibold text-gray-500 tracking-wide mr-1">PROVIDER</span>
          {PROVIDER_CHIPS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setProvider(p.key)}
              className={`px-3 py-1.5 rounded-full text-xs md:text-sm font-medium border transition-all ${
                provider === p.key
                  ? 'bg-gray-900 text-white border-gray-900 shadow-sm font-bold'
                  : 'bg-white text-gray-700 border-gray-300 hover:border-gray-500 hover:text-gray-900'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {DashboardCardsDef.filter((cd) => hasPermission(cd.permission, userPerms, role)).map((cd) => {
            const raw = cards ? cd.accessor(cards) : undefined;
            const display = loading
              ? <span className="inline-flex items-center gap-1 text-gray-400"><Loader2 className="h-3 w-3 animate-spin" />Loading…</span>
              : raw === undefined || raw === null
                ? <span className="text-gray-400">—</span>
                : cd.isMoney
                  ? <span className="font-mono font-semibold tracking-tight">{fmtNGN(Number(raw))}</span>
                  : <span className="font-mono font-semibold tracking-tight">{fmtInt(raw)}</span>;
            const Icon = cd.icon;
            return (
              <button
                key={cd.key}
                type="button"
                onClick={() => openRegisterWithFacet(cd.facetName)}
                className={`group text-left rounded-2xl border ${cd.bg} p-5 shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-amber-400`}
                aria-label={`${cd.title} — click to drill down`}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className={`inline-flex items-center justify-center rounded-xl w-10 h-10 bg-white shadow-sm border ${cd.accent}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${cd.accent} opacity-0 group-hover:opacity-100 transition-opacity`}>
                    <span>Drill down</span>
                    <ChevronRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
                  </div>
                </div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-1">{cd.title}</div>
                <div className={`text-xl md:text-2xl leading-snug ${cd.accent} mb-2`}>{display}</div>
                <div className="text-[11px] text-gray-500 flex items-center justify-between">
                  <span className="truncate pr-1">{cd.microcopy}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Report Library — categorized */}
      <div className="pb-8">
        <div className="flex items-center gap-2 mb-4">
          <LayoutGrid className="h-5 w-5 text-amber-700" />
          <h2 className="text-lg font-bold text-gray-900">Report Library</h2>
          <span className="text-xs text-gray-500">
            Collections {groupCounts.Collections} · Revenue {groupCounts.Revenue} · Accounting {groupCounts.Accounting} · Reconciliation {groupCounts.Reconciliation}
          </span>
        </div>
        <div className="space-y-8">
          {groups.map((g) => {
            const reports = REPORT_LIBRARY.filter((r) => r.group === g);
            if (reports.length === 0) return null;
            const visibleCount = reports.filter((r) => hasPermission(r.viewPermission, userPerms, role)).length;
            const groupAccent: string = {
              Collections: 'from-emerald-50 to-teal-50 border-emerald-200 text-emerald-800',
              Revenue: 'from-blue-50 to-indigo-50 border-blue-200 text-blue-800',
              Accounting: 'from-purple-50 to-violet-50 border-purple-200 text-purple-800',
              Reconciliation: 'from-amber-50 to-orange-50 border-amber-200 text-amber-800',
            }[g] ?? 'from-gray-50 to-gray-50 border-gray-200 text-gray-800';
            return (
              <div key={g}>
                <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold tracking-wider border bg-gradient-to-r ${groupAccent} mb-3`}>
                  <PieChart className="h-3 w-3" /> {g.toUpperCase()}
                  <span className="opacity-75 font-semibold">· {reports.length}</span>
                  {visibleCount < reports.length && (
                    <span className="opacity-60 font-normal">({visibleCount} available)</span>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {reports.map((r) => {
                    const canView = hasPermission(r.viewPermission, userPerms, role);
                    const qs = (filters.dateFrom || filters.dateTo)
                      ? `?${[filters.dateFrom && `dateFrom=${filters.dateFrom}`, filters.dateTo && `dateTo=${filters.dateTo}`].filter(Boolean).join('&')}`
                      : '';
                    const inner = (
                      <div className="group rounded-2xl border border-gray-200 bg-white p-5 hover:shadow-md hover:-translate-y-0.5 hover:border-amber-300 transition-all duration-150 h-full flex flex-col">
                        <div className="flex items-start justify-between mb-3">
                          <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl border ${
                            canView ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-100 text-gray-400 border-gray-200'
                          }`}>
                            <FileText className="h-5 w-5" />
                          </div>
                          {!canView ? (
                            <Lock className="h-4 w-4 text-gray-400" aria-label="Requires permission" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-gray-400 group-hover:text-amber-700 transition-colors" />
                          )}
                        </div>
                        <div className={`text-sm font-bold mb-1 ${canView ? 'text-gray-900' : 'text-gray-500'}`}>{r.title}</div>
                        <div className="text-xs text-gray-500 mb-4 min-h-[2.2em] flex-1">{r.subtitle}</div>
                        <div className="flex items-center justify-between">
                          <span className={`text-xs font-medium inline-flex items-center gap-1 ${
                            canView ? 'text-amber-700' : 'text-gray-400'
                          }`}>
                            {canView ? (
                              <>
                                Open report <ChevronRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
                              </>
                            ) : (
                              <>Permission required <Lock className="h-3 w-3" /></>
                            )}
                          </span>
                        </div>
                      </div>
                    );
                    return canView ? (
                      <Link key={r.key} to={r.pageRoute + qs} className="block">
                        {inner}
                      </Link>
                    ) : (
                      <div key={r.key} className="block opacity-90 cursor-not-allowed">
                        {inner}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {groups.every((g) => REPORT_LIBRARY.filter((r) => r.group === g && hasPermission(r.viewPermission, userPerms, role)).length === 0) && (
            <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-gray-500 text-sm">
              <Search className="h-10 w-10 text-gray-300 mx-auto mb-2" />
              No reports available. Contact admin to grant REPORTS_VIEW_* permissions.
            </div>
          )}
        </div>
      </div>
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

export default ReportsCentre;
