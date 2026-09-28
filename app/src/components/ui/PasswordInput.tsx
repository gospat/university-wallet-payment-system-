import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { clsx } from 'clsx';

export type PasswordStrengthLevel = 'weak' | 'fair' | 'good' | 'strong';

export type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type'
> & {
  label?: string;
  labelClassName?: string;
  wrapperClassName?: string;
  inputClassName?: string;
  leadingIcon?: React.ReactNode;
  strength?: PasswordStrengthLevel | null;
  showStrengthBar?: boolean;
  strengthHint?: string | null;
  mismatch?: boolean;
  matchOk?: boolean;
  autoComplete?: 'current-password' | 'new-password' | 'one-time-code' | 'off';
  variant?: 'light' | 'dark';
};

const STRENGTH_META: Record<
  NonNullable<PasswordStrengthLevel>,
  { label: string; barColor: string; textColor: string; width: string }
> = {
  weak: {
    label: 'Weak',
    barColor: 'bg-red-500',
    textColor: 'text-red-600',
    width: 'w-1/4',
  },
  fair: {
    label: 'Fair',
    barColor: 'bg-orange-500',
    textColor: 'text-orange-600',
    width: 'w-2/4',
  },
  good: {
    label: 'Good',
    barColor: 'bg-amber-500',
    textColor: 'text-amber-600',
    width: 'w-3/4',
  },
  strong: {
    label: 'Strong',
    barColor: 'bg-emerald-500',
    textColor: 'text-emerald-600',
    width: 'w-full',
  },
};

export const scorePassword = (p: string): { level: PasswordStrengthLevel | null; score: number; hint?: string } => {
  if (!p) return { level: null, score: 0 };
  let s = 0;
  if (p.length >= 8) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  if (s === 0) return { level: 'weak', score: 1, hint: 'Use at least 8 characters with mixed case.' };
  if (s === 1) return { level: 'weak', score: 1, hint: 'Add uppercase, digits, or symbols for strength.' };
  if (s === 2) return { level: 'fair', score: 2, hint: 'Mix in a digit or symbol.' };
  if (s === 3) return { level: 'good', score: 3 };
  return { level: 'strong', score: 4 };
};

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  (
    {
      label,
      labelClassName,
      wrapperClassName,
      inputClassName,
      leadingIcon,
      strength,
      showStrengthBar = false,
      strengthHint,
      mismatch = false,
      matchOk = false,
      className,
      autoComplete = 'current-password',
      id,
      disabled,
      variant = 'light',
      ...rest
    },
    ref,
  ) => {
    const [visible, setVisible] = useState(false);
    const inputId = id || `pw-${Math.random().toString(36).slice(2, 9)}`;
    const btnId = `${inputId}-toggle`;

    const strengthMeta = strength ? STRENGTH_META[strength] : null;

    const variantStyles =
      variant === 'dark'
        ? {
            input:
              'bg-gray-700 text-white placeholder:text-gray-500 border-gray-600 focus:border-blue-400 focus:ring-blue-500/30',
            leadingIcon: 'text-gray-400',
            label: 'text-gray-300',
            hint: 'text-gray-500',
            strengthBg: 'bg-gray-600',
            eyeBtn: 'text-gray-400 hover:text-gray-200 focus:ring-gray-500',
          }
        : {
            input:
              'bg-white text-gray-900 placeholder-gray-400 border-gray-300 focus:border-blue-500 focus:ring-blue-200',
            leadingIcon: 'text-gray-400',
            label: 'text-gray-700',
            hint: 'text-gray-500',
            strengthBg: 'bg-gray-200',
            eyeBtn: 'text-gray-500 hover:text-gray-700 focus:ring-blue-400',
          };

    const borderOverride = mismatch
      ? variant === 'dark'
        ? '!border-red-400 !focus:border-red-400 !focus:ring-red-500/30'
        : '!border-red-300 !focus:border-red-400 !focus:ring-red-200'
      : matchOk
        ? variant === 'dark'
          ? '!border-emerald-400 !focus:border-emerald-400 !focus:ring-emerald-500/30'
          : '!border-emerald-300 !focus:border-emerald-400 !focus:ring-emerald-200'
        : '';

    return (
      <div className={clsx('space-y-1.5', wrapperClassName)}>
        {label && (
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={inputId}
              className={clsx('block text-sm font-medium', variantStyles.label, labelClassName)}
            >
              {label}
            </label>
            {strengthMeta && (
              <span
                className={clsx(
                  'text-[11px] font-semibold uppercase tracking-wide',
                  strengthMeta.textColor,
                )}
              >
                {strengthMeta.label}
              </span>
            )}
          </div>
        )}
        <div className="relative">
          {leadingIcon && (
            <span
              className={clsx(
                'absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none',
                variantStyles.leadingIcon,
              )}
            >
              {leadingIcon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            type={visible ? 'text' : 'password'}
            autoComplete={autoComplete}
            disabled={disabled}
            aria-describedby={showStrengthBar || strengthHint ? `${inputId}-hint` : undefined}
            className={clsx(
              'w-full py-3 rounded-lg border outline-none transition-all shadow-sm',
              'focus:ring-2 focus:outline-none focus:ring-opacity-50',
              disabled ? 'opacity-60 cursor-not-allowed' : '',
              disabled && variant === 'light' ? 'bg-gray-50' : '',
              disabled && variant === 'dark' ? 'bg-gray-800' : '',
              leadingIcon ? 'pl-10' : 'pl-4',
              'pr-12',
              variantStyles.input,
              borderOverride,
              inputClassName,
              className,
            )}
            {...rest}
          />
          <button
            id={btnId}
            type="button"
            tabIndex={disabled ? -1 : 0}
            onClick={() => setVisible((v) => !v)}
            aria-pressed={visible}
            aria-controls={inputId}
            aria-label={visible ? 'Hide password' : 'Reveal password'}
            disabled={disabled}
            className={clsx(
              'absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 inline-flex items-center justify-center rounded-md',
              'focus:outline-none focus:ring-2 focus:ring-offset-0',
              variantStyles.eyeBtn,
              disabled ? 'opacity-50 cursor-not-allowed' : '',
            )}
          >
            {visible ? <EyeOff className="h-4.5 w-4.5" /> : <Eye className="h-4.5 w-4.5" />}
          </button>
        </div>
        {showStrengthBar && (
          <div
            className={clsx(
              'w-full h-1.5 rounded-full overflow-hidden mt-1',
              variantStyles.strengthBg,
            )}
          >
            <div
              className={clsx('h-full transition-all duration-300', strengthMeta?.barColor ?? 'w-0')}
              style={{ width: strengthMeta ? `${(strengthMeta.width.includes('1/4') ? 25 : strengthMeta.width.includes('2/4') ? 50 : strengthMeta.width.includes('3/4') ? 75 : 100)}%` : '0%' }}
            />
          </div>
        )}
        {(strengthHint || (mismatch && !strengthHint)) && (
          <p
            id={`${inputId}-hint`}
            className={clsx(
              'text-[11px] leading-relaxed',
              mismatch ? 'font-medium' : variantStyles.hint,
              mismatch
                ? variant === 'dark'
                  ? 'text-red-400'
                  : 'text-red-600'
                : undefined,
            )}
          >
            {mismatch ? strengthHint ?? 'Passwords do not match.' : strengthHint}
          </p>
        )}
      </div>
    );
  },
);

PasswordInput.displayName = 'PasswordInput';

export default PasswordInput;
