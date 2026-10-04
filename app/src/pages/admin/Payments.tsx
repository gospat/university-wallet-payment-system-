import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PortalShell from '../../components/PortalShell';
import api, { navCounters, NavCounters } from '../../services/api';
import { useAuth } from '../../context/AuthContext';

const fmtNGN = (n: number | string | null | undefined) => {
  const num = Number(n ?? 0);
  if (isNaN(num)) return '₦0';
  return `₦${num.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return '—'; }
};

const STATUS_OPTIONS = ['PENDING', 'SUCCESS', 'FAILED', 'REVERSED'] as const;
const GATEWAY_OPTIONS = ['PAYSTACK', 'ALATPAY'] as const;

const StatusPill: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, string> = {
    PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
    SUCCESS: 'bg-green-50 text-green-700 border-green-200',
    FAILED: 'bg-red-50 text-red-700 border-red-200',
    REVERSED: 'bg-gray-100 text-gray-700 border-gray-300',
  };
  const cls = map[status] ?? 'bg-gray-100 text-gray-700 border-gray-200';
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${cls}`}>
      {status}
    </span>
  );
};

const GatewayPill: React.FC<{ gateway?: string | null }> = ({ gateway }) => {
  const g = gateway || 'UNKNOWN';
  const map: Record<string, string> = {
    PAYSTACK: 'bg-blue-50 text-blue-700 border-blue-200',
    ALATPAY: 'bg-purple-50 text-purple-700 border-purple-200',
  };
  const cls = map[g] ?? 'bg-gray-100 text-gray-700 border-gray-200';
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${cls}`}>
      {g === 'PAYSTACK' ? 'Paystack' : g === 'ALATPAY' ? 'ALAT Pay' : g}
    </span>
  );
};

const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500';
const Field: React.FC<{ label: string; children: React.ReactNode; className?: string }> = ({ label, children, className }) => (
  <div className={`space-y-1 ${className ?? ''}`}>
    <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide">{label}</label>
    {children}
  </div>
);

type PaymentRow = {
  id: number;
  reference: string;
  paystackReference?: string | null;
  alatpayReference?: string | null;
  amount: number | string;
  status: string;
  gateway: string;
  paystackChannel?: string | null;
  type: string;
  description?: string | null;
  createdAt: string;
  updatedAt?: string;
  user?: { id: number; firstName: string; lastName: string; email: string; matricNumber?: string | null } | null;
  invoice?: { id: number; invoiceNumber: string; fee?: { id: number; name: string; feeCode?: string } | null } | null;
  receipts?: { id: number; receiptNumber: string; verificationToken?: string; isVoided?: boolean }[];
};

type ListResp = { items: PaymentRow[]; total: number; page: number; pageSize: number; totalPages: number };

function isUserCancelError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message ?? '').trim().toLowerCase();
  return (
    err?.code === 'ERR_CANCELED' ||
    err?.name === 'CanceledError' ||
    err?.name === 'AbortError' ||
    msg === 'canceled' ||
    msg === 'aborted' ||
    msg === 'aborterror' ||
    String(err?.code ?? '').toUpperCase() === 'ERR_CANCELED'
  );
}

const PaymentsPage: React.FC<{ role: 'ADMIN' | 'BURSARY'; brand: string; userText: string; onLogout: () => void; goBack: () => void; dashboardTo: string }> = ({ role, brand, userText, onLogout, goBack, dashboardTo }) => {
  const { user } = useAuth();
  void goBack;
  void dashboardTo;
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const baseEndpoint = role === 'ADMIN' ? '/admin/payments' : '/bursary/payments';
  const activePath = `/${role.toLowerCase()}/payments`;

  useEffect(() => {
    setErrorMsg('');
  }, []);

  useEffect(() => { void navCounters().then(setNavCounts); }, []);

  const defaultQuery = useMemo(() => ({
    page: '1', pageSize: '25', sort: 'createdAt', order: 'desc',
    q: '', status: '', gateway: '', dateFrom: '', dateTo: '',
    studentId: '', feeId: '', invoiceId: '',
  }), []);

  const [query, setQueryState] = useState<Record<string, string>>(defaultQuery);
  const setQuery = useCallback((q: Record<string, string>) => {
    setQueryState(q);
  }, []);
  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const loadedOnceRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadData = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setErrorMsg('');
    try {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([k, v]) => { if (v) params.set(k, v); });
      const resp = await api.get<{ status: string; data: ListResp }>(`${baseEndpoint}?${params.toString()}`, { signal: ac.signal });
      if (resp.data?.status === 'success' && resp.data.data) {
        setData(resp.data.data);
      } else {
        setData(null);
        setErrorMsg('Unexpected response from server');
      }
      loadedOnceRef.current = true;
    } catch (e: any) {
      if (isUserCancelError(e)) return;
      setErrorMsg(e?.message || 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  }, [baseEndpoint, query]);

  useEffect(() => { void loadData(); }, [loadData]);

  const rows = data?.items ?? [];
  const currentPage = Number(data?.page ?? query.page ?? 1);
  const totalPages = Math.max(1, data ? Math.ceil(data.total / Math.max(1, Number(data.pageSize || 25))) : 1);
  const setPage = (p: number) => setQuery({ ...query, page: String(Math.max(1, Math.min(totalPages, p))) });

  const downloadReceipt = (receiptId: number) => {
    const token = localStorage.getItem('token') || '';
    const downloadEndpoint = role === 'ADMIN'
      ? `${(api.defaults.baseURL || '/api/v1')}/admin/receipts/${receiptId}/download`
      : `${(api.defaults.baseURL || '/api/v1')}/bursary/receipts/${receiptId}/download`;
    fetch(downloadEndpoint, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async (r) => {
        if (!r.ok) throw new Error('Download failed');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const disp = r.headers.get('Content-Disposition') || '';
        const match = disp.match(/filename="?([^"]+)"?/);
        a.href = url;
        a.download = match?.[1] || `receipt_${receiptId}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      })
      .catch((err) => { if (isUserCancelError(err)) return; setErrorMsg(err.message || 'Download failed'); });
  };

  return (
    <PortalShell brand={brand} userText={userText} role={role} onLogout={onLogout} activePath={activePath} navCounters={navCounts} userPermissions={user?.permissions as string[] | undefined} showGlobalSearch userEmail={user?.email}>
      <div className="w-full space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">All Payments</h1>
          <p className="text-sm text-gray-500 mt-1">
            {role === 'ADMIN' ? 'View and audit all fee payments across the university.' : 'View all fee payments processed by finance.'}
          </p>
        </div>

        {errorMsg && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm flex items-center justify-between">
            <span>{errorMsg}</span>
            <button className="underline text-red-700" onClick={() => setErrorMsg('')}>Dismiss</button>
          </div>
        )}

        <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            <Field label="Search" className="xl:col-span-2">
              <div className="relative">
                <input
                  type="text"
                  className={`${inputCls} pl-9`}
                  placeholder="Search reference, student name, invoice, fee..."
                  value={query.q}
                  onChange={(e) => setQuery({ ...query, q: e.target.value, page: '1' })}
                />
                <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" /></svg>
              </div>
            </Field>
            <Field label="Status">
              <select className={inputCls} value={query.status} onChange={(e) => setQuery({ ...query, status: e.target.value, page: '1' })}>
                <option value="">All</option>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Gateway">
              <select className={inputCls} value={query.gateway} onChange={(e) => setQuery({ ...query, gateway: e.target.value, page: '1' })}>
                <option value="">All</option>
                {GATEWAY_OPTIONS.map((s) => <option key={s} value={s}>{s === 'PAYSTACK' ? 'Paystack' : 'ALAT Pay'}</option>)}
              </select>
            </Field>
            <Field label="Date From">
              <input type="date" className={inputCls} value={query.dateFrom} onChange={(e) => setQuery({ ...query, dateFrom: e.target.value, page: '1' })} />
            </Field>
            <Field label="Date To">
              <input type="date" className={inputCls} value={query.dateTo} onChange={(e) => setQuery({ ...query, dateTo: e.target.value, page: '1' })} />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 pt-2 border-t border-gray-100">
            <Field label="Sort By">
              <select className={inputCls} value={query.sort} onChange={(e) => setQuery({ ...query, sort: e.target.value })}>
                <option value="createdAt">Created At</option>
                <option value="amount">Amount</option>
                <option value="status">Status</option>
              </select>
            </Field>
            <Field label="Order">
              <select className={inputCls} value={query.order} onChange={(e) => setQuery({ ...query, order: e.target.value })}>
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </Field>
            <Field label="Page Size">
              <select className={inputCls} value={query.pageSize} onChange={(e) => setQuery({ ...query, pageSize: e.target.value, page: '1' })}>
                {[10, 25, 50, 100].map((n) => <option key={n} value={String(n)}>{n}</option>)}
              </select>
            </Field>
            <Field label="Quick Actions" className="justify-self-end self-end">
              <div className="flex gap-2">
                <button className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-700 text-sm font-medium hover:bg-gray-50"
                  onClick={() => { setQuery(defaultQuery); }}>
                  Reset
                </button>
                <button className="px-3 py-2 border border-blue-500 rounded-lg bg-blue-50 text-blue-700 text-sm font-medium hover:bg-blue-100"
                  onClick={() => loadData()}>
                  Refresh
                </button>
              </div>
            </Field>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {[
                    'ID / Reference', 'Student', 'Invoice / Fee', 'Amount', 'Status', 'Gateway',
                    'Channel', 'Receipt', 'Created', 'Actions',
                  ].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {loading && !loadedOnceRef.current ? (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-500">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-500">No payments found.</td></tr>
                ) : rows.map((t) => {
                  const receipt = t.receipts?.[0];
                  return (
                    <tr key={t.id} className="hover:bg-gray-50/60">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-mono text-xs text-gray-900">#{t.id}</div>
                        <div className="font-mono text-xs text-gray-500 break-all max-w-[180px]" title={t.reference}>{t.reference}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-medium text-gray-900">{t.user ? `${t.user.firstName} ${t.user.lastName}` : '—'}</div>
                        <div className="text-xs text-gray-500">{t.user?.matricNumber || `#${t.user?.id ?? '—'}`}</div>
                        <div className="text-xs text-gray-400 break-all max-w-[200px]">{t.user?.email}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-mono text-xs text-gray-900">{t.invoice?.invoiceNumber || '—'}</div>
                        <div className="text-xs text-gray-500">{t.invoice?.fee?.name || '—'}</div>
                        {t.invoice?.fee?.feeCode && <div className="text-xs text-gray-400">{t.invoice.fee.feeCode}</div>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-semibold text-gray-900">{fmtNGN(t.amount)}</td>
                      <td className="px-4 py-3 whitespace-nowrap"><StatusPill status={t.status} /></td>
                      <td className="px-4 py-3 whitespace-nowrap"><GatewayPill gateway={t.gateway} /></td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-700">{t.paystackChannel || t.type || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {receipt ? (
                          <div>
                            <div className="font-mono text-xs text-gray-900">{receipt.receiptNumber}</div>
                            {receipt.isVoided && <div className="text-xs text-red-600 font-medium">Voided</div>}
                          </div>
                        ) : <span className="text-xs text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-600">{fmtDate(t.createdAt)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          {receipt && (
                            <button className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                              onClick={() => downloadReceipt(receipt.id)}>
                              Download PDF
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-6 py-4 border-t border-gray-100 bg-gray-50/50 text-sm text-gray-600">
            <div>
              {data ? `${data.pageSize * (data.page - 1) + (rows.length ? 1 : 0)}–${data.pageSize * (data.page - 1) + rows.length} of ${data.total}` : loadedOnceRef.current ? '0 results' : ''}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1 || !data} className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50">Prev</button>
              <span className="font-medium text-gray-900 min-w-[4rem] text-center">Page {currentPage} of {totalPages}</span>
              <button onClick={() => setPage(currentPage + 1)} disabled={currentPage >= totalPages || !data} className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50">Next</button>
            </div>
          </div>
        </div>
      </div>
    </PortalShell>
  );
};

export default PaymentsPage;
