import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PortalShell from '../../components/PortalShell';
import api, { navCounters, NavCounters } from '../../services/api';
import { useSearchParams } from 'react-router-dom';
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
  student?: { id: number; firstName: string; lastName: string; email: string; matricNumber?: string | null } | null;
  invoice?: { id: number; invoiceNumber: string; fee?: { id: number; name: string; feeCode?: string } | null } | null;
  transaction?: {
    reference: string; paystackChannel?: string | null; gateway?: string; type?: string;
    amount?: number | string; status?: string; createdAt?: string;
  } | null;
  voidedBy?: { id: number; firstName: string; lastName: string; email: string } | null;
};

type ListResp = { items: ReceiptRow[]; total: number; page: number; pageSize: number; totalPages: number };
type VerifyResp = {
  status: string;
  verified: boolean;
  message?: string;
  data?: {
    id: number; receiptNumber: string; verificationToken: string;
    paidAmount: number | string; paidAt: string; isVoided: boolean; voidedAt?: string | null;
    paymentChannel?: string | null; paymentMethodDetail?: string | null; paystackReference?: string | null;
    student?: { id: number; firstName: string; lastName: string; email: string; matricNumber?: string | null };
    invoice?: { id: number; invoiceNumber: string; dueDate?: string; session?: string; semester?: string; fee?: { name: string; feeCode?: string } | null } | null;
    transaction?: { reference?: string; paystackReference?: string; paystackChannel?: string; gateway?: string; type?: string; amount?: number | string; status?: string; createdAt?: string } | null;
  };
  branding?: { name: string; address?: string; phone?: string; website?: string; bankName?: string; bankAccount?: string };
};

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

const ReceiptsPage: React.FC<{ role: 'ADMIN' | 'BURSARY'; brand: string; userText: string; onLogout: () => void; goBack: () => void; dashboardTo: string }> = ({ role, brand, userText, onLogout, goBack, dashboardTo }) => {
  const { user } = useAuth();
  void user;
  void goBack;
  void dashboardTo;
  const [searchParams] = useSearchParams();
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const verifyMode = searchParams.get('verify') === '1';
  const baseEndpoint = role === 'ADMIN' ? '/admin/receipts' : '/bursary/receipts';
  const verifyEndpoint = role === 'ADMIN' ? '/admin/receipts/verify' : '/bursary/receipts/verify';
  const activePath = `/${role.toLowerCase()}/receipts`;

  useEffect(() => { void navCounters().then(setNavCounts); }, []);

  const defaultQuery = useMemo(() => ({
    page: '1', pageSize: '25', sort: 'paidAt', order: 'desc',
    q: '', isVoided: '', dateFrom: '', dateTo: '',
    studentId: '', feeId: '',
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
      if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || e?.name === 'AbortError') return;
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
    const downloadEndpoint = `${api.defaults.baseURL || '/api/v1'}${baseEndpoint}/${receiptId}/download`;
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
      .catch((err) => setErrorMsg(err.message || 'Download failed'));
  };

  // ---------- Verify Receipt panel state ----------
  const [verifyInput, setVerifyInput] = useState('');
  const [verifyResult, setVerifyResult] = useState<VerifyResp | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError] = useState<string>('');

  const runVerify = useCallback(async () => {
    const tok = verifyInput.trim();
    if (!tok) return;
    setVerifyLoading(true);
    setVerifyError('');
    setVerifyResult(null);
    try {
      const resp = await api.get<VerifyResp>(`${verifyEndpoint}/${encodeURIComponent(tok)}`);
      setVerifyResult(resp.data);
    } catch (e: any) {
      if (e?.response?.data) {
        setVerifyResult(e.response.data);
      } else {
        setVerifyError(e?.message || 'Verification failed');
      }
    } finally {
      setVerifyLoading(false);
    }
  }, [verifyEndpoint, verifyInput]);

  const openPublicVerify = (verificationToken: string) => {
    const pubUrl = `${window.location.origin}/public/verify-receipt/${encodeURIComponent(verificationToken)}`;
    window.open(pubUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <PortalShell brand={brand} userText={userText} role={role} onLogout={onLogout} activePath={activePath} navCounters={navCounts}>
      <div className="w-full space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {verifyMode ? 'Verify Receipt' : 'All Receipts'}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {verifyMode
              ? 'Enter a receipt number or verification token to verify authenticity and view details.'
              : role === 'ADMIN'
                ? 'Manage, download, and verify all generated fee receipts.'
                : 'Manage and download finance-issued fee receipts.'}
          </p>
        </div>

        {errorMsg && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm flex items-center justify-between">
            <span>{errorMsg}</span>
            <button className="underline text-red-700" onClick={() => setErrorMsg('')}>Dismiss</button>
          </div>
        )}

        {/* Verify Receipt inline card (only when ?verify=1) */}
        {verifyMode && (
          <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
            <div className="flex items-start gap-3">
              <div className="bg-blue-50 p-3 rounded-xl text-blue-600 flex-shrink-0">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" /></svg>
              </div>
              <div className="flex-1 space-y-4 w-full">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Verify Receipt Authenticity</h2>
                  <p className="text-sm text-gray-500">Lookup any receipt by its verification token or receipt number.</p>
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <input
                      type="text"
                      className={inputCls}
                      placeholder="Enter verification token or receipt number (e.g. REC-2025-000123)"
                      value={verifyInput}
                      onChange={(e) => setVerifyInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') runVerify(); }}
                    />
                  </div>
                  <button
                    className="px-5 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                    onClick={runVerify}
                    disabled={verifyLoading || !verifyInput.trim()}
                  >
                    {verifyLoading ? 'Verifying…' : 'Verify Receipt'}
                  </button>
                </div>

                {verifyError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm">{verifyError}</div>
                )}
                {verifyResult && (
                  <div className={`rounded-xl border p-5 space-y-4 ${verifyResult.verified ? 'border-green-200 bg-green-50/60' : verifyResult.status === 'fail' ? 'border-red-200 bg-red-50/60' : 'border-amber-200 bg-amber-50/60'}`}>
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-full ${verifyResult.verified ? 'bg-green-100 text-green-700' : verifyResult.status === 'fail' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                        {verifyResult.verified ? (
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        ) : verifyResult.status === 'fail' ? (
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        ) : (
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        )}
                      </div>
                      <div>
                        <div className="text-lg font-bold">
                          {verifyResult.verified ? 'Receipt Verified — Authentic' : verifyResult.status === 'fail' ? 'Receipt Not Found' : 'Receipt Voided — No Longer Valid'}
                        </div>
                        <div className="text-sm text-gray-600">
                          {verifyResult.message || (verifyResult.data?.isVoided ? 'This receipt has been voided and is no longer considered valid payment evidence.' : 'This receipt was issued and is still active.')}
                        </div>
                      </div>
                    </div>
                    {verifyResult.branding?.name && (
                      <div className="text-sm border-t border-gray-200 pt-3">
                        <div className="font-semibold text-gray-900">{verifyResult.branding.name}</div>
                        {(verifyResult.branding.address || verifyResult.branding.phone || verifyResult.branding.website) && (
                          <div className="text-gray-600 text-xs mt-1 space-y-0.5">
                            {verifyResult.branding.address && <div>{verifyResult.branding.address}</div>}
                            {verifyResult.branding.phone && <div>Phone: {verifyResult.branding.phone}</div>}
                            {verifyResult.branding.website && <div>Website: {verifyResult.branding.website}</div>}
                          </div>
                        )}
                      </div>
                    )}
                    {verifyResult.data && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm border-t border-gray-200 pt-3">
                        <div><span className="text-gray-500">Receipt No:</span> <span className="font-mono font-medium text-gray-900">{verifyResult.data.receiptNumber}</span></div>
                        <div><span className="text-gray-500">Verification Token:</span> <span className="font-mono text-xs text-gray-700 break-all">{verifyResult.data.verificationToken}</span></div>
                        <div><span className="text-gray-500">Student:</span> <span className="font-medium text-gray-900">{verifyResult.data.student ? `${verifyResult.data.student.firstName} ${verifyResult.data.student.lastName}` : '—'}</span></div>
                        <div><span className="text-gray-500">Matric No:</span> <span className="font-mono text-gray-800">{verifyResult.data.student?.matricNumber || '—'}</span></div>
                        <div><span className="text-gray-500">Fee / Invoice:</span> <span className="text-gray-900">{verifyResult.data.invoice?.fee?.name || verifyResult.data.invoice?.invoiceNumber || '—'}</span></div>
                        <div><span className="text-gray-500">Session:</span> <span className="text-gray-900">{verifyResult.data.invoice?.session || '—'}</span></div>
                        <div><span className="text-gray-500">Amount Paid:</span> <span className="font-bold text-gray-900">{fmtNGN(verifyResult.data.paidAmount)}</span></div>
                        <div><span className="text-gray-500">Paid At:</span> <span className="text-gray-900">{fmtDate(verifyResult.data.paidAt)}</span></div>
                        {verifyResult.data.transaction && (
                          <>
                            <div><span className="text-gray-500">Gateway:</span> <GatewayPill gateway={verifyResult.data.transaction.gateway} /></div>
                            <div><span className="text-gray-500">Tx Status:</span> {verifyResult.data.transaction.status && <StatusPill status={verifyResult.data.transaction.status} />}</div>
                            <div><span className="text-gray-500">Reference:</span> <span className="font-mono text-xs text-gray-800 break-all">{verifyResult.data.transaction.reference || '—'}</span></div>
                            <div><span className="text-gray-500">Channel:</span> <span className="text-gray-800">{verifyResult.data.transaction.paystackChannel || verifyResult.data.transaction.type || '—'}</span></div>
                          </>
                        )}
                        <div className="md:col-span-2 flex flex-wrap gap-2 pt-2 border-t border-gray-200">
                          <button className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
                            onClick={() => downloadReceipt(verifyResult.data!.id)}>
                            Download PDF
                          </button>
                          <button className="px-4 py-2 border border-gray-300 bg-white text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50"
                            onClick={() => openPublicVerify(verifyResult.data!.verificationToken)}>
                            Open Public Verify Link
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            <Field label="Search" className="xl:col-span-2">
              <div className="relative">
                <input
                  type="text"
                  className={`${inputCls} pl-9`}
                  placeholder="Search receipt #, token, student, invoice, fee..."
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
            <Field label="Sort By">
              <select className={inputCls} value={query.sort} onChange={(e) => setQuery({ ...query, sort: e.target.value })}>
                <option value="paidAt">Paid At</option>
                <option value="paidAmount">Amount</option>
                <option value="receiptNumber">Receipt #</option>
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
                    'Receipt #', 'Student', 'Invoice / Fee', 'Paid Amount', 'Paid At',
                    'Status', 'Payment Method', 'Verification Token', 'Actions',
                  ].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {loading && !loadedOnceRef.current ? (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-500">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-500">No receipts found.</td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/60">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-mono text-xs font-semibold text-gray-900">{r.receiptNumber}</div>
                      <div className="text-xs text-gray-400">#{r.id}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{r.student ? `${r.student.firstName} ${r.student.lastName}` : '—'}</div>
                      <div className="text-xs text-gray-500">{r.student?.matricNumber || `#${r.student?.id ?? '—'}`}</div>
                      <div className="text-xs text-gray-400 break-all max-w-[200px]">{r.student?.email}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-mono text-xs text-gray-900">{r.invoice?.invoiceNumber || '—'}</div>
                      <div className="text-xs text-gray-500">{r.invoice?.fee?.name || '—'}</div>
                      {r.invoice?.fee?.feeCode && <div className="text-xs text-gray-400">{r.invoice.fee.feeCode}</div>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap font-bold text-gray-900">{fmtNGN(r.paidAmount)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-600">{fmtDate(r.paidAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.isVoided ? (
                        <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border bg-red-50 text-red-700 border-red-200">Voided</span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border bg-green-50 text-green-700 border-green-200">Active</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        <GatewayPill gateway={r.transaction?.gateway} />
                        <span className="text-xs text-gray-500">{r.paymentChannel || r.transaction?.paystackChannel || '—'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-mono text-xs text-gray-700 break-all inline-block max-w-[160px]" title={r.verificationToken}>{r.verificationToken}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex flex-col items-start gap-1">
                        <button className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                          onClick={() => downloadReceipt(r.id)}>
                          Download PDF
                        </button>
                        <button className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
                          onClick={() => openPublicVerify(r.verificationToken)}>
                          Public Verify Link
                        </button>
                        {!r.isVoided && (
                          <button className="text-amber-700 hover:text-amber-900 text-xs font-medium"
                            onClick={() => { setVerifyInput(r.verificationToken); if (!verifyMode) window.location.hash = ''; }}>
                            Quick Verify
                          </button>
                        )}
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

export default ReceiptsPage;
