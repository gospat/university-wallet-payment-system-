import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Ban, Plus, Search, Key, Shield, Trash2, ShieldCheck, AlertTriangle, Loader2, Lock, UserCog } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import ConfirmAction from '../../components/ConfirmAction';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import {
  usersApi,
  permissionsApi,
  UserOut,
  UserAccessOut,
  UpdateUserAccessInput,
  AccessMode,
  PermissionOut,
  CreateUserInput,
  UpdateUserInput,
  ResetPasswordInput,
} from '../../services/adminApi';
import { navCounters, NavCounters } from '../../services/api';
import { i18n } from '../../i18n/en';

type AlertState = {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'error' | 'success' | 'info';
};

const ROLE_OPTIONS: Array<'ADMIN' | 'BURSARY'> = ['ADMIN', 'BURSARY'];

const PASSWORD_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';

const generateStrongPassword = (length = 16): string => {
  const chars = PASSWORD_CHARSET;
  let result = '';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const array = new Uint32Array(length);
    crypto.getRandomValues(array);
    for (let i = 0; i < length; i++) {
      result += chars[array[i] % chars.length];
    }
  } else {
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return result;
};

const RoleChip: React.FC<{ role: 'ADMIN' | 'BURSARY' | 'STUDENT' }> = ({ role }) => {
  const styles =
    role === 'ADMIN'
      ? 'bg-indigo-50 text-indigo-700 ring-indigo-200'
      : role === 'BURSARY'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : 'bg-gray-100 text-gray-700 ring-gray-200';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset ${styles}`}
    >
      {role}
    </span>
  );
};

const ActivePill: React.FC<{ status: 'ACTIVE' | 'SUSPENDED' | 'GRADUATED' | 'WITHDRAWN' }> = ({
  status,
}) => {
  const active = status === 'ACTIVE';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        active
          ? 'bg-emerald-100 text-emerald-800'
          : status === 'SUSPENDED'
          ? 'bg-red-100 text-red-800'
          : 'bg-gray-200 text-gray-600'
      }`}
    >
      {status}
    </span>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
  </div>
);

const inputCls =
  'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm';

type ConfirmState = {
  isOpen: boolean;
  title: string;
  description: string;
  resourceLabel: string;
  onConfirm: (payload: { reason?: string }) => Promise<void> | void;
  loading: boolean;
};

type UserFormState = {
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  password: string;
  role: 'ADMIN' | 'BURSARY';
  phoneNumber: string;
};

// ---------------------------------------------------------------------------
// Access column + Manage Access (individual permissions / super-admin)
// ---------------------------------------------------------------------------

// Display order for known categories from the canonical backend catalogue.
// Categories not listed are appended alphabetically — the list is intentionally
// open so a new backend category appears without a frontend change.
const CATEGORY_ORDER: string[] = [
  'Dashboard', 'Students', 'Fees', 'Payments', 'Direct Billing', 'Receipts',
  'Academic Structure', 'Reconciliation', 'Reports', 'Admin',
];

const buildCategoryList = (perms: Array<{ category?: string | null }>): string[] => {
  const present = Array.from(new Set(perms.map((p) => p.category || 'Other')));
  const known = CATEGORY_ORDER.filter((c) => present.includes(c));
  const extra = present.filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...extra];
};

const groupByCategory = <T extends { category?: string | null }>(perms: T[]): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  perms.forEach((p) => {
    const cat = p.category || 'Other';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(p);
  });
  return map;
};

/** Human-readable summary of a user's access, used in the Access column. */
const accessBadgeLabel = (u: UserOut): string => {
  if (u.isSuperAdmin) return 'Super Admin';
  if (u.accessMode === 'CUSTOM') {
    const x = u.effectivePermissionCount ?? 0;
    const y = u.rolePermissionCount ?? 0;
    return `Custom · ${x} of ${y}`;
  }
  if (u.role === 'ADMIN') return 'Inherits Admin Role';
  if (u.role === 'BURSARY') return 'Inherits Bursary Role';
  return '—';
};

const AccessBadge: React.FC<{ user: UserOut }> = ({ user }) => {
  if (user.isSuperAdmin) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800 ring-1 ring-inset ring-indigo-200">
        <Lock className="h-3 w-3" /> Super Admin
      </span>
    );
  }
  if (user.accessMode === 'CUSTOM') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200">
        {accessBadgeLabel(user)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 ring-1 ring-inset ring-gray-200">
      {accessBadgeLabel(user)}
    </span>
  );
};

/**
 * "Manage Access" modal — individual (per-user) permissions, deliberately kept
 * SEPARATE from the role baseline editor on the Roles page (contract §3 items 6
 * & 7). Shows the target's role, account status, access mode and permission
 * counts; lets a caller switch between Inherit Role Access and Custom Access and,
 * when CUSTOM, pick from ONLY the target role's available permissions grouped by
 * canonical backend category. ZERO selected permissions is a valid, saveable
 * configuration. Super-admin targets are shown as protected (no checkboxes).
 */
const ManageAccessModal: React.FC<{
  target: UserOut | null;
  viewerIsSuperAdmin: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}> = ({ target, viewerIsSuperAdmin, onClose, onSaved }) => {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [access, setAccess] = useState<UserAccessOut | null>(null);
  const [catalogue, setCatalogue] = useState<PermissionOut[]>([]);
  const [mode, setMode] = useState<AccessMode>('INHERIT');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [origSelected, setOrigSelected] = useState<Set<string>>(new Set());
  const [origMode, setOrigMode] = useState<AccessMode>('INHERIT');
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [superAdminBusy, setSuperAdminBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setAccess(null);
    setError(null);
    setConfirmOpen(false);
    Promise.all([
      usersApi.getAccess(target.id),
      permissionsApi.list().catch(() => [] as PermissionOut[]),
    ])
      .then(([acc, perms]) => {
        if (!alive) return;
        setAccess(acc);
        setCatalogue(perms);
        setMode(acc.accessMode);
        setOrigMode(acc.accessMode);
        const s = new Set(acc.selectedPermissions ?? []);
        setSelected(s);
        setOrigSelected(new Set(s));
      })
      .catch((err: any) => {
        if (!alive) return;
        setLoadError(
          err?.response?.data?.error ?? err?.response?.data?.message ?? err?.message ?? i18n.errors.generic,
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target]);

  const isProtected = !!access?.isProtected || !!target?.isSuperAdmin;

  // ONLY the target role's available permissions (contract §3 item 6).
  //  • BURSARY target → assignable (non-ADMIN-only) catalogue entries;
  //  • ADMIN target   → the full catalogue (ADMIN role maximum = whole registry).
  const availablePermissions = useMemo(() => {
    if (!access) return [] as PermissionOut[];
    if (access.user.role === 'ADMIN') return catalogue;
    return catalogue.filter((p) => p.assignable !== false && p.adminOnly !== true);
  }, [catalogue, access]);

  const categories = useMemo(() => buildCategoryList(availablePermissions), [availablePermissions]);
  const grouped = useMemo(() => groupByCategory(availablePermissions), [availablePermissions]);
  const availableKeys = useMemo(
    () => new Set(availablePermissions.map((p) => p.key)),
    [availablePermissions],
  );

  const toggleCategoryAll = (cat: string, checked: boolean) => {
    const keys = (grouped.get(cat) ?? []).map((p) => p.key);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) keys.forEach((k) => next.add(k));
      else keys.forEach((k) => next.delete(k));
      return next;
    });
  };

  const togglePerm = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const changes = useMemo(() => {
    const added: string[] = [];
    const removed: string[] = [];
    selected.forEach((k) => {
      if (!origSelected.has(k)) added.push(k);
    });
    origSelected.forEach((k) => {
      if (!selected.has(k)) removed.push(k);
    });
    const modeChanged = mode !== origMode;
    return { added, removed, hasChanges: modeChanged || added.length + removed.length > 0 };
  }, [selected, origSelected, mode, origMode]);

  const submit = async () => {
    if (!target || !access) return;
    setSubmitting(true);
    setError(null);
    try {
      // Only target-role-available keys are ever submitted. An EMPTY array is a
      // VALID explicit "zero permissions" configuration.
      const permissionKeys = Array.from(selected).filter((k) => availableKeys.has(k));
      const body: UpdateUserAccessInput =
        mode === 'CUSTOM'
          ? { accessMode: 'CUSTOM', permissionKeys }
          : { accessMode: 'INHERIT' };
      await usersApi.updateAccess(target.id, body);
      setConfirmOpen(false);
      onSaved(
        mode === 'CUSTOM'
          ? 'Individual access updated. The user must sign in again for the change to take effect.'
          : 'Access reset to inherit the role baseline. The user must sign in again for the change to take effect.',
      );
    } catch (err: any) {
      setError(
        err?.response?.data?.error ?? err?.response?.data?.message ?? err?.message ?? i18n.errors.generic,
      );
      setSubmitting(false);
    }
  };

  const setSuperAdmin = async (grant: boolean) => {
    if (!target) return;
    setSuperAdminBusy(true);
    setError(null);
    try {
      await usersApi.setSuperAdmin(target.id, grant);
      onSaved(grant ? 'Super administrator granted.' : 'Super administrator revoked.');
    } catch (err: any) {
      setError(
        err?.response?.data?.error ?? err?.response?.data?.message ?? err?.message ?? i18n.errors.generic,
      );
      setSuperAdminBusy(false);
    }
  };

  const name = target
    ? `${target.firstName} ${target.middleName ? target.middleName + ' ' : ''}${target.lastName}`.trim()
    : '';

  return (
    <Modal
      isOpen={!!target}
      onClose={() => !submitting && !superAdminBusy && onClose()}
      title={`Manage Access: ${name}`}
      size="lg"
      footer={
        isProtected ? (
          <button
            onClick={onClose}
            className="px-6 py-2 rounded-lg bg-gray-700 hover:bg-gray-800 text-white text-sm font-semibold"
          >
            Close
          </button>
        ) : (
          <>
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm disabled:opacity-50 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={submitting || loading || !!loadError || !changes.hasChanges}
              title={!changes.hasChanges ? 'Make a change to enable saving' : ''}
              className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                `Review & Save`
              )}
            </button>
          </>
        )
      }
    >
      {loading && (
        <div className="flex items-center gap-3 py-10 justify-center text-gray-500 text-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading access…
        </div>
      )}

      {!loading && loadError && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div>
            <div className="font-semibold">Failed to load access</div>
            <p className="mt-0.5">{loadError}</p>
          </div>
        </div>
      )}

      {!loading && !loadError && access && (
        <div className="space-y-5">
          {/* Target summary */}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Full Name</div>
              <div className="font-semibold text-gray-900">{name}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Email</div>
              <div className="text-gray-800 break-all">{access.user.email}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Role</div>
              <div className="text-gray-800">{access.user.role}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Account Status</div>
              <ActivePill status={access.user.accountStatus} />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Access Mode</div>
              <div className="text-gray-800">
                {access.accessMode === 'CUSTOM' ? 'Custom Access' : 'Inherits Role Access'}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Effective Permissions</div>
              <div className="text-gray-800">
                {access.effectivePermissionCount} of {access.rolePermissionCount} (role maximum)
              </div>
            </div>
          </div>

          {isProtected ? (
            <div className="flex items-start gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <ShieldCheck className="h-5 w-5 text-indigo-600 mt-0.5 shrink-0" />
              <div className="text-sm text-indigo-900">
                <div className="font-semibold">Protected Super Administrator</div>
                <p className="mt-1 text-indigo-800">
                  This account has protected full-system access and is not restricted by role or
                  individual permission settings.
                </p>
                {viewerIsSuperAdmin && (
                  <button
                    type="button"
                    onClick={() => setSuperAdmin(false)}
                    disabled={superAdminBusy}
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 text-xs font-semibold disabled:opacity-50"
                  >
                    {superAdminBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCog className="h-3.5 w-3.5" />}
                    Revoke Super Admin
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold text-gray-800">Access Mode</legend>
                <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-3 cursor-pointer hover:bg-gray-50">
                  <input
                    type="radio"
                    name="access-mode"
                    value="INHERIT"
                    checked={mode === 'INHERIT'}
                    onChange={() => setMode('INHERIT')}
                    disabled={submitting}
                    className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm">
                    <span className="font-medium text-gray-900">Inherit Role Access</span>
                    <span className="block text-xs text-gray-500 mt-0.5">
                      Hold the full {access.user.role} role baseline ({access.rolePermissionCount} permissions).
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 rounded-xl border border-gray-200 p-3 cursor-pointer hover:bg-gray-50">
                  <input
                    type="radio"
                    name="access-mode"
                    value="CUSTOM"
                    checked={mode === 'CUSTOM'}
                    onChange={() => setMode('CUSTOM')}
                    disabled={submitting}
                    className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm">
                    <span className="font-medium text-gray-900">Custom Access</span>
                    <span className="block text-xs text-gray-500 mt-0.5">
                      Hold ONLY the permissions you select from the {access.user.role} role's available set.
                    </span>
                  </span>
                </label>
              </fieldset>

              {mode === 'CUSTOM' && (
                <div className="border-t border-gray-100 pt-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-sm font-semibold text-gray-800">
                      Permissions ({selected.size}/{availablePermissions.length})
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSelected(new Set(availablePermissions.map((p) => p.key)))}
                        disabled={submitting}
                        className="text-xs px-2.5 py-1 rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 font-medium"
                      >
                        Select All Available
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelected(new Set())}
                        disabled={submitting}
                        className="text-xs px-2.5 py-1 rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 font-medium"
                      >
                        Clear All
                      </button>
                    </div>
                  </div>

                  {availablePermissions.length === 0 ? (
                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-6 text-center text-sm text-gray-500">
                      No permissions are available for the {access.user.role} role.
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                      {categories.map((cat) => {
                        const catPerms = grouped.get(cat) ?? [];
                        if (catPerms.length === 0) return null;
                        const catChecked = catPerms.every((p) => selected.has(p.key));
                        const catSome = catPerms.some((p) => selected.has(p.key));
                        return (
                          <div key={cat} className="border border-gray-100 rounded-xl overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50/70">
                              <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={catChecked}
                                  ref={(el) => {
                                    if (el) el.indeterminate = !catChecked && catSome;
                                  }}
                                  onChange={(e) => toggleCategoryAll(cat, e.target.checked)}
                                  disabled={submitting}
                                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                                <span className="text-sm font-semibold text-gray-800">{cat}</span>
                              </label>
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-white border border-gray-200 text-gray-600">
                                {catPerms.filter((p) => selected.has(p.key)).length}/{catPerms.length}
                              </span>
                            </div>
                            <div className="divide-y divide-gray-50">
                              {catPerms.map((perm) => {
                                const isChecked = selected.has(perm.key);
                                const wasAdded = isChecked && !origSelected.has(perm.key);
                                const wasRemoved = !isChecked && origSelected.has(perm.key);
                                return (
                                  <label
                                    key={perm.key}
                                    className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${submitting ? 'opacity-80' : 'hover:bg-gray-50'} ${wasAdded ? 'bg-emerald-50/60' : wasRemoved ? 'bg-rose-50/60' : ''}`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => togglePerm(perm.key)}
                                      disabled={submitting}
                                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-sm font-medium text-gray-900">{perm.name}</span>
                                        {wasAdded && (
                                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">ADDED</span>
                                        )}
                                        {wasRemoved && (
                                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200">REMOVED</span>
                                        )}
                                      </div>
                                      <div className="font-mono text-xs text-gray-500 mt-0.5 inline-block px-1.5 py-0.5 bg-gray-100 rounded">
                                        {perm.key}
                                      </div>
                                      {perm.description && (
                                        <p className="text-xs text-gray-600 mt-1">{perm.description}</p>
                                      )}
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {viewerIsSuperAdmin && access.user.role === 'ADMIN' && (
                <div className="border-t border-gray-100 pt-4">
                  <button
                    type="button"
                    onClick={() => setSuperAdmin(true)}
                    disabled={superAdminBusy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-300 bg-white text-indigo-700 hover:bg-indigo-50 text-xs font-semibold disabled:opacity-50"
                  >
                    {superAdminBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    Grant Super Admin
                  </button>
                  <p className="mt-1.5 text-xs text-gray-500">
                    Grants protected full-system access (Super-Admin only).
                  </p>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Confirmation step before applying individual access */}
      <Modal
        isOpen={confirmOpen}
        onClose={() => !submitting && setConfirmOpen(false)}
        title="Confirm access change"
        footer={
          <>
            <button
              onClick={() => setConfirmOpen(false)}
              disabled={submitting}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm disabled:opacity-50 rounded-lg hover:bg-gray-50"
            >
              Back
            </button>
            <button
              onClick={submit}
              disabled={submitting}
              className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2"
            >
              {submitting ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Confirm & Save'}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-gray-700">
          <p>
            You are about to update the individual access of{' '}
            <span className="font-semibold">{name}</span>.
          </p>
          <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 space-y-1">
            <div><span className="font-semibold">Access mode:</span> {mode === 'CUSTOM' ? 'Custom Access' : 'Inherit Role Access'}</div>
            {mode === 'CUSTOM' && (
              <>
                <div><span className="font-semibold">Permissions selected:</span> {selected.size}</div>
                <div className="text-xs text-gray-600">
                  Added: {changes.added.length} · Removed: {changes.removed.length}
                </div>
              </>
            )}
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </Modal>
    </Modal>
  );
};

const UsersPage: React.FC = () => {
  const { user, logout } = useAuth();
  const brand = i18n.portals.admin.dashboardBrand;
  const userText = i18n.portals.admin.dashboardGreeting(
    `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin'
  );

  const [rows, setRows] = useState<UserOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'' | 'ADMIN' | 'BURSARY'>('');
  const [accountStatusFilter, setAccountStatusFilter] = useState<'' | 'ACTIVE' | 'SUSPENDED'>('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [alert, setAlert] = useState<AlertState>({
    isOpen: false,
    title: '',
    message: '',
    type: 'error',
  });

  useEffect(() => {
    navCounters().then(setNavCounts).catch(() => setNavCounts({}));
  }, []);

  const [modal, setModal] = useState<{
    open: boolean;
    kind: 'create' | 'edit';
    initial?: UserOut;
  }>({ open: false, kind: 'create' });

  const [form, setForm] = useState<UserFormState>({
    firstName: '',
    middleName: '',
    lastName: '',
    email: '',
    password: '',
    role: 'ADMIN',
    phoneNumber: '',
  });

  const [submitting, setSubmitting] = useState(false);

  const [confirm, setConfirm] = useState<ConfirmState>({
    isOpen: false,
    title: '',
    description: '',
    resourceLabel: '',
    onConfirm: () => {},
    loading: false,
  });

  const [resetPwdModal, setResetPwdModal] = useState<{
    open: boolean;
    password: string;
  }>({ open: false, password: '' });

  // Individual access management (contract §3 item 6). The backend is authoritative
  // for whether the caller may change access; the flag below only controls UI affordances.
  const [manageAccessTarget, setManageAccessTarget] = useState<UserOut | null>(null);
  const viewerIsSuperAdmin = user?.role === 'ADMIN' && user?.isSuperAdmin === true;

  // Contract D6: a NORMAL ADMIN may not manage the individual access of an
  // ADMIN target (super-admin only). The backend enforces this authoritatively
  // with a 403; this only suppresses an affordance that could never succeed.
  const canManageAccessFor = (target: UserOut): boolean =>
    viewerIsSuperAdmin || target.role !== 'ADMIN';

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const params: any = { page, pageSize };
        if (search.trim()) params.search = search.trim();
        if (roleFilter) params.role = roleFilter;
        if (accountStatusFilter) params.accountStatus = accountStatusFilter;
        const r = await usersApi.list(params);
        setRows(r.items);
        setTotal(r.total);
      } catch (err: any) {
        if (signal?.aborted) return;
        if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
        setAlert({
          isOpen: true,
          title: 'Failed to load',
          message: err?.message ?? i18n.errors.generic,
          type: 'error',
        });
      } finally {
        setLoading(false);
      }
    },
    [page, pageSize, search, roleFilter, accountStatusFilter]
  );

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    load(abortRef.current.signal);
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  const openCreate = () => {
    setForm({
      firstName: '',
      middleName: '',
      lastName: '',
      email: '',
      password: generateStrongPassword(),
      role: 'ADMIN',
      phoneNumber: '',
    });
    setModal({ open: true, kind: 'create' });
  };

  const openEdit = (u: UserOut) => {
    setForm({
      firstName: u.firstName,
      middleName: u.middleName ?? '',
      lastName: u.lastName,
      email: u.email,
      password: '',
      role: (ROLE_OPTIONS.includes(u.role as any) ? u.role : 'ADMIN') as 'ADMIN' | 'BURSARY',
      phoneNumber: u.phoneNumber ?? '',
    });
    setModal({ open: true, kind: 'edit', initial: u });
  };

  const submitModal = async () => {
    if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim()) return;
    if (modal.kind === 'create' && !form.password.trim()) return;
    setSubmitting(true);
    try {
      if (modal.kind === 'create') {
        const payload: CreateUserInput = {
          firstName: form.firstName.trim(),
          middleName: form.middleName.trim() || null,
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          password: form.password.trim(),
          role: form.role,
          phoneNumber: form.phoneNumber.trim() || null,
        };
        await usersApi.create(payload);
      } else if (modal.initial) {
        const payload: UpdateUserInput = {
          firstName: form.firstName.trim(),
          middleName: form.middleName.trim() || null,
          lastName: form.lastName.trim(),
          role: form.role,
          phoneNumber: form.phoneNumber.trim() || null,
        };
        await usersApi.update(modal.initial.id, payload);
      }
      setModal({ open: false, kind: 'create' });
      load();
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({
        isOpen: true,
        title: 'Failed to save',
        message: err?.message ?? i18n.errors.generic,
        type: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openResetPassword = (u: UserOut) => {
    setConfirm({
      isOpen: true,
      title: 'Reset Password',
      description: `Reset password for ${u.email}?`,
      resourceLabel: `User: ${u.firstName} ${u.lastName} (${u.email})`,
      loading: false,
      onConfirm: async () => {
        setConfirm((c) => ({ ...c, loading: true }));
        try {
          const newPwd = generateStrongPassword();
          const body: ResetPasswordInput = { newPassword: newPwd };
          await usersApi.resetPassword(u.id, body);
          setConfirm((c) => ({ ...c, isOpen: false, loading: false }));
          setResetPwdModal({ open: true, password: newPwd });
        } catch (err: any) {
          setConfirm((c) => ({ ...c, loading: false }));
          if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
          throw err;
        }
      },
    });
  };

  const openToggleStatus = (u: UserOut) => {
    const isActive = u.accountStatus === 'ACTIVE';
    const title = isActive ? 'Suspend User' : 'Reactivate User';
    const description = isActive
      ? `Suspend user ${u.email}?`
      : `Reactivate suspended user ${u.email}?`;
    const actionLabel = isActive ? 'Suspend' : 'Reactivate';
    setConfirm({
      isOpen: true,
      title,
      description,
      resourceLabel: `User: ${u.firstName} ${u.lastName} (${u.email})`,
      loading: false,
      onConfirm: async () => {
        setConfirm((c) => ({ ...c, loading: true }));
        try {
          await usersApi.deactivate(u.id);
          setConfirm((c) => ({ ...c, isOpen: false, loading: false }));
          load();
        } catch (err: any) {
          setConfirm((c) => ({ ...c, loading: false }));
          if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
          throw err;
        }
      },
    });
    void actionLabel;
  };

  const PROTECTED_UIDS = new Set<number>([1, 2, 48]);
  const openDeleteUser = (u: UserOut) => {
    if (PROTECTED_UIDS.has(u.id)) {
      setAlert({
        isOpen: true, title: 'Cannot delete protected account', type: 'error',
        message: `${u.email} is a protected bootstrap account and cannot be removed. Suspend instead.`,
      });
      return;
    }
    setConfirm({
      isOpen: true,
      title: 'Delete User (Permanent)',
      description: `Delete ${u.role} user ${u.email}? This cannot be undone. Sessions are invalidated immediately.`,
      resourceLabel: `User: ${u.firstName} ${u.lastName} (${u.email} · Role: ${u.role})`,
      loading: false,
      onConfirm: async () => {
        setConfirm((c) => ({ ...c, loading: true }));
        try {
          await usersApi.remove(u.id);
          setConfirm((c) => ({ ...c, isOpen: false, loading: false }));
          load();
        } catch (err: any) {
          setConfirm((c) => ({ ...c, loading: false }));
          if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
          const msg =
            (err?.response?.data?.breakdown || []).length > 0
              ? `${err.response.data.error || 'Cannot delete'} — ${(err.response.data.breakdown as string[]).join(', ')}.`
              : (err?.response?.data?.error ?? err?.message ?? i18n.errors.generic);
          setAlert({ isOpen: true, title: 'Delete failed', type: 'error', message: String(msg).slice(0, 500) });
        }
      },
    });
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const content = (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Shield className="h-6 w-6 text-gray-700" /> Users
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage administrative and bursary user accounts.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm"
        >
          <Plus className="h-4 w-4" /> Create User
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl p-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 w-full">
          <div className="relative flex-1 w-full sm:max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              className="w-full h-9 pl-9 pr-4 rounded-lg border border-gray-200 text-sm"
              placeholder="Search name or email…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 px-3 rounded-lg border border-gray-200 text-sm bg-white"
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value as any);
                setPage(1);
              }}
            >
              <option value="">All Roles</option>
              <option value="ADMIN">ADMIN</option>
              <option value="BURSARY">BURSARY</option>
            </select>
            <select
              className="h-9 px-3 rounded-lg border border-gray-200 text-sm bg-white"
              value={accountStatusFilter}
              onChange={(e) => {
                setAccountStatusFilter(e.target.value as any);
                setPage(1);
              }}
            >
              <option value="">All Statuses</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="SUSPENDED">SUSPENDED</option>
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">ID</th>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">Name</th>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">Email</th>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">Role</th>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">Access</th>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">Account Status</th>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">College</th>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">Department</th>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">Phone</th>
                <th className="px-3 py-3 text-left font-semibold text-gray-700">CreatedAt</th>
                <th className="px-3 py-3 text-right font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-500">
                    No users found.
                  </td>
                </tr>
              )}
              {rows.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50/60">
                  <td className="px-3 py-3 font-mono text-xs text-gray-600">#{u.id}</td>
                  <td className="px-3 py-3 font-medium text-gray-900">
                    {u.firstName} {u.middleName ? u.middleName + ' ' : ''}
                    {u.lastName}
                  </td>
                  <td className="px-3 py-3 text-gray-700">{u.email}</td>
                  <td className="px-3 py-3">
                    <RoleChip role={u.role} />
                  </td>
                  <td className="px-3 py-3">
                    <AccessBadge user={u} />
                  </td>
                  <td className="px-3 py-3">
                    <ActivePill status={u.accountStatus} />
                  </td>
                  <td className="px-3 py-3 text-gray-600">{u.college ?? '—'}</td>
                  <td className="px-3 py-3 text-gray-600">{u.department ?? '—'}</td>
                  <td className="px-3 py-3 text-gray-600">{u.phoneNumber ?? '—'}</td>
                  <td className="px-3 py-3 text-gray-500 text-xs">
                    {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-end gap-1 text-xs">
                      {canManageAccessFor(u) && (
                        <button
                          onClick={() => setManageAccessTarget(u)}
                          className="inline-flex items-center gap-1 text-indigo-700 hover:text-indigo-900 px-2 py-1 rounded hover:bg-indigo-50"
                          title="Manage access and permissions"
                        >
                          <UserCog className="h-3.5 w-3.5" /> Manage Access
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(u)}
                        className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 px-2 py-1 rounded hover:bg-blue-50"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button
                        onClick={() => openResetPassword(u)}
                        className="inline-flex items-center gap-1 text-amber-700 hover:text-amber-900 px-2 py-1 rounded hover:bg-amber-50"
                        title="Reset Password"
                      >
                        <Key className="h-3.5 w-3.5" /> Reset
                      </button>
                      <button
                        onClick={() => openToggleStatus(u)}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded ${
                          u.accountStatus === 'ACTIVE'
                            ? 'text-red-700 hover:text-red-900 hover:bg-red-50'
                            : 'text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50'
                        }`}
                        title={u.accountStatus === 'ACTIVE' ? 'Suspend' : 'Activate'}
                      >
                        <Ban className="h-3.5 w-3.5" />
                        {u.accountStatus === 'ACTIVE' ? 'Suspend' : 'Activate'}
                      </button>
                      <button
                        onClick={() => openDeleteUser(u)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-red-700 hover:text-red-900 hover:bg-red-50"
                        title="Delete user permanently"
                        disabled={PROTECTED_UIDS.has(u.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50/50 text-sm text-gray-600">
          <div>
            Showing {rows.length} of {total}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50"
            >
              Prev
            </button>
            <span className="font-medium text-gray-900 min-w-[4rem] text-center">
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <Modal
        isOpen={modal.open}
        onClose={() => setModal({ open: false, kind: 'create' })}
        title={
          modal.kind === 'create'
            ? 'Create User'
            : `Edit User: ${modal.initial?.firstName ?? ''} ${modal.initial?.lastName ?? ''}`
        }
        footer={
          <>
            <button
              onClick={() => setModal({ open: false, kind: 'create' })}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm"
            >
              Cancel
            </button>
            <button
              onClick={submitModal}
              disabled={
                submitting ||
                !form.firstName.trim() ||
                !form.lastName.trim() ||
                !form.email.trim() ||
                (modal.kind === 'create' && !form.password.trim())
              }
              className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2"
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="First Name">
            <input
              className={inputCls}
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              placeholder="First name"
            />
          </Field>
          <Field label="Middle Name">
            <input
              className={inputCls}
              value={form.middleName}
              onChange={(e) => setForm({ ...form, middleName: e.target.value })}
              placeholder="Middle name (optional)"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Last Name">
              <input
                className={inputCls}
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                placeholder="Last name"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field
              label={
                modal.kind === 'edit' ? 'Email (cannot be changed)' : 'Email'
              }
            >
              <input
                className={`${inputCls} ${modal.kind === 'edit' ? 'bg-gray-100' : ''}`}
                value={form.email}
                onChange={(e) =>
                  modal.kind !== 'edit' && setForm({ ...form, email: e.target.value })
                }
                placeholder="email@university.edu"
                disabled={modal.kind === 'edit'}
              />
            </Field>
          </div>
          {modal.kind === 'create' && (
            <div className="sm:col-span-2">
              <Field label="Password">
                <input
                  className={inputCls}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="Password"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Leave default or edit; shown only once on save
                </p>
              </Field>
            </div>
          )}
          <Field label="Role">
            <select
              className={inputCls}
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as 'ADMIN' | 'BURSARY' })}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Phone">
            <input
              className={inputCls}
              value={form.phoneNumber}
              onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
              placeholder="Phone number (optional)"
            />
          </Field>
        </div>
      </Modal>

      <Modal
        isOpen={resetPwdModal.open}
        onClose={() => setResetPwdModal({ open: false, password: '' })}
        title="Password Reset Successful"
        footer={
          <button
            onClick={() => setResetPwdModal({ open: false, password: '' })}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold text-sm"
          >
            OK
          </button>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-800">
            A new temporary password has been generated.
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Generated Password
            </label>
            <div className="relative">
              <input
                readOnly
                value={resetPwdModal.password}
                className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-gray-50 font-mono text-base font-bold text-gray-900 select-all"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                try {
                  navigator.clipboard.writeText(resetPwdModal.password);
                } catch (_) {
                  /* noop */
                }
              }}
              className="mt-2 text-sm text-blue-700 hover:text-blue-900 font-medium"
            >
              Copy to clipboard
            </button>
          </div>
          <p className="text-sm text-gray-600 leading-relaxed">
            Share this password securely with the user; it cannot be retrieved later.
          </p>
        </div>
      </Modal>

      <ConfirmAction
        isOpen={confirm.isOpen}
        onClose={() => !confirm.loading && setConfirm({ ...confirm, isOpen: false })}
        onConfirm={confirm.onConfirm}
        title={confirm.title}
        description={confirm.description}
        resourceLabel={confirm.resourceLabel}
        reasonRequired={false}
        confirmVariant="danger"
        confirmLabel={
          confirm.title === 'Reset Password'
            ? 'Reset Password'
            : confirm.title === 'Reactivate User'
            ? 'Reactivate'
            : 'Suspend'
        }
        loading={confirm.loading}
      />

      <Modal
        isOpen={alert.isOpen}
        onClose={() => setAlert({ ...alert, isOpen: false })}
        title={alert.title}
        footer={
          <button
            onClick={() => setAlert({ ...alert, isOpen: false })}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold text-sm"
          >
            OK
          </button>
        }
      >
        <p className="text-gray-700 whitespace-pre-wrap break-words select-text text-sm">
          {alert.message}
        </p>
      </Modal>

      <ManageAccessModal
        target={manageAccessTarget}
        viewerIsSuperAdmin={viewerIsSuperAdmin}
        onClose={() => setManageAccessTarget(null)}
        onSaved={(message) => {
          setManageAccessTarget(null);
          setAlert({ isOpen: true, title: 'Access updated', message, type: 'success' });
          load();
        }}
      />
    </div>
  );

  return (
    <PortalShell
      role="ADMIN"
      activePath="/admin/users"
      brand={brand}
      userText={userText}
      userEmail={user?.email}
      onLogout={logout}
      userPermissions={user?.permissions}
      navCounters={navCounts}
      showGlobalSearch
    >
      {content}
    </PortalShell>
  );
};

export default UsersPage;
