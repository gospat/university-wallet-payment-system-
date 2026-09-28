import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, CheckCircle2, ArrowLeft, AlertTriangle, KeyRound, ShieldAlert } from 'lucide-react';
import api from '../../services/api';
import UniversityLogo from '../../components/ui/UniversityLogo';
import PasswordInput, { scorePassword } from '../../components/ui/PasswordInput';

const ResetPasswordPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const navigate = useNavigate();

  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiredError, setExpiredError] = useState<boolean>(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) {
      setExpiredError(true);
    }
  }, [token]);

  const score = useMemo(() => scorePassword(newPw), [newPw]);
  const mismatch = confirmPw.length > 0 && confirmPw !== newPw;
  const matchOk = confirmPw.length > 0 && confirmPw === newPw;
  const canSubmit =
    !submitting &&
    !!token &&
    newPw.length >= 8 &&
    confirmPw.length >= 8 &&
    confirmPw === newPw &&
    !success;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setExpiredError(false);
    setSubmitting(true);
    try {
      await api.post('/auth/reset-password', {
        token,
        newPassword: newPw,
        confirmPassword: confirmPw,
      });
      setSuccess(true);
    } catch (err: any) {
      const status = Number(err?.response?.status || 0);
      const msg = err?.response?.data?.message || err?.message || 'Could not reset password. Please try again.';
      if (status === 409) {
        setExpiredError(true);
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-sky-100 px-4 py-8">
        <div className="max-w-md w-full">
          <div className="flex justify-center mb-6">
            <Link to="/" className="inline-flex items-center gap-3">
              <UniversityLogo size="lg" showName />
            </Link>
          </div>
          <div className="bg-white rounded-2xl shadow-xl p-8 border border-blue-50 text-center">
            <div className="mx-auto w-20 h-20 rounded-full bg-emerald-50 border-4 border-emerald-100 flex items-center justify-center mb-6">
              <CheckCircle2 className="w-10 h-10 text-emerald-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Password updated</h1>
            <p className="text-gray-500 mt-2 text-sm leading-relaxed">
              Your new password is active. You can now log in using your email address and the
              password you just created.
            </p>
            <button
              type="button"
              onClick={() => navigate('/student/login')}
              className="mt-7 w-full inline-flex items-center justify-center gap-2 bg-[var(--brand-primary,#0e74cc)] hover:bg-[var(--brand-primary-hover,#0b64b0)] text-white font-bold py-3 rounded-lg transition shadow-lg shadow-blue-200"
            >
              <KeyRound className="w-4 h-4" />
              Go to Student Login
            </button>
          </div>
          <p className="text-center text-xs text-gray-500 mt-6">
            &copy; {new Date().getFullYear()} Bells University of Technology. All rights reserved.
          </p>
        </div>
      </div>
    );
  }

  if (expiredError && !submitting && !error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-sky-100 px-4 py-8">
        <div className="max-w-md w-full">
          <div className="flex justify-center mb-6">
            <Link to="/" className="inline-flex items-center gap-3">
              <UniversityLogo size="lg" showName />
            </Link>
          </div>
          <div className="bg-white rounded-2xl shadow-xl p-8 border border-amber-100">
            <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200 mb-6">
              <ShieldAlert className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
              <div className="text-[13px] text-amber-900 leading-relaxed">
                <div className="font-semibold mb-0.5">Link expired or already used</div>
                <div>
                  This password reset link is no longer valid. It may have expired after
                  15 minutes or was already used to set a new password.
                </div>
                <div className="mt-2 text-amber-800/90">
                  Please request a new password reset link below.
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => navigate('/forgot-password')}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--brand-primary,#0e74cc)] hover:bg-[var(--brand-primary-hover,#0b64b0)] text-white text-sm font-semibold shadow-sm transition"
              >
                <KeyRound className="w-4 h-4" />
                Request new reset link
              </button>
              <Link
                to="/student/login"
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-semibold transition"
              >
                <ArrowLeft className="w-4 h-4" /> Back to login
              </Link>
            </div>
          </div>
          <p className="text-center text-xs text-gray-500 mt-6">
            &copy; {new Date().getFullYear()} Bells University of Technology. All rights reserved.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-sky-100 px-4 py-8">
      <div className="max-w-md w-full">
        <div className="flex justify-center mb-6">
          <Link to="/" className="inline-flex items-center gap-3">
            <UniversityLogo size="lg" showName />
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8 border border-blue-50">
          <div className="mb-5">
            <Link
              to="/student/login"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to login
            </Link>
          </div>

          <div className="mb-6">
            <div className="flex items-start gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary,#0e74cc)] bg-opacity-10 flex items-center justify-center shrink-0">
                <KeyRound className="w-5 h-5 text-[var(--brand-primary,#0e74cc)]" />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold text-gray-900">Set a new password</h1>
                <p className="text-gray-500 mt-1 text-sm leading-relaxed">
                  Create a strong, unique password for your Bells University account.
                  Your password must be at least 8 characters long.
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-800 leading-relaxed mb-5">
              <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={submit} className="space-y-5">
            <PasswordInput
              label="New Password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              autoComplete="new-password"
              placeholder="At least 8 characters with mixed case, digits and symbols"
              strength={score.level}
              showStrengthBar
              strengthHint={score.hint ?? null}
              inputClassName="px-3 py-3"
            />

            <PasswordInput
              label="Confirm New Password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              autoComplete="new-password"
              placeholder="Re-type the same new password"
              matchOk={matchOk}
              mismatch={mismatch}
              strengthHint={
                confirmPw
                  ? confirmPw === newPw
                    ? undefined
                    : 'Passwords do not match.'
                  : null
              }
              inputClassName="px-3 py-3"
            />

            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-700 leading-relaxed">
              <div className="font-semibold mb-0.5 text-slate-800">Password tips</div>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>Use a mix of uppercase and lowercase letters</li>
                <li>Include at least one digit and one symbol (e.g. !, @, #, $)</li>
                <li>Avoid common passwords and personal information</li>
              </ul>
            </div>

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full inline-flex items-center justify-center gap-2 bg-[var(--brand-primary,#0e74cc)] hover:bg-[var(--brand-primary-hover,#0b64b0)] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3 rounded-lg transition-all transform hover:scale-[1.01] active:scale-[0.99] shadow-lg shadow-blue-200"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Updating password…
                </>
              ) : (
                <>
                  <KeyRound className="w-4 h-4" />
                  Update password
                </>
              )}
            </button>

            {mismatch && (
              <p className="text-center text-[11px] text-red-600 font-medium">
                Passwords do not match — please fix them before submitting.
              </p>
            )}
          </form>
        </div>

        <p className="text-center text-xs text-gray-500 mt-6">
          &copy; {new Date().getFullYear()} Bells University of Technology. All rights reserved.
        </p>
      </div>
    </div>
  );
};

ResetPasswordPage.displayName = 'ResetPasswordPage';

export default ResetPasswordPage;
