import React from 'react';
import { CheckCircle2, XCircle, Clock, Download, History, RefreshCw, HelpCircle, Mail } from 'lucide-react';
import { i18n } from '../../i18n/en';

export interface PaymentResultProps {
  state: 'idle' | 'success' | 'failure' | 'pending';
  data?: {
    amount?: number;
    reference?: string;
    receiptNumber?: string;
    date?: string | Date;
    paystackReference?: string;
    gatewayReference?: string;
    gatewayLabel?: string;
    gateway?: string;
    reason?: string;
  };
  onDownloadReceipt?: () => void;
  onViewHistory?: () => void;
  onTryAgain?: () => void;
  onCheckStatus?: () => void;
  onContactHelp?: () => void;
}

const formatNgn = (n: number | string | null | undefined): string => {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(v);
};

const formatDateTime = (d: string | Date | null | undefined): string => {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('en-NG', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const KVRow: React.FC<{ label: string; value: React.ReactNode; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="flex items-start justify-between py-3 border-b border-gray-100 last:border-0">
    <span className="text-sm text-gray-500 font-medium shrink-0 mr-4">{label}</span>
    <span className={`text-sm font-semibold text-gray-900 text-right ${mono ? 'font-mono' : ''}`}>{value}</span>
  </div>
);

const PaymentResult: React.FC<PaymentResultProps> = ({
  state,
  data,
  onDownloadReceipt,
  onViewHistory,
  onTryAgain,
  onCheckStatus,
  onContactHelp,
}) => {
  const t = i18n.paymentResult;

  if (state === 'idle') return null;

  const heroIconMap = {
    success: { Icon: CheckCircle2, bg: 'bg-emerald-100', fg: 'text-emerald-600', barBg: 'bg-emerald-50' },
    failure: { Icon: XCircle, bg: 'bg-rose-100', fg: 'text-rose-600', barBg: 'bg-rose-50' },
    pending: { Icon: Clock, bg: 'bg-amber-100', fg: 'text-amber-600', barBg: 'bg-amber-50' },
  } as const;

  const { Icon, bg, fg, barBg } = heroIconMap[state];
  const copy = t[state === 'failure' ? 'failure' : state];

  return (
    <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
      <div className={`px-6 py-6 sm:px-8 sm:py-7 flex items-center gap-4 sm:gap-5 ${barBg}`}>
        <div className={`p-3 sm:p-3.5 rounded-full ${bg} shrink-0`}>
          <Icon className="h-10 w-10 sm:h-12 sm:w-12" />
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider font-bold text-gray-500">Payment Status</p>
          <h1 className={`text-2xl sm:text-3xl font-black mt-0.5 ${fg}`}>{copy.heroTitle}</h1>
          <p className="text-sm text-gray-600 mt-1">{copy.heroSubtitle}</p>
        </div>
      </div>

      <div className="p-6 sm:p-8 space-y-6">
        {state === 'success' && (
          <>
            {typeof data?.amount === 'number' && (
              <div className="text-center py-3">
                <p className="text-xs uppercase font-bold tracking-wider text-gray-500 mb-1">
                  {t.success.amountLabel}
                </p>
                <p className="text-3xl sm:text-4xl font-black text-gray-900 tabular-nums">
                  {formatNgn(data.amount)}
                </p>
              </div>
            )}
            <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 px-5">
              {data?.reference && (
                <KVRow label={t.success.referenceLabel} value={data.reference} mono />
              )}
              {data?.receiptNumber && (
                <KVRow label={t.success.receiptLabel} value={data.receiptNumber} mono />
              )}
              <KVRow label={i18n.payment.paidVia} value={data?.gatewayLabel || 'Secure Payment'} />
              {data?.date && (
                <KVRow label={t.success.dateLabel} value={formatDateTime(data.date)} />
              )}
            </div>
            <div className="flex flex-wrap gap-3 pt-2">
              <button
                type="button"
                onClick={onDownloadReceipt}
                className="inline-flex items-center gap-2 bg-[#0a3d91] hover:bg-[#0b46a8] text-white font-semibold px-5 py-2.5 rounded-lg shadow-sm"
              >
                <Download className="h-4 w-4" /> {t.success.ctaDownload}
              </button>
              <button
                type="button"
                onClick={onViewHistory}
                className="inline-flex items-center gap-2 border border-gray-200 bg-white hover:bg-gray-50 text-gray-800 font-semibold px-5 py-2.5 rounded-lg"
              >
                <History className="h-4 w-4" /> {t.success.ctaHistory}
              </button>
            </div>
          </>
        )}

        {state === 'failure' && (
          <>
            <div className="border border-gray-100 rounded-xl px-5 divide-y divide-gray-100">
              {data?.reference && (
                <KVRow label={t.failure.referenceLabel} value={data.reference} mono />
              )}
              {data?.reason && (
                <KVRow label="Reason" value={data.reason} />
              )}
            </div>
            <div className="flex flex-wrap gap-3 pt-2">
              <button
                type="button"
                onClick={onTryAgain}
                className="inline-flex items-center gap-2 bg-[#0a3d91] hover:bg-[#0b46a8] text-white font-semibold px-5 py-2.5 rounded-lg shadow-sm"
              >
                <RefreshCw className="h-4 w-4" /> {t.failure.ctaTryAgain}
              </button>
              <a
                href="mailto:bursary@university.edu.ng"
                onClick={onContactHelp}
                className="inline-flex items-center gap-2 border border-gray-200 bg-white hover:bg-gray-50 text-gray-800 font-semibold px-5 py-2.5 rounded-lg"
              >
                <Mail className="h-4 w-4" /> {t.failure.ctaHelp}
              </a>
            </div>
          </>
        )}

        {state === 'pending' && (
          <>
            <div className="border border-gray-100 rounded-xl px-5 divide-y divide-gray-100">
              {data?.reference && (
                <KVRow label={t.pending.referenceLabel} value={data.reference} mono />
              )}
              {(data?.gatewayReference || data?.paystackReference) && (
                <KVRow label="Gateway Reference" value={data.gatewayReference || data.paystackReference} mono />
              )}
            </div>
            <div className="flex flex-wrap gap-3 pt-2">
              <button
                type="button"
                onClick={onCheckStatus}
                className="inline-flex items-center gap-2 bg-[#0a3d91] hover:bg-[#0b46a8] text-white font-semibold px-5 py-2.5 rounded-lg shadow-sm"
              >
                <HelpCircle className="h-4 w-4" /> {t.pending.ctaCheck}
              </button>
              <button
                type="button"
                onClick={onViewHistory}
                className="inline-flex items-center gap-2 border border-gray-200 bg-white hover:bg-gray-50 text-gray-800 font-semibold px-5 py-2.5 rounded-lg"
              >
                <History className="h-4 w-4" /> {t.pending.ctaHistory}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default PaymentResult;
