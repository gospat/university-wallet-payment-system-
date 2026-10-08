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
    try {
      const init = await studentFeeApi.initiatePayment({
        invoiceId: invoiceId || '',
        partialAmount: amt,
        email: user?.email || invoice?.studentEmail || '',
        idempotencyKey: `INV-${invoiceId || 'X'}-${Date.now()}`,
      });
      const initData = (init as any)?.data ?? init;
      const gl = initData?.gateway_label ?? initData?.gatewayLabel ?? undefined;
      if (gl) setGatewayLabel(gl);
      const checkoutPopupMode: 'hosted_url_iframe' | 'alatpay_native_modal_v1' | undefined = initData?.checkout_popup_mode === 'alatpay_native_modal_v1'
        ? 'alatpay_native_modal_v1'
        : undefined;
      const alatpayCheckout = initData?.alatpay_public_checkout ?? null;
      const alatpayRef = initData?.alatpay_refs ?? null;
      const url = (init as any)?.authorization_url || (init as any)?.data?.authorization_url || '';
      const ref = (init as any)?.reference || (init as any)?.data?.reference || '';
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
            onClosed: () => {},
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
          </div>
        )}
        </div>
      </div>
      <HostedCheckoutModal
        isOpen={checkoutModalOpen}
        onClose={() => setCheckoutModalOpen(false)}
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
