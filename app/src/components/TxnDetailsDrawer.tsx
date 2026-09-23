import React, { useEffect } from 'react';
import { X, Download, ExternalLink } from 'lucide-react';
import { i18n } from '../i18n/en';

export interface TxnDetailsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  transaction: any;
}

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

const TxnDetailsDrawer: React.FC<TxnDetailsDrawerProps> = ({ isOpen, onClose, transaction }) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const tx = transaction || {};
  const createdAt = tx.createdAt || tx.transactionDate || tx.paidAt || tx.date;

  const receiptNumber = tx.receiptNumber || tx.receipt?.receiptNumber || tx.receiptRef || null;
  const receiptId = tx.receiptId || tx.receipt?.id || null;
  const reference = tx.reference || tx.invoiceNumber || 'N/A';
  const paystackReference = tx.paystackReference || tx.paystackRef || tx.gatewayRef || null;
  const channel = tx.paystackChannel || tx.channel || tx.paymentChannel || null;
  const status = tx.status || 'UNKNOWN';
  const amount = tx.amount ?? tx.paidAmount ?? tx.balance ?? tx.amountDue ?? 0;

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
            <span className="text-base font-black text-gray-900 tabular-nums">{formatNgn(amount)}</span>
          </div>

          {receiptNumber && (
            <div className="pt-4 mt-2 border-t border-gray-200">
              <button
                type="button"
                className="w-full inline-flex items-center justify-center gap-2 bg-[#0a3d91] hover:bg-[#0b46a8] text-white font-semibold px-4 py-2.5 rounded-lg shadow-sm"
              >
                <Download className="h-4 w-4" /> Download Receipt
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TxnDetailsDrawer;
