import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import PaymentResult from '../../components/student/PaymentResult';
import { useAuth } from '../../context/AuthContext';
import { i18n } from '../../i18n/en';
import { studentFeeApi } from '../../services/studentFees';
import { isAlatpayUuid } from '../../types/alatpay';
import { ArrowLeft, Clock, History, Mail, RefreshCw, AlertCircle } from 'lucide-react';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(n);

type Stage = 'loading' | 'pending' | 'success' | 'failed' | 'unknown';

const FAST_INTERVAL_MS = 2500;
const FAST_PHASE_MS = 60_000;
const SLOW_INTERVAL_MS = 9000;
const MAX_POLL_MS = 10 * 60 * 1000;

const TERMINAL_SUCCESS: ReadonlySet<string> = new Set(['SUCCESS', 'PAID']);
const TERMINAL_FAILED: ReadonlySet<string> = new Set(['FAILED', 'REVERSED', 'REFUNDED']);

const CallbackPage: React.FC = () => {
  const { paystackRef: refParam } = useParams<{ paystackRef?: string }>();
  const [search] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const fullName = useMemo(() => {
    if (!user) return 'Student';
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Student';
  }, [user]);
  const brand = i18n.portals.student.dashboardBrand;

  const ref = (refParam || search.get('reference') || search.get('trxref') || search.get('paystackRef') || '').trim();

  const providerReferenceOpt: string | null = useMemo(() => {
    const raw = search.get('providerReference');
    if (!raw || typeof raw !== 'string') return null;
    const t = String(raw).trim();
    if (!t) return null;
    if (!isAlatpayUuid(t)) return null;
    return t;
  }, [search]);

  const [stage, setStage] = useState<Stage>('loading');
  const [outstanding, setOutstanding] = useState<number | null>(null);
  const [invoiceId, setInvoiceId] = useState<number | string | null>(null);
  const [receiptRef, setReceiptRef] = useState<string | null>(null);
  const [verifyAmount, setVerifyAmount] = useState<number | null>(null);
  const [verifyDate, setVerifyDate] = useState<any>(null);
  const [payRef, setPayRef] = useState<string | null>(null);
  const [gatewayLabel, setGatewayLabel] = useState<string | undefined>(undefined);
  const [elapsedMs, setElapsedMs] = useState(0);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const startedAtRef = useRef<number>(Date.now());
  const pollSeqRef = useRef(0);
  const inFlightRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const applyStatusData = useCallback((d: any) => {
    if (!d) return;
    const amt = Number(d.amount ?? d.expectedAmount ?? NaN);
    if (!Number.isNaN(amt) && amt > 0) setVerifyAmount(amt);
    const outst = Number(d.outstanding ?? NaN);
    if (!Number.isNaN(outst)) setOutstanding(outst);
    setInvoiceId(d.invoiceId ?? null);
    setReceiptRef(d.receipt?.receiptNumber ?? null);
    setPayRef(d.reference ?? null);
    const gl = d.gateway ? String(d.gateway) : undefined;
    if (gl) setGatewayLabel(gl);
    const dt = d.updatedAt ?? null;
    if (dt) setVerifyDate(dt);
  }, []);

  const pollStatus = useCallback(async (): Promise<string | null> => {
    if (!ref || cancelledRef.current) return null;
    inFlightRef.current = true;
    const seq = ++pollSeqRef.current;
    try {
      const r: any = await studentFeeApi.getPaymentStatus(ref);
      if (cancelledRef.current || seq !== pollSeqRef.current) return null;
      const status = String(r?.status ?? '').toUpperCase();
      if (status) applyStatusData(r);
      return status || null;
    } catch {
      return null;
    } finally {
      if (seq === pollSeqRef.current) {
        inFlightRef.current = false;
      }
    }
  }, [ref, applyStatusData]);

  const scheduleNext = useCallback(() => {
    if (cancelledRef.current) return;
    const elapsed = Date.now() - startedAtRef.current;
    if (elapsed >= MAX_POLL_MS) return;
    // Guarantee at most ONE scheduled polling timer at any time.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const interval = elapsed < FAST_PHASE_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
    timerRef.current = setTimeout(async () => {
      const status = await pollStatus();
      if (cancelledRef.current) return;
      if (status && TERMINAL_SUCCESS.has(status)) {
        setStage('success');
        studentFeeApi.refreshStudentPaymentCaches();
        return;
      }
      if (status && TERMINAL_FAILED.has(status)) {
        setStage('failed');
        return;
      }
      scheduleNext();
    }, interval);
  }, [pollStatus]);

  const forceCheckNow = useCallback(async () => {
    // Cancel any currently scheduled polling timeout before doing an
    // immediate check, so we never have more than one polling chain.
    clearTimers();
    // If a status request is already in flight, do NOT start a parallel one.
    // The in-flight request will reschedule on completion if still pending.
    if (inFlightRef.current) return;
    const status = await pollStatus();
    if (cancelledRef.current) return;
    if (status && TERMINAL_SUCCESS.has(status)) {
      setStage('success');
      studentFeeApi.refreshStudentPaymentCaches();
      return;
    }
    if (status && TERMINAL_FAILED.has(status)) {
      setStage('failed');
      return;
    }
    setStage('pending');
    scheduleNext();
  }, [pollStatus, scheduleNext, clearTimers]);

  useEffect(() => {
    cancelledRef.current = false;
    startedAtRef.current = Date.now();
    pollSeqRef.current = 0;
    inFlightRef.current = false;

    if (!ref) {
      setStage('unknown');
      return;
    }

    setStage('loading');

    elapsedTimerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);

    (async () => {
      let status: string | null = null;
      if (providerReferenceOpt) {
        try {
          const r: any = await studentFeeApi.verifyPayment(ref, { providerReference: providerReferenceOpt });
          const ok = !!r?.success || r?.status === 'SUCCESS' || r?.data?.status === 'SUCCESS' || r?.verified === true;
          const d = r?.data ?? r;
          applyStatusData(d);
          if (ok) {
            status = 'SUCCESS';
          } else {
            const s = String(d?.status ?? r?.status ?? '').toUpperCase();
            if (s) status = s;
          }
        } catch {
          status = null;
        }
      }

      if (cancelledRef.current) return;

      if (!status) {
        status = await pollStatus();
      }

      if (cancelledRef.current) return;

      if (status && TERMINAL_SUCCESS.has(status)) {
        setStage('success');
        studentFeeApi.refreshStudentPaymentCaches();
        return;
      }
      if (status && TERMINAL_FAILED.has(status)) {
        setStage('failed');
        return;
      }
      setStage('pending');
      scheduleNext();
    })();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        forceCheckNow();
      }
    };
    const onFocus = () => forceCheckNow();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);

    return () => {
      cancelledRef.current = true;
      clearTimers();
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [ref, providerReferenceOpt, applyStatusData, pollStatus, scheduleNext, forceCheckNow, clearTimers]);

  const downloadReceipt = async () => {
    const refTarget = receiptRef || ref;
    try {
      const blob = await studentFeeApi.downloadReceiptPdfByReference(refTarget);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `receipt-${refTarget}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (_) {}
  };

  const resultState: 'idle' | 'success' | 'failure' | 'pending' = (() => {
    switch (stage) {
      case 'success': return 'success';
      case 'failed': return 'failure';
      case 'loading':
      case 'pending':
      case 'unknown':
      default:
        return 'pending';
    }
  })();

  const pendingMessage = useMemo(() => {
    if (stage !== 'pending' && stage !== 'loading') return null;
    if (elapsedMs < 15_000) {
      return { title: 'Confirming your payment…', detail: 'Please wait while we confirm your payment with the processor.' };
    }
    if (elapsedMs < FAST_PHASE_MS) {
      return {
        title: 'Waiting for confirmation from ALATPay',
        detail: 'We have received your payment request. Please do not make another payment while confirmation is in progress.',
      };
    }
    return {
      title: 'Confirmation is taking longer than usual',
      detail: 'Your payment may already have been received. Please do not pay again. This page will continue checking automatically.',
    };
  }, [stage, elapsedMs]);

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
      <div className="w-full space-y-6 py-2">
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="mb-5">
            <Link to="/student/invoices" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:text-blue-900">
              <ArrowLeft className="h-4 w-4" /> Back to Invoices
            </Link>
          </div>

          {(stage === 'loading' || stage === 'pending') && pendingMessage && (
            <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
              <div className="px-6 py-6 sm:px-8 sm:py-7 flex items-center gap-4 sm:gap-5 bg-amber-50">
                <div className="p-3 sm:p-3.5 rounded-full bg-amber-100 shrink-0">
                  <Clock className="h-10 w-10 sm:h-12 sm:w-12 text-amber-600 animate-pulse" />
                </div>
                <div>
                  <p className="text-xs uppercase font-bold tracking-wider text-amber-700">Secure Checkout</p>
                  <h1 className="text-2xl sm:text-3xl font-black mt-0.5 text-amber-600">{pendingMessage.title}</h1>
                  <p className="text-amber-700 mt-1.5">{pendingMessage.detail}</p>
                </div>
              </div>
              <div className="px-6 py-5 sm:px-8 sm:py-6 space-y-4">
                {ref && (
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-gray-500 font-medium">Payment Reference</span>
                    <span className="font-mono font-semibold text-gray-900">{ref}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span>Please do not close this page or make another payment.</span>
                </div>
                <div className="flex flex-wrap gap-3 pt-2">
                  <button
                    type="button"
                    onClick={forceCheckNow}
                    className="inline-flex items-center gap-2 bg-[#0a3d91] hover:bg-[#0b46a8] text-white font-semibold px-5 py-2.5 rounded-lg shadow-sm"
                  >
                    <RefreshCw className="h-4 w-4" /> Check Status Now
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/student/invoices')}
                    className="inline-flex items-center gap-2 border border-gray-200 bg-white hover:bg-gray-50 text-gray-800 font-semibold px-5 py-2.5 rounded-lg"
                  >
                    <History className="h-4 w-4" /> Return to Invoices
                  </button>
                </div>
              </div>
            </div>
          )}

          {(stage === 'success' || stage === 'failed') && (
            <PaymentResult
              state={resultState}
              data={{
                amount: verifyAmount ?? undefined,
                reference: payRef ?? (ref ? ref : undefined),
                receiptNumber: receiptRef ?? undefined,
                date: verifyDate ?? undefined,
                paystackReference: ref ? ref : undefined,
                gatewayReference: ref ? ref : undefined,
                gatewayLabel: gatewayLabel,
              }}
              onDownloadReceipt={downloadReceipt}
              onViewHistory={() => navigate('/student/invoices')}
              onTryAgain={() => {
                if (invoiceId) navigate(`/student/payments/confirm/${String(invoiceId)}`);
                else navigate('/student/invoices');
              }}
              onCheckStatus={forceCheckNow}
              onContactHelp={() => {
                try { window.location.href = 'mailto:bursary@university.edu.ng'; } catch (_) {}
              }}
            />
          )}

          {stage === 'unknown' && !ref && (
            <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
              <div className="px-6 py-6 sm:px-8 sm:py-7 flex items-center gap-4 sm:gap-5 bg-amber-50">
                <div className="p-3 sm:p-3.5 rounded-full bg-amber-100 shrink-0">
                  <Clock className="h-10 w-10 sm:h-12 sm:w-12 text-amber-600" />
                </div>
                <div>
                  <p className="text-xs uppercase font-bold tracking-wider text-amber-700">Secure Checkout</p>
                  <h1 className="text-2xl sm:text-3xl font-black mt-0.5 text-amber-600">Verifying your payment</h1>
                  <p className="text-amber-700 mt-1.5">Please wait while we confirm your payment with the processor. No further action is required.</p>
                </div>
              </div>
              <div className="px-6 py-5 sm:px-8 sm:py-6 space-y-3">
                <div className="flex items-center justify-between gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => navigate('/student/invoices')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-gray-50 text-gray-700 hover:bg-gray-100 font-semibold border border-gray-200"
                  >
                    <History className="h-4 w-4" /> View Invoices
                  </button>
                  <button
                    type="button"
                    onClick={() => { try { window.location.href = 'mailto:bursary@university.edu.ng'; } catch (_) {} }}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-semibold shadow-sm"
                  >
                    <Mail className="h-4 w-4" /> Contact Support
                  </button>
                </div>
              </div>
            </div>
          )}

          {stage === 'success' && outstanding !== null && outstanding > 0 && (
            <div className="mt-6 bg-blue-50 rounded-2xl p-5 border border-blue-100">
              <p className="text-xs uppercase font-bold tracking-wider text-blue-700">Outstanding Balance</p>
              <p className="text-2xl font-black text-blue-900 mt-0.5">{fmt(outstanding)}</p>
              {invoiceId && (
                <Link
                  to={`/student/payments/confirm/${String(invoiceId)}`}
                  className="mt-3 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5 rounded-lg shadow-sm"
                >
                  Pay Remaining Balance
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </PortalShell>
  );
};

export default CallbackPage;
