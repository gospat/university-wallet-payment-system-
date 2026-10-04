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

const VOIDED_OPTIONS = [
  { v: '', l: 'All (Active + Voided)' },
  { v: 'false', l: 'Active Only' },
  { v: 'true', l: 'Voided Only' },
] as const;

const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500';
const Field: React.FC<{ label: string; children: React.ReactNode; className?: string }> = ({ label, children, className }) => (
  <div className={`space-y-1 ${className ?? ''}`}>
    <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide">{label}</label>
    {children}
  </div>
);

type ReceiptRow = {
  id: number;
  receiptNumber: string;
  verificationToken: string;
  paidAmount: number | string;
  paidAt: string;
  generatedAt?: string;
  isVoided: boolean;
  voidedAt?: string | null;
  paymentChannel?: string | null;
  paymentMethodDetail?: string | null;
  paystackReference?: string | null;
  qrCodeData?: string | null;
  invoice?: { id: number; invoiceNumber: string; dueDate?: string; session?: string; semester?: string; fee?: { id: number; name: string; feeCode?: string } | null } | null;
  transaction?: { reference: string; paystackChannel?: string | null; gateway?: string; type?: string } | null;
};

type ListResp = { items: ReceiptRow[]; total: number; page: number; pageSize: number; totalPages: number };

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

const MyReceipts: React.FC<{ brand: string; userText: string; onLogout: () => void; goBack: () => void; dashboardTo: string }> = ({ brand, userText, onLogout, goBack, dashboardTo }) => {
  const { user } = useAuth();
  void user;
  void goBack;
  void dashboardTo;
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const baseEndpoint = '/students/receipts';
  const activePath = '/student/receipts';

  useEffect(() => {
    setErrorMsg('');
  }, []);

  useEffect(() => { void navCounters().then(setNavCounts); }, []);

  const defaultQuery = useMemo(() => ({
    page: '1', pageSize: '25',
    q: '', isVoided: '', dateFrom: '', dateTo: '',
  }), []);

  const [query, setQueryState] = useState<Record<string, string>>(defaultQuery);
  const setQuery = useCallback((q: Record<string, string>) => setQueryState(q), []);
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
      setErrorMsg(e?.message || 'Failed to load receipts');
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
    const downloadEndpoint = `${api.defaults.baseURL || '/api/v1'}/students/receipts/${receiptId}/download`;
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

  const openPublicVerify = (verificationToken: string) => {
    const pubUrl = `${window.location.origin}/public/verify-receipt/${encodeURIComponent(verificationToken)}`;
    window.open(pubUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <PortalShell brand={brand} userText={userText} role="STUDENT" onLogout={onLogout} activePath={activePath} navCounters={navCounts}>
      <div className="w-full space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Receipts</h1>
          <p className="text-sm text-gray-500 mt-1">
            Download and view receipts for all fee payments you have made.
          </p>
        </div>

        {errorMsg && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm flex items-center justify-between">
            <span>{errorMsg}</span>
            <button className="underline text-red-700" onClick={() => setErrorMsg('')}>Dismiss</button>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <Field label="Search" className="md:col-span-2">
              <div className="relative">
                <input
                  type="text"
                  className={`${inputCls} pl-9`}
                  placeholder="Search receipt #, invoice, fee name..."
                  value={query.q}
                  onChange={(e) => setQuery({ ...query, q: e.target.value, page: '1' })}
                />
                <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" /></svg>
              </div>
            </Field>
            <Field label="Status">
              <select className={inputCls} value={query.isVoided} onChange={(e) => setQuery({ ...query, isVoided: e.target.value, page: '1' })}>
                {VOIDED_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
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
            <Field label="Page Size">
              <select className={inputCls} value={query.pageSize} onChange={(e) => setQuery({ ...query, pageSize: e.target.value, page: '1' })}>
                {[10, 25, 50, 100].map((n) => <option key={n} value={String(n)}>{n}</option>)}
              </select>
            </Field>
            <Field label="Quick Actions" className="md:col-span-2 lg:col-span-3 justify-self-end self-end">
              <div className="flex gap-2">
                <button className="px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-700 text-sm font-medium hover:bg-gray-50"
                  onClick={() => setQuery(defaultQuery)}>
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

        {/* Table */}
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {[
                    'Receipt #', 'Invoice / Fee', 'Session', 'Amount Paid', 'Paid At',
                    'Status', 'Channel', 'Verification Token', 'Actions',
                  ].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {loading && !loadedOnceRef.current ? (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-500">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-500">You have no receipts yet. Complete a fee payment to generate a receipt.</td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/60">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-mono text-xs font-semibold text-gray-900">{r.receiptNumber}</div>
                      <div className="text-xs text-gray-400">#{r.id}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-mono text-xs text-gray-900">{r.invoice?.invoiceNumber || '—'}</div>
                      <div className="text-xs text-gray-500">{r.invoice?.fee?.name || '—'}</div>
                      {r.invoice?.fee?.feeCode && <div className="text-xs text-gray-400">{r.invoice.fee.feeCode}</div>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-700">{r.invoice?.session || '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap font-bold text-gray-900">{fmtNGN(r.paidAmount)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-600">{fmtDate(r.paidAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.isVoided ? (
                        <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border bg-red-50 text-red-700 border-red-200">Voided</span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border bg-green-50 text-green-700 border-green-200">Active</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-700">{r.paymentChannel || r.transaction?.paystackChannel || '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-mono text-xs text-gray-700 break-all inline-block max-w-[180px]" title={r.verificationToken}>{r.verificationToken}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex flex-col items-start gap-1">
                        <button className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                          onClick={() => downloadReceipt(r.id)}>
                          Download PDF
                        </button>
                        <button className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
                          onClick={() => openPublicVerify(r.verificationToken)}>
                          Share Verify Link
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
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

export default MyReceipts;
