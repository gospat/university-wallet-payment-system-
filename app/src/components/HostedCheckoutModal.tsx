import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck, X, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { studentFeeApi, type InvoiceDetailResponse } from '../services/studentFees';

const formatNgn = (n: number | string | null | undefined): string => {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(v);
};

export interface HostedCheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  checkoutUrl: string;
  gatewayLabel?: string;
  invoiceId?: number | string;
  amount?: number | string;
  reference?: string;
  onSuccessNavigate?: () => void;
}

type BodyMode = 'loading' | 'iframe' | 'closed';

type FetchedInvoiceState = {
  invoiceNumber: string | null;
  amountDue: number | null;
  amountPaid: number | null;
  balance: number | null;
  session: string | null;
  feeName: string | null;
  gateway: string | null;
} | null;

const HostedCheckoutModal: React.FC<HostedCheckoutModalProps> = ({
  isOpen,
  onClose,
  checkoutUrl,
  gatewayLabel,
  invoiceId,
  amount,
  reference,
  onSuccessNavigate,
}) => {
  const [mode, setMode] = useState<BodyMode>('loading');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [statusType, setStatusType] = useState<'success' | 'error' | 'info'>('info');
  const [polling, setPolling] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [fetchedInvoice, setFetchedInvoice] = useState<FetchedInvoiceState>(null);
  const pollIntervalRef = useRef<number | null>(null);
  const popupRef = useRef<Window | null>(null);
  const settledRef = useRef(false);

  const clearPolling = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      window.clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const handleSuccess = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    clearPolling();
    if (popupRef.current && !popupRef.current.closed) {
      try { popupRef.current.close(); } catch {}
    }
    popupRef.current = null;
    setMode('closed');
    setStatusType('success');
    setStatusMessage('Payment successful! Redirecting…');
    const navigate = onSuccessNavigate;
    const close = onClose;
    window.setTimeout(() => {
      try { navigate?.(); } catch {}
      try { close(); } catch {}
    }, 900);
  }, [clearPolling, onClose, onSuccessNavigate]);

  const runPoll = useCallback(async () => {
    if (!invoiceId) return;
    try {
      const r = await studentFeeApi.getInvoice(invoiceId as any);
      const detail = r as unknown as InvoiceDetailResponse;
      const inv = detail?.invoice ?? (r as any)?.data?.invoice ?? (r as any)?.data ?? r;
      if (!inv) return;
      const status = String(inv.status ?? '').toUpperCase();
      const amountDueNum = Number(inv.amountDue ?? 0);
      const amountPaidNum = Number(inv.amountPaid ?? 0);
      if (status === 'PAID' || amountPaidNum >= amountDueNum) {
        handleSuccess();
      }
    } catch {
    }
  }, [invoiceId, handleSuccess]);

  const fetchInvoiceDetail = useCallback(async () => {
    if (!invoiceId) return;
    try {
      const r = await studentFeeApi.getInvoice(invoiceId as any);
      const detail = r as unknown as InvoiceDetailResponse;
      const inv = detail?.invoice ?? (r as any)?.data?.invoice ?? (r as any)?.data ?? r;
      if (!inv) return;
      const ad = Number(inv.amountDue ?? 0);
      const ap = Number(inv.amountPaid ?? 0);
      setFetchedInvoice({
        invoiceNumber: inv.invoiceNumber ?? null,
        amountDue: ad,
        amountPaid: ap,
        balance: Math.max(0, ad - ap),
        session: inv.session ?? null,
        feeName: inv.fee?.name ?? null,
        gateway: (inv as any).gateway ?? null,
      });
    } catch {
    }
  }, [invoiceId]);

  const forcePollOnce = useCallback(async () => {
    setPolling(true);
    try {
      await runPoll();
    } finally {
      window.setTimeout(() => setPolling(false), 500);
    }
  }, [runPoll]);

  const markLoaded = useCallback(() => {
    setMode('iframe');
  }, []);

  useEffect(() => {
    if (!isOpen) {
      clearPolling();
      settledRef.current = false;
      if (popupRef.current && !popupRef.current.closed) {
        try { popupRef.current.close(); } catch {}
      }
      popupRef.current = null;
      setFetchedInvoice(null);
      return;
    }
    setMode('loading');
    setStatusMessage('');
    setShowCancelConfirm(false);
    settledRef.current = false;
    setFetchedInvoice(null);

    fetchInvoiceDetail();

    if (typeof checkoutUrl === 'string' && checkoutUrl.startsWith('http')) {
      try {
        popupRef.current = window.open(
          checkoutUrl,
          'hostedCheckout',
          'width=500,height=760,resizable,scrollbars,status,menubar=no,toolbar=no,location=yes'
        );
      } catch {}
    }

    window.setTimeout(() => {
      if (settledRef.current) return;
      markLoaded();
    }, 400);

    if (invoiceId) {
      pollIntervalRef.current = window.setInterval(() => {
        runPoll();
      }, 3000);
    }

    return () => {
      clearPolling();
    };
  }, [isOpen, checkoutUrl, invoiceId, clearPolling, runPoll, markLoaded, fetchInvoiceDetail]);

  const handleCancelClick = () => {
    setShowCancelConfirm(true);
  };

  const confirmCancel = () => {
    setShowCancelConfirm(false);
    clearPolling();
    if (popupRef.current && !popupRef.current.closed) {
      try { popupRef.current.close(); } catch {}
    }
    popupRef.current = null;
    setMode('closed');
    setStatusType('info');
    setStatusMessage('Checkout cancelled. You can retry or return to invoices.');
  };

  const displayBalance = fetchedInvoice?.balance ?? Number(amount ?? 0);
  const displayInvoiceNumber = fetchedInvoice?.invoiceNumber ?? String(invoiceId ?? '');
  const effectiveGateway = fetchedInvoice?.gateway || gatewayLabel || 'Payment Provider';

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="relative w-[95%] max-w-5xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        <div className="sticky top-0 z-20 h-14 px-5 items-center flex justify-between bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 text-white">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className="h-5 w-5 shrink-0" />
            <span className="text-sm sm:text-base font-semibold truncate">
              Secure Checkout · Pay with {effectiveGateway}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 inline-flex items-center justify-center h-9 w-9 rounded-lg text-white hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white/70 transition"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-0 relative">
          {mode === 'loading' && (
            <div className="min-h-96 flex flex-col items-center justify-center px-6 py-16 text-center gap-4" style={{ minHeight: '30vh' }}>
              <Loader2 className="h-10 w-10 animate-spin text-indigo-600" />
              <div className="max-w-md space-y-3 w-full">
                <p className="text-sm text-gray-600 leading-relaxed">
                  Preparing secure payment with {effectiveGateway}. Do not close this window.
                </p>
                {displayBalance > 0 && (
                  <div className="inline-flex items-center px-4 py-1.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100 text-base font-bold tabular-nums">
                    {formatNgn(displayBalance)}
                  </div>
                )}
                {displayInvoiceNumber && displayInvoiceNumber !== '' && displayInvoiceNumber !== 'undefined' && (
                  <div className="text-xs text-gray-500 font-mono">
                    Invoice #{displayInvoiceNumber}
                  </div>
                )}
                {fetchedInvoice?.feeName && (
                  <div className="text-sm text-gray-700 font-medium">
                    {fetchedInvoice.feeName}
                  </div>
                )}
                {fetchedInvoice?.session && (
                  <div className="text-xs text-gray-500">
                    Academic Session: {fetchedInvoice.session}
                  </div>
                )}
                {fetchedInvoice && fetchedInvoice.amountDue != null && fetchedInvoice.amountPaid != null && (
                  <div className="text-xs text-gray-500 space-y-0.5 border border-gray-100 rounded-lg px-4 py-3 bg-gray-50/50 mt-2">
                    <div className="flex justify-between">
                      <span>Amount Due:</span>
                      <span className="font-semibold text-gray-700">{formatNgn(fetchedInvoice.amountDue)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Amount Paid:</span>
                      <span className="font-semibold text-gray-700">{formatNgn(fetchedInvoice.amountPaid)}</span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-gray-100 mt-1">
                      <span className="font-semibold">Balance:</span>
                      <span className="font-black text-indigo-700">{formatNgn(fetchedInvoice.balance ?? 0)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {mode === 'iframe' && (
            <div className="pointer-events-auto relative">
              <div className="absolute top-3 right-3 z-10 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-[11px] font-semibold shadow-sm">
                <Loader2 className="h-3 w-3 animate-spin" />
                Payment in progress…
              </div>
              <iframe
                src={checkoutUrl}
                title="Secure Payment Checkout"
                className="w-full h-[80vh] min-h-[620px] border-0 bg-white"
                onLoad={markLoaded}
              />
            </div>
          )}

          {mode === 'closed' && (
            <div className="min-h-96 flex items-center justify-center px-6 py-16">
              <div className="max-w-md w-full bg-white border border-gray-100 rounded-2xl p-8 text-center shadow-sm">
                <div className="mx-auto mb-4 h-14 w-14 rounded-full flex items-center justify-center">
                  {statusType === 'success' ? (
                    <div className="h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center">
                      <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                    </div>
                  ) : statusType === 'error' ? (
                    <div className="h-14 w-14 rounded-full bg-red-100 flex items-center justify-center">
                      <AlertTriangle className="h-8 w-8 text-red-600" />
                    </div>
                  ) : (
                    <div className="h-14 w-14 rounded-full bg-slate-100 flex items-center justify-center">
                      <AlertTriangle className="h-8 w-8 text-slate-600" />
                    </div>
                  )}
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-2">
                  {statusType === 'success' ? 'Payment received' : statusType === 'error' ? 'Checkout ended' : 'Checkout closed'}
                </h3>
                <p className="text-sm text-gray-600 mb-4">{statusMessage || 'No status.'}</p>
                {reference && (
                  <p className="text-xs text-gray-500 font-mono mb-4">Ref: {reference}</p>
                )}
                <div className="flex items-center justify-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={forcePollOnce}
                    disabled={polling}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
                  >
                    {polling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Verify status
                  </button>
                  {typeof checkoutUrl === 'string' && checkoutUrl.startsWith('http') && (
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          const w = window.open(
                            checkoutUrl,
                            'hostedCheckout',
                            'width=500,height=760,resizable,scrollbars,status,menubar=no,toolbar=no,location=yes'
                          );
                          popupRef.current = w;
                        } catch {}
                      }}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-gray-200 bg-white hover:bg-gray-50 text-gray-800"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Reopen in new tab
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 z-20 h-16 bg-gray-50 border-t px-5 flex items-center justify-between gap-4">
          <div className="text-[11px] sm:text-xs text-gray-500 leading-snug max-w-[65%]">
            ALATPay / Paystack handles all card &amp; bank data — nothing passes through our servers (PCI-DSS safe)
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={forcePollOnce}
              disabled={polling}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60 shadow-sm"
            >
              {polling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              I&apos;ve completed payment
            </button>
            {!showCancelConfirm ? (
              <button
                type="button"
                onClick={handleCancelClick}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
              >
                Cancel
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={confirmCancel}
                  className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white"
                >
                  Yes, cancel
                </button>
                <button
                  type="button"
                  onClick={() => setShowCancelConfirm(false)}
                  className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-semibold border border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
                >
                  No, wait
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HostedCheckoutModal;
