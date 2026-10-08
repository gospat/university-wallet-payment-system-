import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import PaymentResult from '../../components/student/PaymentResult';
import { useAuth } from '../../context/AuthContext';
import { i18n } from '../../i18n/en';
import { studentFeeApi } from '../../services/studentFees';
import { isAlatpayUuid } from '../../types/alatpay';
import { ArrowLeft, Clock, History, Mail } from 'lucide-react';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(n);

type Stage = 'loading' | 'success' | 'failed' | 'unknown';

const CallbackPage: React.FC = () => {
  const { paystackRef: refParam } = useParams<{ paystackRef?: string }>();
  const [search] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const t = i18n.dashboard.student.callback;

  const fullName = useMemo(() => {
    if (!user) return 'Student';
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Student';
  }, [user]);
  const brand = i18n.portals.student.dashboardBrand;

  const ref = (refParam || search.get('reference') || search.get('trxref') || search.get('paystackRef') || '').trim();

  // ALATPay final authoritative UUID is carried via ?providerReference query param.
  // Strictly validate UUID v4 format via isAlatpayUuid before forwarding to backend.
  // If invalid / missing: providerReferenceOpt = null, fail closed / use legacy path only.
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

  useEffect(() => {
    if (!ref) {
      setStage('unknown');
      return;
    }
    let cancelled = false;
    (async () => {
      setStage('loading');
      try {
        const r: any = await studentFeeApi.verifyPayment(
          ref,
          providerReferenceOpt ? { providerReference: providerReferenceOpt } : undefined,
        );
        const ok = !!r?.success || r?.status === 'SUCCESS' || r?.data?.status === 'SUCCESS' || r?.verified === true;
        const d = r?.data ?? r;
        if (!cancelled) {
          const amt = Number(d?.amount ?? r?.amount ?? NaN);
          if (!Number.isNaN(amt) && amt > 0) setVerifyAmount(amt);
          const outst = Number(d?.invoiceOutstanding ?? d?.remainingBalance ?? r?.remainingBalance ?? r?.invoiceOutstanding ?? NaN);
          if (!Number.isNaN(outst)) setOutstanding(outst);
          setInvoiceId(d?.invoiceId ?? r?.invoiceId ?? null);
          const rRef = d?.receiptReference ?? d?.receiptRef ?? r?.receiptRef ?? r?.receiptReference ?? null;
          setReceiptRef(rRef);
          const pRef = d?.paymentReference ?? d?.reference ?? r?.reference ?? r?.paymentReference ?? null;
          setPayRef(pRef);
          const gl = d?.gateway_label ?? d?.gatewayLabel ?? r?.gateway_label ?? r?.gatewayLabel ?? undefined;
          if (gl) setGatewayLabel(gl);
          const dt = d?.createdAt ?? d?.paidAt ?? d?.date ?? r?.createdAt ?? r?.paidAt ?? null;
          if (dt) setVerifyDate(dt);
          setStage(ok ? 'success' : 'failed');
        }
      } catch (_err: any) {
        if (cancelled) return;
        const status = _err?.response?.status;
        setStage(status >= 400 && status < 500 ? 'failed' : 'unknown');
      }
    })();
    return () => { cancelled = true; };
  }, [ref, providerReferenceOpt]);

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
      case 'unknown':
      default:
        return 'pending';
    }
  })();

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
        {stage === 'unknown' && !ref ? (
          <>
            <div className="mb-5">
              <Link to="/student/invoices" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:text-blue-900">
                <ArrowLeft className="h-4 w-4" /> {t.gotoInvoices}
              </Link>
            </div>
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
          </>
        ) : (
          <>
            <div className="mb-5">
              <Link to="/student/invoices" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:text-blue-900">
                <ArrowLeft className="h-4 w-4" /> {t.gotoInvoices}
              </Link>
            </div>

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
              onCheckStatus={async () => {
                if (ref) {
                  try {
                    const r: any = await studentFeeApi.verifyPayment(ref);
                    const ok = !!r?.success || r?.status === 'SUCCESS' || r?.data?.status === 'SUCCESS' || r?.verified === true;
                    setStage(ok ? 'success' : 'failed');
                  } catch (_) {
                    setStage('unknown');
                  }
                }
              }}
              onContactHelp={() => {
                try { window.location.href = 'mailto:bursary@university.edu.ng'; } catch (_) {}
              }}
            />

            {stage === 'success' && outstanding !== null && outstanding > 0 && (
              <div className="mt-6 bg-blue-50 rounded-2xl p-5 border border-blue-100">
                <p className="text-xs uppercase font-bold tracking-wider text-blue-700">{t.outstandingLabel}</p>
                <p className="text-2xl font-black text-blue-900 mt-0.5">{fmt(outstanding)}</p>
                {invoiceId && (
                  <Link
                    to={`/student/payments/confirm/${String(invoiceId)}`}
                    className="mt-3 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5 rounded-lg shadow-sm"
                  >
                    {t.retry}
                  </Link>
                )}
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </PortalShell>
  );
};

export default CallbackPage;
