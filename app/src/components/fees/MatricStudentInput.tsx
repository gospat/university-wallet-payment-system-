import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, UserCircle2 } from 'lucide-react';
import feeApi, { type MatricStudentResp } from '../../services/adminFees';

export type MatricResolveState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'resolved'; student: MatricStudentResp }
  | { status: 'error'; message: string };

interface MatricStudentInputProps {
  value: string;
  onChange: (val: string) => void;
  onResolved?: (student: MatricStudentResp | null, errMsg: string | null) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  autoResolveOnMount?: boolean;
  helpText?: string;
}

const fmtLevel = (l: number | null) => (l ? `${l} Level` : '—');
const fullName = (s: MatricStudentResp) =>
  [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ').trim() || s.email;

const MatricStudentInput: React.FC<MatricStudentInputProps> = ({
  value,
  onChange,
  onResolved,
  label = 'Matric Number',
  placeholder = 'e.g. 2023/SCI/1001',
  disabled = false,
  autoResolveOnMount = false,
  helpText,
}) => {
  const [state, setState] = useState<MatricResolveState>({ status: 'idle' });
  const firedOnMountRef = useRef(false);
  const latestMatricRef = useRef<string>('');

  const resolve = useCallback(
    async (raw: string) => {
      const matric = raw.trim();
      latestMatricRef.current = matric;
      if (!matric) {
        setState({ status: 'idle' });
        onResolved?.(null, null);
        return;
      }
      setState({ status: 'loading' });
      try {
        const r = await feeApi.getStudentByMatric(matric);
        if (latestMatricRef.current !== matric) return;
        setState({ status: 'resolved', student: r.student });
        onResolved?.(r.student, null);
      } catch (err: any) {
        if (latestMatricRef.current !== matric) return;
        const msg =
          err?.message?.toString?.() ||
          'No active student found with this matric number.';
        setState({ status: 'error', message: msg });
        onResolved?.(null, msg);
      }
    },
    [onResolved],
  );

  useEffect(() => {
    if (autoResolveOnMount && !firedOnMountRef.current && value.trim()) {
      firedOnMountRef.current = true;
      resolve(value);
    }
  }, [autoResolveOnMount, value, resolve]);

  const isIdle = state.status === 'idle';
  const isLoading = state.status === 'loading';
  const isResolved = state.status === 'resolved';
  const isError = state.status === 'error';

  return (
    <div className="space-y-2">
      {label && (
        <label className="block text-xs text-gray-600 mb-1 font-medium">{label}</label>
      )}
      <div className="relative">
        <input
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v);
            if (v.trim() && latestMatricRef.current === v.trim()) {
              /* keep resolved state */
            } else {
              setState({ status: 'idle' });
            }
          }}
          onBlur={() => {
            if (value.trim()) resolve(value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (value.trim()) resolve(value);
            }
          }}
          placeholder={placeholder}
          className={`w-full rounded-md border px-3 py-2 text-sm pr-10 transition-colors ${
            isResolved
              ? 'border-emerald-400 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-200 bg-emerald-50/40'
              : isError
                ? 'border-red-400 focus:border-red-500 focus:ring-1 focus:ring-red-200 bg-red-50/30'
                : 'border-gray-300 focus:border-gray-400 focus:ring-1 focus:ring-gray-200'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-gray-500" />}
          {isResolved && (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />
          )}
          {isError && <XCircle className="h-5 w-5 text-red-600" aria-hidden />}
        </div>
      </div>

      {helpText && isIdle && (
        <p className="text-[11px] text-gray-500 leading-snug">{helpText}</p>
      )}

      {isResolved && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm">
          <div className="flex items-start gap-2.5 min-w-0">
            <UserCircle2 className="h-5 w-5 shrink-0 text-emerald-700 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-emerald-900 truncate">
                {fullName(state.student)}
              </div>
              <div className="text-xs text-emerald-800 flex flex-wrap gap-x-2.5 gap-y-0.5 mt-0.5">
                {state.student.matricNumber && (
                  <span className="font-mono">{state.student.matricNumber}</span>
                )}
                {state.student.academicLevel != null && (
                  <span>{fmtLevel(state.student.academicLevel)}</span>
                )}
                {state.student.programme && <span>{state.student.programme}</span>}
                {state.student.department && (
                  <span className="opacity-80">Dept: {state.student.department}</span>
                )}
              </div>
              <div className="text-[11px] text-emerald-700 mt-0.5 truncate">
                {state.student.email}
                {state.student.status && state.student.status !== 'ACTIVE' && (
                  <span className="ml-2 font-medium uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 rounded">
                    {state.student.status}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {state.message}
        </div>
      )}
    </div>
  );
};

export default MatricStudentInput;
