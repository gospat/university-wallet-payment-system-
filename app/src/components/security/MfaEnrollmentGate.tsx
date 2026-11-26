import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import MfaEnrollmentPanel from './MfaEnrollmentPanel';
import { ShieldAlert, Loader2, LogOut } from 'lucide-react';

/**
 * MANDATORY TWO-FACTOR ENROLMENT GATE
 * ---------------------------------------------------------------------------
 * Mirrors `ForcePasswordChangeGate`: when the MFA policy REQUIRES this account's
 * role to hold a second factor and it has not yet enrolled, the whole
 * application is replaced by a blocking enrolment screen.
 *
 * Server authority: this gate is a UX convenience only. The API independently
 * refuses every non-self-service route for an enforced-but-unenrolled account
 * with `403 MFA_ENROLLMENT_REQUIRED`, and `/auth/mfa/*` is the only surface
 * mounted behind the authentication-only middleware so enrolment remains
 * reachable. If the status probe fails transiently the gate FAILS OPEN — the
 * server still enforces the boundary — so a brief network error cannot lock a
 * legitimate user out of their own portal.
 */
const MfaEnrollmentGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token, user, logout } = useAuth();
  const [required, setRequired] = useState(false);
  const [resolved, setResolved] = useState(false);

  const evaluate = useCallback(async () => {
    if (!token) {
      setRequired(false);
      setResolved(true);
      return;
    }
    try {
      const res = await api.get('/auth/mfa/status');
      const data = res?.data?.data as
        | { enabled?: boolean; required?: boolean }
        | undefined;
      setRequired(Boolean(data?.required) && !data?.enabled);
    } catch {
      // Fail open: the backend enforces enrolment on every protected route.
      setRequired(false);
    } finally {
      setResolved(true);
    }
  }, [token]);

  useEffect(() => {
    void evaluate();
  }, [evaluate, user?.id]);

  // Only the FIRST resolution for a fresh session blanks the UI, so a silent
  // token refresh never flashes a loader over an already-rendered portal.
  if (token && !resolved) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="inline-flex items-center gap-3 text-sm text-gray-500 bg-white rounded-xl px-5 py-3 border border-gray-200 shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
          <span className="font-medium">Checking account security…</span>
        </div>
      </div>
    );
  }

  if (!required) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[9998] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto">
      <div className="relative w-full max-w-2xl my-auto">
        <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden">
          <div className="px-8 pt-8 pb-6 bg-gradient-to-r from-indigo-600 via-blue-600 to-cyan-600">
            <div className="flex items-start gap-4">
              <div className="w-14 h-14 rounded-2xl bg-white/15 backdrop-blur flex items-center justify-center shrink-0 border border-white/20">
                <ShieldAlert className="w-7 h-7 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-xl font-extrabold text-white tracking-tight">
                  Action required — secure your account
                </h2>
                <p className="text-sm text-indigo-100 mt-1 leading-relaxed">
                  Two-factor authentication is required for {user?.role === 'BURSARY' ? 'Bursary' : 'your'}{' '}
                  staff accounts. Set it up now to continue to the portal.
                </p>
              </div>
            </div>
          </div>

          <div className="p-6">
            <MfaEnrollmentPanel dense onEnabled={() => setRequired(false)} />
          </div>

          <div className="px-6 pb-6">
            <button
              type="button"
              onClick={() => logout('LOGOUT')}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-500 hover:text-gray-700"
            >
              <LogOut className="h-4 w-4" /> Log out
            </button>
          </div>
        </div>

        <div className="mt-5 text-center text-[11px] text-slate-300">
          Need help? Contact your administrator or the IT support team.
        </div>
      </div>
    </div>
  );
};

MfaEnrollmentGate.displayName = 'MfaEnrollmentGate';

export default MfaEnrollmentGate;
