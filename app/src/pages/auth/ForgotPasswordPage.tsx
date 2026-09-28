import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Mail, ArrowLeft, CheckCircle2 } from 'lucide-react';
import api from '../../services/api';
import UniversityLogo from '../../components/ui/UniversityLogo';

const ForgotPasswordPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || success) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post('/auth/forgot-password', { email: email.trim() });
      void res;
      setSuccess(true);
    } catch (err: any) {
      setError(
        err?.response?.data?.message ||
        err?.message ||
        'Could not process request. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-sky-100 px-4 py-8">
      <div className="max-w-md w-full">
        <div className="flex justify-center mb-6">
          <Link to="/" className="inline-flex items-center gap-3">
            <UniversityLogo size="lg" showName nameVariant="brand" />
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8 border border-blue-50">
          <div className="mb-6">
            <Link
              to="/student/login"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to login
            </Link>
          </div>

          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900">Forgot your password?</h1>
            <p className="text-gray-500 mt-1.5 text-sm leading-relaxed">
              Enter your registered email address and we&apos;ll send you a secure link
              to create a new password.
            </p>
          </div>

          {success ? (
            <div className="space-y-5">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-emerald-50 border border-emerald-200">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
                <div className="text-[13px] text-emerald-900 leading-relaxed">
                  <div className="font-semibold mb-0.5">Check your inbox</div>
                  <div>
                    If <strong>{email || 'your email'}</strong> is registered in the system,
                    a password reset link has been sent to it.
                  </div>
                  <div className="mt-2 text-emerald-800/90">
                    The link will expire in 15 minutes. Please also check your spam or
                    promotions folder if you do not see it within a few minutes.
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => navigate('/student/login')}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--brand-primary,#0e74cc)] hover:bg-[var(--brand-primary-hover,#0b64b0)] text-white text-sm font-semibold shadow-sm transition"
                >
                  Return to login
                </button>
                <button
                  type="button"
                  onClick={() => { setSuccess(false); setEmail(''); setError(null); }}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-semibold transition"
                >
                  Send another request
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <div className="space-y-1.5">
                <label htmlFor="fpw-email" className="block text-sm font-medium text-gray-700">
                  Registered Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    id="fpw-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@bellsuniversity.edu.ng"
                    autoComplete="email"
                    autoFocus
                    required
                    className="w-full pl-10 pr-4 py-3 rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition shadow-sm"
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 leading-relaxed">
                  <span className="font-semibold shrink-0 mt-0.5">⚠️</span>
                  <span>{error}</span>
                </div>
              )}

              <div className="rounded-lg bg-blue-50 border border-blue-100 p-3 text-xs text-blue-900 leading-relaxed">
                <div className="font-semibold mb-0.5">Security note</div>
                To protect your account, we will never tell you whether an email exists in
                our system or not. No email will be sent for unregistered addresses.
              </div>

              <button
                type="submit"
                disabled={submitting || !email.trim()}
                className="w-full inline-flex items-center justify-center gap-2 bg-[var(--brand-primary,#0e74cc)] hover:bg-[var(--brand-primary-hover,#0b64b0)] disabled:opacity-60 disabled:cursor-not-allowed text-white font-bold py-3 rounded-lg transition-all transform hover:scale-[1.01] active:scale-[0.99] shadow-lg shadow-blue-200"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending reset link…
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4" />
                    Send password reset link
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-gray-500 mt-6">
          &copy; {new Date().getFullYear()} Bells University of Technology. All rights reserved.
        </p>
      </div>
    </div>
  );
};

ForgotPasswordPage.displayName = 'ForgotPasswordPage';

export default ForgotPasswordPage;
