import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Loader2, CreditCard, Receipt, ShieldCheck, User, GraduationCap, Calculator } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { i18n } from '../../i18n/en';
import { studentFeeApi } from '../../services/studentFees';

const formatNgn = (n: number | string | null | undefined): string => {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(v);
};

const PaymentConfirmation: React.FC = () => {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const t = i18n.paymentResult.confirmPayment;

  const fullName = useMemo(() => {
    if (!user) return 'Student';
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Student';
  }, [user]);

  const brand = i18n.portals.student.dashboardBrand;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<any>(null);

  const [proceeding, setProceeding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [gatewayLabel, setGatewayLabel] = useState<string | undefined>(undefined);
  const load = useCallback(async () => {
    if (!invoiceId) {
      setError('Missing invoice id');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let envelope: any = null;
      let invoice: any = null;
      try {
        const r = await studentFeeApi.getInvoice(invoiceId as any);
        envelope = (r as any)?.data ?? r;
        invoice = envelope?.invoice ?? (r as any)?.data?.invoice ?? (r as any)?.invoice ?? envelope;
      } catch {
        envelope = null;
        invoice = null;
      }
      if (!invoice) {
        setError('Unable to load invoice details.');
      } else {
        const due = Number(invoice.amountDue ?? 0);
        const paid = Number(invoice.amountPaid ?? 0);
        const outstanding = Math.max(0, due - paid);
        const processingFee = Math.round(outstanding * 0.015);
        const total = outstanding + processingFee;
        setPayload({
          invoiceId: invoice.id ?? invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          feeName: invoice.fee?.name ?? invoice.feeName ?? invoice.description ?? 'Fee Payment',
          session: invoice.session ?? invoice.academicSession ?? invoice.semester ?? '—',
          amountDue: due,
          amountPaid: paid,
          outstanding,
          processingFee,
          serverComputedAmount: total,
          studentName: invoice.studentName ?? invoice.student?.firstName
            ? `${invoice.student?.firstName ?? ''} ${invoice.student?.lastName ?? ''}`.trim()
            : fullName,
          matricNumber: invoice.matricNumber ?? invoice.student?.matricNumber ?? (user as any)?.matricNumber ?? '—',
          studentEmail: invoice.studentEmail ?? user?.email ?? '',
        });
        // Gateway label comes from envelope.pay (top-level), NOT inside invoice object
        const initialLabel = envelope?.pay?.gateway_label;
        if (initialLabel) setGatewayLabel(initialLabel);
      }
    } catch (_err: any) {
      const m = _err?.response?.data?.message || 'Unable to load invoice';
      setError(typeof m === 'string' ? m : 'Unable to load invoice');
    } finally {
      setLoading(false);
    }
  }, [invoiceId, fullName, user]);

  useEffect(() => { load(); }, [load]);

  const proceed = async () => {
    if (!payload || proceeding) return;
    setProceeding(true);
    setMsg(null);
    try {
      const idempotencyKey = `INVCONF-${payload.invoiceId || invoiceId || 'X'}-${Date.now()}`;
      const init = await studentFeeApi.initiatePayment({
        invoiceId: payload.invoiceId ?? invoiceId ?? '',
        email: payload.studentEmail || user?.email || '',
        idempotencyKey,
      });
      const initData = (init as any)?.data ?? init;
      const gl = initData?.gateway_label ?? initData?.gatewayLabel ?? undefined;
      if (gl) setGatewayLabel(gl);
      const url = (init as any)?.authorization_url || (init as any)?.data?.authorization_url || '';
      if (typeof url === 'string' && url.startsWith('http')) {
        window.location.href = url;
        return;
      }
      const ref = (init as any)?.reference || (init as any)?.data?.reference || '';
      if (ref) {
        navigate(`/student/payments/callback/${encodeURIComponent(ref)}`);
        return;
      }
      const fallbackMsg = (init as any)?.message || (init as any)?.data?.message || 'Unable to initiate payment. Please try again shortly.';
      setMsg(typeof fallbackMsg === 'string' ? fallbackMsg : 'Unable to initiate payment. Please try again shortly.');
    } catch (_err: any) {
      const m = _err?.payload?.message || _err?.message || 'Unable to initiate payment';
      setMsg(typeof m === 'string' ? m : 'Unable to initiate payment');
    } finally {
      setProceeding(false);
    }
  };

  const content = (
    <div className="w-full space-y-6 py-2">
      <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <Link
          to={invoiceId ? `/student/invoices/${invoiceId}` : '/student/invoices'}
          className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:text-blue-900 font-medium"
        >
          <ArrowLeft className="h-4 w-4" /> {t.ctaCancel} / Back to Invoice
        </Link>
      </div>

      <div className="text-center sm:text-left">
        <h1 className="text-2xl sm:text-3xl font-black text-gray-900 tracking-tight flex items-center justify-center sm:justify-start gap-2">
          <CreditCard className="h-7 w-7 text-blue-600" /> {t.heroTitle}
        </h1>
        <p className="text-gray-500 mt-2">{t.heroSubtitle}</p>
      </div>

      {loading ? (
        <div className="bg-white border border-gray-100 rounded-2xl p-12 flex flex-col items-center gap-3">
          <Loader2 className="h-7 w-7 animate-spin text-blue-600" />
          <p className="text-gray-500">Loading invoice…</p>
        </div>
      ) : error ? (
        <div className="bg-white border border-red-100 rounded-2xl p-8 text-center">
          <ShieldCheck className="h-8 w-8 text-red-500 mx-auto mb-3" />
          <p className="font-bold text-red-900">{error}</p>
          <Link to="/student/invoices" className="mt-4 inline-block text-blue-700 hover:text-blue-900 font-medium">
            ← Back to Invoices
          </Link>
        </div>
      ) : payload ? (
        <div className="space-y-6">
          <section className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 bg-blue-50/60 border-b border-blue-100 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100 text-blue-700">
                <Receipt className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-gray-900">{t.feeLabel.replace('Name', ' & Session')}</h2>
                {payload.invoiceNumber && (
                  <p className="text-xs text-gray-500 font-mono mt-0.5">Invoice #{payload.invoiceNumber}</p>
                )}
              </div>
            </div>
            <dl className="divide-y divide-gray-100">
              <div className="flex items-center justify-between px-6 py-4">
                <dt className="text-sm text-gray-500 font-medium flex items-center gap-1.5">
                  <Calculator className="h-4 w-4 text-gray-400" /> {t.feeLabel}
                </dt>
                <dd className="text-sm font-semibold text-gray-900">{payload.feeName}</dd>
              </div>
              <div className="flex items-center justify-between px-6 py-4">
                <dt className="text-sm text-gray-500 font-medium">{t.sessionLabel}</dt>
                <dd className="text-sm font-semibold text-gray-900">{payload.session}</dd>
              </div>
              <div className="flex items-center justify-between px-6 py-4">
                <dt className="text-sm text-gray-500 font-medium">{t.studentLabel}</dt>
                <dd className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5 text-gray-400" /> {payload.studentName}
                </dd>
              </div>
              <div className="flex items-center justify-between px-6 py-4">
                <dt className="text-sm text-gray-500 font-medium flex items-center gap-1.5">
                  <GraduationCap className="h-4 w-4 text-gray-400" /> {t.matricLabel}
                </dt>
                <dd className="text-sm font-mono font-semibold text-gray-900">{payload.matricNumber}</dd>
              </div>
              <div className="flex items-center justify-between px-6 py-4">
                <dt className="text-sm text-gray-500 font-medium">{i18n.payment.processingVia}</dt>
                <dd className="text-sm font-semibold text-gray-900">{gatewayLabel || 'Secure Payment'}</dd>
              </div>
              <div className="flex items-center justify-between px-6 py-4 bg-emerald-50/60">
                <dt className="text-sm font-bold text-emerald-900">{t.amountLabel}</dt>
                <dd className="text-xl font-black text-emerald-700 tabular-nums">
                  {formatNgn(payload.serverComputedAmount ?? payload.outstanding)}
                </dd>
              </div>
            </dl>
          </section>

          {(payload.processingFee > 0 || payload.outstanding !== payload.serverComputedAmount) && (
            <section className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6 space-y-2">
              <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider">Breakdown</h3>
              <div className="flex justify-between text-sm"><span className="text-gray-500">Outstanding</span><span className="tabular-nums text-gray-900">{formatNgn(payload.outstanding)}</span></div>
              {payload.processingFee > 0 && (
                <div className="flex justify-between text-sm"><span className="text-gray-500">Processing Fee (1.5%)</span><span className="tabular-nums text-gray-900">{formatNgn(payload.processingFee)}</span></div>
              )}
              <div className="flex justify-between pt-2 mt-1 border-t border-gray-100 font-bold text-base">
                <span className="text-gray-900">Total</span>
                <span className="tabular-nums text-blue-700">{formatNgn(payload.serverComputedAmount ?? payload.outstanding)}</span>
              </div>
            </section>
          )}

          {msg && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800 flex items-start gap-2">
              <ShieldCheck className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
              <span>{msg}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
            <Link
              to={invoiceId ? `/student/invoices/${invoiceId}` : '/student/invoices'}
              className="inline-flex items-center gap-1.5 text-sm border border-gray-200 bg-white hover:bg-gray-50 text-gray-800 font-semibold px-5 py-2.5 rounded-lg"
            >
              <ArrowLeft className="h-4 w-4" /> {t.ctaCancel}
            </Link>
            <button
              type="button"
              onClick={proceed}
              disabled={proceeding || Number(payload.serverComputedAmount ?? payload.outstanding ?? 0) <= 0}
              className="inline-flex items-center gap-2 bg-[#0a3d91] hover:bg-[#0b46a8] disabled:opacity-60 text-white font-bold px-6 py-3 rounded-lg shadow-sm"
            >
              {proceeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {proceeding ? 'Preparing…' : (gatewayLabel ? `Pay with ${gatewayLabel}` : t.ctaProceed)}
            </button>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );

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
      {content}
    </PortalShell>
  );
};

export default PaymentConfirmation;
