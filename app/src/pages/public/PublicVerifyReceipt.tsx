import React from 'react';
import api from '../../services/api';
import { CheckCircle2, XCircle, Loader2, ShieldCheck, Building2, GraduationCap, CalendarClock, Hash, ArrowLeft, QrCode, Banknote, Search, Link as LinkIcon, AlertTriangle } from 'lucide-react';
import { i18n } from '../../i18n/en';

type VerifyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ok';
      verified: boolean;
      branding: { name: string; address: string; phone: string; website: string; bankName?: string; bankAccount?: string };
      data: any;
    }
  | { status: 'error'; message: string };

const naira = (v: string | number) => {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtDate = (d: any) => {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'medium' });
  } catch {
    return '—';
  }
};

const PublicVerifyReceiptPage: React.FC<{ initialToken?: string }> = ({ initialToken }) => {
  const [input, setInput] = React.useState(initialToken ?? '');
  const [state, setState] = React.useState<VerifyState>({ status: 'idle' });

  const tokenFromPath = React.useMemo(() => {
    try {
      const m = window.location.pathname.match(/verify-receipt\/([A-Za-z0-9_-]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch {
      return '';
    }
  }, []);

  React.useEffect(() => {
    if (tokenFromPath) {
      setInput(tokenFromPath);
      void runVerify(tokenFromPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenFromPath]);

  const runVerify = async (token: string) => {
    const t = token.trim();
    if (!t) {
      setState({ status: 'error', message: 'Please enter or scan a verification token' });
      return;
    }
    setState({ status: 'loading' });
    try {
      const { data } = await api.get(`/public/verify-receipt/${encodeURIComponent(t)}`);
      setState({ status: 'ok', verified: !!data.verified, branding: data.branding || {}, data: data.data || {} });
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ||
        (err?.response?.status === 404 ? 'Receipt not found or verification token invalid' : 'Verification failed. Please try again.');
      setState({ status: 'error', message: msg });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runVerify(input);
  };

  const brand = (state as any).branding || {};
  const data = (state as any).data || {};
  const verified = (state as any).verified;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/40 to-indigo-50/40">
      <div className="max-w-3xl mx-auto px-4 py-10 sm:py-14">
        <div className="flex items-center justify-between mb-6">
          <a href="/" className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 font-medium">
            <ArrowLeft className="h-4 w-4" /> Back to portals
          </a>
        </div>

        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 overflow-hidden">
          <div className="bg-gradient-to-r from-[#0a3d91] via-[#114fb3] to-[#0a3d91] text-white p-6 sm:p-8">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full bg-white/15 backdrop-blur px-3 py-1 text-xs font-semibold tracking-wide mb-3 ring-1 ring-white/20">
                  <ShieldCheck className="h-3.5 w-3.5" /> Public Receipt Verification
                </div>
                <h1 className="text-2xl sm:text-3xl font-black tracking-tight mb-2">
                  {brand.name || i18n.app.universityName || 'University Receipt Verification'}
                </h1>
                <p className="text-blue-100/90 text-sm sm:text-base">
                  Verify that a university fee payment receipt is authentic and up-to-date.
                </p>
                {(brand.address || brand.phone || brand.website) ? (
                  <div className="mt-3 text-xs text-blue-100/80 space-y-0.5">
                    {brand.address && <div>{brand.address}</div>}
                    {(brand.phone || brand.website) && (
                      <div>
                        {brand.phone}
                        {brand.phone && brand.website && ' • '}
                        {brand.website}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="hidden sm:block">
                <div className="w-16 h-16 rounded-2xl bg-white/10 ring-1 ring-white/20 flex items-center justify-center backdrop-blur">
                  <QrCode className="h-8 w-8 text-white" />
                </div>
              </div>
            </div>
          </div>

          <div className="p-6 sm:p-8">
            <form onSubmit={handleSubmit} className="space-y-3">
              <label className="block">
                <span className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                  <Hash className="h-4 w-4 text-slate-500" /> Verification token or receipt URL
                </span>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Paste the verification token or full URL from a receipt QR code"
                  className="mt-2 w-full rounded-xl border border-slate-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none px-4 py-3 text-sm font-mono"
                  autoFocus
                />
              </label>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <button
                  type="submit"
                  disabled={state.status === 'loading'}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#0a3d91] hover:bg-[#0b46a8] active:bg-[#0a3d91] disabled:opacity-60 text-white font-semibold px-5 py-3 shadow-sm"
                >
                  {state.status === 'loading' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  {state.status === 'loading' ? 'Verifying…' : 'Verify Receipt'}
                </button>
                <p className="text-xs text-slate-500 flex items-center gap-1.5">
                  <LinkIcon className="h-3.5 w-3.5" />
                  Example: <code className="px-1.5 py-0.5 bg-slate-100 rounded">/verify-receipt/REC-…TOKEN…</code>
                </p>
              </div>
            </form>

            <div className="mt-6">
              {state.status === 'idle' && (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-5 text-sm text-slate-600">
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                      <QrCode className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-semibold text-slate-800 mb-1">How to verify a receipt</p>
                      <p>
                        Scan the QR code printed on any official University receipt, or paste the verification token
                        above. The page will confirm the payment amount, student, fee type, date, and whether the receipt
                        is still valid (not voided).
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {state.status === 'error' && (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-xl bg-white border border-red-200 text-red-600 flex items-center justify-center">
                      <XCircle className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-bold text-red-800">Receipt not verified</p>
                      <p className="text-red-700 text-sm mt-1">{state.message}</p>
                      <p className="text-red-600/90 text-xs mt-2 flex items-center gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5" /> If you believe this is an error, contact Bursary with
                        a copy of the receipt.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {state.status === 'ok' && (
                <div
                  className={`rounded-2xl border p-5 ${
                    verified ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4 mb-5">
                    <div className="flex items-start gap-3">
                      <div
                        className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${
                          verified ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'
                        }`}
                      >
                        {verified ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
                      </div>
                      <div>
                        <p className="font-black text-lg text-slate-900">
                          {verified ? 'Receipt verified and authentic' : 'Receipt found — but marked as VOIDED'}
                        </p>
                        <p className="text-sm text-slate-600">
                          {verified
                            ? 'This is an official, non-voided receipt issued by the University Bursary.'
                            : 'This receipt was issued but has since been voided. It is no longer valid as proof of payment.'}
                        </p>
                      </div>
                    </div>
                    <div
                      className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-black tracking-wide ring-1 ${
                        verified
                          ? 'bg-emerald-600 text-white ring-emerald-700/20'
                          : 'bg-amber-500 text-white ring-amber-600/20'
                      }`}
                    >
                      {verified ? 'VALID' : 'VOIDED'}
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="rounded-xl bg-white border border-slate-100 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                        <Banknote className="h-3.5 w-3.5" /> Amount paid
                      </div>
                      <div className="text-2xl font-black text-slate-900">{naira(data.paidAmount)}</div>
                    </div>
                    <div className="rounded-xl bg-white border border-slate-100 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                        <Hash className="h-3.5 w-3.5" /> Receipt number
                      </div>
                      <div className="text-lg font-bold text-slate-900 font-mono">{data.receiptNumber ?? '—'}</div>
                    </div>
                  </div>

                  <div className="mt-3 grid sm:grid-cols-2 gap-3">
                    <div className="rounded-xl bg-white border border-slate-100 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                        <GraduationCap className="h-3.5 w-3.5" /> Student
                      </div>
                      <div className="text-sm font-semibold text-slate-900">
                        {data.student?.fullName ?? ((`${data.student?.firstName ?? ''} ${data.student?.lastName ?? ''}`.trim()) || '—')}
                      </div>
                      <div className="text-xs text-slate-500 font-mono mt-0.5">
                        {data.student?.matricNumber ?? '—'}
                      </div>
                    </div>
                    <div className="rounded-xl bg-white border border-slate-100 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                        <Building2 className="h-3.5 w-3.5" /> Fee / Purpose
                      </div>
                      <div className="text-sm font-semibold text-slate-900">
                        {data.invoice?.feeName ?? '—'}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {data.invoice?.invoiceNumber && <span className="font-mono mr-2">#{data.invoice.invoiceNumber}</span>}
                        {data.invoice?.session && <span className="mr-2">{data.invoice.session}</span>}
                        {data.invoice?.semester && <span>{data.invoice.semester}</span>}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 grid sm:grid-cols-2 gap-3">
                    <div className="rounded-xl bg-white border border-slate-100 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                        <CalendarClock className="h-3.5 w-3.5" /> Date / Time paid
                      </div>
                      <div className="text-sm font-semibold text-slate-900">{fmtDate(data.paidAt)}</div>
                    </div>
                    <div className="rounded-xl bg-white border border-slate-100 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                        <LinkIcon className="h-3.5 w-3.5" /> Verification URL
                      </div>
                      <div className="text-xs text-slate-900 break-all font-mono bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-2">
                        {data.qrUrl || window.location.href}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
                    <p className="font-semibold text-slate-700 mb-1">Disclaimer</p>
                    <p>
                      This verification result is generated in real-time from the University Bursary system. Receipts
                      marked VOIDED are not valid proof of payment. For further confirmation contact{' '}
                      <strong>{brand.name || 'the University Bursary'}</strong>
                      {brand.phone ? ` on ${brand.phone}` : ''}
                      {brand.website ? ` or visit ${brand.website}` : ''}.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-slate-100 bg-slate-50/60 px-6 py-4 sm:px-8 sm:py-5 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-3">
            <div>© {new Date().getFullYear()} {brand.name || 'University Payment Platform'}. All rights reserved.</div>
            <div>Powered by the University Bursary payment system</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PublicVerifyReceiptPage;
