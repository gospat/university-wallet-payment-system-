import React, { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import api, { apiErrorMessage } from '../../services/api';
import {
  ShieldCheck,
  ShieldOff,
  Loader2,
  Copy,
  Check,
  KeyRound,
  Smartphone,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Download,
} from 'lucide-react';

/**
 * TWO-FACTOR AUTHENTICATION MANAGEMENT PANEL
 * ---------------------------------------------------------------------------
 * Self-service MFA surface backed by the authenticated endpoints (mounted behind
 * `protectSelfService`, so a staff account that is REQUIRED to enrol but has not
 * yet done so can still reach it):
 *   • GET  /auth/mfa/status                          — current state
 *   • POST /auth/mfa/setup                           — generate a pending secret
 *   • POST /auth/mfa/enable          { code }        — confirm + issue recovery codes
 *   • POST /auth/mfa/disable         { password }    — remove the factor (refused
 *                                                       by the server when the
 *                                                       account is REQUIRED to keep one)
 *   • POST /auth/mfa/recovery-codes/regenerate { password }
 *
 * The TOTP secret is displayed ONLY while enrolling (as a QR code and a manual
 * key) and is never persisted client-side. Recovery codes are shown ONCE, after
 * which the server stores only bcrypt hashes.
 */

type MfaEnforcement = 'staff' | 'all' | 'off';

export interface MfaStatusData {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
  required: boolean;
  enforcement: MfaEnforcement;
}

interface SetupData {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  digits: number;
  period: number;
}

interface Props {
  /** Called after the factor is switched on (so a host gate can unblock). */
  onEnabled?: () => void;
  /** Called after the factor is switched off. */
  onDisabled?: () => void;
  /** Compact spacing for embedding into the blocking enrolment gate. */
  dense?: boolean;
}

type Phase = 'loading' | 'ready' | 'error';

const formatManualKey = (secret: string): string =>
  (secret.match(/.{1,4}/g) ?? [secret]).join(' ');

const formatDateTime = (value?: string | null): string => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const MfaEnrollmentPanel: React.FC<Props> = ({ onEnabled, onDisabled, dense }) => {
  const [status, setStatus] = useState<MfaStatusData | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [setup, setSetup] = useState<SetupData | null>(null);
  const [enableCode, setEnableCode] = useState('');
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const [proofPassword, setProofPassword] = useState('');
  const [pendingAction, setPendingAction] = useState<'none' | 'disable' | 'regenerate'>('none');

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<'secret' | 'codes' | null>(null);

  const loadStatus = useCallback(async () => {
    setPhase('loading');
    setLoadError(null);
    try {
      const res = await api.get('/auth/mfa/status');
      setStatus((res?.data?.data ?? null) as MfaStatusData | null);
      setPhase('ready');
    } catch (err: any) {
      setLoadError(apiErrorMessage(err, 'Unable to load your two-factor settings.'));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const copy = async (text: string, kind: 'secret' | 'codes') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      /* clipboard unavailable — the value stays selectable on screen */
    }
  };

  const handleStartSetup = async () => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await api.post('/auth/mfa/setup', {});
      setSetup((res?.data?.data ?? null) as SetupData | null);
      setEnableCode('');
    } catch (err: any) {
      setActionError(apiErrorMessage(err, 'Could not start two-factor setup. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const handleEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const code = enableCode.trim();
    if (!code) {
      setActionError('Enter the 6-digit code shown in your authenticator app.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.post('/auth/mfa/enable', { code });
      const codes: string[] = res?.data?.data?.recoveryCodes ?? [];
      setNewCodes(codes);
      setSetup(null);
      setEnableCode('');
      setStatus((prev) => (prev ? { ...prev, enabled: true, recoveryCodesRemaining: codes.length } : prev));
    } catch (err: any) {
      setActionError(apiErrorMessage(err, 'That code was not accepted. Check your device clock and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const handleProofSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || pendingAction === 'none') return;
    if (!proofPassword.trim()) {
      setActionError('Enter your current password to continue.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      if (pendingAction === 'disable') {
        await api.post('/auth/mfa/disable', { password: proofPassword });
        setProofPassword('');
        setPendingAction('none');
        setNotice('Two-factor authentication has been disabled.');
        await loadStatus();
        onDisabled?.();
      } else {
        const res = await api.post('/auth/mfa/recovery-codes/regenerate', { password: proofPassword });
        const codes: string[] = res?.data?.data?.recoveryCodes ?? [];
        setProofPassword('');
        setPendingAction('none');
        setNewCodes(codes);
        setStatus((prev) => (prev ? { ...prev, recoveryCodesRemaining: codes.length } : prev));
      }
    } catch (err: any) {
      setActionError(apiErrorMessage(err, 'The operation could not be completed. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const finishRecoveryView = () => {
    setNewCodes(null);
    setNotice('Two-factor authentication is active. Store your recovery codes somewhere safe.');
    onEnabled?.();
  };

  const downloadCodes = () => {
    if (!newCodes) return;
    const body = [
      'Bells University Payment Portal — two-factor recovery codes',
      `Generated: ${new Date().toISOString()}`,
      'Each code can be used once. Keep them somewhere safe and offline.',
      '',
      ...newCodes,
      '',
    ].join('\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bells-mfa-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const cardPad = dense ? 'p-5' : 'p-6';

  // ---------------------------------------------------------------- loading
  if (phase === 'loading') {
    return (
      <div className={`bg-white border border-gray-100 rounded-2xl shadow-sm ${cardPad}`}>
        <div className="h-24 flex items-center justify-center gap-2 text-gray-400 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading two-factor settings…
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className={`bg-white border border-red-100 rounded-2xl shadow-sm ${cardPad}`}>
        <div className="flex items-start gap-3">
          <XCircle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700">
            <p className="font-semibold">Two-factor settings unavailable</p>
            <p className="mt-0.5">{loadError}</p>
            <button
              type="button"
              onClick={loadStatus}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-red-700 hover:text-red-900"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------- recovery codes (once)
  if (newCodes) {
    const codesText = newCodes.join('\n');
    return (
      <div className={`bg-white border border-gray-100 rounded-2xl shadow-sm ${cardPad}`}>
        <header className="mb-4">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" /> Save your recovery codes
          </h3>
          <p className="text-sm text-gray-600 mt-1 leading-relaxed">
            These one-time codes let you sign in if you ever lose access to your authenticator
            app. Each code works once. <strong>They will not be shown again.</strong>
          </p>
        </header>

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="grid grid-cols-2 gap-2 font-mono text-sm text-gray-800">
            {newCodes.map((code) => (
              <span key={code} className="select-all tracking-wider">{code}</span>
            ))}
          </div>
        </div>

        {actionError && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {actionError}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => copy(codesText, 'codes')}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            {copied === 'codes' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            {copied === 'codes' ? 'Copied' : 'Copy codes'}
          </button>
          <button
            type="button"
            onClick={downloadCodes}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            <Download className="h-4 w-4" /> Download .txt
          </button>
          <button
            type="button"
            onClick={finishRecoveryView}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 ml-auto"
          >
            <CheckCircle2 className="h-4 w-4" /> I have saved these codes
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------- setup flow
  if (setup) {
    return (
      <div className={`bg-white border border-gray-100 rounded-2xl shadow-sm ${cardPad}`}>
        <header className="mb-4">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-blue-600" /> Set up your authenticator
          </h3>
          <p className="text-sm text-gray-600 mt-1 leading-relaxed">
            Scan the QR code with an authenticator app (Google Authenticator, Authy, Microsoft
            Authenticator, 1Password), then enter the 6-digit code it shows.
          </p>
        </header>

        <div className="flex flex-col sm:flex-row gap-6 items-start">
          <div className="bg-white border border-gray-200 rounded-xl p-3 shrink-0 mx-auto sm:mx-0">
            <QRCodeSVG value={setup.otpauthUrl} size={172} level="M" marginSize={2} aria-label="Two-factor QR code" />
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
              Can&apos;t scan? Enter this key manually
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono text-gray-800">
                {formatManualKey(setup.secret)}
              </code>
              <button
                type="button"
                onClick={() => copy(setup.secret, 'secret')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                {copied === 'secret' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                {copied === 'secret' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              Account: <span className="font-medium text-gray-700">{setup.issuer}</span> ·
              Type: time-based ({setup.digits} digits, {setup.period}s)
            </p>

            <form onSubmit={handleEnable} className="mt-4 space-y-3">
              <label htmlFor="mfa-enable-code" className="block text-sm font-medium text-gray-700">
                Enter the 6-digit code from your app
              </label>
              <input
                id="mfa-enable-code"
                type="text"
                value={enableCode}
                onChange={(e) => setEnableCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="••••••"
                className="w-full sm:w-48 rounded-lg border border-gray-300 px-4 py-2.5 text-center font-mono text-lg tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                disabled={busy}
              />

              {actionError && (
                <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {actionError}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={busy || !enableCode.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  {busy ? 'Verifying…' : 'Verify & enable'}
                </button>
                <button
                  type="button"
                  onClick={() => { setSetup(null); setEnableCode(''); setActionError(null); }}
                  className="text-sm font-semibold text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------------- enabled
  const enabled = status?.enabled === true;

  return (
    <div className={`bg-white border border-gray-100 rounded-2xl shadow-sm ${cardPad}`}>
      <header className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <ShieldCheck className={`h-5 w-5 ${enabled ? 'text-emerald-600' : 'text-gray-400'}`} />
            Two-Factor Authentication
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            {enabled
              ? 'Your account is protected by a time-based one-time code.'
              : 'Add a second step to your sign-in using an authenticator app.'}
          </p>
        </div>
        <span
          className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
            enabled
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : status?.required
              ? 'bg-red-50 text-red-700 border-red-200'
              : 'bg-gray-100 text-gray-600 border-gray-200'
          }`}
        >
          {enabled ? 'On' : status?.required ? 'Required' : 'Off'}
        </span>
      </header>

      {notice && (
        <div role="status" className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" /> {notice}
        </div>
      )}
      {actionError && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {actionError}
        </div>
      )}

      {enabled ? (
        <>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
              <dt className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Enabled on</dt>
              <dd className="mt-0.5 text-gray-900 font-medium">{formatDateTime(status?.enrolledAt)}</dd>
            </div>
            <div className="bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
              <dt className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Recovery codes left</dt>
              <dd className="mt-0.5 text-gray-900 font-medium">
                {status?.recoveryCodesRemaining ?? 0}
                {typeof status?.recoveryCodesRemaining === 'number' && status.recoveryCodesRemaining <= 2 && (
                  <span className="ml-2 text-xs font-semibold text-amber-700">running low — regenerate</span>
                )}
              </dd>
            </div>
          </dl>

          {pendingAction === 'none' ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => { setPendingAction('regenerate'); setProofPassword(''); setActionError(null); setNotice(null); }}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                <RefreshCw className="h-4 w-4" /> Regenerate recovery codes
              </button>
              {status?.required ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Required for your role — cannot be turned off.
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => { setPendingAction('disable'); setProofPassword(''); setActionError(null); setNotice(null); }}
                  className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50"
                >
                  <ShieldOff className="h-4 w-4" /> Turn off
                </button>
              )}
            </div>
          ) : (
            <form onSubmit={handleProofSubmit} className="mt-5 rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm font-semibold text-gray-800 mb-2">
                {pendingAction === 'disable'
                  ? 'Confirm your password to turn off two-factor authentication'
                  : 'Confirm your password to generate new recovery codes'}
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={proofPassword}
                  onChange={(e) => setProofPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Current password"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  disabled={busy}
                />
                <button
                  type="submit"
                  disabled={busy || !proofPassword.trim()}
                  className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-60 ${
                    pendingAction === 'disable' ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-900 hover:bg-gray-800'
                  }`}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  {pendingAction === 'disable' ? 'Turn off' : 'Regenerate'}
                </button>
                <button
                  type="button"
                  onClick={() => { setPendingAction('none'); setProofPassword(''); setActionError(null); }}
                  className="text-sm font-semibold text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                You can alternatively use a current 6-digit code instead of your password.
              </p>
            </form>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleStartSetup}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {busy ? 'Preparing…' : 'Set up two-factor authentication'}
          </button>
          {status?.required && (
            <span className="inline-flex items-center gap-1.5 text-xs text-red-700">
              <AlertTriangle className="h-3.5 w-3.5" /> Required for your role before you can continue.
            </span>
          )}
        </div>
      )}
    </div>
  );
};

MfaEnrollmentPanel.displayName = 'MfaEnrollmentPanel';

export default MfaEnrollmentPanel;
