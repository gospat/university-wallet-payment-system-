import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  ShieldCheck,
  Mail,
  History,
  Banknote,
  Users,
  TrendingUp,
  BarChart3,
  Download,
  FileText,
  CalendarDays,
  ArrowUpRight,
  Layers,
  CircleDollarSign,
  GraduationCap,
  Receipt,
  CheckCircle2,
  Percent,
  ListChecks,
} from 'lucide-react';
import api, { navCounters, NavCounters } from '../../services/api';
import Modal from '../../components/Modal';
import PortalShell from '../../components/PortalShell';
import { i18n } from '../../i18n/en';
import { useLocation } from 'react-router-dom';

const naira = (v: string | number) => {
  const n = Number(v);
  if (!isFinite(n)) return '₦0.00';
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

type Summary = {
  cards?: any;
  recentTransactions?: any[];
};

type Trend = {
  buckets?: Array<{ label: string; value: number; count: number; date: string }>;
  total?: number;
  totalCount?: number;
  unit?: 'day' | 'week' | 'month';
  filters?: any;
};

type ByCat = {
  rows?: Array<{ id: number; name: string; code: string; total: number; count: number }>;
  grandTotal?: number;
  filters?: any;
};

type Filters = {
  dateFrom: string;
  dateTo: string;
  groupBy: 'day' | 'week' | 'month';
};

const Sparkline: React.FC<{ points: number[]; color?: string }> = ({ points, color = '#0a3d91' }) => {
  const width = 220;
  const height = 60;
  const pad = 4;
  if (!points.length) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = Math.max(1, max - min);
  const stepX = (width - pad * 2) / Math.max(1, points.length - 1);
  const coords = points.map((v, i) => {
    const x = pad + i * stepX;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return `${x},${y}`;
  });
  const area = `${pad},${height - pad} ${coords.join(' ')} ${width - pad},${height - pad}`;
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polygon points={area} fill={color} fillOpacity={0.1} />
      <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

const BarChart: React.FC<{
  data: Array<{ label: string; value: number }>;
  height?: number;
  color?: string;
  valueFormatter?: (n: number) => string;
}> = ({ data, height = 240, color = '#0a3d91', valueFormatter }) => {
  const width = 720;
  const padL = 52;
  const padR = 12;
  const padT = 16;
  const padB = 56;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const max = Math.max(1, ...data.map((d) => d.value));
  const barW = (innerW / data.length) * 0.65;
  const step = innerW / data.length;
  const fmt = valueFormatter ?? ((n) => naira(n));
  return (
    <div className="overflow-x-auto w-full">
      <svg width={width} height={height} className="min-w-[720px]">
        {Array.from({ length: 5 }).map((_, i) => {
          const y = padT + (innerH / 4) * i;
          const val = max - (max / 4) * i;
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#e2e8f0" strokeDasharray="3 3" />
              <text x={padL - 8} y={y + 4} textAnchor="end" fontSize={10} fill="#94a3b8">
                {fmt(val)}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (d.value / max) * innerH;
          const x = padL + step * i + (step - barW) / 2;
          const y = padT + innerH - h;
          return (
            <g key={d.label}>
              <rect x={x} y={y} width={barW} height={h} rx={6} fill={color} opacity={0.85} />
              <rect x={x} y={y} width={barW} height={Math.min(6, h)} rx={6} fill={color} />
              <text x={x + barW / 2} y={height - padB + 16} textAnchor="middle" fontSize={10} fill="#64748b">
                {d.label}
              </text>
              <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize={10} fill="#334155" fontWeight={600}>
                {fmt(d.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

const CatChart: React.FC<{ data: ByCat['rows'] }> = ({ data }) => {
  const rows = data || [];
  const grand = rows.reduce((s, r) => s + r.total, 0);
  const palette = ['#0a3d91', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#6366f1', '#0ea5e9', '#10b981'];
  const total = grand || 1;
  const maxW = grand || 1;
  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <div className="rounded-xl bg-slate-50 border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 text-center">
          No collections yet for the selected period.
        </div>
      )}
      {rows.map((r, idx) => {
        const pct = (r.total / total) * 100;
        const color = palette[idx % palette.length];
        return (
          <div key={r.id + r.code}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                <span className="text-sm font-semibold text-slate-800 truncate">
                  {r.name || r.code || `Category ${r.id}`}
                </span>
                <span className="text-xs text-slate-400 font-mono shrink-0">{r.count} tx</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-sm font-bold text-slate-900">{naira(r.total)}</span>
                <span className="text-xs text-slate-500 w-12 text-right">{pct.toFixed(1)}%</span>
              </div>
            </div>
            <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${(r.total / maxW) * 100}%`, background: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
};

const BursaryDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [trendLoading, setTrendLoading] = useState(false);
  const [catLoading, setCatLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [summary, setSummary] = useState<Summary>({});
  const [trend, setTrend] = useState<Trend>({});
  const [byCategory, setByCategory] = useState<ByCat>({});

  const fullName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();

  useEffect(() => {
    navCounters().then(setNavCounts);
  }, []);

  const defaultFrom = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  }, []);
  const defaultTo = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [filters, setFilters] = useState<Filters>({ dateFrom: defaultFrom, dateTo: defaultTo, groupBy: 'day' });

  const [alertModal, setAlertModal] = useState({
    isOpen: false,
    title: '',
    message: '',
    type: 'error' as 'error' | 'success',
  });

  const showAlert = (title: string, message: string, type: 'error' | 'success' = 'error') =>
    setAlertModal({ isOpen: true, title, message, type });

  useEffect(() => {
    fetchSummary();
    fetchTrend();
    fetchCategory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.dateFrom, filters.dateTo, filters.groupBy]);

  const buildQs = () => {
    const p: any = {};
    if (filters.dateFrom) p.dateFrom = filters.dateFrom;
    if (filters.dateTo) p.dateTo = filters.dateTo + 'T23:59:59';
    p.groupBy = filters.groupBy;
    return new URLSearchParams(p).toString();
  };

  const fetchSummary = async () => {
    setSummaryLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filters.dateFrom) qs.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) qs.set('dateTo', filters.dateTo + 'T23:59:59');
      const res = await api.get(`/bursary/dashboard/summary?${qs.toString()}`);
      setSummary(res.data.data || {});
    } catch (e) {
      console.error(e);
    } finally {
      setSummaryLoading(false);
    }
  };

  const fetchTrend = async () => {
    setTrendLoading(true);
    try {
      const res = await api.get(`/bursary/dashboard/trend?${buildQs()}`);
      setTrend(res.data.data || {});
    } catch (e) {
      console.error(e);
    } finally {
      setTrendLoading(false);
    }
  };

  const fetchCategory = async () => {
    setCatLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filters.dateFrom) qs.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) qs.set('dateTo', filters.dateTo + 'T23:59:59');
      const res = await api.get(`/bursary/dashboard/by-category?${qs.toString()}`);
      setByCategory(res.data.data || {});
    } catch (e) {
      console.error(e);
    } finally {
      setCatLoading(false);
    }
  };

  const exportCollections = async (format: 'json' | 'csv') => {
    setExportLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filters.dateFrom) qs.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) qs.set('dateTo', filters.dateTo + 'T23:59:59');
      qs.set('format', format);
      const res = await api.get(`/bursary/reports/collections?${qs.toString()}`, {
        responseType: format === 'csv' ? ('blob' as any) : 'json',
      });
      if (format === 'csv') {
        const blob = res.data as Blob;
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        const fn: string =
          (res as any).headers?.['content-disposition']?.match(/filename="?([^"]+)"?/)?.[1] ||
          `collections_${Date.now()}.csv`;
        a.href = url;
        a.download = fn;
        a.click();
        window.URL.revokeObjectURL(url);
      } else {
        const j = JSON.stringify(res.data, null, 2);
        const blob = new Blob([j], { type: 'application/json' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `collections_${Date.now()}.json`;
        a.click();
        window.URL.revokeObjectURL(url);
      }
      showAlert('Export started', `Collections export (${format.toUpperCase()}) is downloading.`, 'success');
    } catch (e: any) {
      showAlert('Export failed', e?.response?.data?.message || 'Failed to export collections report');
    } finally {
      setExportLoading(false);
    }
  };

  const cards = summary.cards || {};
  const sparkData = (trend.buckets || []).map((b) => b.value);

  const brand = i18n.portals.bursary.dashboardBrand;

  const chartBars = (trend.buckets || []).map((b) => ({
    label:
      trend.unit === 'day'
        ? b.label.slice(5)
        : trend.unit === 'week'
          ? b.label.replace('W/C ', '').slice(5)
          : b.label,
    value: b.value,
  }));

  return (
    <PortalShell
      role="BURSARY"
      activePath={location.pathname}
      brand={brand}
      userText={fullName || i18n.portals.bursary.dashboardGreeting(fullName || '')}
      userEmail={user?.email ?? undefined}
      onLogout={logout}
      userPermissions={(user?.permissions as string[]) ?? []}
      showGlobalSearch
      navCounters={navCounts}
    >
      <div className="w-full space-y-6">
        {/* Profile header */}
        <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 md:p-8 flex flex-col md:flex-row items-center md:items-start gap-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 -mt-10 -mr-10 w-56 h-56 bg-emerald-50 rounded-full blur-3xl opacity-70 pointer-events-none"></div>
          <div className="h-24 w-24 bg-gradient-to-br from-emerald-100 to-emerald-50 rounded-3xl flex items-center justify-center text-emerald-700 text-3xl font-black shrink-0 border-4 border-white shadow-lg z-10 ring-1 ring-emerald-100">
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <div className="flex-1 text-center md:text-left z-10 w-full">
            <h1 className="text-2xl font-black text-slate-900 tracking-tight">
              {user?.firstName} {user?.lastName}
            </h1>
            <p className="text-slate-500 font-semibold mb-4">Financial Controller — Bursary Department</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full md:w-2/3">
              <div className="flex items-center gap-2.5 text-sm text-slate-700 bg-slate-50 px-3.5 py-2.5 rounded-xl border border-slate-100">
                <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0" />
                <span className="truncate font-semibold">Bursary Dept</span>
              </div>
              <div className="flex items-center gap-2.5 text-sm text-slate-700 bg-slate-50 px-3.5 py-2.5 rounded-xl border border-slate-100">
                <Mail className="h-4 w-4 text-emerald-600 shrink-0" />
                <span className="truncate font-semibold">
                  {user?.email || 'finance@university.edu.ng'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Filters toolbar */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 md:p-5 flex flex-col lg:flex-row lg:items-end gap-4 lg:gap-6">
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5 flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5" /> From
              </label>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
                className="w-full rounded-xl border border-slate-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none px-3.5 py-2.5 text-sm font-medium"
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5 flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5" /> To
              </label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
                className="w-full rounded-xl border border-slate-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none px-3.5 py-2.5 text-sm font-medium"
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5 flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" /> Trend group by
              </label>
              <select
                value={filters.groupBy}
                onChange={(e) => setFilters({ ...filters, groupBy: e.target.value as any })}
                className="w-full rounded-xl border border-slate-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none px-3.5 py-2.5 text-sm font-medium bg-white"
              >
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
                <option value="month">Monthly</option>
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-stretch gap-2">
            <button
              onClick={() => exportCollections('csv')}
              disabled={exportLoading}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-600 disabled:opacity-60 text-white font-bold px-4 py-2.5 shadow-sm"
            >
              <Download className="h-4 w-4" /> CSV export
            </button>
            <button
              onClick={() => exportCollections('json')}
              disabled={exportLoading}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold px-4 py-2.5 ring-1 ring-slate-200"
            >
              <FileText className="h-4 w-4" /> JSON
            </button>
          </div>
        </div>

        {/* Collections-only KPI cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 relative overflow-hidden">
            <div className="flex items-start justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg ring-1 ring-emerald-100">
                  <CircleDollarSign className="h-3 w-3" /> Total Collected
                </div>
                <div className="mt-3 text-2xl font-black text-slate-900 tracking-tight">
                  {naira(cards.totalCollected ?? cards.totalRevenue ?? 0)}
                </div>
                <div className="mt-1 text-sm text-slate-500 font-medium">
                  {cards.totalRevenueTransactions ?? cards.transactionsCount ?? 0} successful transactions
                </div>
              </div>
              <div className="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center ring-1 ring-emerald-100">
                <Banknote className="h-5 w-5" />
              </div>
            </div>
            <div className="mt-4 -mx-1 -mb-1 flex items-end">
              <Sparkline points={sparkData} color="#059669" />
              <span className="inline-flex items-center gap-1 ml-auto mr-2 text-emerald-700 bg-emerald-50 ring-1 ring-emerald-100 rounded-lg px-2 py-0.5 text-[11px] font-bold">
                <ArrowUpRight className="h-3 w-3" /> trend
              </span>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 relative overflow-hidden">
            <div className="flex items-start justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-lg ring-1 ring-indigo-100">
                  <Receipt className="h-3 w-3" /> Receipts Issued
                </div>
                <div className="mt-3 text-2xl font-black text-slate-900 tracking-tight">
                  {(cards.receiptsIssued ?? 0).toLocaleString()}
                </div>
                <div className="mt-1 text-sm text-slate-500 font-medium">
                  Official receipts printed
                </div>
              </div>
              <div className="w-11 h-11 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center ring-1 ring-indigo-100">
                <Receipt className="h-5 w-5" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-teal-700 bg-teal-50 px-2.5 py-1 rounded-lg ring-1 ring-teal-100">
                  <Users className="h-3 w-3" /> Paying Students
                </div>
                <div className="mt-3 text-2xl font-black text-slate-900 tracking-tight">
                  {(cards.uniquePayingStudents ?? 0).toLocaleString()}
                </div>
                <div className="mt-1 text-sm text-slate-500 font-medium">
                  Unique students who paid
                </div>
              </div>
              <div className="w-11 h-11 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center ring-1 ring-teal-100">
                <CheckCircle2 className="h-5 w-5" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-fuchsia-700 bg-fuchsia-50 px-2.5 py-1 rounded-lg ring-1 ring-fuchsia-100">
                  <Percent className="h-3 w-3" /> Avg Transaction
                </div>
                <div className="mt-3 text-2xl font-black text-slate-900 tracking-tight">
                  {naira(cards.averageTransaction ?? 0)}
                </div>
                <div className="mt-1 text-sm text-slate-500 font-medium">
                  Mean successful payment
                </div>
              </div>
              <div className="w-11 h-11 rounded-xl bg-fuchsia-50 text-fuchsia-600 flex items-center justify-center ring-1 ring-fuchsia-100">
                <BarChart3 className="h-5 w-5" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-sky-700 bg-sky-50 px-2.5 py-1 rounded-lg ring-1 ring-sky-100">
                  <GraduationCap className="h-3 w-3" /> Total Students
                </div>
                <div className="mt-3 text-2xl font-black text-slate-900 tracking-tight">
                  {(cards.totalStudents ?? 0).toLocaleString()}
                </div>
                <div className="mt-1 text-sm text-slate-500 font-medium">
                  Registered students
                </div>
              </div>
              <div className="w-11 h-11 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center ring-1 ring-sky-100">
                <GraduationCap className="h-5 w-5" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-orange-700 bg-orange-50 px-2.5 py-1 rounded-lg ring-1 ring-orange-100">
                  <ListChecks className="h-3 w-3" /> Fees Published
                </div>
                <div className="mt-3 text-2xl font-black text-slate-900 tracking-tight">
                  {(cards.feesPublishedCount ?? 0).toLocaleString()}
                </div>
                <div className="mt-1 text-sm text-slate-500 font-medium">
                  Active fee items in catalogue
                </div>
              </div>
              <div className="w-11 h-11 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center ring-1 ring-orange-100">
                <Layers className="h-5 w-5" />
              </div>
            </div>
          </div>
        </div>

        {/* Trend chart + Category */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <div className="xl:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 p-5 md:p-6">
            <div className="flex items-start justify-between mb-4 gap-3">
              <div>
                <h3 className="font-black text-lg text-slate-900 flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-blue-600" /> Collections over time
                </h3>
                <p className="text-sm text-slate-500">
                  {trend.unit === 'day' ? 'Daily' : trend.unit === 'week' ? 'Weekly' : 'Monthly'} fee revenue within the
                  selected window.
                </p>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500 uppercase tracking-wider font-bold">Total</div>
                <div className="text-2xl font-black text-slate-900">{naira(trend.total ?? 0)}</div>
                <div className="text-xs text-slate-500 font-medium">{trend.totalCount ?? 0} transactions</div>
              </div>
            </div>
            {trendLoading ? (
              <div className="h-[240px] flex items-center justify-center text-slate-400 text-sm font-medium">
                Loading trend…
              </div>
            ) : (
              <BarChart data={chartBars} />
            )}
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 md:p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="font-black text-lg text-slate-900 flex items-center gap-2">
                  <Layers className="h-5 w-5 text-teal-600" /> Collections by category
                </h3>
                <p className="text-sm text-slate-500">Fee category breakdown of successful payments.</p>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500 uppercase tracking-wider font-bold">Grand</div>
                <div className="text-xl font-black text-slate-900">{naira(byCategory.grandTotal ?? 0)}</div>
              </div>
            </div>
            {catLoading ? (
              <div className="h-[200px] flex items-center justify-center text-slate-400 text-sm font-medium">
                Loading categories…
              </div>
            ) : (
              <CatChart data={byCategory.rows} />
            )}
          </div>
        </div>

        {/* Recent transactions */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 md:p-6">
          <div className="flex items-center justify-between mb-4 gap-3">
            <div>
              <h3 className="font-black text-lg text-slate-900 flex items-center gap-2">
                <History className="h-5 w-5 text-slate-600" /> Recent transactions
              </h3>
              <p className="text-sm text-slate-500">Latest successful fee payments.</p>
            </div>
            <button
              onClick={() => exportCollections('csv')}
              disabled={exportLoading}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold px-3.5 py-2 text-sm ring-1 ring-slate-200"
            >
              <Download className="h-4 w-4" /> Full report
            </button>
          </div>
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="py-3 px-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Date</th>
                  <th className="py-3 px-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Student</th>
                  <th className="py-3 px-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Purpose</th>
                  <th className="py-3 px-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Reference</th>
                  <th className="py-3 px-3 text-right text-xs font-bold text-slate-500 uppercase tracking-wider">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summaryLoading && (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-sm text-slate-400 font-medium">
                      Loading transactions…
                    </td>
                  </tr>
                )}
                {!summaryLoading && (!summary.recentTransactions || summary.recentTransactions.length === 0) && (
                  <tr>
                    <td colSpan={5} className="py-12 text-center">
                      <div className="flex flex-col items-center gap-2">
                        <Banknote className="h-9 w-9 text-slate-300" />
                        <p className="text-sm font-semibold text-slate-700">No recent fee payments</p>
                        <p className="text-xs text-slate-500">Successful transactions will appear here.</p>
                      </div>
                    </td>
                  </tr>
                )}
                {summary.recentTransactions?.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50/60">
                    <td className="py-3 px-3 whitespace-nowrap text-sm text-slate-600">
                      {new Date(t.createdAt).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap">
                      <div className="text-sm font-semibold text-slate-800">{t.student?.name || '—'}</div>
                      <div className="text-xs text-slate-500 font-mono">{t.student?.matricNumber || '—'}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="text-sm font-semibold text-slate-800">{t.invoice?.feeName || t.type || '—'}</div>
                      <div className="text-xs text-slate-500 font-mono">{t.invoice?.invoiceNumber || ''}</div>
                    </td>
                    <td className="py-3 px-3 text-sm text-slate-600 font-mono">{t.reference}</td>
                    <td className="py-3 px-3 whitespace-nowrap text-right text-sm font-black text-slate-900">
                      {naira(t.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      <Modal
        isOpen={alertModal.isOpen}
        onClose={() => setAlertModal({ ...alertModal, isOpen: false })}
        title={alertModal.title}
        footer={
          <button
            onClick={() => setAlertModal({ ...alertModal, isOpen: false })}
            className={`px-6 py-2 rounded-xl font-black text-white shadow-md transition-all ${
              alertModal.type === 'success'
                ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-200'
                : 'bg-rose-600 hover:bg-rose-700 shadow-rose-200'
            }`}
          >
            Acknowledge
          </button>
        }
      >
        <div className="py-4">
          <p className="text-slate-700 text-lg">{alertModal.message}</p>
        </div>
      </Modal>
    </PortalShell>
  );
};

export default BursaryDashboard;
