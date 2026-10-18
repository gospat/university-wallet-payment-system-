import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import Modal from '../../components/Modal';
import Alert from '../../components/Alert';
import api, { navCounters, NavCounters } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { getAccessToken } from '../../utils/tokenStore';
import {
  cancelTransaction as cancelTransactionApi,
  CANCEL_TRANSACTION_REASONS,
  type CancelTransactionReasonKey,
} from '../../services/adminFees';

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
    CANCELLED: 'bg-gray-50 text-gray-600 border-gray-200',
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
      {g === 'PAYSTACK' ? 'Paystack' : g === 'ALATPAY' ? 'ALATPay' : g}
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

type VerifyTxDetail = {
  id: number;
  reference: string;
  status: string;
  gateway: string;
  amount: number | string;
  expectedAmount: number | string;
  description?: string | null;
  type?: string | null;
  createdAt: string;
  updatedAt?: string;
  paystackReference?: string | null;
  paystackChannel?: string | null;
  alatpayReference?: string | null;
  alatpayOrderReference?: string | null;
  alatpayInitPaymentReference?: string | null;
  alatpayFinalTransactionId?: string | null;
  alatpayCheckoutUrl?: string | null;
  alatpaySessionId?: string | null;
  underpaidReason?: string | null;
  userId?: number | null;
  invoiceId?: number | null;
  user?: { id: number; firstName: string; lastName: string; email: string; matricNumber?: string | null } | null;
  invoice?: { id: number; invoiceNumber: string; amountDue: number | string; amountPaid: number | string; status: string; fee?: { id: number; name: string; feeCode?: string } | null } | null;
  receipts?: { id: number; receiptNumber: string; verificationToken?: string; isVoided?: boolean; generatedAt?: string }[];
};

type VerifyResult = {
  verified: boolean;
  bellsStatus: string;
  providerStatus: string | null;
  provider: string;
  amountExpected: number | string;
  amountConfirmed: number | string;
  providerTransactionId: string | null;
  verifiedAt: string;
  reason?: string | null;
  alreadyVerified?: boolean;
  receipt?: any;
  generalLedger?: any;
  message?: string;
};

const DetailRow: React.FC<{ label: string; value?: React.ReactNode }> = ({ label, value }) => (
  <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3 py-1.5 border-b border-gray-100 last:border-0">
    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide w-44 shrink-0">{label}</span>
    <span className="text-sm text-gray-900 break-all font-mono">{value ?? '—'}</span>
  </div>
);

const VerifyPaymentWorkspace: React.FC<{ baseEndpoint: string }> = ({ baseEndpoint }) => {
  const [lookupField, setLookupField] = useState<'reference' | 'transactionId' | 'paystackRef' | 'alatpayFinalTxId'>('reference');
  const [lookupValue, setLookupValue] = useState('');
  const [txDetail, setTxDetail] = useState<VerifyTxDetail | null>(null);
  const [glDetail, setGlDetail] = useState<any>(null);
  const [alatpayFinalTxIdValid, setAlatpayFinalTxIdValid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const doLookup = async () => {
    const value = lookupValue.trim();
    if (!value) { setErrorMsg('Enter a value to look up.'); return; }
    setLoading(true); setErrorMsg(''); setTxDetail(null); setGlDetail(null); setVerifyResult(null);
    try {
      const typeMap: Record<string, string> = {
        reference: 'reference',
        transactionId: 'transactionId',
        paystackRef: 'paystackReference',
        alatpayFinalTxId: 'alatpayFinalTransactionId',
      };
      const type = typeMap[lookupField];
      const q = new URLSearchParams();
      q.set('type', type);
      q.set('value', value);
      const resp = await api.get<{ status: string; data: { transaction: VerifyTxDetail; generalLedger: any; alatpayFinalTxIdValid: boolean; webhookEvidence: any; settlementEvidence: any } }>(`${baseEndpoint}/lookup?${q.toString()}`);
      if (resp.data?.status === 'success') {
        setTxDetail(resp.data.data.transaction);
        setGlDetail(resp.data.data.generalLedger);
        setAlatpayFinalTxIdValid(resp.data.data.alatpayFinalTxIdValid);
      } else {
        setErrorMsg('Transaction not found.');
      }
    } catch (e: any) {
      if (e?.response?.status === 404) setErrorMsg('Transaction not found.');
      else setErrorMsg(e?.response?.data?.message || e?.message || 'Lookup failed.');
    } finally {
      setLoading(false);
    }
  };

  const doVerify = async () => {
    if (!txDetail) return;
    setVerifyLoading(true); setVerifyResult(null); setErrorMsg('');
    try {
      const resp = await api.post<{ status: string; data: VerifyResult }>(`${baseEndpoint}/${txDetail.id}/verify`);
      const data = resp.data?.data;
      if (data) setVerifyResult(data);
      // Refresh transaction detail after verification
      const detailResp = await api.get<{ status: string; data: { transaction: VerifyTxDetail; generalLedger: any; alatpayFinalTxIdValid: boolean } }>(`${baseEndpoint}/${txDetail.id}`);
      if (detailResp.data?.status === 'success') {
        setTxDetail(detailResp.data.data.transaction);
        setGlDetail(detailResp.data.data.generalLedger);
        setAlatpayFinalTxIdValid(detailResp.data.data.alatpayFinalTxIdValid);
      }
    } catch (e: any) {
      setErrorMsg(e?.response?.data?.message || e?.message || 'Verification request failed.');
    } finally {
      setVerifyLoading(false);
    }
  };

  const resultKind = (() => {
    if (!verifyResult) return null;
    if (verifyResult.alreadyVerified) return 'already';
    if (verifyResult.verified && verifyResult.bellsStatus === 'SUCCESS') return 'success';
    if (verifyResult.bellsStatus === 'FAILED') return 'failed';
    if (verifyResult.provider === 'ALATPAY' && !alatpayFinalTxIdValid && !verifyResult.verified) return 'unable';
    if (verifyResult.reason === 'PROVIDER_TRANSPORT_ERROR') return 'unavailable';
    return 'pending';
  })();

  const resultStyle: Record<string, string> = {
    success: 'border-green-200 bg-green-50 text-green-800',
    already: 'border-blue-200 bg-blue-50 text-blue-800',
    pending: 'border-amber-200 bg-amber-50 text-amber-800',
    unable: 'border-orange-200 bg-orange-50 text-orange-800',
    unavailable: 'border-red-200 bg-red-50 text-red-800',
    failed: 'border-red-200 bg-red-50 text-red-800',
  };

  const canVerify = txDetail && (
    txDetail.gateway === 'PAYSTACK'
      ? !!txDetail.paystackReference
      : txDetail.gateway === 'ALATPAY'
        ? !!txDetail.alatpayFinalTransactionId && alatpayFinalTxIdValid
        : false
  );

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Verify Payment</h1>
        <p className="text-sm text-gray-500 mt-1">
          Look up a transaction and confirm its status with the payment provider. Verification is authoritative and idempotent.
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Lookup by">
            <select className={inputCls} value={lookupField} onChange={(e) => setLookupField(e.target.value as any)}>
              <option value="reference">Bells Payment Reference</option>
              <option value="transactionId">Transaction ID</option>
              <option value="paystackRef">Paystack Reference</option>
              <option value="alatpayFinalTxId">ALATPay Final Transaction UUID</option>
            </select>
          </Field>
          <Field label="Value" className="sm:col-span-2">
            <input
              type="text"
              className={inputCls}
              placeholder={lookupField === 'reference' ? 'PAY-20261010-WKCLUP' : lookupField === 'transactionId' ? '12345' : lookupField === 'paystackRef' ? 'Paystack reference' : 'ALATPay final UUID v4'}
              value={lookupValue}
              onChange={(e) => setLookupValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doLookup(); }}
            />
          </Field>
        </div>
        <div className="flex gap-3">
          <button
            onClick={doLookup}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Looking up...' : 'Look Up Transaction'}
          </button>
        </div>
        {errorMsg && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm">{errorMsg}</div>
        )}
      </div>

      {txDetail && (
        <>
          <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-1">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-gray-900">Transaction Details</h2>
              <div className="flex items-center gap-2">
                <StatusPill status={txDetail.status} />
                <GatewayPill gateway={txDetail.gateway} />
              </div>
            </div>
            <DetailRow label="Transaction ID" value={String(txDetail.id)} />
            <DetailRow label="Bells Payment Reference" value={txDetail.reference} />
            <DetailRow label="Student Name" value={txDetail.user ? `${txDetail.user.firstName} ${txDetail.user.lastName}` : '—'} />
            <DetailRow label="Matric Number" value={txDetail.user?.matricNumber} />
            <DetailRow label="Invoice Number" value={txDetail.invoice?.invoiceNumber} />
            <DetailRow label="Fee" value={txDetail.invoice?.fee?.name} />
            <DetailRow label="Gateway" value={txDetail.gateway} />
            <DetailRow label="Transaction Status" value={txDetail.status} />
            <DetailRow label="Expected Amount" value={fmtNGN(txDetail.expectedAmount)} />
            <DetailRow label="Amount Received" value={fmtNGN(txDetail.amount)} />
            <DetailRow label="Created" value={fmtDate(txDetail.createdAt)} />
            <DetailRow label="Updated" value={fmtDate(txDetail.updatedAt)} />
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-1">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Provider Identifiers</h2>
            {txDetail.gateway === 'PAYSTACK' && (
              <DetailRow label="Paystack Reference" value={txDetail.paystackReference} />
            )}
            {txDetail.gateway === 'ALATPAY' && (
              <>
                <DetailRow label="ALATPay Order Reference" value={txDetail.alatpayOrderReference} />
                <DetailRow label="ALATPay Init Reference" value={txDetail.alatpayInitPaymentReference} />
                <DetailRow
                  label="ALATPay Final Transaction UUID"
                  value={
                    txDetail.alatpayFinalTransactionId ? (
                      <span className={alatpayFinalTxIdValid ? 'text-green-700' : 'text-red-700'}>
                        {txDetail.alatpayFinalTransactionId}
                        {' '}
                        <span className="text-xs">({alatpayFinalTxIdValid ? 'valid UUID v4' : 'NOT a valid UUID — cannot verify'})</span>
                      </span>
                    ) : (
                      <span className="text-orange-700">Not captured</span>
                    )
                  }
                />
              </>
            )}
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-1">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Financial Evidence</h2>
            <DetailRow
              label="Receipt"
              value={txDetail.receipts && txDetail.receipts.length > 0 ? (
                <span className="text-green-700">{txDetail.receipts[0].receiptNumber} (voided: {String(txDetail.receipts[0].isVoided)})</span>
              ) : <span className="text-gray-400">None</span>}
            />
            <DetailRow
              label="General Ledger"
              value={glDetail ? (
                <span className="text-green-700">{glDetail.entryType} — {fmtNGN(glDetail.amount)}</span>
              ) : <span className="text-gray-400">No posting</span>}
            />
            <DetailRow label="Underpaid Reason" value={txDetail.underpaidReason} />
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">Provider Verification</h2>
            {txDetail.gateway === 'ALATPAY' && !alatpayFinalTxIdValid && (
              <div className="rounded-lg border border-orange-200 bg-orange-50 text-orange-800 px-4 py-3 text-sm">
                Provider verification unavailable because the final ALATPay transaction identifier was not captured.
                The payment remains unresolved. Check webhook/reconciliation evidence or use the authorized
                cancellation/reconciliation workflow.
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={doVerify}
                disabled={!canVerify || verifyLoading}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {verifyLoading ? 'Checking provider...' : 'Check Provider Status'}
              </button>
            </div>

            {verifyResult && (
              <div className={`rounded-lg border px-4 py-4 ${resultStyle[resultKind ?? 'pending']}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-base">
                    {resultKind === 'success' && 'SUCCESS — Payment confirmed by provider.'}
                    {resultKind === 'already' && 'Already verified and financially posted.'}
                    {resultKind === 'pending' && 'PENDING — Provider has not confirmed a final payment result.'}
                    {resultKind === 'unable' && 'UNABLE TO VERIFY — Final provider transaction ID is unavailable. No financial status was changed.'}
                    {resultKind === 'unavailable' && 'PROVIDER UNAVAILABLE — Provider verification could not be completed. No financial status was changed.'}
                    {resultKind === 'failed' && 'FAILED — Authoritative terminal provider failure.'}
                  </span>
                </div>
                {verifyResult.message && <p className="text-sm opacity-90 mb-3">{verifyResult.message}</p>}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  <DetailRow label="Provider" value={verifyResult.provider} />
                  <DetailRow label="Provider Status" value={verifyResult.providerStatus} />
                  <DetailRow label="Bells Status" value={verifyResult.bellsStatus} />
                  <DetailRow label="Amount Expected" value={fmtNGN(verifyResult.amountExpected)} />
                  <DetailRow label="Amount Confirmed" value={fmtNGN(verifyResult.amountConfirmed)} />
                  <DetailRow label="Provider Transaction ID" value={verifyResult.providerTransactionId} />
                  <DetailRow label="Verification Time" value={fmtDate(verifyResult.verifiedAt)} />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

const PaymentsPage: React.FC<{ role: 'ADMIN' | 'BURSARY'; brand: string; userText: string; onLogout: () => void; goBack: () => void; dashboardTo: string }> = ({ role, brand, userText, onLogout, goBack, dashboardTo }) => {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const viewMode = searchParams.get('view') ?? 'list';
  const isVerifyView = viewMode === 'verify';
  void goBack;
  void dashboardTo;
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const baseEndpoint = role === 'ADMIN' ? '/admin/payments' : '/bursary/payments';
  const activePath = `/${role.toLowerCase()}/payments${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;

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
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState<CancelTransactionReasonKey | ''>('');
  const [cancelWritten, setCancelWritten] = useState<string>('');
  const [cancelEvidence, setCancelEvidence] = useState<string>('');
  const [cancelOverride, setCancelOverride] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState<string>('');

  const STRICT_SUPPORT_TICKET_REGEX = /^(SUPPORT-[0-9]{5,}|[A-Z]{2,}-TKT-[0-9]{4,}|REC-[A-Z0-9]{6,})$/;

  const canCancelTransaction = (t: any): { ok: boolean; why?: string } => {
    if (!t) return { ok: false, why: 'Missing row' };
    const status = String(t.status ?? '');
    const ineligible = new Set(['SUCCESS', 'REVERSED', 'CANCELLED']);
    if (ineligible.has(status)) {
      return { ok: false, why: `Status ${status} cannot be cancelled (only pending/processing/failed/unpaid attempts are eligible).` };
    }
    const receipts = Array.isArray(t.receipts) ? t.receipts.length : 0;
    if (receipts > 0) return { ok: false, why: `Receipted (${receipts}) transactions must use reversal workflow, not cancellation.` };
    const invoicePaid = Number(t.invoice?.amountPaid ?? 0);
    const txAmount = Number(t.amount ?? 0);
    if (invoicePaid > 0 && txAmount > 0) {
      return { ok: false, why: 'Invoice already has amountPaid and this attempt already has an amount posted.' };
    }
    return { ok: true };
  };

  const openCancelDialog = (t: any) => {
    setCancelTarget(t);
    setCancelReason('');
    setCancelWritten('');
    setCancelEvidence('');
    setCancelOverride(false);
    setCancelError('');
    setCancelDialogOpen(true);
  };
  const closeCancelDialog = () => {
    setCancelDialogOpen(false);
    setCancelTarget(null);
  };
  const doCancelTransaction = async () => {
    if (!cancelTarget) return;
    if (!cancelReason) { setCancelError('Cancellation reason is required.'); return; }
    if (cancelReason === 'OTHER' && (cancelWritten.trim().length < 1)) {
      setCancelError('Written explanation is required when reason is Other.'); return;
    }
    if (cancelOverride && role !== 'ADMIN') {
      setCancelError('Manual Support Override is only available to ADMIN role.'); return;
    }
    if (cancelOverride && !STRICT_SUPPORT_TICKET_REGEX.test(cancelEvidence.trim())) {
      setCancelError('Manual Support Override requires a valid support reference (e.g. SUPPORT-12345, AB-TKT-1234, REC-ABC123).'); return;
    }
    setCancelLoading(true); setCancelError('');
    try {
      await cancelTransactionApi(
        Number(cancelTarget.id),
        {
          reason: cancelReason,
          writtenExplanation: cancelWritten || null,
          evidenceReference: cancelEvidence || null,
          evidenceOverride: cancelOverride ? 'MANUAL_SUPPORT_OVERRIDE' : undefined,
        },
        { role: role === 'ADMIN' ? 'admin' : 'bursary' }
      );
      closeCancelDialog();
      await loadData();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || String(err) || 'Cancellation failed.';
      setCancelError(msg.slice(0, 600));
    } finally {
      setCancelLoading(false);
    }
  };

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
    const token = getAccessToken() || '';
    const downloadEndpoint = role === 'ADMIN'
      ? `${(api.defaults.baseURL || '/api/v1')}/admin/receipts/${receiptId}/download`
      : `${(api.defaults.baseURL || '/api/v1')}/bursary/receipts/${receiptId}/download`;
    fetch(downloadEndpoint, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    })
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
      {isVerifyView ? (
        <VerifyPaymentWorkspace baseEndpoint={baseEndpoint} />
      ) : (
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
                {GATEWAY_OPTIONS.map((s) => <option key={s} value={s}>{s === 'PAYSTACK' ? 'Paystack' : 'ALATPay'}</option>)}
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
                          {(() => {
                            const c = canCancelTransaction(t);
                            return (
                              <button
                                className="text-red-600 hover:text-red-800 text-sm font-medium disabled:text-gray-300 disabled:cursor-not-allowed"
                                disabled={!c.ok}
                                title={c.ok ? 'Cancel this payment attempt (manual / audited, no financial posting)' : (c.why ?? '')}
                                onClick={() => openCancelDialog(t)}
                              >
                                Cancel
                              </button>
                            );
                          })()}
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
      )}
      <Modal
        isOpen={cancelDialogOpen}
        title={`Cancel Payment Attempt #${cancelTarget?.id ?? ''} ${cancelTarget?.reference ? `(${cancelTarget.reference})` : ''}`}
        size="lg"
        onClose={() => { if (!cancelLoading) closeCancelDialog(); }}
        footer={
          <div className="w-full flex justify-end gap-2">
            <button
              type="button"
              disabled={cancelLoading}
              onClick={closeCancelDialog}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
            >
              Cancel (close)
            </button>
            <button
              type="button"
              disabled={cancelLoading || !cancelTarget || !cancelReason || (cancelReason === 'OTHER' && cancelWritten.trim().length < 1)}
              onClick={doCancelTransaction}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white shadow-sm bg-gradient-to-br from-red-600 to-rose-600 hover:from-red-700 hover:to-rose-700 focus:outline-none focus:ring-2 focus:ring-red-500/30 disabled:opacity-50"
            >
              {cancelLoading ? 'Cancelling…' : 'Confirm Cancel Attempt'}
            </button>
          </div>
        }
      >
        <div className="space-y-5 text-sm">
          <Alert variant="info">
            Cancellation marks an unpaid attempt as CANCELLED for audit purposes. It does <strong>not</strong> modify the invoice
            balance, generate a receipt, post any General Ledger entry, or trigger settlements. Server-side safety checks are
            the final arbiter.
          </Alert>
          <Alert variant="danger">
            <div className="text-xs leading-relaxed">
              <div className="font-semibold mb-1">Never auto-cancel.</div>
              Never cancel merely because a popup closed, time elapsed, a callback is missing, or you see no final UUID.
              Always verify independently: receipts already issued, settlements posted, General Ledger financial entries,
              webhook evidence, and any provider dashboard reference before cancelling.
            </div>
          </Alert>
          {cancelTarget && (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-xs">
              <div>
                <dt className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Student</dt>
                <dd className="font-medium text-gray-900 mt-0.5">{cancelTarget.user ? `${cancelTarget.user.firstName} ${cancelTarget.user.lastName}` : '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Invoice</dt>
                <dd className="font-medium text-gray-900 mt-0.5">{cancelTarget.invoice?.invoiceNumber || '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Current Status</dt>
                <dd className="mt-0.5"><StatusPill status={cancelTarget.status ?? 'UNKNOWN'} /></dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">Amount / Expected</dt>
                <dd className="font-medium text-gray-900 mt-0.5 tabular-nums">{fmtNGN(cancelTarget.amount ?? 0)} / {fmtNGN(cancelTarget.expectedAmount ?? 0)}</dd>
              </div>
            </dl>
          )}
          <div className="space-y-1.5">
            <label htmlFor="cancel-reason" className="block text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Cancellation reason <span className="text-red-600">*</span>
            </label>
            <select
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason((e.target.value as CancelTransactionReasonKey) || '')}
              className={inputCls}
            >
              <option value="">— Select reason —</option>
              {CANCEL_TRANSACTION_REASONS.map((r) => (
                <option key={r.key} value={r.key}>{r.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="cancel-evidence" className="block text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Evidence reference
            </label>
            <input
              id="cancel-evidence"
              type="text"
              placeholder="provider ticket# / recon ID / email subject / internal ref"
              value={cancelEvidence}
              onChange={(e) => setCancelEvidence(e.target.value ?? '')}
              maxLength={500}
              className={inputCls}
            />
            <div className="text-[11px] text-gray-500 leading-relaxed">
              If provider success refs or SUCCESS-like status are present, EVIDENCE &amp; WRITTEN EXPLANATION (&ge;20 chars) are REQUIRED server-side.
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="cancel-written" className="block text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Written explanation {cancelReason === 'OTHER' && <span className="text-red-600">*</span>}
            </label>
            <textarea
              id="cancel-written"
              rows={4}
              maxLength={2000}
              value={cancelWritten}
              onChange={(e) => setCancelWritten(e.target.value ?? '')}
              placeholder="Documented evidence, checks performed, or supporting rationale…"
              className={inputCls + ' resize-y min-h-[100px]'}
            />
          </div>
          {role === 'ADMIN' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 space-y-2">
              <label htmlFor="cancel-override" className="flex items-start gap-2 cursor-pointer">
                <input
                  id="cancel-override"
                  type="checkbox"
                  checked={cancelOverride}
                  onChange={(e) => setCancelOverride(!!e.target.checked)}
                  disabled={cancelLoading}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                />
                <span className="text-xs font-semibold text-amber-900">
                  Manual Support Override (MANUAL_SUPPORT_OVERRIDE)
                </span>
              </label>
              <p className="text-[11px] text-amber-800 leading-relaxed pl-6">
                Exceptional reconciliation only. Requires ADMIN role, VOID_TRANSACTIONS permission, a valid support
                reference (e.g. <code className="font-mono">SUPPORT-12345</code>, <code className="font-mono">AB-TKT-1234</code>,
                <code className="font-mono">REC-ABC123</code>), and a written explanation. Never use for popup-close,
                elapsed time, missing callback, or missing final UUID.
              </p>
            </div>
          )}
          {cancelError && (
            <Alert variant="danger">
              <div className="text-xs whitespace-pre-wrap leading-relaxed">{cancelError}</div>
            </Alert>
          )}
        </div>
      </Modal>
    </PortalShell>
  );
};

export default PaymentsPage;
