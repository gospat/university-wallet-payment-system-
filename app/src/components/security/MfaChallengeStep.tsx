import React, { useEffect, useRef, useState } from 'react';
import api, { apiErrorMessage } from '../../services/api';
import { ShieldCheck, Loader2, ArrowLeft, KeyRound, RefreshCw } from 'lucide-react';

/**
 * SECOND-FACTOR (TOTP) CHALLENGE STEP — shared by all three login pages.
 * ---------------------------------------------------------------------------
 * The password step returned `{ mfaRequired: true, challengeToken }` instead of a
 * session, so no access token and no refresh cookie exist yet. This step POSTs
 * the one-time code (or a recovery code) plus the short-lived challenge token to
 * the PUBLIC endpoint `POST /auth/mfa/challenge`. ONLY on a verified second
 * factor does the server mint the real session (access token + HttpOnly refresh
 * cookie), which the parent login page then installs via `useAuth().login()`.
 *
 * The challenge token is single-use and expires after 5 minutes: a failed code
 * consumes it, so a failed attempt must send the user back to re-enter their
 * password rather than silently retrying the same token.
 */

export type MfaLoginVariant = 'brand' | 'admin' | 'bursary';

interface Props {
  /** Short-lived, single-use token proving the password step passed. */
  challengeToken: string;
  /** Called with the freshly minted session once the second factor verifies. */
  onVerified: (result: { token: string; user: any; expiresInMs?: number }) => void;
  /** Return to the password form (the challenge token has been consumed/failed). */
  onBack: () => void;
  /** Visual theme matching the hosting login page. */
  variant?: MfaLoginVariant;
  /** Optional masked account hint (e.g. "a•••@bellsuniversity.edu.ng"). */
  accountHint?: string;
}

interface VariantTheme {
  icon: string;
  iconRing: string;
  heading: string;
  subtext: string;
  input: string;
  label: string;
  button: string;
  link: string;
  error: string;
  idleRing: string;
}

const THEMES: Record<MfaLoginVariant, VariantTheme> = {
  brand: {
    icon: 'text-blue-600',
    iconRing: 'bg-blue-100',
    heading: 'text-gray-900',
    subtext: 'text-gray-500',
    input:
      'border-gray-300 bg-white text-gray-900 focus:ring-blue-500 focus:border-blue-500',
    label: 'text-gray-700',
    button:
      'bg-[var(--brand-primary,#0e74cc)] hover:bg-[var(--brand-primary-hover,#0b64b0)] text-white shadow-blue-200',
    link: 'text-[var(--brand-primary,#0e74cc)] hover:text-blue-800',
    error: 'bg-red-50 text-red-600 border-red-100',
    idleRing: 'border-gray-200',
  },
  admin: {
    icon: 'text-green-400',
    iconRing: 'bg-gray-700 border border-gray-600',
    heading: 'text-white',
    subtext: 'text-gray-400',
    input:
      'border-gray-600 bg-gray-700 text-white placeholder-gray-500 focus:ring-green-500 focus:border-green-500',
    label: 'text-gray-300',
    button: 'bg-green-600 hover:bg-green-700 text-white shadow-green-900/20',
    link: 'text-green-400 hover:text-green-300',
    error: 'bg-red-900/30 text-red-400 border-red-900/50',
    idleRing: 'border-green-500',
  },
  bursary: {
    icon: 'text-amber-600',
    iconRing: 'bg-amber-100 border border-amber-200',
    heading: 'text-gray-900',
    subtext: 'text-gray-500',
    input:
      'border-gray-300 bg-white text-gray-900 focus:ring-amber-500 focus:border-amber-500',
    label: 'text-gray-700',
    button: 'bg-amber-600 hover:bg-amber-700 text-white shadow-amber-200',
    link: 'text-amber-700 hover:text-amber-900',
    error: 'bg-red-50 text-red-600 border-red-100',
    idleRing: 'border-amber-200',
  },
};

const MfaChallengeStep: React.FC<Props> = ({
  challengeToken,
  onVerified,
  onBack,
  variant = 'brand',
  accountHint,
}) => {
  const t = THEMES[variant];
  const [code, setCode] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [recoveryMode]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    const value = code.trim();
    if (!value) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/auth/mfa/challenge', {
        challengeToken,
        code: value,
      });
      const token = res?.data?.token ?? res?.data?.accessToken;
      const user = res?.data?.data?.user;
      if (!token || !user) {
        setError('Verification succeeded but the session could not be started. Please log in again.');
        return;
      }
      onVerified({ token, user, expiresInMs: res?.data?.expiresInMs });
    } catch (err: any) {
      // 401 → wrong/expired/replayed code (the token is now consumed);
      // 429 → locked out; 503 → replay-protection store down.
      setError(
        apiErrorMessage(
          err,
          'That code was not accepted. Please try again or use a recovery code.',
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="text-center mb-2">
      <div
        className={`p-3 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4 ${t.iconRing}`}
      >
        <ShieldCheck className={`h-8 w-8 ${t.icon}`} />
      </div>
      <h1 className={`text-2xl font-bold ${t.heading}`}>Two-factor verification</h1>
      <p className={`${t.subtext} mt-2 text-sm leading-relaxed`}>
        {recoveryMode
          ? 'Enter one of the recovery codes you saved when you enabled two-factor authentication.'
          : 'Enter the 6-digit code from your authenticator app to finish signing in.'}
      </p>
      {accountHint && !recoveryMode && (
        <p className={`${t.subtext} mt-1 text-xs`}>
          Signing in as <span className="font-semibold">{accountHint}</span>
        </p>
      )}

      {error && (
        <div
          role="alert"
          className={`mt-5 text-sm p-4 rounded-lg border text-left ${t.error}`}
        >
          {error}
        </div>
      )}

      <form onSubmit={submit} className="mt-6 space-y-5 text-left">
        <div>
          <label className={`block text-sm font-medium mb-2 ${t.label}`}>
            {recoveryMode ? 'Recovery code' : 'Authentication code'}
          </label>
          <input
            ref={inputRef}
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={recoveryMode ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoCapitalize={recoveryMode ? 'characters' : 'off'}
            spellCheck={false}
            maxLength={recoveryMode ? 24 : 6}
            placeholder={recoveryMode ? 'XXXXX-XXXXX' : '••••••'}
            className={`w-full px-4 py-3 border rounded-lg outline-none transition-all text-center tracking-[0.5em] font-mono text-lg ${t.input}`}
            disabled={loading}
          />
        </div>

        <button
          type="submit"
          disabled={loading || !code.trim()}
          className={`w-full font-bold py-3 rounded-lg transition-all transform hover:scale-[1.02] active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed shadow-lg ${t.button}`}
        >
          <span className="inline-flex items-center justify-center gap-2">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Verifying…
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4" />
                Verify &amp; continue
              </>
            )}
          </span>
        </button>
      </form>

      <div className="mt-5 flex flex-col sm:flex-row items-center justify-center gap-3 text-sm">
        <button
          type="button"
          onClick={() => {
            setRecoveryMode((m) => !m);
            setCode('');
            setError('');
          }}
          className={`inline-flex items-center gap-1.5 font-medium transition ${t.link}`}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {recoveryMode ? 'Use authenticator code' : 'Use a recovery code'}
        </button>
        <span className={`hidden sm:inline ${t.subtext}`}>·</span>
        <button
          type="button"
          onClick={onBack}
          className={`inline-flex items-center gap-1.5 font-medium transition ${t.link}`}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to login
        </button>
      </div>
    </div>
  );
};

MfaChallengeStep.displayName = 'MfaChallengeStep';

export default MfaChallengeStep;
