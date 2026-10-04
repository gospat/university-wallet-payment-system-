import React, { useEffect, useState, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import {
  Download,
  BookOpen,
  Building2,
  GraduationCap,
  FileText,
  Receipt,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  ChevronRight,
  Layers,
  CircleDollarSign,
  Banknote,
  ArrowRight,
  CreditCard,
  Clock,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Modal from '../../components/Modal';
import PortalShell from '../../components/PortalShell';
import { i18n } from '../../i18n/en';
import studentFeeApi, {
  type InvoiceSummary,
  type ReceiptSummary,
  type FeeScheduleResponse,
} from '../../services/studentFees';

const naira = (v: string | number) => {
  const n = Number(v);
  if (!isFinite(n)) return '₦0.00';
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtDateShort = (d: any) => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
};

const invoiceStatusChip = (s: string) => {
  switch (s) {
    case 'PAID':
      return { label: s, cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10' };
    case 'PARTIALLY_PAID':
      return { label: 'PARTIAL', cls: 'bg-amber-50 text-amber-700 ring-amber-600/10' };
    case 'PENDING':
      return { label: s, cls: 'bg-blue-50 text-blue-700 ring-blue-600/10' };
    case 'FAILED':
    case 'CANCELLED':
    case 'REFUNDED':
    case 'REVERSED':
      return { label: s, cls: 'bg-slate-100 text-slate-600 ring-slate-500/10' };
    case 'UNPAID':
    case 'OVERDUE':
      return { label: s, cls: 'bg-rose-50 text-rose-700 ring-rose-600/10' };
    default:
      return { label: s, cls: 'bg-slate-50 text-slate-600 ring-slate-500/10' };
  }
};

const INVOICE_FILTERS = [
  { key: 'ALL', label: 'All attempts' },
  { key: 'PAID', label: 'Paid' },
  { key: 'PARTIALLY_PAID', label: 'Partial' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

const RECEIPT_FILTERS = [
  { key: 'ALL', label: 'All receipts' },
  { key: 'ACTIVE', label: 'Valid only' },
  { key: 'VOIDED', label: 'Voided only' },
];

const STUDENT_DASH_TABS = [
  { id: 'overview', label: 'Overview', icon: Layers },
  { id: 'invoices', label: 'Payment History', icon: FileText },
  { id: 'receipts', label: 'Receipts', icon: Receipt },
];

type TabId = (typeof STUDENT_DASH_TABS)[number]['id'];

const PAGE_SIZE = 10;

const StudentDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const fullName = useMemo(() => {
    if (!user) return 'Student';
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Student';
  }, [user]);
  const brand = i18n.portals.student.dashboardBrand;

  // ---------- T19: Fee/Invoice/Receipt state --------------------------------
  const [schedule, setSchedule] = useState<FeeScheduleResponse | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<TabId>('overview');

  // Invoices
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [invLoading, setInvLoading] = useState(false);
  const [invTotal, setInvTotal] = useState(0);
  const [invPage, setInvPage] = useState(1);
  const [invFilter, setInvFilter] = useState<string>('PAID');

  // Receipts
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [rcptLoading, setRcptLoading] = useState(false);
  const [rcptTotal, setRcptTotal] = useState(0);
  const [rcptPage, setRcptPage] = useState(1);
  const [rcptFilter, setRcptFilter] = useState<string>('ALL');

  // ---------- Modal State (receipts) -----------------------------
  const [alertModal, setAlertModal] = useState({
    isOpen: false,
    title: '',
    message: '',
    type: 'error' as 'error' | 'success',
  });

  const showAlert = (
    title: string,
    message: string,
    type: 'error' | 'success' = 'error',
  ) => {
    setAlertModal({ isOpen: true, title, message, type });
  };

  // ---------- Derived aggregates from schedule -----------------------------
  const kpis = useMemo(() => {
    const s = schedule?.schedule || [];
    let paid = 0;
    for (const sess of s) {
      paid += Number(sess.totalPaid || 0);
    }
    return { totalPaid: paid };
  }, [schedule]);

  // ---------- Initial load --------------------------------------------------
  useEffect(() => {
    void loadSchedule();
    void loadInvoices(1, invFilter);
    void loadReceipts(1, rcptFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- T19: Data loaders ---------------------------------------------
  const loadSchedule = async () => {
    setScheduleLoading(true);
    try {
      const data = await studentFeeApi.schedule();
      setSchedule(data);
    } catch (err) {
      console.error(err);
    } finally {
      setScheduleLoading(false);
    }
  };

  const loadInvoices = async (page: number, filterKey: string) => {
    setInvLoading(true);
    try {
      const status = filterKey === 'ALL' ? undefined : filterKey;
      const resp = await studentFeeApi.listInvoices({
        page,
        pageSize: PAGE_SIZE,
        status,
        sort: 'createdAt',
        order: 'desc',
      });
      setInvoices(resp.invoices || []);
      setInvTotal(Number(resp.total || 0));
      setInvPage(page);
    } catch (err) {
      console.error(err);
    } finally {
      setInvLoading(false);
    }
  };

  const loadReceipts = async (page: number, filterKey: string) => {
    setRcptLoading(true);
    try {
      const params: any = { page, pageSize: PAGE_SIZE };
      if (filterKey === 'ACTIVE') params.isVoided = 'false';
      if (filterKey === 'VOIDED') params.isVoided = 'true';
      const resp = await studentFeeApi.listReceipts(params);
      setReceipts(resp.items || []);
      setRcptTotal(Number(resp.total || 0));
      setRcptPage(page);
    } catch (err) {
      console.error(err);
    } finally {
      setRcptLoading(false);
    }
  };

  const downloadFormalReceipt = async (r: ReceiptSummary) => {
    if (r.isVoided) {
      showAlert('Receipt Voided', 'This receipt was voided and cannot be downloaded. Contact Bursary for a replacement.');
      return;
    }
    try {
      const token = localStorage.getItem('token') ?? '';
      const response = await api.get(`/students/receipts/${r.id}/download`, {
        responseType: 'blob',
        headers: { Accept: 'application/pdf', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `receipt_${r.receiptNumber || r.id}.pdf`);
      document.body.appendChild(link);
      link.click();
      window.URL.revokeObjectURL(url);
      link.remove();
    } catch (err: any) {
      console.error(err);
      const msg =
        err?.response?.status === 410
          ? 'This receipt was voided. Contact Bursary for assistance.'
          : 'Failed to download receipt. Please try again later.';
      showAlert('Receipt Error', msg);
    }
  };

  const recentInvoices = useMemo(() => invoices.slice(0, 5), [invoices]);
  const recentReceipts = useMemo(() => receipts.slice(0, 5), [receipts]);

  const invTotalPages = Math.max(1, Math.ceil(invTotal / PAGE_SIZE));
  const rcptTotalPages = Math.max(1, Math.ceil(rcptTotal / PAGE_SIZE));

  // =========================================================================
  // RENDER
  // =========================================================================
  return (
    <PortalShell
      role="STUDENT"
      activePath={location.pathname}
      userPermissions={[]}
      brand={brand}
      userText={fullName}
      userEmail={user?.email}
      onLogout={logout}
      showGlobalSearch={false}
    >
      <div className="w-full space-y-6">
        {/* Student Profile Section */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col md:flex-row items-center md:items-start gap-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 -mt-4 -mr-4 w-40 h-40 bg-blue-50 rounded-full blur-3xl opacity-60"></div>
          <div className="h-20 w-20 bg-blue-100 rounded-2xl flex items-center justify-center text-blue-600 text-2xl font-bold shrink-0 border-4 border-white shadow-sm z-10">
            {user?.firstName?.[0]}
            {user?.lastName?.[0]}
          </div>
          <div className="flex-1 text-center md:text-left z-10 w-full">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
              {user?.firstName} {user?.lastName}
            </h1>
            <p className="text-slate-500 font-medium mb-3 font-mono text-sm">{user?.matricNumber || 'N/A'}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full">
              <div className="flex items-center gap-2 text-sm text-slate-600 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
                <BookOpen className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="truncate font-medium" title={user?.college || 'N/A'}>
                  {user?.college || 'N/A'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm text-slate-600 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
                <Building2 className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="truncate font-medium" title={user?.department || 'N/A'}>
                  {user?.department || 'N/A'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm text-slate-600 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
                <GraduationCap className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="truncate font-medium" title={user?.program || 'N/A'}>
                  {user?.program || 'N/A'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Browse Available Payments CTA Banner */}
        <div className="bg-gradient-to-r from-[#0a3d91] via-[#0b46a8] to-[#0e53c5] rounded-2xl shadow-lg border border-[#0a3d91]/20 p-5 md:p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 -mt-10 -mr-10 w-56 h-56 bg-white/10 rounded-full blur-3xl pointer-events-none"></div>
          <div className="absolute bottom-0 left-0 -mb-10 -ml-10 w-40 h-40 bg-white/5 rounded-full blur-2xl pointer-events-none"></div>
          <div className="flex flex-col md:flex-row items-start md:items-center gap-5 relative z-10">
            <div className="w-14 h-14 rounded-2xl bg-white/15 backdrop-blur flex items-center justify-center text-white ring-1 ring-white/20 shrink-0">
              <CreditCard className="h-7 w-7" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl md:text-2xl font-black text-white tracking-tight">
                Browse Available Payments
              </h2>
              <p className="text-blue-100 text-sm md:text-base font-medium mt-1">
                Select any fee you need to pay — tuition, hostel, departmental dues, and more.
                No pre-billing required.
              </p>
            </div>
            <button
              onClick={() => navigate('/student/payments')}
              className="inline-flex items-center gap-2 bg-white hover:bg-blue-50 text-[#0a3d91] font-black px-5 py-3 rounded-xl shadow-lg transition-all hover:scale-[1.02] shrink-0"
            >
              Browse Catalogue <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg ring-1 ring-emerald-100">
                  <CheckCircle2 className="h-3 w-3" /> Amount Paid
                </div>
                <div className="mt-3 text-2xl font-black text-slate-900 tracking-tight">
                  {scheduleLoading ? '—' : naira(kpis.totalPaid)}
                </div>
                <div className="mt-1 text-sm text-slate-500 font-medium">Total settled fees to date</div>
              </div>
              <div className="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center ring-1 ring-emerald-100">
                <Banknote className="h-5 w-5" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-blue-700 bg-blue-50 px-2.5 py-1 rounded-lg ring-1 ring-blue-100">
                  <Layers className="h-3 w-3" /> Payment Attempts
                </div>
                <div className="mt-3 text-2xl font-black text-slate-900 tracking-tight">
                  {invLoading ? '—' : invTotal.toLocaleString()}
                </div>
                <div className="mt-1 text-sm text-slate-500 font-medium">Checkout sessions initiated</div>
              </div>
              <div className="w-11 h-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center ring-1 ring-blue-100">
                <Clock className="h-5 w-5" />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {['PAID', 'PARTIALLY_PAID', 'PENDING', 'FAILED'].map((k) => {
                const cnt = invoices.filter((i) => i.status === k).length;
                if (!cnt) return null;
                return (
                  <span
                    key={k}
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-md ring-1 ${invoiceStatusChip(k).cls}`}
                  >
                    {k} {cnt}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-lg ring-1 ring-indigo-100">
                  <Receipt className="h-3 w-3" /> Receipts Issued
                </div>
                <div className="mt-3 text-2xl font-black text-slate-900 tracking-tight">
                  {rcptLoading ? '—' : rcptTotal.toLocaleString()}
                </div>
                <div className="mt-1 text-sm text-slate-500 font-medium">Official payment receipts</div>
              </div>
              <div className="w-11 h-11 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center ring-1 ring-indigo-100">
                <CircleDollarSign className="h-5 w-5" />
              </div>
            </div>
          </div>
        </div>

        {/* Tabs: Overview / Invoices / Receipts */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="border-b border-slate-200 px-4 sm:px-6 pt-4">
            <div className="flex flex-wrap gap-1 sm:gap-2">
              {STUDENT_DASH_TABS.map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-t-xl border-b-2 -mb-px transition-colors ${
                      active
                        ? 'border-[#0a3d91] text-[#0a3d91] bg-blue-50/40'
                        : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="p-4 sm:p-6">
            {activeTab === 'overview' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                {/* Recent invoices */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                      <FileText className="h-4 w-4 text-slate-500" /> Recent Payment Attempts
                    </h3>
                    <button
                      onClick={() => setActiveTab('invoices')}
                      className="text-xs font-semibold text-[#0a3d91] hover:underline"
                    >
                      View all →
                    </button>
                  </div>
                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    {invLoading || !invoices.length ? (
                      <div className="p-8 text-center text-sm text-slate-500">
                        {invLoading ? 'Loading…' : 'No payment attempts yet. Browse the catalogue to start paying.'}
                      </div>
                    ) : (
                      <ul className="divide-y divide-slate-100">
                        {recentInvoices.map((iv) => {
                          const chip = invoiceStatusChip(iv.status);
                          return (
                            <li key={iv.id} className="p-4 hover:bg-slate-50 transition-colors">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-slate-900 truncate">
                                    {iv.fee?.name || `Invoice ${iv.invoiceNumber}`}
                                  </div>
                                  <div className="text-xs text-slate-500 mt-0.5 font-mono">
                                    {iv.invoiceNumber} • {fmtDateShort(iv.dueDate)}
                                  </div>
                                  <div className="text-xs text-slate-500 mt-0.5">
                                    {iv.session || ''} {iv.semester ? `• ${iv.semester}` : ''}
                                  </div>
                                </div>
                                <div className="text-right shrink-0">
                                  <div className="text-sm font-bold text-slate-900">{naira(iv.balance)}</div>
                                  <span className={`mt-1 inline-block text-[10px] font-bold px-2 py-0.5 rounded ring-1 ${chip.cls}`}>
                                    {chip.label}
                                  </span>
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>

                {/* Recent receipts */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                      <Receipt className="h-4 w-4 text-slate-500" /> Recent Receipts
                    </h3>
                    <button
                      onClick={() => setActiveTab('receipts')}
                      className="text-xs font-semibold text-[#0a3d91] hover:underline"
                    >
                      View all →
                    </button>
                  </div>
                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    {rcptLoading || !receipts.length ? (
                      <div className="p-8 text-center text-sm text-slate-500">
                        {rcptLoading ? 'Loading receipts…' : 'No receipts yet. Complete a payment to receive one.'}
                      </div>
                    ) : (
                      <ul className="divide-y divide-slate-100">
                        {recentReceipts.map((r) => (
                          <li key={r.id} className="p-4 hover:bg-slate-50 transition-colors">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-slate-900 font-mono truncate">
                                  {r.receiptNumber}
                                </div>
                                <div className="text-xs text-slate-500 mt-0.5 truncate">
                                  {r.invoice?.fee?.name || 'Fee payment'}
                                </div>
                                <div className="text-xs text-slate-500 mt-0.5">{fmtDateShort(r.paidAt)}</div>
                              </div>
                              <div className="text-right shrink-0 flex flex-col items-end gap-1.5">
                                <div className="text-sm font-bold text-slate-900">{naira(r.paidAmount)}</div>
                                <span
                                  className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded ring-1 ${
                                    r.isVoided
                                      ? 'bg-amber-50 text-amber-700 ring-amber-600/10'
                                      : 'bg-emerald-50 text-emerald-700 ring-emerald-600/10'
                                  }`}
                                >
                                  {r.isVoided ? 'VOIDED' : 'VALID'}
                                </span>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'invoices' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap bg-slate-100 p-1 rounded-lg">
                    {INVOICE_FILTERS.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => {
                          setInvFilter(f.key);
                          void loadInvoices(1, f.key);
                        }}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                          invFilter === f.key
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-500 hover:text-slate-700'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-xs text-slate-500 font-medium">
                    {invTotal.toLocaleString()} payment attempt{invTotal === 1 ? '' : 's'}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 overflow-x-auto">
                  <table className="w-full min-w-[720px]">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Invoice</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Fee / Purpose</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Due</th>
                        <th className="px-4 py-3 text-right text-xs font-bold text-slate-500 uppercase tracking-wider">Due</th>
                        <th className="px-4 py-3 text-right text-xs font-bold text-slate-500 uppercase tracking-wider">Paid</th>
                        <th className="px-4 py-3 text-right text-xs font-bold text-slate-500 uppercase tracking-wider">Remaining</th>
                        <th className="px-4 py-3 text-center text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {invLoading ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500">
                            Loading invoices…
                          </td>
                        </tr>
                      ) : !invoices.length ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500">
                            <FileText className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                            No payment attempts match this filter.
                          </td>
                        </tr>
                      ) : (
                        invoices.map((iv) => {
                          const chip = invoiceStatusChip(iv.status);
                          return (
                            <tr key={iv.id} className="hover:bg-slate-50">
                              <td className="px-4 py-3 align-top">
                                <div className="font-mono text-xs font-semibold text-slate-900">{iv.invoiceNumber}</div>
                                <div className="text-[11px] text-slate-500 mt-0.5">
                                  {iv.session} {iv.semester ? `• ${iv.semester}` : ''}
                                </div>
                              </td>
                              <td className="px-4 py-3 align-top">
                                <div className="text-sm font-semibold text-slate-900">{iv.fee?.name || '—'}</div>
                              </td>
                              <td className="px-4 py-3 align-top text-xs text-slate-600">{fmtDateShort(iv.dueDate)}</td>
                              <td className="px-4 py-3 align-top text-right text-sm font-semibold text-slate-900">
                                {naira(iv.amountDue)}
                              </td>
                              <td className="px-4 py-3 align-top text-right text-sm text-slate-600">{naira(iv.amountPaid)}</td>
                              <td className="px-4 py-3 align-top text-right text-sm font-bold text-slate-900">{naira(iv.balance)}</td>
                              <td className="px-4 py-3 align-top text-center">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold ring-1 ${chip.cls}`}>
                                  {chip.label}
                                </span>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {invTotalPages > 1 && (
                  <div className="flex items-center justify-between pt-2">
                    <div className="text-xs text-slate-500 font-medium">
                      Page {invPage} of {invTotalPages}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          const p = Math.max(invPage - 1, 1);
                          void loadInvoices(p, invFilter);
                        }}
                        disabled={invPage <= 1 || invLoading}
                        className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded-md text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" /> Prev
                      </button>
                      <button
                        onClick={() => {
                          const p = Math.min(invPage + 1, invTotalPages);
                          void loadInvoices(p, invFilter);
                        }}
                        disabled={invPage >= invTotalPages || invLoading}
                        className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded-md text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50"
                      >
                        Next <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'receipts' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap bg-slate-100 p-1 rounded-lg">
                    {RECEIPT_FILTERS.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => {
                          setRcptFilter(f.key);
                          void loadReceipts(1, f.key);
                        }}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                          rcptFilter === f.key
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-500 hover:text-slate-700'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-xs text-slate-500 font-medium">
                    {rcptTotal.toLocaleString()} receipt{rcptTotal === 1 ? '' : 's'} on record
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 overflow-x-auto">
                  <table className="w-full min-w-[720px]">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Receipt #</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Fee / Purpose</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Date Paid</th>
                        <th className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">Channel</th>
                        <th className="px-4 py-3 text-right text-xs font-bold text-slate-500 uppercase tracking-wider">Amount</th>
                        <th className="px-4 py-3 text-center text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                        <th className="px-4 py-3 text-center text-xs font-bold text-slate-500 uppercase tracking-wider">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rcptLoading ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500">
                            Loading receipts…
                          </td>
                        </tr>
                      ) : !receipts.length ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500">
                            <Receipt className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                            No receipts match this filter.
                          </td>
                        </tr>
                      ) : (
                        receipts.map((r) => (
                          <tr key={r.id} className="hover:bg-slate-50">
                            <td className="px-4 py-3 align-top">
                              <div className="font-mono text-xs font-bold text-slate-900">{r.receiptNumber}</div>
                              <div className="text-[11px] text-slate-500 mt-0.5 font-mono truncate max-w-[160px]">
                                {r.verificationToken}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <div className="text-sm font-semibold text-slate-900">
                                {r.invoice?.fee?.name || r.transaction?.type || 'Fee payment'}
                              </div>
                              {r.invoice?.invoiceNumber && (
                                <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
                                  Inv: {r.invoice.invoiceNumber}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3 align-top text-xs text-slate-600">{fmtDateShort(r.paidAt)}</td>
                            <td className="px-4 py-3 align-top text-xs text-slate-600 capitalize">
                              {r.transaction?.paystackChannel || r.paymentChannel || '—'}
                            </td>
                            <td className="px-4 py-3 align-top text-right text-sm font-bold text-slate-900">
                              {naira(r.paidAmount)}
                            </td>
                            <td className="px-4 py-3 align-top text-center">
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold ring-1 ${
                                  r.isVoided
                                    ? 'bg-amber-50 text-amber-700 ring-amber-600/10'
                                    : 'bg-emerald-50 text-emerald-700 ring-emerald-600/10'
                                }`}
                              >
                                {r.isVoided ? (
                                  <>
                                    <XCircle className="h-3 w-3" /> VOIDED
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle2 className="h-3 w-3" /> VALID
                                  </>
                                )}
                              </span>
                            </td>
                            <td className="px-4 py-3 align-top text-center">
                              <button
                                onClick={() => downloadFormalReceipt(r)}
                                disabled={r.isVoided}
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold ring-1 ${
                                  r.isVoided
                                    ? 'bg-slate-50 text-slate-400 ring-slate-200 cursor-not-allowed'
                                    : 'bg-[#0a3d91] hover:bg-[#0b46a8] text-white ring-[#0a3d91]/10 shadow-sm'
                                }`}
                              >
                                <Download className="h-3.5 w-3.5" /> PDF
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {rcptTotalPages > 1 && (
                  <div className="flex items-center justify-between pt-2">
                    <div className="text-xs text-slate-500 font-medium">
                      Page {rcptPage} of {rcptTotalPages}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          const p = Math.max(rcptPage - 1, 1);
                          void loadReceipts(p, rcptFilter);
                        }}
                        disabled={rcptPage <= 1 || rcptLoading}
                        className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded-md text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" /> Prev
                      </button>
                      <button
                        onClick={() => {
                          const p = Math.min(rcptPage + 1, rcptTotalPages);
                          void loadReceipts(p, rcptFilter);
                        }}
                        disabled={rcptPage >= rcptTotalPages || rcptLoading}
                        className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 rounded-md text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50"
                      >
                        Next <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* General Alert Modal */}
      <Modal
        isOpen={alertModal.isOpen}
        onClose={() => setAlertModal({ ...alertModal, isOpen: false })}
        title={alertModal.title}
        footer={
          <button
            onClick={() => setAlertModal({ ...alertModal, isOpen: false })}
            className={`px-6 py-2 rounded-lg font-bold text-white shadow-sm transition-all ${
              alertModal.type === 'success'
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            Acknowledge
          </button>
        }
      >
        <div className="py-4">
          <p className="text-slate-700 text-base">{alertModal.message}</p>
        </div>
      </Modal>
    </PortalShell>
  );
};

export default StudentDashboard;
