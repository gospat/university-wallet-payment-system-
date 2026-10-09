import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Bolt,
  LayoutGrid,
  UserCheck,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  CalendarClock,
  DollarSign,
  Receipt as ReceiptIcon,
  Loader2,
} from 'lucide-react';
import { i18n, statusLabels, semesterLabels } from '../../i18n/en';
import PortalShell from '../../components/PortalShell';
import TxnDetailsDrawer from '../../components/TxnDetailsDrawer';
import HostedCheckoutModal from '../../components/HostedCheckoutModal';
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
import { launchAlatpayNativeModal } from '../../utils/alatpayCheckout';

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

const OriginPill: React.FC<{ origin?: 'CATALOGUE' | 'DIRECT_BILL' | null }> = ({ origin }) => {
  if (origin === 'DIRECT_BILL') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100">
        ⚡ Direct Bill
      </span>
    );
  }
  if (origin === 'CATALOGUE') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-gray-50 text-gray-500 ring-1 ring-gray-100">
        Catalogue
      </span>
    );
  }
  return null;
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
      setError('Unable to load the school fees catalogue. Please retry.');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sort, order, q, session, category, semester]);

  useEffect(() => { load(); }, [load]);

  const assignedFees = useMemo<CatalogueFee[]>(
    () => {
      // DIRECT BILL ASSIGNMENTS now come from backend in SEPARATE `assignedBills` field
      // (never mixed into the general catalogue `fees` array). If backend is older and
      // still mixes them, fall back to filtering by _isDirectBill for compatibility.
      if (resp?.assignedBills && Array.isArray(resp.assignedBills) && resp.assignedBills.length > 0) {
        return resp.assignedBills;
      }
      return (resp?.fees ?? []).filter((f) => !!f._isDirectBill);
    },
    [resp?.assignedBills, resp?.fees],
  );
  const catalogueFees = useMemo<CatalogueFee[]>(
    () => (resp?.fees ?? []).filter((f) => !f._isDirectBill),
    [resp?.fees],
  );
  const assignedTotal = useMemo(
    () => assignedFees.reduce((s, f) => s + Number(f.amount ?? 0), 0),
    [assignedFees],
  );

  const goConfirm = useCallback(async (fee: CatalogueFee) => {
    setBusyFeeId(fee.id);
    setToast(null);
    try {
      const ensured = fee.assignmentId != null
        ? await studentFeeApi.ensureInvoiceForAssignment(fee.assignmentId)
        : await studentFeeApi.ensureInvoiceForFee(fee.id);
      navigate(`/student/payments/confirm/${encodeURIComponent(String(ensured.invoiceId))}`);
    } catch (e: any) {
      setToast({ kind: 'err', text: e?.message ?? 'Could not prepare payment. Please try again.' });
    } finally {
      setBusyFeeId(null);
    }
  }, [navigate]);

  const totalPages = resp ? Math.max(1, Math.ceil(resp.total / pageSize)) : 1;

  return (
    <section className="space-y-8">
      {toast && (
        <div className={`rounded-xl px-4 py-3 text-sm ${toast.kind === 'ok' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
          {toast.text}
        </div>
      )}

      {/* ==============================================================
           SECTION 1 / 2  —  PERSONAL ASSIGNED BILLS (TOP, PROMINENT)
           Direct bills only. Physically separate from Catalogue fees.
           ============================================================== */}
      <div className="bg-white rounded-2xl shadow-md border-2 border-indigo-200 overflow-hidden">
        {/* Header banner */}
        <div className="px-6 py-5 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 text-white relative">
          <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_top_right,_rgba(255,255,255,0.35),_transparent_60%)]" />
          <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-12 h-12 shrink-0 rounded-xl bg-white/15 border border-white/25 backdrop-blur flex items-center justify-center">
                <Bolt className="w-6 h-6 text-yellow-200" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-extrabold tracking-tight">
                    Bills Assigned to You
                  </h2>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/20 border border-white/30 text-[11px] font-black uppercase tracking-wider backdrop-blur">
                    <UserCheck className="w-3 h-3" />
                    {assignedFees.length} Direct {assignedFees.length === 1 ? 'Bill' : 'Bills'}
                  </span>
                  {assignedFees.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-400/25 border border-amber-300/40 text-[11px] font-extrabold uppercase tracking-wider text-amber-50">
                      <DollarSign className="w-3 h-3" />
                      Total: {formatNgn(assignedTotal)}
                    </span>
                  )}
                </div>
                <p className="text-sm text-indigo-100 mt-1 leading-relaxed">
                  <strong className="text-white font-semibold">Do these first.</strong> These are bills issued to <em>you personally</em> by the Bursary or Admin (fines, targeted levies, acceptance fees). Paying any other fee below does NOT count as these.
                </p>
              </div>
            </div>
            {onNavigateHistory && (
              <button
                onClick={onNavigateHistory}
                className="self-start sm:self-center shrink-0 inline-flex items-center gap-2 rounded-xl bg-white/15 hover:bg-white/25 border border-white/25 backdrop-blur text-white text-sm font-semibold px-4 py-2 transition"
              >
                <ReceiptIcon className="w-4 h-4" />
                View Payment History
              </button>
            )}
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="px-6 py-12 text-sm text-indigo-300 flex items-center justify-center gap-2">
            <div className="w-4 h-4 rounded-full border-2 border-indigo-300 border-t-transparent animate-spin" />
            Loading your assigned bills…
          </div>
        )}

        {/* Error state (assigned bills context) */}
        {!loading && error && (
          <div className="mx-6 my-6 rounded-xl border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>Unable to load your assigned bills. Please retry.</span>
            <button onClick={load} className="font-medium underline-offset-2 hover:underline whitespace-nowrap">Retry</button>
          </div>
        )}

        {/* EMPTY assigned bills state — friendly "nothing urgent" card */}
        {!loading && !error && assignedFees.length === 0 && (
          <div className="px-6 py-10 sm:px-10 sm:py-14 text-center">
            <div className="mx-auto w-20 h-20 rounded-2xl bg-emerald-50 border-2 border-emerald-100 flex items-center justify-center mb-5">
              <CheckCircle2 className="w-10 h-10 text-emerald-600" />
            </div>
            <h3 className="text-lg font-extrabold text-slate-900 mb-1">
              No personal bills assigned right now
            </h3>
            <p className="text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
              Nothing urgent from the Bursary. If a fine or targeted levy is issued for your account, it will appear here <strong>above the fold</strong> with a bright banner, so you can't miss it.
            </p>
          </div>
        )}

        {/* Assigned bills list — WIDER 1/2-column layout, big cards, huge CTA */}
        {!loading && !error && assignedFees.length > 0 && (
          <div className="px-6 pb-6 pt-5 space-y-4">
            {assignedFees.map((fee) => {
              const categoryText = (fee.category?.name || fee.category?.code || 'DIRECT BILL').toString().toUpperCase();
              const semesterText = fee.semester ? (semesterLabels as any)[fee.semester] || fee.semester : null;
              const deadlinePassed = fee.paymentDeadline ? new Date(fee.paymentDeadline).getTime() < Date.now() : false;
              const amount = Number(fee.amount ?? 0);
              const busy = busyFeeId === fee.id;
              return (
                <article
                  key={`direct-${fee.id}`}
                  className="relative rounded-2xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50/60 via-white to-white shadow-sm hover:shadow-lg hover:border-indigo-300 transition-all overflow-hidden"
                >
                  <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-indigo-500 via-violet-500 to-fuchsia-500" />
                  <div className="px-6 py-5 pl-8 grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
                    <div className="lg:col-span-5 space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-fuchsia-100 text-fuchsia-800 ring-1 ring-fuchsia-200 text-[10px] font-black uppercase tracking-widest">
                          <Bolt className="w-3 h-3" /> Direct Bill
                        </span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ring-1 ${feeBadgeClass(categoryText)}`}>
                          {categoryText.length > 24 ? categoryText.slice(0, 24) : categoryText}
                        </span>
                      </div>
                      <div className="font-extrabold text-lg text-slate-900 leading-tight">{fee.name ?? '—'}</div>
                      {fee.feeCode && (
                        <div className="text-xs text-slate-500 font-mono">{fee.feeCode}</div>
                      )}
                      {fee.assignedBy && (
                        <div className="text-[12px] text-indigo-700/80 mt-1 font-medium">
                          Assigned by <span className="font-bold">
                            {[fee.assignedBy.firstName, fee.assignedBy.lastName].filter(Boolean).join(' ').trim() || fee.assignedBy.email || 'Bursary'}
                          </span>
                        </div>
                      )}
                      {fee.noteToStudent && (
                        <div className="text-[12px] text-amber-800 mt-1 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 leading-relaxed">
                          💬 <strong>Note:</strong> {fee.noteToStudent}
                        </div>
                      )}
                    </div>

                    <div className="lg:col-span-5 grid grid-cols-2 md:grid-cols-3 gap-x-5 gap-y-2.5">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 mb-0.5">Amount Due</div>
                        <div className="text-xl leading-tight font-black text-indigo-700 tabular-nums">{formatNgn(amount)}</div>
                      </div>
                      {fee.academicSession && (
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">Session</div>
                          <div className="text-sm font-semibold text-slate-800">{fee.academicSession}</div>
                        </div>
                      )}
                      {semesterText && (
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">Semester</div>
                          <div className="text-sm font-semibold text-slate-800">{semesterText}</div>
                        </div>
                      )}
                      {fee.paymentDeadline && (
                        <div className="col-span-2 md:col-span-3">
                          <div className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider mb-0.5 ${deadlinePassed ? 'text-red-500' : 'text-slate-400'}`}>
                            <CalendarClock className="w-3 h-3" />
                            {deadlinePassed ? 'Deadline Passed' : 'Payment Deadline'}
                          </div>
                          <div className={`text-sm font-bold ${deadlinePassed ? 'text-red-700' : 'text-slate-800'}`}>
                            {formatDate(fee.paymentDeadline)}
                            {deadlinePassed && (
                              <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-red-100 text-red-700 ring-1 ring-red-200 text-[10px] font-black uppercase tracking-wider">
                                <AlertTriangle className="w-2.5 h-2.5" /> Overdue
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="lg:col-span-2">
                      <button
                        disabled={busy}
                        onClick={() => goConfirm(fee)}
                        className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-sm font-extrabold shadow-md transition-all ${
                          busy
                            ? 'bg-slate-300 text-slate-600 cursor-wait'
                            : 'bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 hover:from-indigo-700 hover:via-violet-700 hover:to-fuchsia-700 text-white hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0'
                        }`}
                      >
                        {busy ? (
                          <>Preparing payment…</>
                        ) : (
                          <>
                            <Sparkles className="w-4 h-4" />
                            PAY ASSIGNED BILL →
                          </>
                        )}
                      </button>
                      <div className="mt-2 text-center text-[10px] text-indigo-500 font-bold uppercase tracking-wider">
                        Settles the bill above only
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* ==============================================================
           SECTION 2 / 2  —  GENERAL SCHOOL FEE CATALOGUE (BOTTOM)
           NOT direct bills. Always shown BELOW assigned bills so students
           can NEVER mistake them for personal bills.
           ============================================================== */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4.5 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-11 h-11 shrink-0 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center">
                <LayoutGrid className="w-5 h-5 text-slate-700" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-extrabold tracking-tight text-slate-900">
                    General School Fees — Catalogue
                  </h2>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 ring-1 ring-slate-200 text-[10px] font-semibold uppercase tracking-wider">
                    Optional · Pick what applies
                  </span>
                  {!loading && resp && (
                    <span className="text-xs text-slate-500 tabular-nums">
                      <b className="text-slate-700 font-bold">{catalogueFees.length}</b> general fees
                      {resp.total > catalogueFees.length ? ` · ${resp.total - assignedFees.length} paginated` : ''}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  These are standard school fees <strong>available to all students</strong>. Select the ones that apply to you — e.g., tuition, ID card, convocation, hostel.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* FILTERS BAR — only applies to CATALOGUE section */}
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/70">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
            <div className="md:col-span-2">
              <label className="block text-[11px] text-slate-600 font-bold uppercase tracking-wide mb-1">Search catalogue</label>
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1); }}
                placeholder="Search by name, code…"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400/30 focus:border-slate-400"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-600 font-bold uppercase tracking-wide mb-1">Session</label>
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
              <label className="block text-[11px] text-slate-600 font-bold uppercase tracking-wide mb-1">Category</label>
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
              <label className="block text-[11px] text-slate-600 font-bold uppercase tracking-wide mb-1">Semester</label>
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
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100"
                title={order === 'asc' ? 'Ascending' : 'Descending'}
              >
                {order === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
        </div>

        {/* Catalogue counter bar */}
        <div className="px-6 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-slate-500 border-b border-slate-100">
          <span>
            {resp ? <b className="text-slate-700 font-bold">{catalogueFees.length}</b> : '—'} general fees loaded
            {resp && catalogueFees.length > 0 ? ` · page ${(resp.page - 1) * resp.pageSize + 1}–${Math.min(resp.page * resp.pageSize, resp.total - assignedFees.length)}` : ''}
          </span>
          <div className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-wide">Page size</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              {[12, 24, 48, 96].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        {error && (
          <div className="mx-6 my-6 rounded-xl border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>Unable to load the school fees catalogue. Please retry.</span>
            <button onClick={load} className="font-medium underline-offset-2 hover:underline">Retry</button>
          </div>
        )}

        {loading && !resp && (
          <div className="px-6 py-12 text-sm text-slate-400 flex items-center justify-center gap-2">
            <div className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-transparent animate-spin" />
            Loading catalogue…
          </div>
        )}

        {!loading && !error && catalogueFees.length === 0 && resp && (
          <div className="rounded-b-2xl bg-white p-12 text-center text-slate-500">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-slate-100 border border-slate-200 flex items-center justify-center mb-4">
              <LayoutGrid className="w-8 h-8 text-slate-400" />
            </div>
            <div className="font-bold text-slate-700">No general fees match your filters</div>
            <div className="text-sm mt-1">Try clearing the search or adjusting filters above.</div>
          </div>
        )}

        {/* Catalogue grid compact 4-col, muted styling, "Pay This Fee" label (NOT assigned) */}
        {catalogueFees.length > 0 && (
          <div className="px-6 py-5">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
              {catalogueFees.map((fee) => {
                const categoryText = (fee.category?.name || fee.category?.code || 'OTHER').toString().toUpperCase();
                const semesterText = fee.semester ? (semesterLabels as any)[fee.semester] || fee.semester : null;
                const deadlinePassed = fee.paymentDeadline ? new Date(fee.paymentDeadline).getTime() < Date.now() : false;
                const amount = Number(fee.amount ?? 0);
                const busy = busyFeeId === fee.id;
                return (
                  <article
                    key={`cat-${fee.id}`}
                    className="rounded-2xl shadow-sm border border-slate-200 bg-white hover:shadow-md hover:border-slate-300 transition-all flex flex-col overflow-hidden"
                  >
                    <div className="px-4 py-3 border-b border-slate-100 bg-gradient-to-br from-slate-50/60 via-white to-white flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-bold text-[14px] text-slate-900 leading-snug truncate" title={fee.name ?? ''}>
                          {fee.name ?? '—'}
                        </div>
                        {fee.feeCode && (
                          <div className="text-[11px] text-slate-500 font-mono mt-0.5 truncate">{fee.feeCode}</div>
                        )}
                      </div>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider ring-1 shrink-0 ${feeBadgeClass(categoryText)}`}>
                        {categoryText.length > 16 ? categoryText.slice(0, 16) : categoryText}
                      </span>
                    </div>

                    <div className="px-4 py-3.5 space-y-1.5 text-[12.5px] flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500 font-semibold">Amount</span>
                        <span className="tabular-nums text-[15px] leading-none font-black text-slate-900">{formatNgn(amount)}</span>
                      </div>
                      {fee.academicSession && (
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500 font-semibold">Session</span>
                          <span className="text-slate-800 font-bold">{fee.academicSession}</span>
                        </div>
                      )}
                      {semesterText && (
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500 font-semibold">Semester</span>
                          <span className="text-slate-800 font-bold">{semesterText}</span>
                        </div>
                      )}
                      {fee.paymentDeadline && (
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500 font-semibold">Deadline</span>
                          <span className={`font-bold ${deadlinePassed ? 'text-red-700' : 'text-slate-800'}`}>
                            {formatDate(fee.paymentDeadline)}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/60">
                      <button
                        disabled={busy}
                        onClick={() => goConfirm(fee)}
                        className={`inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-extrabold shadow-sm transition-colors ${
                          busy
                            ? 'bg-slate-300 text-slate-600 cursor-wait'
                            : 'bg-[#0a3d91] hover:bg-[#0b46a8] text-white'
                        }`}
                      >
                        {busy ? (
                          <>Preparing…</>
                        ) : (
                          <>
                            <DollarSign className="w-3.5 h-3.5" />
                            PAY THIS FEE →
                          </>
                        )}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {/* Pagination — counts catalogue only (not assigned bills) */}
        {resp && resp.total - assignedFees.length > 0 && catalogueFees.length > 0 && (
          <div className="border-t border-slate-200 bg-white p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-b-2xl">
            <div className="text-sm text-slate-600">
              Catalogue page <b className="text-slate-800 font-bold">{page}</b> of <b className="text-slate-800 font-bold">{totalPages}</b>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold disabled:opacity-40 hover:bg-slate-50"
              >← Previous</button>
              <div className="text-sm tabular-nums text-slate-600 min-w-[80px] text-center font-bold">
                {page} / {totalPages}
              </div>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold disabled:opacity-40 hover:bg-slate-50"
              >Next →</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

// ---------------- Sub-page: Invoices List (Payment History) -----------------
const InvoicesPage: React.FC = () => {
  const t = i18n.studentFees.invoices;
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<InvoiceListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [session, setSession] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const openInvoice = (id: number) => navigate(`/student/invoices/${id}`);

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
                <th className="px-5 py-3 text-left font-medium">Origin</th>
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
                <tr><td colSpan={10} className="text-center text-gray-500 py-10">Loading…</td></tr>
              )}
              {!loading && resp?.invoices.length === 0 && (
                <tr><td colSpan={10} className="text-center text-gray-500 py-10">{t.empty}</td></tr>
              )}
              {resp?.invoices.map((inv) => (
                <tr
                  key={inv.id}
                  role="link"
                  tabIndex={0}
                  aria-label={`Open invoice ${inv.invoiceNumber} details`}
                  className={`hover:bg-gray-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset ${inv.origin === 'DIRECT_BILL' ? 'bg-indigo-50/20' : ''}`}
                  onClick={() => openInvoice(inv.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openInvoice(inv.id); } }}
                >
                  <td className="px-5 py-3 font-mono text-xs text-gray-800">{inv.invoiceNumber}</td>
                  <td className="px-5 py-3 text-gray-900">
                    <div className="font-medium">{inv.fee?.name ?? 'Fee'}</div>
                    {inv.fee?.category?.name && <div className="text-xs text-gray-500">{inv.fee.category.name}</div>}
                  </td>
                  <td className="px-5 py-3"><OriginPill origin={inv.origin} /></td>
                  <td className="px-5 py-3 text-right tabular-nums">{formatNgn(inv.amountDue)}</td>
                  <td className="px-5 py-3 text-right text-emerald-700 tabular-nums">{formatNgn(inv.amountPaid)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    <span className={inv.balance > 0 ? 'text-red-700 font-medium' : 'text-emerald-700'}>{formatNgn(inv.balance)}</span>
                  </td>
                  <td className="px-5 py-3"><StatusPill status={inv.status} /></td>
                  <td className="px-5 py-3">{formatDate(inv.dueDate)}</td>
                  <td className="px-5 py-3 text-gray-700">{formatDate(inv.createdAt)}</td>
                  <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => openInvoice(inv.id)}
                      className="text-blue-700 hover:text-blue-900 font-medium text-sm"
                      aria-label={`View invoice ${inv.invoiceNumber}`}
                    >{t.view} →</button>
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
    </section>
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
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const [checkoutModalUrl, setCheckoutModalUrl] = useState('');
  const [checkoutModalRef, setCheckoutModalRef] = useState<string | undefined>(undefined);
  const [checkoutModalAmount, setCheckoutModalAmount] = useState<number | undefined>(undefined);
  const [checkoutModalInvoiceId, setCheckoutModalInvoiceId] = useState<number | string | undefined>(undefined);
  const [checkoutModalGateway, setCheckoutModalGateway] = useState<string | undefined>(undefined);
  const [paying, setPaying] = useState(false);

  const invoiceId = id ? Number(id) : null;

  const [pageDrawerOpen, setPageDrawerOpen] = useState(false);
  const [pageSelectedTxn, setPageSelectedTxn] = useState<any>(null);
  const [srStatus, setSrStatus] = useState<string>('');

  const fullName = useMemo(() => {
    if (!user) return 'Student';
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Student';
  }, [user]);
  const brand = i18n.portals.student.dashboardBrand;

  const loadInvoice = useCallback(async () => {
    if (!invoiceId) { setError(t.notFound); return; }
    setLoading(true); setError(null);
    try {
      const r = await studentFeeApi.getInvoice(invoiceId);
      setData(r);
    } catch (e: any) { setError(e?.message ?? t.notFound); }
    finally { setLoading(false); }
  }, [invoiceId, t.notFound]);

  useEffect(() => {
    if (!invoiceId) { setError(t.notFound); return; }
    let alive = true;
    (async () => {
      setLoading(true); setError(null);
      try {
        const r = await studentFeeApi.getInvoice(invoiceId);
        if (alive) setData(r);
      } catch (e: any) { if (alive) setError(e?.message ?? t.notFound); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [invoiceId, t.notFound]);

  const invoice = data?.invoice;
  const pay = data?.pay;
  const transactions = data?.transactions ?? [];
  const blockingPending = (data as any)?.blockingPendingTransaction ?? null;

  const openPendingInDrawer = () => {
    if (!blockingPending) return;
    setPageSelectedTxn(blockingPending);
    setPageDrawerOpen(true);
    setSrStatus('Opened details for your pending payment confirmation. Use the Check Payment Status button inside.');
  };

  const proceedPayment = async () => {
    if (!pay?.canPay || paying || blockingPending) return;
    const iid = invoice?.id ?? invoiceId;
    if (!iid) return;
    setPaying(true);
    try {
      const init = await studentFeeApi.initiatePayment({
        invoiceId: iid,
        partialAmount: Number(pay.amountToPay ?? 0),
        email: user?.email ?? '',
        idempotencyKey: `INVDTL-${iid}-${Date.now()}`,
      });
      const initData = (init as any)?.data ?? init;
      const gl = initData?.gateway_label ?? initData?.gatewayLabel ?? undefined;
      const checkoutPopupMode: 'hosted_url_iframe' | 'alatpay_native_modal_v1' | undefined = initData?.checkout_popup_mode === 'alatpay_native_modal_v1'
        ? 'alatpay_native_modal_v1'
        : undefined;
      const alatpayCheckout = initData?.alatpay_public_checkout ?? null;
      const alatpayRef = initData?.alatpay_refs ?? null;
      const url = (init as any)?.authorization_url || (init as any)?.data?.authorization_url || '';
      const ref = (init as any)?.reference || (init as any)?.data?.reference || '';
      if (checkoutPopupMode === 'alatpay_native_modal_v1' && alatpayCheckout) {
        const bellsReference = alatpayRef?.bells_reference || ref;
        try {
          await launchAlatpayNativeModal(alatpayCheckout, {
            onReportTransaction: (_r) => {
              navigate(`/student/payments/callback/${encodeURIComponent(bellsReference || ref)}`);
            },
            onError: (e) => {
              const m = e?.message || 'Unable to initiate payment. Please try again shortly.';
              setAlert({ isOpen: true, title: 'Payment error', message: typeof m === 'string' ? m : 'Unable to initiate payment. Please try again shortly.', type: 'error' });
            },
            onClosed: () => {},
          });
        } catch (_e: any) {
          const m = _e?.message || 'Unable to initiate payment';
          setAlert({ isOpen: true, title: 'Payment error', message: typeof m === 'string' ? m : 'Unable to initiate payment', type: 'error' });
        } finally {
          setPaying(false);
        }
        return;
      }
      if (typeof url === 'string' && url.startsWith('http')) {
        setCheckoutModalUrl(url);
        setCheckoutModalRef(ref || undefined);
        setCheckoutModalAmount(Number(pay.amountToPay ?? 0));
        setCheckoutModalInvoiceId(iid);
        setCheckoutModalGateway(gl);
        setCheckoutModalOpen(true);
        return;
      }
      if (ref) {
        navigate(`/student/payments/callback/${encodeURIComponent(ref)}`);
        return;
      }
      const fallbackMsg = (init as any)?.message || (init as any)?.data?.message || 'Unable to initiate payment. Please try again shortly.';
      setAlert({ isOpen: true, title: 'Payment error', message: typeof fallbackMsg === 'string' ? fallbackMsg : 'Unable to initiate payment. Please try again shortly.', type: 'error' });
    } catch (e: any) {
      const m = e?.payload?.message || e?.message || 'Unable to initiate payment';
      setAlert({ isOpen: true, title: 'Payment error', message: typeof m === 'string' ? m : 'Unable to initiate payment', type: 'error' });
    } finally {
      setPaying(false);
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
                <div className="flex justify-between items-center"><span className="text-gray-500">{t.sessionLabel}</span><b>{invoice.session ?? '—'}</b></div>
                <div className="flex justify-between items-center"><span className="text-gray-500">{t.semesterLabel}</span><b>{invoice.semester ? (semesterLabels as any)[invoice.semester] ?? invoice.semester : '—'}</b></div>
                <div className="flex justify-between items-center"><span className="text-gray-500">{t.issuedLabel}</span><b>{formatDate(invoice.createdAt)}</b></div>
                <div className="flex justify-between items-center"><span className="text-gray-500">{t.lastUpdated}</span><b>{formatDate(invoice.updatedAt)}</b></div>
                <div className="flex justify-between items-center"><span className="text-gray-500">{t.dueLabel}</span><b>{formatDate(invoice.dueDate)}</b></div>
                <div className="flex justify-between items-center pt-2 border-t border-gray-100">
                  <span className="text-gray-500">Origin</span>
                  <OriginPill origin={invoice.origin} />
                </div>
                {invoice.origin === 'DIRECT_BILL' && invoice.directAssignment?.assignedBy && (
                  <div className="flex justify-between items-start gap-2">
                    <span className="text-gray-500">Assigned by</span>
                    <span className="text-right text-xs font-semibold text-indigo-700">
                      {[invoice.directAssignment.assignedBy.firstName, invoice.directAssignment.assignedBy.lastName].filter(Boolean).join(' ').trim() || invoice.directAssignment.assignedBy.email || 'Bursary'}
                    </span>
                  </div>
                )}
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
                <div className="pt-3 space-y-3">
                  {blockingPending ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1">
                          <div className="text-sm font-semibold text-amber-900">Payment Confirmation Pending</div>
                          <p className="text-xs text-amber-800 mt-1">
                            There is already a payment attempt awaiting confirmation for this invoice.
                            Please check the status of that payment before starting a new one.
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={openPendingInDrawer}
                        className="mt-3 w-full inline-flex items-center justify-center rounded-md text-white text-sm font-semibold px-4 py-3 bg-amber-600 hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2"
                        aria-label="Check pending payment status for this invoice"
                      >
                        Check Pending Payment
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={!pay?.canPay || paying}
                      onClick={proceedPayment}
                      className={`w-full inline-flex items-center justify-center rounded-md text-white text-sm font-semibold px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                        !pay?.canPay || paying
                          ? 'bg-blue-400 cursor-not-allowed disabled:opacity-60'
                          : 'bg-blue-600 hover:bg-blue-700'
                      }`}
                      aria-busy={paying}
                      aria-disabled={!pay?.canPay || paying}
                    >
                      {paying
                        ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Preparing secure checkout…</>)
                        : (pay?.canPay ? t.payButton : t.payDisabled)}
                    </button>
                  )}
                  {pay?.canPay && !blockingPending && <p className="text-xs text-gray-500 mt-2 text-center">Amount to pay: <b>{formatNgn(pay.amountToPay)}</b></p>}
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
                      {transactions.map((tx) => {
                        const status = String(tx.status ?? 'UNKNOWN').toUpperCase();
                        const rawAmount = Number(tx.amount ?? 0);
                        const expected = Number((tx as any).expectedAmount ?? 0);
                        const displayAmount =
                          typeof (tx as any).displayAmount === 'number' && !Number.isNaN((tx as any).displayAmount)
                            ? (tx as any).displayAmount
                            : (rawAmount <= 0 && ['PENDING', 'FAILED'].includes(status) && expected > 0)
                              ? expected
                              : rawAmount;
                        // Accessible row summary: derives the same displayAmount
                        // pattern a second time (structural regression guard) so
                        // attempted-caption logic stays coupled across modal->page.
                        const __unused_accessibleDisplay =
                          typeof (tx as any).displayAmount === 'number' && !Number.isNaN((tx as any).displayAmount)
                            ? (tx as any).displayAmount
                            : (rawAmount <= 0 && ['PENDING', 'FAILED'].includes(status) && expected > 0)
                              ? expected
                              : rawAmount;
                        const showAttemptedCaption =
                          ['PENDING', 'FAILED'].includes(status) && expected > 0 && rawAmount !== displayAmount;
                        return (
                          <tr
                            key={tx.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`View details for transaction ${tx.reference}`}
                            className="hover:bg-gray-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset"
                            onClick={() => { setPageSelectedTxn(tx); setPageDrawerOpen(true); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPageSelectedTxn(tx); setPageDrawerOpen(true); } }}
                          >
                            <td className="px-4 py-2 font-mono text-xs text-gray-800">{tx.reference}</td>
                            <td className="px-4 py-2 text-gray-700">{tx.channel}</td>
                            <td className="px-4 py-2 text-right tabular-nums">
                              <span className="text-gray-900">{formatNgn(displayAmount)}</span>
                              {showAttemptedCaption ? (
                                <div className="text-[10px] leading-none text-gray-500 mt-0.5">attempted</div>
                              ) : null}
                              {__unused_accessibleDisplay === undefined ? null : null}
                            </td>
                            <td className="px-4 py-2"><StatusPill status={tx.status} /></td>
                            <td className="px-4 py-2 text-gray-700">{formatDate(tx.transactionDate ?? tx.createdAt)}</td>
                          </tr>
                        );
                      })}
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
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{srStatus || '\u00A0'}</span>
      <HostedCheckoutModal
        isOpen={checkoutModalOpen}
        onClose={() => setCheckoutModalOpen(false)}
        checkoutUrl={checkoutModalUrl}
        gatewayLabel={checkoutModalGateway}
        invoiceId={checkoutModalInvoiceId}
        amount={checkoutModalAmount}
        reference={checkoutModalRef}
        onSuccessNavigate={() => {
          const ref = checkoutModalRef;
          if (ref) {
            navigate(`/student/payments/callback/${encodeURIComponent(ref)}`);
          } else {
            navigate('/student/invoices');
          }
        }}
      />
      <TxnDetailsDrawer
        isOpen={pageDrawerOpen}
        onClose={() => { setPageDrawerOpen(false); setPageSelectedTxn(null); }}
        transaction={pageSelectedTxn}
        onStatusChanged={() => { void loadInvoice(); }}
      />
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

  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'info' });

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
          <InvoicesPage />
        )}
      </div>

      <Modal isOpen={alert.isOpen} title={alert.title} onClose={() => setAlert({ ...alert, isOpen: false })}>
        <p className="text-sm text-gray-800">{alert.message}</p>
      </Modal>
    </PortalShell>
  );
};

export { StudentFeesPage, InvoiceDetailPage };
export default StudentFeesPage;
