import React, { useState } from 'react';
import Modal from './Modal';
import { i18n } from '../i18n/en';

interface ConfirmActionProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (payload: { reason?: string }) => Promise<void> | void;
  title: string;
  description: string;
  resourceLabel: string;
  amount?: string | number;
  reference?: string;
  reasonRequired?: boolean;
  confirmLabel?: string;
  confirmVariant?: 'danger' | 'warning' | 'primary';
  cancelLabel?: string;
  loading?: boolean;
}

const formatNGN = (value: string | number): string => {
  if (typeof value === 'number') {
    return `₦${value.toLocaleString()}`;
  }
  return value;
};

const VARIANT_STYLES: Record<NonNullable<ConfirmActionProps['confirmVariant']>, string> = {
  danger: 'bg-red-600 hover:bg-red-700 text-white',
  warning: 'bg-amber-600 hover:bg-amber-700 text-white',
  primary: 'bg-blue-600 hover:bg-blue-700 text-white',
};

const ConfirmAction: React.FC<ConfirmActionProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  resourceLabel,
  amount,
  reference,
  reasonRequired = false,
  confirmLabel,
  confirmVariant = 'danger',
  cancelLabel,
  loading = false,
}) => {
  const [reason, setReason] = useState('');

  const reasonValid = !reasonRequired || reason.trim().length > 0;
  const confirmDisabled = loading || !reasonValid;

  const handleClose = () => {
    if (loading) return;
    setReason('');
    onClose();
  };

  const handleConfirm = async () => {
    if (confirmDisabled) return;
    await onConfirm({ reason: reasonRequired ? reason.trim() : undefined });
    setReason('');
  };

  const variantStyle = VARIANT_STYLES[confirmVariant];

  const footer = (
    <div className="flex items-center justify-between w-full gap-3">
      <button
        type="button"
        onClick={handleClose}
        disabled={loading}
        className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {cancelLabel ?? i18n.confirmAction.cancelLabel}
      </button>
      <button
        type="button"
        onClick={handleConfirm}
        disabled={confirmDisabled}
        className={`px-6 py-2 text-sm font-semibold rounded-lg inline-flex items-center gap-2 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed ${variantStyle}`}
      >
        {loading && (
          <svg
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        {loading ? i18n.confirmAction.confirming : confirmLabel ?? i18n.confirmAction.confirmDefault}
      </button>
    </div>
  );

  const attributeRows: Array<{ label: string; value: React.ReactNode }> = [];
  attributeRows.push({ label: 'Resource', value: resourceLabel });
  if (amount !== undefined && amount !== null && amount !== '') {
    attributeRows.push({ label: 'Amount', value: formatNGN(amount) });
  }
  if (reference) {
    attributeRows.push({ label: 'Reference', value: reference });
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={title}
      footer={footer}
    >
      <div className="space-y-5">
        <p className="text-sm text-gray-600 leading-relaxed">{description}</p>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-gray-100 bg-gray-50/50 p-4">
          {attributeRows.map((row) => (
            <div key={row.label} className="col-span-2 sm:col-span-1 min-w-0">
              <div className="text-xs text-gray-500 mb-0.5">{row.label}</div>
              <div className="text-sm font-medium text-gray-900 truncate">{row.value}</div>
            </div>
          ))}
        </div>

        {reasonRequired && (
          <div>
            <label htmlFor="confirm-action-reason" className="block text-sm font-medium text-gray-700 mb-1.5">
              {i18n.confirmAction.reasonLabel}
              <span className="text-red-500 ml-0.5">*</span>
            </label>
            <textarea
              id="confirm-action-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={i18n.confirmAction.reasonPlaceholder}
              disabled={loading}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 disabled:bg-gray-50 disabled:text-gray-500 resize-y"
            />
            {!reasonValid && reasonRequired && reason.length === 0 && (
              <p className="mt-1.5 text-xs text-red-600">{i18n.confirmAction.reasonRequired}</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default ConfirmAction;
