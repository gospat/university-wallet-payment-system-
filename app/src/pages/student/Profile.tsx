import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { i18n } from '../../i18n/en';
import api from '../../services/api';
import { KeyRound, User, Save, BookOpen, GraduationCap, Mail, Phone, MapPin, CheckCircle2, AlertTriangle, Loader2, XCircle } from 'lucide-react';
import PasswordInput, { scorePassword } from '../../components/ui/PasswordInput';

type StudentProfileResponse = {
  data?: {
    id?: number;
    firstName?: string;
    lastName?: string;
    middleName?: string | null;
    email?: string;
    phoneNumber?: string | null;
    address?: string | null;
    matricNumber?: string;
    level?: string | null;
    currentSession?: string | null;
    college?: string | null;
    department?: string | null;
    programme?: string | null;
    studentType?: string;
    entryMode?: string;
    admissionYear?: number | null;
    graduationYear?: number | null;
  };
};

const ProfilePage: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const t = i18n.dashboard.student.profile;

  const fullName = useMemo(() => {
    if (!user) return 'Student';
    return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'Student';
  }, [user]);
  const brand = i18n.portals.student.dashboardBrand;

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<StudentProfileResponse['data'] | null>(null);

  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [changing, setChanging] = useState(false);
  const [pwToast, setPwToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/students/me');
        const d = r?.data?.data ?? r?.data ?? (r as any);
        setProfile(d || null);
        setPhone(String(d?.phoneNumber ?? ''));
        setAddress(String(d?.address ?? ''));
        setEmail(String(d?.email ?? user?.email ?? ''));
      } catch (_) {
        setEmail(String(user?.email ?? ''));
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const onSave = async () => {
    setSaving(true);
    setToast(null);
    try {
      await api.patch('/students/me', {
        phoneNumber: phone || undefined,
        address: address || undefined,
        email: email || undefined,
      });
      setToast({ type: 'ok', text: t.saveSuccess });
    } catch (_err: any) {
      const msg = _err?.response?.data?.message || _err?.message || t.saveFailed;
      setToast({ type: 'err', text: typeof msg === 'string' ? msg : t.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  const onChangePassword = async () => {
    setPwToast(null);
    if (!newPw || newPw.length < 8) {
      setPwToast({ type: 'err', text: t.passwordMin });
      return;
    }
    if (newPw !== confirmPw) {
      setPwToast({ type: 'err', text: t.passwordMismatch });
      return;
    }
    setChanging(true);
    try {
      await api.patch('/auth/change-password', { currentPassword: currentPw, newPassword: newPw });
      setPwToast({ type: 'ok', text: t.passwordSuccess });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (_err: any) {
      const msg = _err?.response?.data?.message || _err?.message || t.passwordFailed;
      setPwToast({ type: 'err', text: typeof msg === 'string' ? msg : t.passwordFailed });
    } finally {
      setChanging(false);
    }
  };

  return (
    <PortalShell
      role="STUDENT"
      activePath={location.pathname}
      userPermissions={[]}
      brand={brand}
      userText={fullName}
      userEmail={user?.email}
      onLogout={logout}
      navCounters={{}}
      showGlobalSearch={false}
    >
      <div className="w-full space-y-6">
        <div className="mb-6">
          <h1 className="text-2xl font-black text-gray-900 tracking-tight flex items-center gap-2">
            <User className="h-6 w-6 text-blue-600" /> {t.title}
          </h1>
          <p className="text-gray-500 mt-1">{t.subtitle}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <section className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
              <header className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    <Mail className="h-5 w-5 text-blue-600" /> {t.contactTitle}
                  </h2>
                  <p className="text-sm text-gray-500 mt-1">{t.contactHint}</p>
                </div>
              </header>

              {loading ? (
                <div className="h-32 flex items-center justify-center text-gray-400">Loading profile…</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <label className="block">
                    <span className="text-sm font-medium text-gray-700 mb-1 block">{t.emailLabel}</span>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-medium text-gray-700 mb-1 block">
                      <Phone className="h-3.5 w-3.5 inline mr-1 -mt-0.5" /> {t.phoneLabel}
                    </span>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className="text-sm font-medium text-gray-700 mb-1 block">
                      <MapPin className="h-3.5 w-3.5 inline mr-1 -mt-0.5" /> {t.addressLabel}
                    </span>
                    <textarea
                      rows={3}
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                    />
                  </label>
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onSave}
                  disabled={saving || loading}
                  className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold px-5 py-2.5 rounded-lg shadow-sm"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {saving ? t.saving : t.saveChanges}
                </button>
                {toast && (
                  <span className={`inline-flex items-center gap-1.5 text-sm ${toast.type === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
                    {toast.type === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                    {toast.text}
                  </span>
                )}
              </div>
            </section>

            <section className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
              <header className="mb-5">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <KeyRound className="h-5 w-5 text-blue-600" /> {t.passwordTitle}
                </h2>
                <p className="text-sm text-gray-500 mt-1">{t.passwordHint}</p>
              </header>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <PasswordInput
                  label={t.currentPasswordLabel}
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  autoComplete="current-password"
                  inputClassName="px-3 py-2"
                />
                <PasswordInput
                  label={t.newPasswordLabel}
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                  strength={scorePassword(newPw).level}
                  showStrengthBar
                  strengthHint={scorePassword(newPw).hint ?? null}
                  inputClassName="px-3 py-2"
                />
                <PasswordInput
                  label={t.confirmPasswordLabel}
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  autoComplete="new-password"
                  matchOk={!!confirmPw && confirmPw === newPw}
                  mismatch={!!confirmPw && confirmPw !== newPw}
                  strengthHint={
                    !!confirmPw
                      ? confirmPw === newPw
                        ? undefined
                        : 'Passwords do not match.'
                      : null
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
                  {changing ? t.updatingPassword : t.updatePassword}
                </button>
                {pwToast && (
                  <span className={`inline-flex items-center gap-1.5 text-sm ${pwToast.type === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
                    {pwToast.type === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                    {pwToast.text}
                  </span>
                )}
              </div>
            </section>
          </div>

          <aside className="space-y-6">
            <section className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
              <header className="mb-4">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <GraduationCap className="h-5 w-5 text-amber-600" /> {t.academicTitle}
                </h2>
                <p className="text-xs text-gray-500 mt-1">{t.academicHint}</p>
              </header>
              <dl className="grid grid-cols-1 gap-3 text-sm">
                {[
                  [t.matricLabel, profile?.matricNumber || (user as any)?.matricNumber || '—'],
                  [t.levelLabel, profile?.level || (user as any)?.level || '—'],
                  [t.sessionLabel, profile?.currentSession || '—'],
                  [t.collegeLabel, profile?.college || (user as any)?.college || '—'],
                  [t.deptLabel, profile?.department || (user as any)?.department || '—'],
                  [t.programmeLabel, profile?.programme || (user as any)?.programme || '—'],
                  [t.studentTypeLabel, profile?.studentType || (user as any)?.studentType || '—'],
                  [t.entryModeLabel, profile?.entryMode || (user as any)?.entryMode || '—'],
                  [t.admissionYearLabel, profile?.admissionYear ? String(profile.admissionYear) : '—'],
                  [t.graduationYearLabel, profile?.graduationYear ? String(profile.graduationYear) : '—'],
                ].map(([label, value]) => (
                  <div key={String(label)} className="bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
                    <dt className="text-xs uppercase tracking-wider text-gray-500 font-semibold">{label}</dt>
                    <dd className="mt-0.5 text-gray-900 font-medium truncate">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl p-5">
              <div className="flex items-start gap-3">
                <BookOpen className="h-5 w-5 text-blue-700 mt-0.5 shrink-0" />
                <div className="text-sm text-blue-900">
                  <p className="font-semibold">Need help?</p>
                  <p className="opacity-80 mt-1">Contact admissions for any corrections to academic records. Password resets are also available via the login page forgot-password flow.</p>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </PortalShell>
  );
};

export default ProfilePage;
