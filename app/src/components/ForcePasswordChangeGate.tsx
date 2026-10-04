import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import {
  ShieldAlert,
  Lock,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Loader2,
  LogOut,
  KeyRound,
} from 'lucide-react';

const StrengthBar: React.FC<{ score: number }> = ({ score }) => {
  const widths = ['w-1/4', 'w-2/4', 'w-3/4', 'w-full'];
  const colors = ['bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-emerald-500'];
  const idx = Math.max(0, Math.min(3, score - 1));
  return (
    <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
      <div className={`h-full transition-all duration-300 ${score > 0 ? widths[idx] + ' ' + colors[idx] : 'w-0'}`} />
    </div>
  );
};

const scorePassword = (p: string): { score: number; label: string; hint?: string } => {
  if (!p) return { score: 0, label: 'Empty' };
  let s = 0;
  if (p.length >= 8) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  if (s === 1) return { score: s, label: 'Weak', hint: 'Add more variety (uppercase, digits, symbols)' };
  if (s === 2) return { score: s, label: 'Fair', hint: 'Mix in a digit or symbol' };
  if (s === 3) return { score: s, label: 'Good' };
  return { score: s, label: 'Strong' };
};

export const ForcePasswordChangeGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, token, logout, clearMustChangePassword } = useAuth();
  const blocked = user?.role === 'STUDENT' && user?.mustChangePassword === true && !!token;

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConf, setShowConf] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (!blocked) {
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
      setShowCur(false); setShowNew(false); setShowConf(false);
      setFormErr(null); setSuccess(false); submittedRef.current = false;
    }
  }, [blocked]);

  const newScore = scorePassword(newPw);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittedRef.current) return;
    setFormErr(null);

    if (!currentPw.trim()) {
      setFormErr('Enter your current (temporary) password.');
      return;
    }
    if (newPw.length < 8) {
      setFormErr('New password must be at least 8 characters.');
      return;
    }
    if (newScore.score < 2) {
      setFormErr('New password is too weak — add uppercase + digits or symbols.');
      return;
    }
    if (newPw !== confirmPw) {
      setFormErr('New passwords do not match.');
      return;
    }
    if (newPw === currentPw) {
      setFormErr('New password must differ from your temporary password.');
      return;
    }

    submittedRef.current = true;
    setSubmitting(true);
    try {
      await api.patch('/auth/change-password', {
        currentPassword: currentPw,
        newPassword: newPw,
      });
      clearMustChangePassword();
      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
      }, 2500);
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ||
        err?.message ||
        'Could not change password — please try again.';
      setFormErr(msg);
    } finally {
      setSubmitting(false);
      submittedRef.current = false;
    }
  };

  if (!blocked) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[9999] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 opacity-40 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/60 via-transparent to-transparent pointer-events-none" />

      <div className="relative w-full max-w-lg">
        <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden">
          <div className="px-8 pt-8 pb-6 bg-gradient-to-r from-indigo-600 via-blue-600 to-cyan-600 -mx-1 -mt-1 mb-0">
            <div className="flex items-start gap-4">
              <div className="w-14 h-14 rounded-2xl bg-white/15 backdrop-blur flex items-center justify-center shrink-0 border border-white/20">
                <KeyRound className="w-7 h-7 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-xl font-extrabold text-white tracking-tight">
                  Action required — set your password
                </h2>
                <p className="text-sm text-indigo-100 mt-1 leading-relaxed">
                  Hi {user?.firstName ?? 'there'}, an admin recently reset your password.
                  For security, you <strong>must</strong> choose a new personal password
                  before you can access anything else.
                </p>
              </div>
            </div>
          </div>

          {success ? (
            <div className="px-8 py-12 space-y-5 text-center">
              <div className="mx-auto w-20 h-20 rounded-full bg-emerald-50 border-4 border-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-600" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-gray-900">
                  Password updated
                </div>
                <div className="text-sm text-gray-600 mt-1">
                  Taking you to your dashboard…
                </div>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="px-8 py-7 space-y-5">
              <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200">
                <ShieldAlert className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
                <div className="text-[12px] text-amber-900 leading-relaxed">
                  <div className="font-semibold mb-0.5">You are locked until this is done</div>
                  All portals, payments, and receipts are hidden. Logout is always available below.
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-bold text-gray-800 flex items-center gap-1">
                  <Lock className="w-3.5 h-3.5" />
                  Temporary password
                </label>
                <div className="relative">
                  <input
                    type={showCur ? 'text' : 'password'}
                    value={currentPw}
                    autoFocus
                    onChange={(e) => setCurrentPw(e.target.value)}
                    placeholder="Paste or type the password given to you"
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-300 pr-12 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCur((s) => !s)}
                    className="absolute inset-y-0 right-2 flex items-center px-2 text-gray-500 hover:text-gray-700"
                    tabIndex={-1}
                  >
                    {showCur ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-bold text-gray-800 flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    <KeyRound className="w-3.5 h-3.5" />
                    New password
                  </span>
                  <span className={`text-[11px] font-semibold uppercase tracking-wide ${
                    newScore.score === 0 ? 'text-gray-400' :
                    newScore.score === 1 ? 'text-red-600' :
                    newScore.score === 2 ? 'text-orange-600' :
                    newScore.score === 3 ? 'text-amber-600' :
                    'text-emerald-600'
                  }`}>
                    {newScore.label}
                  </span>
                </label>
                <div className="relative">
                  <input
                    type={showNew ? 'text' : 'password'}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    placeholder="At least 8 chars with uppercase, digit, symbol"
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-300 pr-12 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((s) => !s)}
                    className="absolute inset-y-0 right-2 flex items-center px-2 text-gray-500 hover:text-gray-700"
                    tabIndex={-1}
                  >
                    {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <StrengthBar score={newScore.score} />
                {newPw && newScore.hint && (
                  <p className="text-[11px] text-gray-500">{newScore.hint}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-bold text-gray-800 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Confirm new password
                </label>
                <div className="relative">
                  <input
                    type={showConf ? 'text' : 'password'}
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    placeholder="Re-type the same new password"
                    className={`w-full px-4 py-2.5 rounded-xl border pr-12 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
                      confirmPw
                        ? confirmPw === newPw
                          ? 'border-emerald-300 focus:border-emerald-400'
                          : 'border-red-300 focus:border-red-400'
                        : 'border-gray-300 focus:border-indigo-400'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConf((s) => !s)}
                    className="absolute inset-y-0 right-2 flex items-center px-2 text-gray-500 hover:text-gray-700"
                    tabIndex={-1}
                  >
                    {showConf ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {confirmPw && (
                  confirmPw === newPw ? (
                    <div className="flex items-center gap-1 text-[11px] text-emerald-600 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Passwords match
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-[11px] text-red-600 font-medium">
                      <XCircle className="w-3.5 h-3.5" /> Passwords do not match
                    </div>
                  )
                )}
              </div>

              {formErr && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-[12px] text-red-800 leading-relaxed">
                  <XCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                  <div className="whitespace-pre-line">{formErr}</div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => logout('LOGOUT')}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold text-gray-600 hover:text-gray-800 hover:bg-gray-100 transition"
                >
                  <LogOut className="w-4 h-4" />
                  Log out
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-50 text-white text-sm font-bold shadow-sm shadow-indigo-200 transition"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Updating…
                    </>
                  ) : (
                    <>
                      <Lock className="w-4 h-4" />
                      Update password
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="mt-5 text-center text-[11px] text-slate-300">
          Need help? Contact the Bursary or Admin team for assistance.
        </div>
      </div>
    </div>
  );
};

export default ForcePasswordChangeGate;
