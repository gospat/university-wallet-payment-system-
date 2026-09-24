import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { UserPlus, ListFilter, RefreshCw, Search, FileText } from 'lucide-react';
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

  const fetchDirectAssignments = useCallback(async () => {
    setLoading(true);
    try {
      const r = await feeApi.listAssignments({
        q: q.trim() || undefined,
        assignmentType: 'STUDENT',
        isActive: true,
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
  }, [q, page, pageSize]);

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
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {loading && (
                      <tr>
                        <td colSpan={8} className="text-center py-10 text-gray-500">
                          Loading direct bills…
                        </td>
                      </tr>
                    )}
                    {!loading && rows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="text-center py-10 text-gray-500">
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
