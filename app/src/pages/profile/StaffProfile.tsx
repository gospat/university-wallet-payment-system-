import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { i18n } from '../../i18n/en';
import api from '../../services/api';
import {
  UserCircle2,
  KeyRound,
  Mail,
  ShieldCheck,
  Clock,
  CalendarClock,
  CheckCircle2,
  XCircle,
  Loader2,
  Lock,
  Info,
} from 'lucide-react';
import PasswordInput, { scorePassword } from '../../components/ui/PasswordInput';

/**
 * Shared self-service "My Profile" page for the STAFF portals (ADMIN + BURSARY).
 * ---------------------------------------------------------------------------
 * Reuses the existing student-profile pattern (app/src/pages/student/Profile.tsx)
 * and the existing authenticated backend surface:
 *   • GET   /auth/me              — current authenticated user (read-only display)
 *   • PATCH /auth/change-password — self-service password change
 *
 * SECURITY — the page is deliberately "self only":
 *   • The role and the displayed record are derived from `useAuth()` and from
 *     GET /auth/me, which resolves the user FROM THE BEARER TOKEN. No `userId`
 *     is ever accepted from the browser, so a BURSARY (or ADMIN) user can only
 *     ever read and change their OWN account.
 *   • Role, account status and permissions are displayed read-only and cannot be
 *     edited here — those are administrator-managed.
 *   • Nothing sensitive is rendered: no password hash, no tokens, no refresh
 *     tokens, no internal permission IDs.
 *
 * This is a PERSONAL ACCOUNT capability, not an operational RBAC capability:
 * it requires no permission on the backend and no permission guard is applied
 * to /admin/profile or /bursary/profile. Any authenticated ADMIN/BURSARY
 * session — including one whose permission set is empty (`permissions: []`) —
 * may open it, view its own details and change its own password.
 */

type StaffRole = 'ADMIN' | 'BURSARY';

/** Safe subset of the authenticated user returned by GET /auth/me (safeUserSelect). */
type StaffUser = {
  id?: number;
  email?: string;
  firstName?: string;
  middleName?: string | null;
  lastName?: string;
  phoneNumber?: string | null;
  role?: string;
  accountStatus?: string | null;
  lastLoginAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

const ROLE_FRIENDLY: Record<string, string> = {
  ADMIN: 'Administrator',
  BURSARY: 'Bursary',
};

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  SUSPENDED: 'bg-amber-50 text-amber-700 border-amber-200',
  GRADUATED: 'bg-blue-50 text-blue-700 border-blue-200',
  WITHDRAWN: 'bg-gray-100 text-gray-600 border-gray-200',
};

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

const titleCaseStatus = (status: string): string =>
  status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : '—';

const StaffProfile: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();

  const role: StaffRole = user?.role === 'BURSARY' ? 'BURSARY' : 'ADMIN';
  const brand =
    role === 'ADMIN'
      ? i18n.portals.admin.dashboardBrand
      : i18n.portals.bursary.dashboardBrand;

  const userText = useMemo(() => {
    const base =
      `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || user?.email || 'Staff';
    return role === 'ADMIN' ? i18n.portals.admin.dashboardGreeting(base) : `Bursary: ${base}`;
  }, [role, user]);

  // ---------------------------------------------------------------------------
  // Account information — read from the AUTHENTICATED current-user endpoint.
  // /auth/me takes NO identifier: it resolves the target from the session token.
  // ---------------------------------------------------------------------------
  const [profile, setProfile] = useState<StaffUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/auth/me');
        const data = res?.data?.data?.user ?? res?.data?.user ?? null;
        if (!cancelled) setProfile(data);
      } catch (err: any) {
        if (!cancelled) {
          const msg = err?.response?.data?.message || err?.message;
          setLoadError(typeof msg === 'string' ? msg : 'Unable to load your account details.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fall back to the session user while /auth/me is in flight (or if it failed).
  const source: StaffUser = profile ?? (user as StaffUser | null) ?? {};

  const fullName = useMemo(() => {
    const parts = [source.firstName, source.middleName, source.lastName].filter(Boolean);
    return parts.join(' ').trim() || '—';
  }, [source.firstName, source.middleName, source.lastName]);

  const roleKey = String(source.role ?? role).toUpperCase();
  const roleFriendly = ROLE_FRIENDLY[roleKey] ?? roleKey;
  const accountStatus = String(source.accountStatus ?? '').toUpperCase();
  const initials =
    `${source.firstName?.[0] ?? ''}${source.lastName?.[0] ?? ''}`.toUpperCase() ||
    (source.email?.[0] ?? 'S').toUpperCase();

  // Exactly the fields required for the profile — nothing sensitive or internal.
  const accountRows: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'Full Name', value: fullName },
    { label: 'First Name', value: source.firstName || '—' },
    ...(source.middleName ? [{ label: 'Middle Name', value: source.middleName }] : []),
    { label: 'Last Name', value: source.lastName || '—' },
    { label: 'Email Address', value: source.email || '—' },
    { label: 'Role', value: roleFriendly },
    {
      label: 'Account Status',
      value: (
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${
            STATUS_STYLE[accountStatus] ?? 'bg-gray-100 text-gray-600 border-gray-200'
          }`}
        >
          {titleCaseStatus(accountStatus)}
        </span>
      ),
    },
    { label: 'Last Login', value: source.lastLoginAt ? formatDateTime(source.lastLoginAt) : 'Never' },
    { label: 'Account Created', value: formatDateTime(source.createdAt) },
    { label: 'Last Account Update', value: formatDateTime(source.updatedAt) },
  ];

  // ---------------------------------------------------------------------------
  // Self-service password change — the EXISTING authenticated endpoint.
  // ---------------------------------------------------------------------------
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [changing, setChanging] = useState(false);
  const [pwFeedback, setPwFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const newStrength = scorePassword(newPw);

  const onChangePassword = async () => {
    setPwFeedback(null);

    if (!currentPw) {
      setPwFeedback({ type: 'err', text: 'Please enter your current password.' });
      return;
    }
    if (newPw.length < 8) {
      setPwFeedback({ type: 'err', text: 'New password must be at least 8 characters.' });
      return;
    }
    if (newPw === currentPw) {
      setPwFeedback({ type: 'err', text: 'New password must differ from your current password.' });
      return;
    }
    if (newPw !== confirmPw) {
      setPwFeedback({ type: 'err', text: 'New password and confirmation do not match.' });
      return;
    }

    setChanging(true);
    try {
      await api.patch('/auth/change-password', {
        currentPassword: currentPw,
        newPassword: newPw,
      });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setPwFeedback({ type: 'ok', text: 'Password changed successfully.' });
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message;
      setPwFeedback({
        type: 'err',
        text: typeof msg === 'string' ? msg : 'Unable to change your password.',
      });
    } finally {
      setChanging(false);
    }
  };

  return (
    <PortalShell
      role={role}
      activePath={location.pathname}
      brand={brand}
      userText={userText}
      userEmail={user?.email}
      onLogout={logout}
      userPermissions={user?.permissions as string[] | undefined}
      navCounters={{}}
      showGlobalSearch
    >
      <div className="w-full space-y-6">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
            <UserCircle2 className={`h-6 w-6 ${role === 'BURSARY' ? 'text-amber-600' : 'text-gray-700'}`} />
            My Profile
          </h1>
          <p className="text-gray-500 mt-1">
            Your personal account details and password for the {roleFriendly} portal.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {/* ---------------- Account Information (read-only) ---------------- */}
            <section className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
              <header className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    <Mail className="h-5 w-5 text-blue-600" /> Account Information
                  </h2>
                  <p className="text-sm text-gray-500 mt-1">
                    Sourced from your authenticated session. These details are read-only.
                  </p>
                </div>
                <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600">
                  <Lock className="h-3.5 w-3.5" /> Read-only
                </span>
              </header>

              {loading ? (
                <div className="h-32 flex items-center justify-center gap-2 text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading your account…
                </div>
              ) : (
                <>
                  {loadError && (
                    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      {loadError}
                    </div>
                  )}
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {accountRows.map((row) => (
                      <div
                        key={row.label}
                        className="bg-gray-50 rounded-lg px-3 py-2 border border-gray-100"
                      >
                        <dt className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
                          {row.label}
                        </dt>
                        <dd className="mt-0.5 text-gray-900 font-medium truncate">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-4 flex items-start gap-2 text-xs text-gray-500">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      Your role, account status and permissions are managed by an administrator and
                      cannot be changed from this page.
                    </span>
                  </div>
                </>
              )}
            </section>

            {/* ------------------------- Change Password ------------------------ */}
            <section className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
              <header className="mb-5">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <KeyRound className="h-5 w-5 text-blue-600" /> Change Password
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  You must confirm your current password before setting a new one.
                </p>
              </header>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <PasswordInput
                  label="Current Password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  autoComplete="current-password"
                  inputClassName="px-3 py-2"
                />
                <PasswordInput
                  label="New Password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                  strength={newStrength.level}
                  showStrengthBar
                  strengthHint={newStrength.hint ?? null}
                  inputClassName="px-3 py-2"
                />
                <PasswordInput
                  label="Confirm New Password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  autoComplete="new-password"
                  matchOk={!!confirmPw && confirmPw === newPw}
                  mismatch={!!confirmPw && confirmPw !== newPw}
                  strengthHint={
                    confirmPw ? (confirmPw === newPw ? undefined : 'Passwords do not match.') : null
                  }
                  inputClassName="px-3 py-2"
                />
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onChangePassword}
                  disabled={changing || (!!confirmPw && confirmPw !== newPw)}
                  className="inline-flex items-center gap-2 bg-gray-900 hover:bg-gray-800 disabled:opacity-60 text-white font-semibold px-5 py-2.5 rounded-lg shadow-sm"
                >
                  {changing ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  {changing ? 'Updating…' : 'Update Password'}
                </button>
                {pwFeedback && (
                  <span
                    role={pwFeedback.type === 'ok' ? 'status' : 'alert'}
                    className={`inline-flex items-center gap-1.5 text-sm ${
                      pwFeedback.type === 'ok' ? 'text-green-700' : 'text-red-700'
                    }`}
                  >
                    {pwFeedback.type === 'ok' ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    {pwFeedback.text}
                  </span>
                )}
              </div>
            </section>
          </div>

          {/* ------------------------------ Summary ------------------------------ */}
          <aside className="space-y-6">
            <section className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
              <div className="flex items-center gap-3">
                <div
                  className={`h-12 w-12 shrink-0 rounded-full flex items-center justify-center text-sm font-bold ${
                    role === 'BURSARY' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {initials}
                </div>
                <div className="min-w-0">
                  <div className="text-base font-bold text-gray-900 truncate">{fullName}</div>
                  <div className="text-xs text-gray-500 truncate">{source.email || user?.email || '—'}</div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-semibold text-gray-700">
                  <ShieldCheck className="h-3.5 w-3.5" /> {roleFriendly}
                </span>
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
                    STATUS_STYLE[accountStatus] ?? 'bg-gray-100 text-gray-600 border-gray-200'
                  }`}
                >
                  {titleCaseStatus(accountStatus)}
                </span>
              </div>

              <dl className="mt-5 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="inline-flex items-center gap-1.5 text-gray-500">
                    <Clock className="h-3.5 w-3.5" /> Last Login
                  </dt>
                  <dd className="text-gray-900 font-medium text-right">
                    {source.lastLoginAt ? formatDateTime(source.lastLoginAt) : 'Never'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="inline-flex items-center gap-1.5 text-gray-500">
                    <CalendarClock className="h-3.5 w-3.5" /> Created
                  </dt>
                  <dd className="text-gray-900 font-medium text-right">
                    {formatDateTime(source.createdAt)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="inline-flex items-center gap-1.5 text-gray-500">
                    <CalendarClock className="h-3.5 w-3.5" /> Updated
                  </dt>
                  <dd className="text-gray-900 font-medium text-right">
                    {formatDateTime(source.updatedAt)}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl p-5">
              <div className="flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-blue-700 mt-0.5 shrink-0" />
                <div className="text-sm text-blue-900">
                  <p className="font-semibold">Account security</p>
                  <p className="opacity-80 mt-1">
                    This page always shows your own account — it is linked to your signed-in session
                    and cannot be used to view or edit another user. Contact an administrator if any
                    detail is incorrect.
                  </p>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </PortalShell>
  );
};

export default StaffProfile;
