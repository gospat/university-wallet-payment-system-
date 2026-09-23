import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { i18n, statusLabels, semesterLabels } from '../../i18n/en';
import PortalShell from '../../components/PortalShell';
import TxnDetailsDrawer from '../../components/TxnDetailsDrawer';
import { useAuth } from '../../context/AuthContext';
import studentFeeApi, {
  type CatalogueFee,
  type CatalogueQuery,
  type CatalogueResponse,
  type InvoiceListResponse,
  type InvoiceListQuery,
  type InvoiceDetailResponse,
} from '../../services/studentFees';
import Modal from '../../components/Modal';

type AlertState = { isOpen: boolean; title: string; message: string; type: 'success' | 'error' | 'info'; };

const formatNgn = (n: number | string | null | undefined) => {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 2 }).format(v);
};

const formatDate = (d: string | Date | null | undefined) => {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });
};

const StatusPill: React.FC<{ status: string; }> = ({ status }) => {
  const map: Record<string, string> = {
    PAID: 'bg-emerald-100 text-emerald-800',
    PARTIALLY_PAID: 'bg-amber-100 text-amber-800',
    UNPAID: 'bg-gray-100 text-gray-800',
    OVERDUE: 'bg-red-100 text-red-800',
    PENDING: 'bg-sky-100 text-sky-800',
    FAILED: 'bg-red-100 text-red-800',
    CANCELLED: 'bg-gray-200 text-gray-600',
    REFUNDED: 'bg-purple-100 text-purple-800',
    REVERSED: 'bg-rose-100 text-rose-800',
  };
  const cls = map[status] ?? 'bg-gray-100 text-gray-800';
  const label = (statusLabels as any)[status] ?? status;
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>{label}</span>;
};

const FEE_BADGE_COLORS: Record<string, string> = {
  TUITION: 'bg-blue-50 text-blue-700 ring-blue-100',
  HOSTEL: 'bg-purple-50 text-purple-700 ring-purple-100',
  REGISTRATION: 'bg-indigo-50 text-indigo-700 ring-indigo-100',
  ACCEPTANCE: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  LAB_PRACTICAL: 'bg-cyan-50 text-cyan-700 ring-cyan-100',
  LIBRARY: 'bg-teal-50 text-teal-700 ring-teal-100',
  SPORTS: 'bg-green-50 text-green-700 ring-green-100',
  MEDICAL: 'bg-rose-50 text-rose-700 ring-rose-100',
  SUG: 'bg-amber-50 text-amber-700 ring-amber-100',
  PROJECT_THESIS: 'bg-orange-50 text-orange-700 ring-orange-100',
  SIWES: 'bg-sky-50 text-sky-700 ring-sky-100',
  MATRIC_CONVOCATION: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-100',
  IDCARD: 'bg-slate-50 text-slate-700 ring-slate-100',
  EXAMINATION: 'bg-violet-50 text-violet-700 ring-violet-100',
  DEVELOPMENT_LEVY: 'bg-lime-50 text-lime-700 ring-lime-100',
};

const feeBadgeClass = (category?: string | null): string => {
  if (!category) return 'bg-gray-50 text-gray-700 ring-gray-100';
  const upper = String(category).toUpperCase();
  return FEE_BADGE_COLORS[upper] ?? 'bg-slate-50 text-slate-700 ring-slate-100';
};

// ---------------- Sub-page: Browse Catalogue (Make Payment) ----------------
type BrowseCataloguePageProps = { onNavigateHistory?: () => void };
const BrowseCataloguePage: React.FC<BrowseCataloguePageProps> = ({ onNavigateHistory }) => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resp, setResp] = useState<CatalogueResponse | null>(null);

  const [q, setQ] = useState<string>('');
  const [session, setSession] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [semester, setSemester] = useState<'' | 'FIRST' | 'SECOND'>('');
  const [sort, setSort] = useState<CatalogueQuery['sort']>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);

  const [busyFeeId, setBusyFeeId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const sessions = useMemo(() => {
    const s = new Set<string>();
    resp?.fees.forEach((f) => { if (f.academicSession) s.add(f.academicSession); });
    return Array.from(s).sort((a, b) => b.localeCompare(a));
  }, [resp]);

  const categories = useMemo(() => {
    const s = new Set<string>();
    resp?.fees.forEach((f) => {
      const c = f.category?.name || f.category?.code || null;
      if (c) s.add(String(c));
    });
    return Array.from(s).sort();
  }, [resp]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query: CatalogueQuery = { page, pageSize, sort, order };
      if (q.trim()) query.q = q.trim();
      if (session) query.session = session;
      if (category) query.category = category;
      if (semester) query.semester = semester;
      const data = await studentFeeApi.catalogue(query);
      const normalised: CatalogueResponse = data.fees
        ? data
        : { fees: (data as any).rows ?? [], total: (data as any).total ?? 0, page: (data as any).page ?? 1, pageSize: (data as any).pageSize ?? 12 };
      setResp(normalised);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load available payments');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sort, order, q, session, category, semester]);

  useEffect(() => { load(); }, [load]);

  const goConfirm = useCallback(async (fee: CatalogueFee) => {
    setBusyFeeId(fee.id);
    setToast(null);
    try {
      const ensured = await studentFeeApi.ensureInvoiceForFee(fee.id);
      navigate(`/student/payments/confirm/${encodeURIComponent(String(ensured.invoiceId))}`);
    } catch (e: any) {
      setToast({ kind: 'err', text: e?.message ?? 'Could not prepare payment. Please try again.' });
    } finally {
      setBusyFeeId(null);
    }
  }, [navigate]);

  const totalPages = resp ? Math.max(1, Math.ceil(resp.total / pageSize)) : 1;

  return (
    <section className="space-y-6">
      {/* Intro / filters */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Available Payments</h2>
            <p className="text-sm text-slate-500 mt-1">
              Pick the fee applicable to you and click <b>Pay Now</b>. Newly created fees by the Bursary appear here automatically.
            </p>
          </div>
          {onNavigateHistory && (
            <button
              onClick={onNavigateHistory}
              className="self-start sm:self-end inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-semibold px-3.5 py-2 shadow-sm"
            >
              View Payment History
            </button>
          )}
        </div>

        {toast && (
          <div className={`rounded-lg px-4 py-3 text-sm ${toast.kind === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
            {toast.text}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
          <div className="md:col-span-2">
            <label className="block text-xs text-slate-600 font-semibold mb-1">Search</label>
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
              placeholder="Search by name, code…"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0a3d91]/20 focus:border-[#0a3d91]"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 font-semibold mb-1">Session</label>
            <select
              value={session}
              onChange={(e) => { setSession(e.target.value); setPage(1); }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              <option value="">All Sessions</option>
              {sessions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-600 font-semibold mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => { setCategory(e.target.value); setPage(1); }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              <option value="">All Categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-600 font-semibold mb-1">Semester</label>
            <select
              value={semester}
              onChange={(e) => { setSemester(e.target.value as any); setPage(1); }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              <option value="">All</option>
              <option value="FIRST">First Semester</option>
              <option value="SECOND">Second Semester</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sort ?? 'createdAt'}
              onChange={(e) => setSort(e.target.value as any)}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            >
              <option value="createdAt">Newest</option>
              <option value="name">Name</option>
              <option value="feeCode">Code</option>
              <option value="academicSession">Session</option>
              <option value="amount">Amount</option>
            </select>
            <button
              onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              title={order === 'asc' ? 'Ascending' : 'Descending'}
            >
              {order === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            {resp ? <b className="text-slate-700">{resp.total}</b> : '—'} fees available
            {resp && resp.fees.length > 0 ? ` · showing ${(resp.page - 1) * resp.pageSize + 1}–${Math.min(resp.page * resp.pageSize, resp.total)}` : ''}
          </span>
          <div className="flex items-center gap-2">
            <span>Page size</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              {[12, 24, 48, 96].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={load} className="font-medium underline-offset-2 hover:underline">Retry</button>
        </div>
      )}

      {!loading && !error && resp && resp.fees.length === 0 && (
        <div className="rounded-2xl bg-white border border-slate-200 p-12 text-center text-slate-500">
          No fees available. Check back later or adjust the filters.
        </div>
      )}

      {/* Fee Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {resp?.fees.map((fee) => {
          const categoryText = (fee.category?.name || fee.category?.code || 'OTHER').toString().toUpperCase();
          const semesterText = fee.semester ? (semesterLabels as any)[fee.semester] || fee.semester : null;
          const deadlinePassed = fee.paymentDeadline ? new Date(fee.paymentDeadline).getTime() < Date.now() : false;
          const amount = Number(fee.amount ?? 0);
          const busy = busyFeeId === fee.id;
          return (
            <article
              key={fee.id}
              className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md hover:border-[#0a3d91]/30 transition-all flex flex-col"
            >
              <div className="px-5 py-4 border-b border-slate-100 bg-gradient-to-br from-slate-50 via-white to-white flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-bold text-slate-900 truncate" title={fee.name ?? ''}>{fee.name ?? '—'}</div>
                  {fee.feeCode && (
                    <div className="text-xs text-slate-500 mt-1 font-mono truncate">{fee.feeCode}</div>
                  )}
                </div>
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ring-1 shrink-0 ${feeBadgeClass(categoryText)}`}>
                  {categoryText.length > 20 ? categoryText.slice(0, 20) : categoryText}
                </span>
              </div>

              <div className="px-5 py-4 space-y-2 text-sm flex-1">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-slate-500 font-medium">Amount</span>
                  <span className="text-slate-900 font-black tabular-nums text-base leading-6">{formatNgn(amount)}</span>
                </div>
                {fee.academicSession && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 font-medium">Session</span>
                    <span className="text-slate-800 font-semibold">{fee.academicSession}</span>
                  </div>
                )}
                {semesterText && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 font-medium">Semester</span>
                    <span className="text-slate-800 font-semibold">{semesterText}</span>
                  </div>
                )}
                {fee.level && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 font-medium">Level</span>
                    <span className="text-slate-800 font-semibold">{fee.level} Level</span>
                  </div>
                )}
                {fee.program && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500 font-medium">Programme</span>
                    <span className="text-slate-800 font-semibold text-right truncate">{fee.program}</span>
                  </div>
                )}
                {fee.college && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500 font-medium">Faculty</span>
                    <span className="text-slate-800 font-semibold text-right truncate">{fee.college}</span>
                  </div>
                )}
                {fee.department && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500 font-medium">Department</span>
                    <span className="text-slate-800 font-semibold text-right truncate">{fee.department}</span>
                  </div>
                )}
                {fee.paymentDeadline && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 font-medium">Deadline</span>
                    <span className={`font-semibold ${deadlinePassed ? 'text-red-700' : 'text-slate-800'}`}>
                      {formatDate(fee.paymentDeadline)}
                    </span>
                  </div>
                )}
              </div>

              <div className="px-5 py-3.5 border-t border-slate-100 bg-slate-50/60">
                <button
                  disabled={busy}
                  onClick={() => goConfirm(fee)}
                  className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-bold shadow-sm transition-colors ${
                    busy
                      ? 'bg-slate-300 text-slate-600 cursor-wait'
                      : 'bg-[#0a3d91] hover:bg-[#0b46a8] text-white'
                  }`}
                >
                  {busy ? (
                    <>Preparing payment…</>
                  ) : (
                    <>PAY NOW →</>
                  )}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {/* Pagination */}
      {resp && resp.total > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-sm text-slate-600">
            Page <b className="text-slate-800">{page}</b> of <b className="text-slate-800">{totalPages}</b>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:bg-slate-50"
            >Previous</button>
            <div className="text-sm tabular-nums text-slate-600 min-w-[80px] text-center">
              {page} / {totalPages}
            </div>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:bg-slate-50"
            >Next</button>
          </div>
        </div>
      )}
    </section>
  );
};

// ---------------- Sub-page: Invoices List (Payment History) -----------------
const InvoicesPage: React.FC<{ onOpenInvoice: (id: number) => void; }> = ({ onOpenInvoice }) => {
  const t = i18n.studentFees.invoices;
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<InvoiceListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [session, setSession] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedTxn, setSelectedTxn] = useState<any>(null);

  const sessions = useMemo(() => {
    const s = new Set<string>();
    resp?.invoices.forEach((inv) => { if (inv.session) s.add(inv.session); });
    return Array.from(s).sort();
  }, [resp]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q: InvoiceListQuery = { page, pageSize };
      if (session) q.session = session;
      if (status) q.status = status;
      if (dateFrom) q.dateFrom = new Date(dateFrom).toISOString();
      if (dateTo) { const d = new Date(dateTo); d.setHours(23,59,59,999); q.dateTo = d.toISOString(); }
      const data = await studentFeeApi.listInvoices(q);
      setResp(data);
    } catch (e: any) { setError(e?.message ?? 'Failed to load invoices'); }
    finally { setLoading(false); }
  }, [page, pageSize, session, status, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const totalPages = resp ? Math.max(1, Math.ceil(resp.total / pageSize)) : 1;

  return (
    <section className="space-y-5">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          <div>
            <label className="text-xs text-gray-600 font-medium">{t.filterSession}</label>
            <select value={session} onChange={(e) => { setSession(e.target.value); setPage(1); }} className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
              <option value="">{t.filterAllSessions}</option>
              {sessions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium">{t.filterStatus}</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
              <option value="">{t.filterAllStatuses}</option>
              {(['UNPAID','PARTIALLY_PAID','PAID','OVERDUE','PENDING','FAILED','CANCELLED','REFUNDED','REVERSED'] as const).map((s) => <option key={s} value={s}>{(statusLabels as any)[s] ?? s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium">{t.filterDateFrom}</label>
            <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-600 font-medium">{t.filterDateTo}</label>
            <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <button type="button" onClick={() => { setSession(''); setStatus(''); setDateFrom(''); setDateTo(''); setPage(1); }} className="w-full text-sm bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-md px-3 py-2">Clear Filters</button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-3 flex justify-between">
          <span>{error}</span>
          <button onClick={load} className="text-sm font-medium underline hover:underline">Retry</button>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-5 py-3 text-left font-medium">{t.headerNumber}</th>
                <th className="px-5 py-3 text-left font-medium">{t.headerFee}</th>
                <th className="px-5 py-3 text-right font-medium">{t.headerAmount}</th>
                <th className="px-5 py-3 text-right font-medium">{t.headerPaid}</th>
                <th className="px-5 py-3 text-right font-medium">{t.headerBalance}</th>
                <th className="px-5 py-3 text-left font-medium">{t.headerStatus}</th>
                <th className="px-5 py-3 text-left font-medium">{t.headerDue}</th>
                <th className="px-5 py-3 text-left font-medium">{t.headerCreated}</th>
                <th className="px-5 py-3 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && !resp && (
                <tr><td colSpan={9} className="text-center text-gray-500 py-10">Loading…</td></tr>
              )}
              {!loading && resp?.invoices.length === 0 && (
                <tr><td colSpan={9} className="text-center text-gray-500 py-10">{t.empty}</td></tr>
              )}
              {resp?.invoices.map((inv) => (
                <tr
                  key={inv.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => { setSelectedTxn(inv); setDrawerOpen(true); }}
                >
                  <td className="px-5 py-3 font-mono text-xs text-gray-800">{inv.invoiceNumber}</td>
                  <td className="px-5 py-3 text-gray-900">
                    <div className="font-medium">{inv.fee?.name ?? 'Fee'}</div>
                    {inv.fee?.category?.name && <div className="text-xs text-gray-500">{inv.fee.category.name}</div>}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{formatNgn(inv.amountDue)}</td>
                  <td className="px-5 py-3 text-right text-emerald-700 tabular-nums">{formatNgn(inv.amountPaid)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    <span className={inv.balance > 0 ? 'text-red-700 font-medium' : 'text-emerald-700'}>{formatNgn(inv.balance)}</span>
                  </td>
                  <td className="px-5 py-3"><StatusPill status={inv.status} /></td>
                  <td className="px-5 py-3">{formatDate(inv.dueDate)}</td>
                  <td className="px-5 py-3 text-gray-700">{formatDate(inv.createdAt)}</td>
                  <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <button type="button" onClick={() => onOpenInvoice(inv.id)} className="text-blue-700 hover:text-blue-900 font-medium text-sm">{t.view} →</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <label>{t.page}</label>
            <input type="number" min={1} value={page} onChange={(e) => setPage(Math.max(1, Number(e.target.value) || 1))} className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm" />
            <span>{t.of} {totalPages}</span>
            <label className="ml-4">{t.pageSize}</label>
            <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="rounded-md border border-gray-300 px-2 py-1 text-sm">
              {[10,25,50,100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))} className="px-3 py-1 rounded-md text-sm border border-gray-300 disabled:opacity-40">{t.prev}</button>
            <button disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 rounded-md text-sm border border-gray-300 disabled:opacity-40">{t.next}</button>
          </div>
        </div>
      </div>

      <TxnDetailsDrawer
        isOpen={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedTxn(null); }}
        transaction={selectedTxn}
      />
    </section>
  );
};

// ---------------- Sub-page: Invoice Detail ----------------
const InvoiceDetailModal: React.FC<{
  open: boolean;
  invoiceId: number | null;
  onClose: () => void;
  onOpenStandalone: (id: number) => void;
}> = ({ open, invoiceId, onClose, onOpenStandalone }) => {
  const t = i18n.studentFees.invoiceDetail;
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<InvoiceDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !invoiceId) { setData(null); setError(null); return; }
    let alive = true;
    const run = async () => {
      setLoading(true); setError(null);
      try {
        const r = await studentFeeApi.getInvoice(invoiceId);
        if (alive) setData(r);
      } catch (e: any) { if (alive) setError(e?.message ?? 'Invoice not found'); }
      finally { if (alive) setLoading(false); }
    };
    run();
    return () => { alive = false; };
  }, [open, invoiceId]);

  const invoice = data?.invoice;
  const pay = data?.pay;
  const transactions = data?.transactions ?? [];

  return (
    <Modal
      isOpen={open}
      title={invoice ? t.pageSubtitle(invoice.invoiceNumber) : t.pageTitle}
      onClose={onClose}
    >
      <div className="space-y-6">
        {loading && <p className="text-gray-500">Loading invoice…</p>}
        {error && !loading && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-3">{t.notFound}</div>
        )}
        {!loading && !error && invoice && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">{t.sessionLabel}</span><b>{invoice.session ?? '—'}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.semesterLabel}</span><b>{invoice.semester ? (semesterLabels as any)[invoice.semester] ?? invoice.semester : '—'}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.issuedLabel}</span><b>{formatDate(invoice.createdAt)}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.lastUpdated}</span><b>{formatDate(invoice.updatedAt)}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.dueLabel}</span><b>{formatDate(invoice.dueDate)}</b></div>
              </div>
              <div className="bg-white border border-gray-100 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">{t.amountDueLabel}</span><b className="tabular-nums">{formatNgn(invoice.amountDue)}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.amountPaidLabel}</span><b className="tabular-nums text-emerald-700">{formatNgn(invoice.amountPaid)}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.balanceLabel}</span><b className={`tabular-nums ${invoice.balance > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{formatNgn(invoice.balance)}</b></div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">{t.statusLabel}</span>
                  <StatusPill status={invoice.status} />
                </div>
                <div className="pt-3 border-t border-gray-100">
                  <button
                    type="button"
                    disabled={!pay?.canPay}
                    onClick={() => pay?.canPay && onOpenStandalone(invoice.id)}
                    className={pay?.canPay
                      ? 'w-full inline-flex items-center justify-center rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2'
                      : 'w-full inline-flex items-center justify-center rounded-md bg-gray-200 text-gray-500 text-sm font-semibold px-4 py-2 cursor-not-allowed'}
                  >
                    {pay?.canPay ? t.payButton : t.payDisabled}
                  </button>
                  {pay?.canPay && (
                    <p className="text-xs text-gray-500 mt-2 text-center">
                      You will be redirected to pay {formatNgn(pay.amountToPay)}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-2">{t.historyTitle}</h4>
              {transactions.length === 0 ? (
                <div className="text-sm text-gray-500 bg-white border border-gray-100 rounded-lg px-4 py-6 text-center">{t.historyEmpty}</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-100">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium">{t.historyTxn}</th>
                        <th className="px-4 py-2 text-left font-medium">{t.historyChannel}</th>
                        <th className="px-4 py-2 text-right font-medium">{t.historyAmount}</th>
                        <th className="px-4 py-2 text-left font-medium">{t.historyStatus}</th>
                        <th className="px-4 py-2 text-left font-medium">{t.historyDate}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {transactions.map((tx) => (
                        <tr key={tx.id}>
                          <td className="px-4 py-2 font-mono text-xs text-gray-800">{tx.reference}</td>
                          <td className="px-4 py-2 text-gray-700">{tx.channel}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNgn(tx.amount)}</td>
                          <td className="px-4 py-2"><StatusPill status={tx.status} /></td>
                          <td className="px-4 py-2 text-gray-700">{formatDate(tx.transactionDate ?? tx.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

// ---------------- Invoice Standalone Page ----------------
const InvoiceDetailPage: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const t = i18n.studentFees.invoiceDetail;
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<InvoiceDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'info' });
  const { user, logout } = useAuth();

  const invoiceId = id ? Number(id) : null;

  const fullName = useMemo(() => {
    if (!user) return 'Student';
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Student';
  }, [user]);
  const brand = i18n.portals.student.dashboardBrand;

  useEffect(() => {
    if (!invoiceId) { setError(t.notFound); return; }
    let alive = true;
    const run = async () => {
      setLoading(true); setError(null);
      try {
        const r = await studentFeeApi.getInvoice(invoiceId);
        if (alive) setData(r);
      } catch (e: any) { if (alive) setError(e?.message ?? t.notFound); }
      finally { if (alive) setLoading(false); }
    };
    run();
    return () => { alive = false; };
  }, [invoiceId, t.notFound]);

  const invoice = data?.invoice;
  const pay = data?.pay;
  const transactions = data?.transactions ?? [];

  const proceedPayment = async () => {
    if (!pay?.canPay) return;
    const iid = invoice?.id ?? invoiceId;
    if (!iid) return;
    try {
      const init = await studentFeeApi.initiatePayment({
        invoiceId: iid,
        partialAmount: Number(pay.amountToPay ?? 0),
        email: user?.email ?? '',
        idempotencyKey: `INVDTL-${iid}-${Date.now()}`,
      });
      const url = (init as any)?.authorization_url || (init as any)?.data?.authorization_url || '';
      if (typeof url === 'string' && url.startsWith('http')) {
        window.location.href = url;
        return;
      }
      const ref = (init as any)?.reference || (init as any)?.data?.reference || '';
      if (ref) {
        navigate(`/student/payments/callback/${encodeURIComponent(ref)}`);
        return;
      }
      const fallbackMsg = (init as any)?.message || (init as any)?.data?.message || 'Unable to initiate payment. Please try again shortly.';
      setAlert({ isOpen: true, title: 'Payment error', message: typeof fallbackMsg === 'string' ? fallbackMsg : 'Unable to initiate payment. Please try again shortly.', type: 'error' });
    } catch (e: any) {
      const m = e?.payload?.message || e?.message || 'Unable to initiate payment';
      setAlert({ isOpen: true, title: 'Payment error', message: typeof m === 'string' ? m : 'Unable to initiate payment', type: 'error' });
    }
  };

  return (
    <PortalShell
      role="STUDENT"
      activePath={location.pathname}
      userPermissions={[]}
      brand={brand}
      userText={fullName}
      userEmail={user?.email}
      onLogout={logout}
      navCounters={{}}
      showGlobalSearch={false}
    >
      <div className="w-full space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <button onClick={() => navigate(-1)} className="text-sm text-blue-700 hover:text-blue-900 mb-2">{t.back}</button>
            <h1 className="text-2xl font-semibold text-gray-900">{t.pageTitle}</h1>
            {invoice && <p className="text-sm text-gray-500 mt-1">{t.pageSubtitle(invoice.invoiceNumber)}</p>}
          </div>
        </div>

        {loading && <p className="text-gray-500 bg-white rounded-xl shadow-sm border border-gray-100 p-6">Loading invoice…</p>}
        {error && !loading && (
          <div className="rounded-xl bg-white border border-red-200 p-6 text-red-800">{t.notFound}<div className="text-xs mt-1 text-gray-500">{error}</div></div>
        )}
        {!loading && !error && invoice && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">{t.sessionLabel}</span><b>{invoice.session ?? '—'}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.semesterLabel}</span><b>{invoice.semester ? (semesterLabels as any)[invoice.semester] ?? invoice.semester : '—'}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.issuedLabel}</span><b>{formatDate(invoice.createdAt)}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.lastUpdated}</span><b>{formatDate(invoice.updatedAt)}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.dueLabel}</span><b>{formatDate(invoice.dueDate)}</b></div>
                <div className="pt-2 border-t border-gray-100">
                  <div className="flex justify-between"><span className="text-gray-500">Fee</span><b className="text-gray-800">{invoice.fee?.name ?? '—'}</b></div>
                  <div className="flex justify-between text-gray-500"><span>Category</span><span>{invoice.fee?.category?.name ?? '—'}</span></div>
                </div>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-2 text-sm">
                <h3 className="font-semibold text-gray-900 mb-1">{t.summaryLabel}</h3>
                <div className="flex justify-between"><span className="text-gray-500">{t.amountDueLabel}</span><b className="tabular-nums">{formatNgn(invoice.amountDue)}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.amountPaidLabel}</span><b className="tabular-nums text-emerald-700">{formatNgn(invoice.amountPaid)}</b></div>
                <div className="flex justify-between"><span className="text-gray-500">{t.balanceLabel}</span><b className={`tabular-nums ${invoice.balance > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{formatNgn(invoice.balance)}</b></div>
                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                  <span className="text-gray-500">{t.statusLabel}</span>
                  <StatusPill status={invoice.status} />
                </div>
                <div className="pt-3">
                  <button
                    type="button"
                    disabled={!pay?.canPay}
                    onClick={proceedPayment}
                    className={pay?.canPay
                      ? 'w-full inline-flex items-center justify-center rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-3'
                      : 'w-full inline-flex items-center justify-center rounded-md bg-gray-200 text-gray-500 text-sm font-semibold px-4 py-3 cursor-not-allowed'}
                  >
                    {pay?.canPay ? t.payButton : t.payDisabled}
                  </button>
                  {pay?.canPay && <p className="text-xs text-gray-500 mt-2 text-center">Amount to pay: <b>{formatNgn(pay.amountToPay)}</b></p>}
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">{t.historyTitle}</div>
              {transactions.length === 0 ? (
                <div className="text-sm text-gray-500 px-5 py-10 text-center">{t.historyEmpty}</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium">{t.historyTxn}</th>
                        <th className="px-4 py-2 text-left font-medium">{t.historyChannel}</th>
                        <th className="px-4 py-2 text-right font-medium">{t.historyAmount}</th>
                        <th className="px-4 py-2 text-left font-medium">{t.historyStatus}</th>
                        <th className="px-4 py-2 text-left font-medium">{t.historyDate}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {transactions.map((tx) => (
                        <tr key={tx.id}>
                          <td className="px-4 py-2 font-mono text-xs text-gray-800">{tx.reference}</td>
                          <td className="px-4 py-2 text-gray-700">{tx.channel}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNgn(tx.amount)}</td>
                          <td className="px-4 py-2"><StatusPill status={tx.status} /></td>
                          <td className="px-4 py-2 text-gray-700">{formatDate(tx.transactionDate ?? tx.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <Modal isOpen={alert.isOpen} title={alert.title} onClose={() => setAlert({ ...alert, isOpen: false })}>
        <p className="text-sm text-gray-800">{alert.message}</p>
      </Modal>
    </PortalShell>
  );
};

// ---------------- Student Fees Root Page ----------------
const StudentFeesPage: React.FC<{ initialTab?: 'browse' | 'history' | 'schedule' | 'invoices'; }> = ({ initialTab = 'browse' }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const active: 'browse' | 'history' = (() => {
    const p = location.pathname;
    if (p.includes('/payment-history') || p.includes('/invoices')) return 'history';
    if (p === '/student/payments' || p.includes('/fees/schedule') || p.includes('/fees')) return 'browse';
    const mapped: any = initialTab;
    if (mapped === 'history' || mapped === 'invoices') return 'history';
    return 'browse';
  })();

  const [modalInvoiceId, setModalInvoiceId] = useState<number | null>(null);
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'info' });

  const openStandalone = (id: number) => {
    setModalInvoiceId(null);
    navigate(`/student/invoices/${id}`);
  };

  const fullName = useMemo(() => {
    if (!user) return 'Student';
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Student';
  }, [user]);
  const brand = i18n.portals.student.dashboardBrand;

  const tabs: Array<{ key: 'browse' | 'history'; label: string; subtitle: string; to: string }> = [
    { key: 'browse', label: 'Make Payment', subtitle: 'Browse all available fees and pick which to pay', to: '/student/payments' },
    { key: 'history', label: 'Payment History', subtitle: 'Past invoices, payments and status', to: '/student/payment-history' },
  ];

  return (
    <PortalShell
      role="STUDENT"
      activePath={location.pathname}
      userPermissions={[]}
      brand={brand}
      userText={fullName}
      userEmail={user?.email}
      onLogout={logout}
      navCounters={{}}
      showGlobalSearch={false}
    >
      <div className="w-full space-y-6">
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              {active === 'browse' ? 'Make Payment' : 'Payment History'}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {active === 'browse'
                ? 'All school fees and charges set by the Bursary. Pick the one applicable to you.'
                : 'Your invoice history: see status, amounts paid, and open payment records.'}
            </p>
          </div>
          <div className="flex items-center bg-white rounded-xl border border-slate-200 p-1 shadow-sm">
            {tabs.map((t) => {
              const isActive = active === t.key;
              return (
                <Link
                  key={t.key}
                  to={t.to}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-[#0a3d91] text-white shadow'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
          </div>
        </header>

        {active === 'browse' ? (
          <BrowseCataloguePage onNavigateHistory={() => navigate('/student/payment-history')} />
        ) : (
          <InvoicesPage onOpenInvoice={(id) => setModalInvoiceId(id)} />
        )}
      </div>

      <InvoiceDetailModal
        open={!!modalInvoiceId}
        invoiceId={modalInvoiceId}
        onClose={() => setModalInvoiceId(null)}
        onOpenStandalone={openStandalone}
      />
      <Modal isOpen={alert.isOpen} title={alert.title} onClose={() => setAlert({ ...alert, isOpen: false })}>
        <p className="text-sm text-gray-800">{alert.message}</p>
      </Modal>
    </PortalShell>
  );
};

export { StudentFeesPage, InvoiceDetailPage };
export default StudentFeesPage;
