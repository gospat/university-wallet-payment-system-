import React, { useEffect, useMemo, useState } from 'react';
import { Zap, CreditCard, Send, CheckCircle2, Copy, AlertTriangle } from 'lucide-react';
import MatricStudentInput from './MatricStudentInput';
import type { MatricStudentResp } from '../../services/adminFees';
import feeApi, {
  type CreateDirectStudentBillInput,
  type DirectStudentBillSuccessResp,
  type FeeOut,
} from '../../services/adminFees';

type ActorRole = 'ADMIN' | 'BURSARY';

interface DirectBillFormProps {
  actorRole: ActorRole;
  onSuccess?: (resp: DirectStudentBillSuccessResp) => void;
  compact?: boolean;
  onCancel?: () => void;
  initialMatric?: string;
}

const fmtNgn = (n: number | string | null | undefined) => {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(v);
};

const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime())
    ? '—'
    : dt.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });
};

const toISODate = (s: string | null | undefined) =>
  s ? new Date(s).toISOString().slice(0, 10) : '';

const DirectBillForm: React.FC<DirectBillFormProps> = ({
  actorRole,
  onSuccess,
  compact = false,
  onCancel,
  initialMatric = '',
}) => {
  const [matric, setMatric] = useState(initialMatric);
  const [resolved, setResolved] = useState<MatricStudentResp | null>(null);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  useEffect(() => setMatric(initialMatric), [initialMatric]);

  const [mode, setMode] = useState<'existing' | 'adhoc'>('existing');
  const [fees, setFees] = useState<FeeOut[]>([]);
  const [feesLoading, setFeesLoading] = useState(false);
  const [selectedFeeId, setSelectedFeeId] = useState<number | ''>('');

  const [adhocName, setAdhocName] = useState('');
  const [adhocCategory, setAdhocCategory] = useState('OTHER');

  const [overrideAmount, setOverrideAmount] = useState<string>('');
  const [overrideDeadline, setOverrideDeadline] = useState<string>('');
  const [noteToStudent, setNoteToStudent] = useState<string>('');

  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<DirectStudentBillSuccessResp | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFeesLoading(true);
    feeApi
      .listFees({ isActive: true, pageSize: 500, sort: 'name', order: 'asc' })
      .then((r) => {
        if (!cancelled) setFees(r.fees ?? []);
      })
      .finally(() => !cancelled && setFeesLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedFee = useMemo(
    () => fees.find((f) => f.id === selectedFeeId) ?? null,
    [fees, selectedFeeId],
  );

  const effectiveAmount: string = useMemo(() => {
    if (overrideAmount.trim() !== '') return overrideAmount.trim();
    if (mode === 'existing' && selectedFee) return String(selectedFee.amount);
    return '';
  }, [mode, overrideAmount, selectedFee]);

  const effectiveDeadline: string = useMemo(() => {
    if (overrideDeadline) return overrideDeadline;
    if (mode === 'existing' && selectedFee?.paymentDeadline)
      return toISODate(selectedFee.paymentDeadline);
    return '';
  }, [mode, overrideDeadline, selectedFee]);

  const canSubmit: boolean = useMemo(() => {
    if (submitting) return false;
    if (!resolved || resolveErr) return false;
    if (!effectiveAmount) return false;
    const amt = Number(effectiveAmount);
    if (!isFinite(amt) || amt <= 0) return false;
    if (mode === 'existing') return selectedFeeId !== '';
    return adhocName.trim().length >= 2;
  }, [submitting, resolved, resolveErr, effectiveAmount, mode, selectedFeeId, adhocName]);

  const resetOutcome = () => {
    setSubmitErr(null);
    setSubmitOk(null);
    setCopied(false);
  };

  useEffect(() => {
    resetOutcome();
  }, [matric, mode, selectedFeeId, adhocName, overrideAmount, overrideDeadline, noteToStudent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !resolved) return;
    resetOutcome();
    setSubmitting(true);
    try {
      let body: CreateDirectStudentBillInput;
      const common = {
        matricNumber: matric.trim(),
        overrideDeadline: overrideDeadline || undefined,
        noteToStudent: noteToStudent.trim() || undefined,
      };
      if (mode === 'existing') {
        body = {
          ...common,
          feeId: Number(selectedFeeId),
          overrideAmount:
            overrideAmount.trim() !== '' ? Number(overrideAmount.trim()) : undefined,
        };
      } else {
        body = {
          ...common,
          adhocFeeName: adhocName.trim(),
          adhocFeeCategory: adhocCategory.trim() || 'OTHER',
          overrideAmount: Number(overrideAmount.trim()),
        };
      }
      const resp = await feeApi.createDirectStudentBill(body);
      setSubmitOk(resp);
      onSuccess?.(resp);
    } catch (err: any) {
      setSubmitErr(err?.message?.toString?.() || 'Failed to bill student. Please retry.');
    } finally {
      setSubmitting(false);
    }
  };

  const copyInv = async () => {
    if (!submitOk) return;
    try {
      await navigator.clipboard.writeText(submitOk.invoiceNumber);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (_) {
      /* noop */
    }
  };

  const SectionTitle: React.FC<{ num: 1 | 2 | 3; text: string }> = ({ num, text }) => (
    <div className="flex items-center gap-2 mb-2">
      <div className="h-6 w-6 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center">
        {num}
      </div>
      <div className="text-sm font-semibold text-gray-900">{text}</div>
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className={`space-y-5 ${compact ? '' : 'px-1'}`}>
      <div>
        <SectionTitle num={1} text="Identify the Student" />
        <MatricStudentInput
          value={matric}
          onChange={(v) => {
            setMatric(v);
            setResolved(null);
            setResolveErr(null);
          }}
          onResolved={(s, err) => {
            setResolved(s);
            setResolveErr(err);
          }}
          label="Matric Number"
          placeholder="2023/SCI/1001 — press Enter or blur to resolve"
          autoResolveOnMount
          helpText="Enter a currently-enrolled student's official matric number. Only ACTIVE students can receive direct bills."
        />
      </div>

      <div>
        <SectionTitle num={2} text="Choose what to bill" />
        <div className="flex rounded-lg border border-gray-200 bg-white p-1 gap-1 mb-3">
          <button
            type="button"
            onClick={() => setMode('existing')}
            className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-1.5 ${
              mode === 'existing'
                ? 'bg-blue-600 text-white'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <CreditCard className="h-4 w-4" /> Bill from Catalogue
          </button>
          <button
            type="button"
            onClick={() => setMode('adhoc')}
            className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-1.5 ${
              mode === 'adhoc'
                ? 'bg-amber-600 text-white'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Zap className="h-4 w-4" /> Ad-hoc Charge
          </button>
        </div>

        {mode === 'existing' ? (
          <div className="space-y-2">
            <label className="block text-xs text-gray-600 mb-1 font-medium">
              Select from active bills catalogue
            </label>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={String(selectedFeeId)}
              disabled={feesLoading}
              onChange={(e) => {
                setSelectedFeeId(e.target.value ? Number(e.target.value) : '');
                if (!overrideAmount) setOverrideAmount('');
                if (!overrideDeadline && selectedFee?.paymentDeadline) {
                  /* keep cleared */
                }
              }}
            >
              <option value="">
                {feesLoading ? 'Loading bills…' : '— Choose a bill from catalogue —'}
              </option>
              {fees.map((f) => (
                <option key={f.id} value={f.id}>
                  [{f.feeCode}] {f.name} · {f.academicSession} · {fmtNgn(f.amount)}
                </option>
              ))}
            </select>
            {selectedFee && (
              <div className="rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-900 space-y-0.5">
                <div>
                  <span className="font-semibold">Scope:</span>{' '}
                  {[
                    selectedFee.college,
                    selectedFee.department,
                    selectedFee.program,
                    selectedFee.level ? `${selectedFee.level}L` : null,
                    selectedFee.studentType,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Visible to every student'}
                </div>
                {selectedFee.description && (
                  <div className="text-blue-800 opacity-90">{selectedFee.description}</div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <label className="block text-xs text-gray-600 mb-1 font-medium">
                Charge name <span className="text-red-500">*</span>
              </label>
              <input
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={adhocName}
                onChange={(e) => setAdhocName(e.target.value)}
                placeholder="e.g. Late Registration Penalty — Semester 1"
                maxLength={150}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1 font-medium">
                Fee Category code
              </label>
              <input
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm uppercase"
                value={adhocCategory}
                onChange={(e) => setAdhocCategory(e.target.value.toUpperCase())}
                placeholder="OTHER (default)"
                maxLength={20}
                pattern="^[A-Z0-9_]{2,20}$"
              />
              <p className="text-[11px] text-gray-500 mt-1">
                If this category doesn't exist, it will be created automatically.
              </p>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1 font-medium">
                Assigned by
              </label>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 flex items-center gap-2">
                {actorRole === 'BURSARY' ? (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                    BURSARY
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                    ADMIN
                  </span>
                )}
                <span>Origin marked on receipt as Direct Bill.</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div>
        <SectionTitle num={3} text="Amount, due date & notes" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1 font-medium">
              Amount (NGN) <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              className={`w-full rounded-md border px-3 py-2 text-sm ${
                selectedFee &&
                mode === 'existing' &&
                overrideAmount === '' &&
                Number(selectedFee.amount) > 0
                  ? 'border-blue-300 bg-blue-50/40'
                  : 'border-gray-300'
              }`}
              value={overrideAmount}
              onChange={(e) => setOverrideAmount(e.target.value)}
              placeholder={
                mode === 'existing'
                  ? selectedFee
                    ? `Catalogue default: ${fmtNgn(selectedFee.amount)}`
                    : 'Enter amount'
                  : 'e.g. 25000.00'
              }
            />
            {effectiveAmount && (
              <p className="text-[11px] text-gray-500 mt-1">
                Bill amount:{' '}
                <span className="font-semibold text-gray-800 tabular-nums">
                  {fmtNgn(effectiveAmount)}
                </span>
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1 font-medium">
              Payment deadline
            </label>
            <input
              type="date"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={overrideDeadline}
              onChange={(e) => setOverrideDeadline(e.target.value)}
            />
            {effectiveDeadline && (
              <p className="text-[11px] text-gray-500 mt-1">
                Due on:{' '}
                <span className="font-medium text-gray-800">{fmtDate(effectiveDeadline)}</span>
              </p>
            )}
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-gray-600 mb-1 font-medium">
              Note or description to the student (optional)
            </label>
            <textarea
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={noteToStudent}
              onChange={(e) => setNoteToStudent(e.target.value)}
              placeholder="Any specific explanation or instructions (e.g. Pay before course registration closes.)"
              maxLength={500}
            />
          </div>
        </div>
      </div>

      {submitErr && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-red-600" />
          <div className="min-w-0 flex-1">{submitErr}</div>
        </div>
      )}

      {submitOk && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3.5 text-sm text-emerald-900 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-emerald-800">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            {submitOk.created
              ? 'Direct bill created & invoice generated'
              : 'Idempotent match — bill already in place for this student'}
            <span className="ml-auto text-[11px] uppercase tracking-wide font-semibold bg-emerald-100 px-2 py-0.5 rounded-full">
              {submitOk.origin}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-emerald-700/80">Student</dt>
              <dd className="font-medium text-emerald-900">{submitOk.studentName}</dd>
            </div>
            <div>
              <dt className="text-emerald-700/80">Matric</dt>
              <dd className="font-mono font-medium text-emerald-900">
                {submitOk.matricNumber ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-emerald-700/80">Fee</dt>
              <dd className="font-medium text-emerald-900">{submitOk.feeName}</dd>
            </div>
            <div>
              <dt className="text-emerald-700/80">Amount</dt>
              <dd className="font-semibold tabular-nums">{fmtNgn(submitOk.amount)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-emerald-700/80">Invoice #</dt>
              <dd className="font-mono font-bold flex items-center gap-2 flex-wrap">
                <span>{submitOk.invoiceNumber}</span>
                <button
                  type="button"
                  onClick={copyInv}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-300 bg-white hover:bg-emerald-100 text-emerald-800 text-[10px]"
                >
                  <Copy className="h-3 w-3" />
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </dd>
            </div>
            <div>
              <dt className="text-emerald-700/80">Assignment #</dt>
              <dd className="font-mono text-emerald-900">#{submitOk.assignmentId}</dd>
            </div>
            <div>
              <dt className="text-emerald-700/80">Due</dt>
              <dd className="font-medium text-emerald-900">{fmtDate(submitOk.deadline)}</dd>
            </div>
          </dl>
          <p className="text-[11px] text-emerald-700/90 leading-snug">
            This charge now appears on the student's dashboard — both in their{' '}
            <strong>Make Payment</strong> catalogue (pinned top, DIRECT BILL badge) and in their{' '}
            <strong>Payment History / Invoices</strong> list.
          </p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-800 hover:bg-gray-50"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white text-sm font-medium inline-flex items-center gap-1.5"
        >
          {submitting ? (
            <>
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
              Processing…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" />
              Assign Bill &amp; Notify Student
            </>
          )}
        </button>
      </div>
    </form>
  );
};

export default DirectBillForm;
