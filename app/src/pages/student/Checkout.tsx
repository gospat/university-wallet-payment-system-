import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import HostedCheckoutModal from '../../components/HostedCheckoutModal';
import { useAuth } from '../../context/AuthContext';
import { i18n } from '../../i18n/en';
import { studentFeeApi } from '../../services/studentFees';
import { launchAlatpayNativeModal } from '../../utils/alatpayCheckout';
import { ArrowRight, Loader2, CreditCard, AlertTriangle, ArrowLeft, Receipt, Calculator } from 'lucide-react';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(n);

const MIN_PARTIAL = 20000;

const CheckoutPage: React.FC = () => {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const t = i18n.dashboard.student.checkout;

  const fullName = useMemo(() => {
    if (!user) return 'Student';
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Student';
  }, [user]);
  const brand = i18n.portals.student.dashboardBrand;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<any>(null);

  const [amountToPay, setAmountToPay] = useState<string>('');
  const [proceeding, setProceeding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [gatewayLabel, setGatewayLabel] = useState<string | undefined>(undefined);
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const [checkoutModalUrl, setCheckoutModalUrl] = useState('');
  const [checkoutModalRef, setCheckoutModalRef] = useState<string | undefined>(undefined);
  const [checkoutModalAmount, setCheckoutModalAmount] = useState<number | undefined>(undefined);
  const [checkoutModalInvoiceId, setCheckoutModalInvoiceId] = useState<number | string | undefined>(undefined);
  const [checkoutModalGateway, setCheckoutModalGateway] = useState<string | undefined>(undefined);
  const [checkoutMode, setCheckoutMode] = useState<'hosted_url_iframe' | 'alatpay_native_modal_v1' | undefined>(undefined);
  const [alatpayNativeModal, setAlatpayNativeModal] = useState<any>(null);
  const [alatpayRefs, setAlatpayRefs] = useState<any>(null);

  const [pendingTx, setPendingTx] = useState<any>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [showUnresolved, setShowUnresolved] = useState(false);
  const [lastInitiatedResult, setLastInitiatedResult] = useState<any>(null);

  useEffect(() => {
    (async () => {
      if (!invoiceId) {
        setError('Missing invoice id');
        setLoading(false);
        return;
      }
      try {
        const r = (await studentFeeApi.getInvoice(invoiceId as any)) as any;
        const inv = r?.data?.invoice ?? r?.invoice ?? r?.data ?? r;
        setInvoice(inv || null);
        const outstanding = Number((inv?.outstanding ?? inv?.amountDue ?? 0) - (inv?.amountPaid ?? 0));
        const due = Number(inv?.amountDue ?? outstanding ?? 0);
        const paid = Number(inv?.amountPaid ?? 0);
        const out = due - paid;
        setAmountToPay(String(out > 0 ? out : 0));

        // Restore unresolved payment panel from the backend invoice detail
        // (do NOT rely exclusively on React state from the original checkout
        // session, which is lost on tab refresh / re-navigation).
        const blockingPending =
          (r as any)?.blockingPendingTransaction ??
          (r?.data as any)?.blockingPendingTransaction ??
          null;
        if (blockingPending && String(blockingPending.status ?? '').toUpperCase() === 'PENDING') {
          setPendingTx({
            reference: blockingPending.reference,
            transactionId: blockingPending.id,
            gateway: blockingPending.gateway ?? null,
            expectedAmount: blockingPending.expectedAmount ?? null,
          });
          if (blockingPending.gateway) setGatewayLabel(String(blockingPending.gateway));
          setShowUnresolved(true);
        }
      } catch (_err: any) {
        const m = _err?.response?.data?.message || 'Unable to load invoice';
        setError(typeof m === 'string' ? m : 'Unable to load invoice');
      } finally {
        setLoading(false);
      }
    })();
  }, [invoiceId]);

  const due = Number(invoice?.amountDue ?? 0);
  const paid = Number(invoice?.amountPaid ?? 0);
  const outstanding = Math.max(0, due - paid);
  const amt = Number(amountToPay || 0);
  const errs = useMemo(() => {
    const e: string[] = [];
    if (outstanding <= 0) e.push('This invoice has already been paid in full.');
    if (!amt || amt <= 0) e.push('Please enter an amount to pay.');
    else if (amt < MIN_PARTIAL) e.push(t.amountMin);
    else if (amt > outstanding) e.push(t.amountExceed);
    return e;
  }, [outstanding, amt, t]);

  const proceed = async () => {
    if (errs.length) return;
    setProceeding(true);
    setMsg(null);
    setCheckoutMode(undefined);
    setAlatpayNativeModal(null);
    setAlatpayRefs(null);
    setShowUnresolved(false);
    setLastInitiatedResult(null);
    try {
      const init = await studentFeeApi.initiatePayment({
        invoiceId: invoiceId || '',
        partialAmount: amt,
        email: user?.email || invoice?.studentEmail || '',
        idempotencyKey: `INV-${invoiceId || 'X'}-${Date.now()}`,
      });
      const initData = (init as any)?.data ?? init;
      setLastInitiatedResult(initData);
      const gl = initData?.gateway_label ?? initData?.gatewayLabel ?? undefined;
      if (gl) setGatewayLabel(gl);
      const checkoutPopupMode: 'hosted_url_iframe' | 'alatpay_native_modal_v1' | undefined = initData?.checkout_popup_mode === 'alatpay_native_modal_v1'
        ? 'alatpay_native_modal_v1'
        : undefined;
      const alatpayCheckout = initData?.alatpay_public_checkout ?? null;
      const alatpayRef = initData?.alatpay_refs ?? null;
      const url = (init as any)?.authorization_url || (init as any)?.data?.authorization_url || '';
      const ref = (init as any)?.reference || (init as any)?.data?.reference || '';
      setPendingTx({ reference: ref, transactionId: initData?.transactionId ?? null });
      if (checkoutPopupMode === 'alatpay_native_modal_v1' && alatpayCheckout) {
        const bellsReference = alatpayRef?.bells_reference || ref;
        try {
          await launchAlatpayNativeModal(alatpayCheckout, {
            onReportTransaction: (report) => {
              const bellsRef = bellsReference || ref;
              const base = `/student/payments/callback/${encodeURIComponent(bellsRef)}`;
              const finalUuid = report?.extractedFinalTxId ?? null;
              if (finalUuid && typeof finalUuid === 'string' && finalUuid.trim()) {
                const qs = new URLSearchParams({ providerReference: finalUuid.trim() }).toString();
                navigate(`${base}?${qs}`);
              } else {
                navigate(base);
              }
            },
            onError: (e) => {
              const m = e?.message || t.failedInit;
              setMsg(typeof m === 'string' ? m : t.failedInit);
            },
            onClosed: () => {
              setShowUnresolved(true);
            },
          });
        } catch (_e: any) {
          const m = _e?.message || t.failedInit;
          setMsg(typeof m === 'string' ? m : t.failedInit);
        } finally {
          setProceeding(false);
        }
        return;
      }
      if (typeof url === 'string' && url.startsWith('http')) {
        setCheckoutMode('hosted_url_iframe');
        setCheckoutModalUrl(url);
        setCheckoutModalRef(ref || undefined);
        setCheckoutModalAmount(amt);
        setCheckoutModalInvoiceId(invoiceId);
        setCheckoutModalGateway(gl);
        setCheckoutModalOpen(true);
        setProceeding(false);
        return;
      }
      if (ref) {
        navigate(`/student/payments/callback/${encodeURIComponent(ref)}`);
        return;
      }
      const fallbackMsg = (init as any)?.message || (init as any)?.data?.message || t.failedInit;
      setMsg(typeof fallbackMsg === 'string' ? fallbackMsg : t.failedInit);
    } catch (_err: any) {
      const m = _err?.payload?.message || _err?.message || t.failedInit;
      setMsg(typeof m === 'string' ? m : t.failedInit);
    } finally {
      setProceeding(false);
    }
  };

  const checkStatus = async () => {
    if (!lastInitiatedResult && !pendingTx) {
      setMsg('No pending payment reference available.');
      return;
    }
    const ref =
      (lastInitiatedResult?.reference) ||
      (pendingTx?.reference) ||
      (lastInitiatedResult?.alatpay_refs?.bells_reference);
    if (!ref) {
      setMsg('No pending payment reference available.');
      return;
    }
    setCheckingStatus(true);
    setMsg(null);
    try {
      const providerReference = lastInitiatedResult?.alatpay_refs?.final_transaction_id ?? null;
      const result: any = await studentFeeApi.verifyPayment(ref, { providerReference });
      const ui = result?.uiState ?? result?.data?.uiState ?? result?.status ?? 'pending';
      const txStatus = result?.transaction?.status ?? result?.data?.transaction?.status ?? null;
      if (ui === 'success' || txStatus === 'SUCCESS') {
        const bellsRef = ref;
        navigate(`/student/payments/callback/${encodeURIComponent(bellsRef)}`);
        return;
      }
      if (ui === 'failed' || txStatus === 'FAILED') {
        setMsg('Payment failed. Please try a new payment or contact Support.');
        return;
      }
      alert(
        'Payment is still being processed by the provider. Please try again later or contact Support if it remains unresolved for more than 24 hours.'
      );
    } catch (_err: any) {
      const rawStatus = _err?.response?.data?.rawStatus ?? null;
      const status = _err?.response?.data?.status ?? null;
      if (status === 'pending_confirmation' || rawStatus === 'PENDING' || (status && String(status).includes('pending'))) {
        alert(
          'Payment is still being processed by the provider. Please try again later or contact Support if it remains unresolved for more than 24 hours.'
        );
      } else {
        const m = _err?.payload?.message || _err?.message || 'Unable to check payment status.';
        setMsg(typeof m === 'string' ? m : 'Unable to check payment status.');
      }
    } finally {
      setCheckingStatus(false);
    }
  };

  const continuePayment = async () => {
    const txId =
      (pendingTx?.transactionId) ||
      (lastInitiatedResult?.transactionId) ||
      (lastInitiatedResult?.data?.transactionId);
    if (!txId) {
      setMsg('Transaction identifier is not available for Continue. Please use Check Payment Status or start a new payment.');
      return;
    }
    setContinuing(true);
    setMsg(null);
    try {
      const option: any = await studentFeeApi.getContinueOption(txId);
      if (!option?.canResume) {
        const reason = option?.reason || 'Unable to continue this payment session.';
        setMsg(reason);
        alert(reason);
        setContinuing(false);
        return;
      }
      const payload = option.payload || {};
      if (option.resumeMode === 'alatpay_native') {
        // ALATPay SDK setup re-launch does NOT safely reuse the same provider
        // attempt unless the backend explicitly confirms
        // sdkSetupIsSameAttempt === true. Otherwise, clearly explain that safe
        // continuation is unavailable and direct to Check Status / Support.
        if (payload?.sdkSetupIsSameAttempt !== true) {
          const cannotResume =
            'Safe continuation of this ALATPay payment is not available because the original provider session cannot be verified to be the same attempt. Please use Check Payment Status or contact Support.';
          setMsg(cannotResume);
          alert(cannotResume);
          setContinuing(false);
          return;
        }
        const alatpayCheckout = lastInitiatedResult?.alatpay_public_checkout ?? null;
        if (!alatpayCheckout) {
          const cannotResume = 'Original ALATPay checkout session data is no longer available in this browser tab. Please use Check Payment Status or start a new payment.';
          setMsg(cannotResume);
          alert(cannotResume);
          setContinuing(false);
          return;
        }
        const bellsReference = payload.bellsReference || pendingTx?.reference || lastInitiatedResult?.reference || '';
        try {
          await launchAlatpayNativeModal(alatpayCheckout, {
            onReportTransaction: (report) => {
              const base = `/student/payments/callback/${encodeURIComponent(bellsReference)}`;
              const finalUuid = report?.extractedFinalTxId ?? null;
              if (finalUuid && typeof finalUuid === 'string' && finalUuid.trim()) {
                const qs = new URLSearchParams({ providerReference: finalUuid.trim() }).toString();
                navigate(`${base}?${qs}`);
              } else {
                navigate(base);
              }
            },
            onError: (e) => {
              const m = e?.message || t.failedInit;
              setMsg(typeof m === 'string' ? m : t.failedInit);
            },
            onClosed: () => {
              setShowUnresolved(true);
            },
          });
        } catch (_e: any) {
          const m = _e?.message || t.failedInit;
          setMsg(typeof m === 'string' ? m : t.failedInit);
        } finally {
          setContinuing(false);
        }
        return;
      }
      if (option.resumeMode === 'paystack_redirect') {
        const authUrl = payload.paystackAuthorizationUrl || null;
        if (typeof authUrl === 'string' && authUrl.startsWith('http')) {
          setCheckoutMode('hosted_url_iframe');
          setCheckoutModalUrl(authUrl);
          setCheckoutModalRef(payload.paystackReference || payload.bellsReference || undefined);
          setCheckoutModalAmount(payload.expectedAmountNaira || amt);
          setCheckoutModalInvoiceId(invoiceId);
          setCheckoutModalGateway('Paystack');
          setCheckoutModalOpen(true);
          setContinuing(false);
          return;
        }
        const ref = payload.paystackReference || payload.bellsReference || null;
        if (ref) {
          navigate(`/student/payments/callback/${encodeURIComponent(ref)}`);
          setContinuing(false);
          return;
        }
        const cannotResume = 'Stored Paystack redirect URL is not available for safe resume. Please Check Payment Status or contact Support.';
        setMsg(cannotResume);
        alert(cannotResume);
        setContinuing(false);
        return;
      }
      const genericNoResume = option.reason || 'Unable to continue this payment session.';
      setMsg(genericNoResume);
      alert(genericNoResume);
    } catch (_err: any) {
      const m = _err?.payload?.message || _err?.message || 'Unable to retrieve continue option.';
      setMsg(typeof m === 'string' ? m : 'Unable to retrieve continue option.');
    } finally {
      setContinuing(false);
    }
  };

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
          <div className="mb-1">
            <Link to={invoiceId ? `/student/invoices/${invoiceId}` : '/student/invoices'} className="inline-flex items-center gap-1 text-sm text-blue-700 hover:text-blue-900">
              <ArrowLeft className="h-4 w-4" /> {t.backToInvoice}
            </Link>
          </div>

        <div className="mb-6">
          <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-blue-600" /> {t.title}
          </h1>
          <p className="text-gray-500 mt-1">{t.subtitle}</p>
        </div>

        {loading ? (
          <div className="bg-white border border-gray-100 rounded-2xl p-12 flex flex-col items-center gap-3">
            <Loader2 className="h-7 w-7 animate-spin text-blue-600" />
            <p className="text-gray-500">Loading invoice…</p>
          </div>
        ) : error ? (
          <div className="bg-white border border-red-100 rounded-2xl p-8 text-center">
            <AlertTriangle className="h-8 w-8 text-red-500 mx-auto mb-3" />
            <p className="font-bold text-red-900">{error}</p>
            <Link to="/student/invoices" className="mt-4 inline-block text-blue-700 hover:text-blue-900 font-medium">{t.backToInvoices}</Link>
          </div>
        ) : (
          <div className="space-y-6">
            <section className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
              <header className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    <Receipt className="h-5 w-5 text-blue-600" /> {t.summaryTitle}
                  </h2>
                  {invoice?.invoiceNumber && (
                    <p className="text-sm text-gray-500 font-mono mt-1">#{invoice.invoiceNumber}</p>
                  )}
                </div>
              </header>
              <dl className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
                {[
                  [t.studentLabel, [invoice?.studentName, `${user?.firstName || ''} ${user?.lastName || ''}`.trim()].find(Boolean) || fullName],
                  [t.matricLabel, invoice?.matricNumber || (user as any)?.matricNumber || '—'],
                  [t.feeLabel, invoice?.feeName || invoice?.description || 'Invoice'],
                  [t.sessionLabel, invoice?.session || invoice?.academicSession || '—'],
                  [t.dueLabel, fmt(due)],
                  [t.paidLabel, fmt(paid)],
                  [i18n.payment.processingVia, gatewayLabel || 'Secure Payment'],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-center justify-between px-4 py-3 bg-white">
                    <dt className="text-sm text-gray-500 font-medium">{label as string}</dt>
                    <dd className="text-sm font-semibold text-gray-900 text-right">{value as string}</dd>
                  </div>
                ))}
                <div className="flex items-center justify-between px-4 py-4 bg-blue-50/50">
                  <dt className="text-sm font-bold text-blue-900">{t.outstandingLabel}</dt>
                  <dd className="text-xl font-black text-blue-700">{fmt(outstanding)}</dd>
                </div>
              </dl>
            </section>

            <section className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Calculator className="h-5 w-5 text-gray-700" /> {t.toPayLabel}
              </h2>
              <p className="text-sm text-gray-500 mt-1">{t.toPayHint}</p>
              <div className="mt-4 max-w-sm">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 font-semibold">₦</span>
                  <input
                    type="number"
                    min={MIN_PARTIAL}
                    step="1"
                    value={amountToPay}
                    onChange={(e) => setAmountToPay(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 pl-8 pr-3 py-3 text-xl font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="mt-2 flex gap-2 flex-wrap">
                  {[Math.min(outstanding, 50000), Math.min(outstanding, 100000), outstanding].map((v, i) => v > 0 && (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setAmountToPay(String(v))}
                      className="text-xs px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium border border-blue-100"
                    >
                      {fmt(v)}
                    </button>
                  ))}
                </div>
              </div>
              {errs.length > 0 && (
                <ul className="mt-4 space-y-1">
                  {errs.map((e) => (
                    <li key={e} className="text-sm text-red-700 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4" /> {e}
                    </li>
                  ))}
                </ul>
              )}
              {msg && (
                <p className="mt-4 text-sm text-red-700 inline-flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4" /> {msg}
                </p>
              )}
              <div className="mt-6 flex items-center justify-between gap-3 flex-wrap">
                <Link
                  to="/student/invoices"
                  className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 font-medium"
                >
                  <ArrowLeft className="h-4 w-4" /> {t.backToInvoices}
                </Link>
                <button
                  type="button"
                  onClick={proceed}
                  disabled={proceeding || errs.length > 0}
                  className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-bold px-6 py-3 rounded-lg shadow-sm"
                >
                  {proceeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {proceeding ? t.proceeding : t.proceed}
                </button>
              </div>
            </section>

            {showUnresolved && (
              <section className="bg-amber-50 border border-amber-200 rounded-2xl shadow-sm p-6">
                <h2 className="text-lg font-bold text-amber-900 flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-600" /> Unresolved Payment Attempt
                </h2>
                <p className="text-sm text-amber-800 mt-1">
                  You recently closed a payment popup or checkout window before confirmation completed. Your payment may still be in progress. Use the actions below before starting a new payment.
                </p>
                <div className="mt-4 text-xs font-mono text-amber-900/80 bg-amber-100/60 border border-amber-200 rounded-lg px-3 py-2">
                  Reference:&nbsp;
                  <span className="font-bold">
                    {pendingTx?.reference ||
                      lastInitiatedResult?.reference ||
                      lastInitiatedResult?.alatpay_refs?.bells_reference ||
                      '—'}
                  </span>
                  {gatewayLabel && (
                    <span className="ml-4">
                      Via:&nbsp;<span className="font-bold">{gatewayLabel}</span>
                    </span>
                  )}
                </div>
                <div className="mt-5 flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={checkStatus}
                    disabled={checkingStatus}
                    aria-label="Check Payment Status"
                    className="inline-flex items-center gap-2 bg-white hover:bg-amber-100 disabled:opacity-60 text-amber-900 font-bold px-5 py-2.5 rounded-lg shadow-sm border border-amber-300"
                  >
                    {checkingStatus ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CreditCard className="h-4 w-4" />
                    )}
                    {checkingStatus ? 'Checking…' : 'Check Payment Status'}
                  </button>
                  <button
                    type="button"
                    onClick={continuePayment}
                    disabled={continuing || checkingStatus}
                    aria-label="Continue Payment"
                    className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white font-bold px-5 py-2.5 rounded-lg shadow-sm"
                  >
                    {continuing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowRight className="h-4 w-4" />
                    )}
                    {continuing ? 'Continuing…' : 'Continue Payment'}
                  </button>
                </div>
              </section>
            )}
          </div>
        )}
        </div>
      </div>
      <HostedCheckoutModal
        isOpen={checkoutModalOpen}
        onClose={() => {
          setCheckoutModalOpen(false);
          setShowUnresolved(true);
        }}
        checkoutUrl={checkoutModalUrl}
        gatewayLabel={checkoutModalGateway}
        invoiceId={checkoutModalInvoiceId}
        amount={checkoutModalAmount}
        reference={checkoutModalRef}
        checkoutMode={checkoutMode}
        alatpayNativeModal={alatpayNativeModal}
        alatpayRefs={alatpayRefs}
        onSuccessNavigate={() => {
          const ref = checkoutModalRef;
          if (ref) {
            navigate(`/student/payments/callback/${encodeURIComponent(ref)}`);
          } else {
            navigate('/student/invoices');
          }
        }}
      />
    </PortalShell>
  );
};

export default CheckoutPage;
