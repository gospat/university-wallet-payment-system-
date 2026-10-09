import React, { useEffect, useMemo, useState } from 'react';
import { X, Download, ExternalLink, RefreshCw, AlertTriangle, CheckCircle2, Clock, XCircle, HelpCircle } from 'lucide-react';
import { i18n } from '../i18n/en';
import studentFeeApi from '../services/studentFees';

export interface TxnDetailsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  transaction: any;
  onStatusChanged?: () => void;
}

type ReverifyUi =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; receipt: { id: number; receiptNumber: string; verificationToken?: string | null } | null; invoice: any | null; message?: string }
  | { kind: 'pending'; message?: string }
  | { kind: 'failed'; message?: string }
  | { kind: 'unavailable'; reason?: string | null; message?: string; supportContact?: boolean }
  | { kind: 'cooldown'; cooldownMs: number; message?: string }
  | { kind: 'conflict'; reason?: string | null; message?: string };

const formatNgn = (n: number | string | null | undefined): string => {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(v);
};

const formatDate = (d: string | Date | null | undefined): string => {
  if (!d) return 'N/A';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return 'N/A';
  return dt.toLocaleDateString('en-NG', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

const formatTime = (d: string | Date | null | undefined): string => {
  if (!d) return 'N/A';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return 'N/A';
  return dt.toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
  });
};

const statusClass = (status: string): string => {
  const map: Record<string, string> = {
    PAID: 'bg-emerald-100 text-emerald-800',
    SUCCESS: 'bg-emerald-100 text-emerald-800',
    PARTIALLY_PAID: 'bg-amber-100 text-amber-800',
    UNPAID: 'bg-gray-100 text-gray-800',
    OVERDUE: 'bg-red-100 text-red-800',
    PENDING: 'bg-sky-100 text-sky-800',
    FAILED: 'bg-red-100 text-red-800',
    CANCELLED: 'bg-gray-200 text-gray-600',
    REFUNDED: 'bg-purple-100 text-purple-800',
    REVERSED: 'bg-rose-100 text-rose-800',
  };
  return map[status] ?? 'bg-gray-100 text-gray-800';
};

const statusLabel = (status: string): string => {
  const labels: Record<string, string> = i18n.statusLabels as any;
  return labels[status] ?? status;
};

const DetailRow: React.FC<{ label: string; value: React.ReactNode; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="flex items-start justify-between py-3 border-b border-gray-100 last:border-0 gap-4">
    <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 shrink-0 w-36">{label}</span>
    <span className={`text-sm text-gray-900 text-right ${mono ? 'font-mono' : ''}`}>{value || 'N/A'}</span>
  </div>
);

const TxnDetailsDrawer: React.FC<TxnDetailsDrawerProps> = ({ isOpen, onClose, transaction, onStatusChanged }) => {
  const [reverifyUi, setReverifyUi] = useState<ReverifyUi>({ kind: 'idle' });
  const [cooldownTick, setCooldownTick] = useState<number>(0);
  const [downloadLoading, setDownloadLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    setReverifyUi({ kind: 'idle' });
    setDownloadLoading(false);
    setCooldownTick(0);
  }, [isOpen, transaction?.id]);

  useEffect(() => {
    if (reverifyUi.kind !== 'cooldown') return;
    const endAt = Date.now() + Math.max(1000, Number(reverifyUi.cooldownMs || 0));
    const iv = window.setInterval(() => {
      const remain = Math.max(0, endAt - Date.now());
      setCooldownTick(remain);
      if (remain <= 0) {
        window.clearInterval(iv);
        setReverifyUi({ kind: 'idle' });
      }
    }, 500);
    return () => window.clearInterval(iv);
  }, [reverifyUi.kind, (reverifyUi as any).cooldownMs]);

  if (!isOpen) return null;

  const tx = transaction || {};
  const createdAt = tx.createdAt || tx.transactionDate || tx.paidAt || tx.date;

  const receiptNumber = tx.receiptNumber || tx.receipt?.receiptNumber || tx.receiptRef || null;
  const receiptId = tx.receiptId || tx.receipt?.id || null;
  const reference = tx.reference || tx.invoiceNumber || 'N/A';
  const paystackReference = tx.paystackReference || tx.paystackRef || tx.gatewayRef || null;
  const channel = tx.paystackChannel || tx.channel || tx.paymentChannel || null;
  const status = String(tx.status || 'UNKNOWN').toUpperCase();
  const isTerminal = ['SUCCESS', 'PAID', 'UNDERPAID', 'OVERPAID', 'REVERSED', 'REFUNDED', 'FAILED', 'CANCELLED'].includes(status);
  const rawAmount = Number(tx.amount ?? 0);
  const expectedAmount = Number(tx.expectedAmount ?? tx.paidAmount ?? 0);
  let amount = rawAmount;
  if (typeof (tx as any).displayAmount === 'number' && !Number.isNaN((tx as any).displayAmount)) {
    amount = (tx as any).displayAmount;
  } else if (amount <= 0 && ['PENDING', 'FAILED'].includes(status) && expectedAmount > 0) {
    amount = expectedAmount;
  }
  const amountIsAttempt =
    amount !== rawAmount && ['PENDING', 'FAILED'].includes(status);
  const isLikelyTransaction =
    typeof (tx as any).gateway === 'string' ||
    typeof (tx as any).channel === 'string' ||
    typeof (tx as any).paymentReference !== 'undefined' ||
    typeof (tx as any).transactionDate !== 'undefined' ||
    typeof (tx as any).paystackReference !== 'undefined' ||
    typeof (tx as any).alatpayFinalTransactionId !== 'undefined';
  const isLikelyInvoice =
    typeof (tx as any).invoiceNumber === 'string' ||
    typeof (tx as any).fee !== 'undefined' ||
    typeof (tx as any).amountDue !== 'undefined' ||
    typeof (tx as any).balance !== 'undefined';
  const txId = Number((tx as any).id ?? (tx as any).transactionId ?? NaN);
  const canShowReverify = !isTerminal && !isLikelyInvoice && isLikelyTransaction && Number.isFinite(txId) && txId > 0;

  const handleDownload = async () => {
    const rid = receiptId ?? tx.receipt?.id ?? null;
    if (!rid) return;
    try {
      setDownloadLoading(true);
      await studentFeeApi.downloadReceiptPdf(rid);
    } catch (e: any) {
      setReverifyUi({
        kind: 'unavailable',
        reason: 'receipt_download_failed',
        message: e?.message ?? 'Receipt download failed. Please try again or contact Bursary.',
        supportContact: true,
      });
    } finally {
      setDownloadLoading(false);
    }
  };

  const handleReverify = async () => {
    if (!Number.isFinite(txId) || txId <= 0) return;
    if (reverifyUi.kind === 'loading' || reverifyUi.kind === 'cooldown') return;
    setReverifyUi({ kind: 'loading' });
    try {
      const r: any = await studentFeeApi.reverifyPayment(txId);
      const uiState = String(r?.uiState || 'pending').toLowerCase();
      if (uiState === 'success') {
        setReverifyUi({
          kind: 'success',
          receipt: r?.receipt ?? null,
          invoice: r?.invoice ?? null,
          message: 'Payment confirmed successfully.',
        });
        onStatusChanged?.();
      } else if (uiState === 'failed') {
        setReverifyUi({ kind: 'failed', message: 'Payment confirmed as failed by the provider.' });
        onStatusChanged?.();
      } else if (uiState === 'pending') {
        setReverifyUi({ kind: 'pending', message: 'Payment is still pending. Please check again later.' });
      } else if (uiState === 'unavailable') {
        setReverifyUi({
          kind: 'unavailable',
          reason: r?.providerResult?.reason ?? r?.reason ?? 'provider_unavailable',
          message: r?.message ?? 'Unable to confirm payment at this time.',
          supportContact: !!r?.supportContact,
        });
      } else {
        setReverifyUi({
          kind: 'unavailable',
          reason: 'unknown_ui_state',
          message: 'Could not determine payment status. Please try again.',
        });
      }
    } catch (e: any) {
      const statusCode = Number(e?.response?.status || 0);
      const data = e?.response?.data ?? {};
      if (statusCode === 429) {
        setReverifyUi({
          kind: 'cooldown',
          cooldownMs: Number(data?.cooldownMs || 30000),
          message: data?.message ?? 'Please wait a moment before checking again.',
        });
      } else if (statusCode === 409) {
        setReverifyUi({
          kind: 'conflict',
          reason: data?.reason ?? 'correlation_missing',
          message: data?.message ?? 'Unable to confirm payment automatically.',
        });
      } else if (statusCode === 403 || statusCode === 401 || statusCode === 404) {
        setReverifyUi({
          kind: 'unavailable',
          reason: statusCode === 404 ? 'not_found' : 'unauthorized',
          message: data?.message ?? 'Transaction not available for verification.',
          supportContact: true,
        });
      } else {
        setReverifyUi({
          kind: 'unavailable',
          reason: 'network_error',
          message: e?.message ?? 'Network error while verifying payment. Please try again.',
        });
      }
    }
  };

  const cooldownSecondsLeft = useMemo(() => {
    if (reverifyUi.kind !== 'cooldown') return 0;
    return Math.ceil(Math.max(0, cooldownTick) / 1000);
  }, [reverifyUi, cooldownTick]);

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl flex flex-col animate-[slideIn_0.2s_ease-out]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Transaction Details</h2>
            <p className="text-xs text-gray-500 mt-0.5 font-mono truncate max-w-[240px]">{reference}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1">
          {receiptNumber ? (
            receiptId ? (
              <DetailRow
                label="Receipt"
                value={
                  <a
                    href={`/student/receipts/${encodeURIComponent(receiptId)}`}
                    className="text-blue-700 hover:text-blue-900 inline-flex items-center gap-1 font-semibold"
                  >
                    {receiptNumber} <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                }
                mono
              />
            ) : (
              <DetailRow label="Receipt" value={receiptNumber} mono />
            )
          ) : (
            <DetailRow label="Receipt" value="N/A" />
          )}

          <DetailRow label="Payment Reference" value={reference} mono />

          <DetailRow
            label="Gateway Reference"
            value={paystackReference || 'N/A'}
            mono
          />

          <DetailRow label="Date" value={formatDate(createdAt)} />
          <DetailRow label="Time" value={formatTime(createdAt)} />

          <DetailRow
            label="Channel"
            value={channel ? String(channel).charAt(0).toUpperCase() + String(channel).slice(1).replace(/_/g, ' ') : 'N/A'}
          />

          <div className="flex items-start justify-between py-3 border-b border-gray-100 gap-4">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 shrink-0 w-36">Status</span>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${statusClass(status)}`}>
              {statusLabel(status)}
            </span>
          </div>

          <div className="flex items-start justify-between py-3 gap-4">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 shrink-0 w-36">Amount (NGN)</span>
            <div className="text-right">
              <span className="text-base font-black text-gray-900 tabular-nums">{formatNgn(amount)}</span>
              {amountIsAttempt ? (
                <div className="text-[10px] leading-none text-gray-500 mt-1">attempted amount (not yet confirmed)</div>
              ) : null}
            </div>
          </div>

          {canShowReverify && (
            <div className="pt-4 mt-2 border-t border-gray-200 space-y-3">
              {reverifyUi.kind !== 'idle' && (
                <div className={(() => {
                  switch (reverifyUi.kind) {
                    case 'success':
                      return 'rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2';
                    case 'failed':
                      return 'rounded-lg border border-red-200 bg-red-50 p-3 space-y-2';
                    case 'pending':
                      return 'rounded-lg border border-sky-200 bg-sky-50 p-3 space-y-2';
                    case 'cooldown':
                      return 'rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2';
                    case 'conflict':
                      return 'rounded-lg border border-purple-200 bg-purple-50 p-3 space-y-2';
                    case 'unavailable':
                    default:
                      return 'rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2';
                  }
                })()}>
                  {reverifyUi.kind === 'success' && (
                    <>
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="h-4.5 w-4.5 mt-0.5 text-emerald-600 shrink-0" />
                        <div className="text-sm text-emerald-900 font-medium">
                          Payment Successful
                        </div>
                      </div>
                      <p className="text-xs text-emerald-800 pl-6.5 ml-6">
                        {reverifyUi.message || 'Your payment has been confirmed and receipt generated.'}
                      </p>
                      {reverifyUi.receipt && (
                        <div className="ml-6 text-xs">
                          <a
                            href={`/student/receipts/${encodeURIComponent(String(reverifyUi.receipt.id))}`}
                            className="inline-flex items-center gap-1 text-emerald-800 font-semibold hover:text-emerald-900 underline"
                          >
                            {reverifyUi.receipt.receiptNumber} <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      )}
                      {reverifyUi.invoice && Number(reverifyUi.invoice.balance ?? 0) <= 0 && (
                        <div className="ml-6 text-xs text-emerald-800/90">
                          Invoice balance: <b className="font-semibold">₦0.00</b> (fully paid)
                        </div>
                      )}
                    </>
                  )}
                  {reverifyUi.kind === 'pending' && (
                    <>
                      <div className="flex items-start gap-2">
                        <Clock className="h-4.5 w-4.5 mt-0.5 text-sky-600 shrink-0" />
                        <div className="text-sm text-sky-900 font-medium">Payment Still Pending</div>
                      </div>
                      <p className="text-xs text-sky-800 ml-6">
                        {reverifyUi.message || 'The provider has not yet finalised this payment. You may check again later.'}
                      </p>
                    </>
                  )}
                  {reverifyUi.kind === 'failed' && (
                    <>
                      <div className="flex items-start gap-2">
                        <XCircle className="h-4.5 w-4.5 mt-0.5 text-red-600 shrink-0" />
                        <div className="text-sm text-red-900 font-medium">Payment Failed</div>
                      </div>
                      <p className="text-xs text-red-800 ml-6">
                        {reverifyUi.message || 'This payment attempt was declined. Please initiate a new payment if needed.'}
                      </p>
                    </>
                  )}
                  {reverifyUi.kind === 'cooldown' && (
                    <>
                      <div className="flex items-start gap-2">
                        <Clock className="h-4.5 w-4.5 mt-0.5 text-amber-600 shrink-0 animate-pulse" />
                        <div className="text-sm text-amber-900 font-medium">Too Many Attempts</div>
                      </div>
                      <p className="text-xs text-amber-800 ml-6">
                        {reverifyUi.message || 'Please wait before checking again.'}
                        <span className="inline-block ml-1 font-mono font-bold">
                          ({cooldownSecondsLeft}s)
                        </span>
                      </p>
                    </>
                  )}
                  {reverifyUi.kind === 'conflict' && (
                    <>
                      <div className="flex items-start gap-2">
                        <HelpCircle className="h-4.5 w-4.5 mt-0.5 text-purple-600 shrink-0" />
                        <div className="text-sm text-purple-900 font-medium">Unable to Confirm Automatically</div>
                      </div>
                      <p className="text-xs text-purple-800 ml-6">
                        {reverifyUi.message || 'The provider reference for this payment was not captured.'}
                      </p>
                      <p className="text-xs text-purple-800/90 ml-6">
                        Please contact <b>Bursary</b> with your payment reference for manual verification.
                      </p>
                    </>
                  )}
                  {reverifyUi.kind === 'unavailable' && (
                    <>
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4.5 w-4.5 mt-0.5 text-slate-600 shrink-0" />
                        <div className="text-sm text-slate-900 font-medium">
                          {reverifyUi.reason === 'receipt_download_failed' ? 'Receipt Download Failed' : 'Unable to Confirm Payment'}
                        </div>
                      </div>
                      <p className="text-xs text-slate-800 ml-6">
                        {reverifyUi.message || 'The verification service is currently unavailable. Please try again later.'}
                      </p>
                      {reverifyUi.supportContact && (
                        <p className="text-xs text-slate-700 ml-6">
                          If the issue persists, please contact <b>Bursary</b> with your reference.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={handleReverify}
                disabled={reverifyUi.kind === 'loading' || reverifyUi.kind === 'cooldown'}
                className={
                  'w-full inline-flex items-center justify-center gap-2 font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-colors ' +
                  (reverifyUi.kind === 'loading' || reverifyUi.kind === 'cooldown'
                    ? 'bg-slate-200 text-slate-500 cursor-not-allowed'
                    : 'bg-white hover:bg-slate-50 text-[#0a3d91] border border-[#0a3d91]/30')
                }
              >
                <RefreshCw className={'h-4 w-4 ' + (reverifyUi.kind === 'loading' ? 'animate-spin' : '')} />
                {reverifyUi.kind === 'loading'
                  ? 'Checking Payment Status…'
                  : reverifyUi.kind === 'cooldown'
                  ? `Wait ${cooldownSecondsLeft}s…`
                  : 'Check Payment Status'}
              </button>
            </div>
          )}

          {(reverifyUi.kind === 'success' && reverifyUi.receipt && !receiptNumber) && (
            <div className="pt-4 mt-2 border-t border-gray-200">
              <button
                type="button"
                onClick={() => {
                  if (reverifyUi.kind === 'success' && reverifyUi.receipt) {
                    setDownloadLoading(true);
                    studentFeeApi
                      .downloadReceiptPdf(reverifyUi.receipt.id)
                      .catch((e) => {
                        setReverifyUi({
                          kind: 'unavailable',
                          reason: 'receipt_download_failed',
                          message: e?.message ?? 'Receipt download failed. Please try again or contact Bursary.',
                          supportContact: true,
                        });
                      })
                      .finally(() => setDownloadLoading(false));
                  }
                }}
                disabled={downloadLoading}
                className="w-full inline-flex items-center justify-center gap-2 bg-[#0a3d91] hover:bg-[#0b46a8] disabled:opacity-60 text-white font-semibold px-4 py-2.5 rounded-lg shadow-sm"
              >
                <Download className={'h-4 w-4 ' + (downloadLoading ? 'animate-pulse' : '')} />
                {downloadLoading ? 'Preparing Receipt…' : 'Download Receipt'}
              </button>
            </div>
          )}

          {receiptNumber && (
            <div className="pt-4 mt-2 border-t border-gray-200">
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloadLoading}
                className="w-full inline-flex items-center justify-center gap-2 bg-[#0a3d91] hover:bg-[#0b46a8] disabled:opacity-60 text-white font-semibold px-4 py-2.5 rounded-lg shadow-sm"
              >
                <Download className={'h-4 w-4 ' + (downloadLoading ? 'animate-pulse' : '')} />
                {downloadLoading ? 'Preparing Receipt…' : 'Download Receipt'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TxnDetailsDrawer;
