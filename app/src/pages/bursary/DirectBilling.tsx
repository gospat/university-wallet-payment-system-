import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { UserPlus, ListFilter, RefreshCw, Search, FileText, Pencil, Power, Trash2, X, DollarSign, CalendarClock, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import DirectBillForm from '../../components/fees/DirectBillForm';
import { useAuth } from '../../context/AuthContext';
import { navCounters, NavCounters } from '../../services/api';
import feeApi, {
  type FeeAssignmentOut,
} from '../../services/adminFees';
import { i18n } from '../../i18n/en';

type BursaryDirectTab = 'assigned' | 'bill';

const fmtNgn = (n: number | string | null | undefined) => {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(v);
};

const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime())
    ? '—'
    : dt.toLocaleDateString('en-NG', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
};

const studentFullName = (a: FeeAssignmentOut) => {
  const t = a.targetStudent;
  if (!t) return '—';
  return [t.firstName, t.lastName].filter(Boolean).join(' ') || t.matricNumber || '—';
};

const BursaryDirectBillingPage: React.FC<{
  role: 'BURSARY' | 'ADMIN';
  brand: string;
  userText: string;
  onLogout: () => void;
  dashboardTo: string;
}> = ({ role, brand, userText, onLogout, dashboardTo }) => {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [navCounts, setNavCounts] = useState<NavCounters>({});

  useEffect(() => {
    navCounters().then(setNavCounts);
  }, []);

  const paramTab = searchParams.get('tab') as BursaryDirectTab | null;
  const [activeTab, setActiveTab] = useState<BursaryDirectTab>(paramTab ?? 'bill');
  useEffect(() => {
    const next: BursaryDirectTab = paramTab === 'assigned' ? 'assigned' : 'bill';
    setActiveTab(next);
  }, [paramTab]);
  const goTab = (t: BursaryDirectTab) => {
    setSearchParams({ tab: t });
  };

  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<FeeAssignmentOut[]>([]);
  const [total, setTotal] = useState(0);
  const [filterActive, setFilterActive] = useState<boolean | 'all'>(true);
  const [editingAssignment, setEditingAssignment] = useState<FeeAssignmentOut | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState({ overrideAmount: '', overrideDeadline: '', noteToStudent: '' });
  const [editSaving, setEditSaving] = useState(false);

  function summarizeHttpError(err: any, fallback: string) {
    const data = (err as any)?.response?.data;
    const msg = data?.message ?? (typeof err === 'string' ? err : (err as Error)?.message);
    const details = Array.isArray(data?.details)
      ? data.details.map((d: any) => typeof d === 'string' ? d : d?.message ?? JSON.stringify(d))
      : [];
    return { kind: 'danger' as const, title: msg ?? fallback, details: details.length ? details : undefined, message: undefined };
  }

  type AlertState = { open: boolean; kind: 'info' | 'success' | 'warn' | 'danger'; title: string; message?: string; details?: string[]; };
  const [alert, setAlert] = useState<AlertState>({ open: false, kind: 'info', title: '' });
  const closeAlert = () => setAlert(s => ({ ...s, open: false }));
  const flashSuccess = (title: string, message?: string) => setAlert({ open: true, kind: 'success', title, message });
  const flashDanger = (title: string, e: any) => setAlert({ ...summarizeHttpError(e, title), open: true });

  const fetchDirectAssignments = useCallback(async () => {
    setLoading(true);
    try {
      const r = await feeApi.listAssignments({
        q: q.trim() || undefined,
        assignmentType: 'STUDENT',
        isActive: filterActive,
        page,
        pageSize,
      });
      setRows(r.assignments ?? []);
      setTotal(r.total ?? 0);
    } catch (e) {
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, filterActive]);

  useEffect(() => {
    if (activeTab === 'assigned') fetchDirectAssignments();
  }, [activeTab, fetchDirectAssignments]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const originPill = (a: FeeAssignmentOut) => {
    const cls =
      'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider';
    return (
      <span
        className={`${cls} bg-indigo-50 text-indigo-700 border border-indigo-200`}
        title={`Direct bill — Bursary assignment #${a.id}`}
      >
        DIRECT BILL
      </span>
    );
  };

  const amount = (a: FeeAssignmentOut) => a.overrideAmount ?? a.fee?.amount ?? 0;
  const deadline = (a: FeeAssignmentOut) => a.overrideDeadline ?? a.fee?.paymentDeadline;

  const openEditModal = (a: FeeAssignmentOut) => {
    setEditingAssignment(a);
    setEditForm({
      overrideAmount: a.overrideAmount != null ? String(a.overrideAmount) : '',
      overrideDeadline: a.overrideDeadline ?? '',
      noteToStudent: a.noteToStudent ?? '',
    });
    setEditModalOpen(true);
  };

  const closeEditModal = () => {
    setEditModalOpen(false);
    setEditingAssignment(null);
    setEditSaving(false);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAssignment) return;
    setEditSaving(true);
    try {
      if (editForm.overrideAmount.trim() !== '') {
        const n = Number(editForm.overrideAmount);
        if (isNaN(n) || n < 0) {
          flashDanger('Invalid amount', {
            response: {
              data: {
                message: 'Please enter a valid amount (0 or greater), or leave blank to revert to fee template default.',
              },
            },
          });
          setEditSaving(false);
          return;
        }
      }
      const body: any = {};
      if (editForm.overrideAmount.trim() !== '') {
        body.overrideAmount = Number(editForm.overrideAmount);
      } else {
        body.overrideAmount = null;
      }
      if (editForm.overrideDeadline) {
        body.overrideDeadline = editForm.overrideDeadline;
      } else {
        body.overrideDeadline = null;
      }
      body.noteToStudent = editForm.noteToStudent || null;
      await feeApi.updateAssignment(editingAssignment.id, body);
      closeEditModal();
      flashSuccess('Direct bill updated', 'Amount, deadline and note to student updated successfully.');
      await fetchDirectAssignments();
    } catch (e) {
      flashDanger('Could not save changes to direct bill', e);
      setEditSaving(false);
    }
  };

  const handleToggleActive = async (a: FeeAssignmentOut) => {
    try {
      if (a.isActive) {
        await feeApi.disableAssignment(a.id);
      } else {
        await feeApi.enableAssignment(a.id);
      }
      await fetchDirectAssignments();
    } catch (e) {
      flashDanger('Could not change active status for direct bill', e);
    }
  };

  const handleDelete = async (a: FeeAssignmentOut) => {
    const ok = window.confirm('Cannot be undone. Related UNPAID invoices removed.');
    if (!ok) return;
    try {
      await feeApi.deleteAssignment(a.id);
      await fetchDirectAssignments();
    } catch (e) {
      flashDanger('Could not delete direct bill', e);
    }
  };

  const toDateInput = (d: string | null | undefined) => {
    if (!d) return '';
    try {
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return '';
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    } catch {
      return '';
    }
  };

  return (
    <PortalShell
      role={role}
      activePath={location.pathname + location.search}
      brand={brand}
      userText={userText}
      userEmail={user?.email ?? undefined}
      onLogout={onLogout}
      userPermissions={(user?.permissions as string[]) ?? []}
      showGlobalSearch
      navCounters={navCounts}
    >
      <div className="w-full space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              {activeTab === 'bill' ? 'Bill a Student (Direct)' : 'Direct Bills Assigned'}
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {activeTab === 'bill'
                ? 'Raise a targeted charge for a specific student by matric number. The bill appears immediately on their payment catalogue and invoices list.'
                : 'All direct bills issued per-student with invoice status, amount and origin traceability.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-gray-200 bg-white p-1">
              {([
                { k: 'bill' as BursaryDirectTab, label: 'Bill a Student', icon: UserPlus },
                { k: 'assigned' as BursaryDirectTab, label: 'Assigned', icon: ListFilter },
              ] as const).map(({ k, label, icon: Icon }) => (
                <button
                  key={k}
                  onClick={() => goTab(k)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    activeTab === k
                      ? 'bg-amber-600 text-white'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => navigate(dashboardTo)}
              className="px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
            >
              Dashboard
            </button>
          </div>
        </header>

        {activeTab === 'bill' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <DirectBillForm
                actorRole={role}
                onSuccess={() => {
                  /* reload assigned list in background */
                  fetchDirectAssignments();
                }}
              />
            </div>
            <div className="space-y-4">
              <div className="bg-gradient-to-br from-amber-50 to-white rounded-2xl border border-amber-200 p-5 text-sm space-y-3">
                <div className="flex items-center gap-2 text-amber-800 font-semibold">
                  <FileText className="h-5 w-5" />
                  What happens when you submit
                </div>
                <ol className="list-decimal pl-5 space-y-1.5 text-amber-900/90 text-xs leading-relaxed">
                  <li>
                    Student is resolved by matric and validated as{' '}
                    <strong>ACTIVE</strong> (inactive students are rejected).
                  </li>
                  <li>
                    A FeeAssignment record is created with{' '}
                    <code className="bg-white/70 px-1 rounded border border-amber-200 font-mono">
                      STUDENT
                    </code>{' '}
                    target + linked to the student ID.
                  </li>
                  <li>
                    An unpaid invoice is generated atomically and numbered sequentially (row-lock
                    to avoid gaps).
                  </li>
                  <li>
                    Two Audit Log rows are written inside the same transaction — FEE_ASSIGNED and
                    INVOICE_GENERATED — for forensics.
                  </li>
                  <li>
                    Email notification is queued to the student's registered email (non-blocking;
                    SMTP errors are swallowed silently so the response still returns).
                  </li>
                  <li>
                    The student sees this charge <strong>immediately</strong> pinned to the top of
                    their Make Payment catalogue with a DIRECT BILL badge, and also in their
                    Invoices / Payment History list with origin DIRECT_BILL.
                  </li>
                </ol>
              </div>
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-xs space-y-2">
                <div className="text-sm font-semibold text-gray-900">
                  Re-submitting the same bill
                </div>
                <p className="text-gray-600 leading-relaxed">
                  Double-posting is safe. The endpoint applies three-layer idempotency: identical{' '}
                  <code className="font-mono">(studentId, feeId, active)</code> assignment, unique{' '}
                  <code className="font-mono">(studentId, feeId, session)</code> invoice, and the
                  Idempotency-Key HTTP header when available. Repeating the request returns{' '}
                  <span className="inline-block bg-blue-50 text-blue-800 px-1.5 rounded border border-blue-200">
                    created=false
                  </span>{' '}
                  with the existing invoice reference.
                </p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'assigned' && (
          <div className="space-y-4">
            {alert.open && (
              <div className={`rounded-xl border px-4 py-3 shadow-sm ${
                alert.kind === 'success'
                  ? 'bg-emerald-50 border-emerald-200'
                  : alert.kind === 'warn'
                  ? 'bg-amber-50 border-amber-200'
                  : alert.kind === 'danger'
                  ? 'bg-red-50 border-red-200'
                  : 'bg-slate-50 border-slate-200'
              }`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    {alert.kind === 'success' ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 flex-shrink-0" />
                    ) : alert.kind === 'warn' ? (
                      <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                    ) : alert.kind === 'danger' ? (
                      <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                    ) : (
                      <Info className="h-5 w-5 text-slate-600 mt-0.5 flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className={`text-sm font-semibold ${
                        alert.kind === 'success'
                          ? 'text-emerald-900'
                          : alert.kind === 'warn'
                          ? 'text-amber-900'
                          : alert.kind === 'danger'
                          ? 'text-red-900'
                          : 'text-slate-900'
                      }`}>
                        {alert.title}
                      </p>
                      {alert.message && (
                        <p className={`text-xs mt-1 ${
                          alert.kind === 'success'
                            ? 'text-emerald-700'
                            : alert.kind === 'warn'
                            ? 'text-amber-700'
                            : alert.kind === 'danger'
                            ? 'text-red-700'
                            : 'text-slate-700'
                        }`}>
                          {alert.message}
                        </p>
                      )}
                      {alert.details && alert.details.length > 0 && (
                        <ul className={`text-xs mt-1.5 space-y-0.5 list-disc pl-4 ${
                          alert.kind === 'danger' ? 'text-red-700' : 'text-slate-700'
                        }`}>
                          {alert.details.map((d, i) => (
                            <li key={i}>{d}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={closeAlert}
                    className={`h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 transition-colors ${
                      alert.kind === 'success'
                        ? 'text-emerald-600 hover:bg-emerald-100'
                        : alert.kind === 'warn'
                        ? 'text-amber-600 hover:bg-amber-100'
                        : alert.kind === 'danger'
                        ? 'text-red-600 hover:bg-red-100'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
              <div className="md:col-span-1">
                <label className="text-xs text-gray-600 font-medium block mb-1">Status</label>
                <select
                  value={filterActive === 'all' ? 'all' : filterActive ? 'true' : 'false'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFilterActive(v === 'all' ? 'all' : v === 'true');
                    setPage(1);
                  }}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="true">Active only</option>
                  <option value="false">Inactive only</option>
                  <option value="all">All</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-gray-600 font-medium block mb-1">Search</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    className="w-full rounded-md border border-gray-300 pl-8 pr-3 py-2 text-sm"
                    placeholder="Matric number, fee code, department…"
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-600 font-medium block mb-1">Per page</label>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={fetchDirectAssignments}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-500">Page</span>
                  <input
                    type="number"
                    min={1}
                    value={page}
                    onChange={(e) =>
                      setPage(Math.max(1, Math.min(totalPages, Number(e.target.value) || 1)))
                    }
                    className="w-16 rounded-md border border-gray-300 px-2 py-1"
                  />
                  <span className="text-gray-500">of {totalPages}</span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Fee / Charge</th>
                      <th className="px-4 py-3 text-right font-medium">Amount</th>
                      <th className="px-4 py-3 text-left font-medium">Due Date</th>
                      <th className="px-4 py-3 text-left font-medium">Student</th>
                      <th className="px-4 py-3 text-left font-medium">Matric / Dept</th>
                      <th className="px-4 py-3 text-center font-medium">Status</th>
                      <th className="px-4 py-3 text-left font-medium">Invoice Ref</th>
                      <th className="px-4 py-3 text-left font-medium">Origin</th>
                      <th className="px-4 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {loading && (
                      <tr>
                        <td colSpan={9} className="text-center py-10 text-gray-500">
                          Loading direct bills…
                        </td>
                      </tr>
                    )}
                    {!loading && rows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="text-center py-10 text-gray-500">
                          No direct bills yet. Switch to the{' '}
                          <strong>Bill a Student</strong> tab to issue the first one.
                        </td>
                      </tr>
                    )}
                    {rows.map((a) => (
                      <tr key={a.id} className="hover:bg-gray-50 align-top">
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">
                            {a.fee?.name ?? `Ad-hoc #${a.feeId}`}
                          </div>
                          <div className="text-xs text-gray-500 font-mono">
                            {a.fee?.feeCode ?? a.fee?.category?.code ?? '—'}
                          </div>
                          <div className="text-[11px] text-gray-500 mt-0.5">
                            {a.fee?.academicSession ?? '—'}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold">
                          {fmtNgn(amount(a))}
                          {a.overrideAmount && a.fee?.amount && String(a.overrideAmount) !== String(a.fee.amount) && (
                            <div className="text-[10px] text-amber-700 font-normal">overridden</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-700 tabular-nums whitespace-nowrap">
                          {fmtDate(deadline(a))}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">
                            {studentFullName(a)}
                          </div>
                          <div className="text-[11px] text-gray-500">
                            Assigned {fmtDate(a.assignedAt)}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs text-gray-800">
                            {a.targetStudent?.matricNumber ?? '—'}
                          </div>
                          {a.fee?.department && (
                            <div className="text-[11px] text-gray-500 mt-0.5">
                              {a.fee.department}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                              a.isActive
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {a.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-700 font-mono text-xs">
                          —
                          <div className="text-[10px] text-gray-400 mt-0.5">
                            Assignment #{a.id}
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">{originPill(a)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => openEditModal(a)}
                              title="Edit"
                              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-gray-600 hover:text-indigo-700 hover:bg-indigo-50 border border-transparent hover:border-indigo-200 transition-colors"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleActive(a)}
                              title={a.isActive ? 'Disable' : 'Enable'}
                              className={`inline-flex items-center justify-center h-8 w-8 rounded-md border border-transparent transition-colors ${
                                a.isActive
                                  ? 'text-amber-700 hover:text-amber-800 hover:bg-amber-50 hover:border-amber-200'
                                  : 'text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50 hover:border-emerald-200'
                              }`}
                            >
                              <Power className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(a)}
                              title="Delete"
                              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-gray-600 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
                <div>
                  Showing {rows.length ? (page - 1) * pageSize + 1 : 0}–
                  {Math.min(page * pageSize, total)} of {total} direct bills
                </div>
                <div className="flex items-center gap-3">
                  <span>Rows with an invoice reference will be populated when the underlying invoice engine materializes them.</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {editModalOpen && editingAssignment && (
        <div className="fixed inset-0 z-50 p-4 bg-black/40 backdrop-blur-sm flex items-center justify-center">
          <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="bg-gradient-to-br from-fuchsia-500 via-indigo-500 to-purple-600 px-5 py-4 flex items-start justify-between text-white">
              <div className="flex items-start gap-3">
                <div>
                  <h2 className="text-2xl font-bold leading-tight">Edit Direct Bill</h2>
                  <p className="text-xs text-white/80 mt-0.5">
                    Assignment #{editingAssignment.id} · Change amount, due date, or note for this specific student bill
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm bg-white/15 border border-white/20 rounded-full px-2.5 py-1 flex items-center gap-1.5">
                  <Pencil className="h-3.5 w-3.5" />
                  Editing
                </span>
                <button
                  type="button"
                  onClick={closeEditModal}
                  className="bg-white/10 hover:bg-white/20 rounded-md h-8 w-8 flex items-center justify-center text-white/90 transition-colors"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap bg-gradient-to-r from-indigo-50 via-purple-50 to-fuchsia-50 px-5 py-3 gap-3 items-center border-b border-indigo-100">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-semibold text-indigo-600 uppercase tracking-wide">Student</div>
                <div className="text-sm font-bold text-gray-900 truncate">{studentFullName(editingAssignment)}</div>
                <div className="text-[11px] text-gray-500 font-mono">{editingAssignment.targetStudent?.matricNumber ?? '—'}</div>
              </div>
              <div className="w-px h-8 bg-indigo-200/60 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-semibold text-purple-600 uppercase tracking-wide">Fee / Charge</div>
                <div className="text-sm font-bold text-gray-900 truncate">{editingAssignment.fee?.name ?? `Ad-hoc #${editingAssignment.feeId}`}</div>
                <div className="text-[11px] text-gray-500 italic font-mono">{editingAssignment.fee?.feeCode ?? editingAssignment.fee?.category?.code ?? '—'}</div>
              </div>
              <div className="w-px h-8 bg-indigo-200/60 flex-shrink-0" />
              <div className="text-right">
                <div className="text-[11px] font-semibold text-fuchsia-600 uppercase tracking-wide">Currently Charging</div>
                <div className="inline-block bg-gradient-to-r from-fuchsia-600 to-indigo-600 text-white rounded-full px-3 py-1 text-sm font-bold tabular-nums shadow-sm">
                  ₦ {fmtNgn(amount(editingAssignment))}
                </div>
              </div>
            </div>

            <form onSubmit={handleEditSubmit} className="px-5 py-5 space-y-5">
              <div>
                <label htmlFor="edit-override-amount" className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Override Amount (NGN)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 flex items-center gap-1.5">
                    <DollarSign className="h-4 w-4" />
                  </span>
                  <input
                    id="edit-override-amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={editForm.overrideAmount}
                    onChange={(e) =>
                      setEditForm({ ...editForm, overrideAmount: e.target.value })
                    }
                    placeholder={editingAssignment.fee?.amount != null ? `Default: ${fmtNgn(editingAssignment.fee.amount)}` : 'Leave blank to use default'}
                    className="w-full rounded-md border border-gray-300 pl-10 pr-3 py-2.5 text-sm tabular-nums focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all"
                  />
                </div>
                <p className="text-[11px] mt-1.5 flex items-start gap-1 text-amber-700 bg-amber-50/60 px-2 py-1.5 rounded border border-amber-100">
                  <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    Editing amount? Leave blank to cancel override → template amount used:{' '}
                    <strong>{fmtNgn(editingAssignment.fee?.amount)}</strong>.
                  </span>
                </p>
              </div>

              <div>
                <label htmlFor="edit-override-deadline" className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Override Deadline
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
                    <CalendarClock className="h-4 w-4" />
                  </span>
                  <input
                    id="edit-override-deadline"
                    type="date"
                    value={toDateInput(editForm.overrideDeadline)}
                    onChange={(e) =>
                      setEditForm({ ...editForm, overrideDeadline: e.target.value })
                    }
                    className="w-full rounded-md border border-gray-300 pl-10 pr-3 py-2.5 text-sm tabular-nums focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all"
                  />
                </div>
                <p className="text-[11px] mt-1.5 flex items-start gap-1 text-indigo-700 bg-indigo-50/60 px-2 py-1.5 rounded border border-indigo-100">
                  <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    Template default deadline:{' '}
                    <strong>{fmtDate(editingAssignment.fee?.paymentDeadline)}</strong>. Leave blank to revert to template.
                  </span>
                </p>
              </div>

              <div>
                <label htmlFor="edit-note-to-student" className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 mb-1.5">
                  <FileText className="h-3.5 w-3.5 text-gray-500" />
                  Note to Student
                </label>
                <textarea
                  id="edit-note-to-student"
                  rows={4}
                  maxLength={2000}
                  value={editForm.noteToStudent}
                  onChange={(e) =>
                    setEditForm({ ...editForm, noteToStudent: e.target.value })
                  }
                  placeholder="Optional note visible to the student on this bill…"
                  className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all resize-y"
                />
                <p className="text-[11px] text-gray-500 mt-1.5 px-2">
                  Optional. This note appears amber-highlighted on the student's Assigned Bills section (max 2000 chars).
                </p>
              </div>

              <div className="px-5 -mx-5 -mb-5 mt-2 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs text-gray-500 italic">
                  <Info className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>Changes are immediately reflected on the student bill list.</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={closeEditModal}
                    disabled={editSaving}
                    className="px-4 py-2 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={editSaving}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  >
                    {editSaving ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Pencil className="h-4 w-4" />
                    )}
                    {editSaving ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </PortalShell>
  );
};

const DirectBillingWrappedBase: React.FC<{ role: 'BURSARY' | 'ADMIN' }> = ({ role }) => {
  const { user, logout } = useAuth();
  const dashboardTo = role === 'ADMIN' ? '/admin/dashboard' : '/bursary/dashboard';
  const brand = role === 'ADMIN' ? i18n.portals.admin.dashboardBrand : i18n.portals.bursary.dashboardBrand;
  const userText = role === 'ADMIN'
    ? i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin')
    : `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
  return (
    <BursaryDirectBillingPage
      role={role}
      brand={brand}
      userText={userText}
      onLogout={logout}
      dashboardTo={dashboardTo}
    />
  );
};

export const BursaryDirectBillingWrapped = () => <DirectBillingWrappedBase role="BURSARY" />;
export const AdminDirectBillingWrapped = () => <DirectBillingWrappedBase role="ADMIN" />;
export default BursaryDirectBillingPage;
