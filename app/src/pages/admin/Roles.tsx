import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Shield, Pencil, Eye, ChevronDown, ChevronRight, Loader2, CheckCircle2, AlertTriangle, Info, Lock } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import { rolesApi, permissionsApi, RoleOut, PermissionOut, RoleDiff } from '../../services/adminApi';
import { navCounters, NavCounters } from '../../services/api';
import { i18n } from '../../i18n/en';

type AlertState = {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'error' | 'success' | 'info';
};

type RoleName = 'ADMIN' | 'BURSARY' | 'STUDENT';

const ROLE_META: Record<RoleName, {
  name: string;
  kind: string;
  description: string;
  badgeClass: string;
  iconClass: string;
  barClass: string;
  trackClass: string;
}> = {
  ADMIN: {
    name: 'ADMIN',
    kind: 'Super Administrator',
    description: 'Full system access. Protected role — cannot be modified.',
    badgeClass: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    iconClass: 'text-indigo-600',
    barClass: 'bg-indigo-500',
    trackClass: 'bg-indigo-50',
  },
  BURSARY: {
    name: 'BURSARY',
    kind: 'Finance / Bursary Staff',
    description: 'Financial operations, payments and receipts. Customizable permissions.',
    badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    iconClass: 'text-emerald-600',
    barClass: 'bg-emerald-500',
    trackClass: 'bg-emerald-50',
  },
  STUDENT: {
    name: 'STUDENT',
    kind: 'Student Portal User',
    description: 'Fixed student self-service access. System role — not configurable.',
    badgeClass: 'bg-sky-100 text-sky-800 border-sky-200',
    iconClass: 'text-sky-600',
    barClass: 'bg-sky-500',
    trackClass: 'bg-sky-50',
  },
};

// Display order for known categories. Categories NOT listed here are appended
// alphabetically — the list is intentionally OPEN so a new backend permission
// category (e.g. "Reports") shows up automatically without a frontend change.
const CATEGORY_ORDER: string[] = [
  'Dashboard',
  'Students',
  'Fees',
  'Payments',
  'Direct Billing',
  'Receipts',
  'Academic Structure',
  'Reconciliation',
  'Reports',
  'Admin',
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

const RolesPage: React.FC = () => {
  const { user, logout, refetchUser } = useAuth();
  const brand = i18n.portals.admin.dashboardBrand;
  const userText = i18n.portals.admin.dashboardGreeting(
    `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin'
  );

  const [roles, setRoles] = useState<RoleOut[]>([]);
  const [allPermissions, setAllPermissions] = useState<PermissionOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'error' });

  const [modal, setModal] = useState<{ open: boolean; mode: 'view' | 'edit'; role?: RoleOut }>({ open: false, mode: 'view' });
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [origPermsAtOpen, setOrigPermsAtOpen] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set(CATEGORY_ORDER));

  useEffect(() => {
    navCounters().then(setNavCounts).catch(() => setNavCounts({}));
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [rolesData, permsData] = await Promise.all([rolesApi.list(), permissionsApi.list()]);
      setRoles(rolesData);
      setAllPermissions(permsData);
    } catch (err: any) {
      if (signal?.aborted) return;
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Failed to load', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Permissions that may be assigned to a configurable role (BURSARY). The
  // backend is the authority; `assignable` mirrors ADMIN-only classification.
  const assignablePermissions = useMemo(
    () => allPermissions.filter((p) => p.assignable !== false),
    [allPermissions],
  );

  const allCategories = useMemo(() => buildCategoryList(allPermissions), [allPermissions]);
  const groupedAllPerms = useMemo(() => groupByCategory(allPermissions), [allPermissions]);
  const groupedAssignable = useMemo(() => groupByCategory(assignablePermissions), [assignablePermissions]);
  const assignableCategories = useMemo(() => buildCategoryList(assignablePermissions), [assignablePermissions]);

  const toggleCat = (cat: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const openView = (role: RoleOut) => {
    setSelectedPerms(new Set(role.permissions.map((p) => p.key)));
    setOrigPermsAtOpen(new Set(role.permissions.map((p) => p.key)));
    setExpandedCats(new Set(allCategories));
    setModal({ open: true, mode: 'view', role });
  };

  const openEdit = (role: RoleOut) => {
    const now = new Set(role.permissions.map((p) => p.key));
    setSelectedPerms(now);
    setOrigPermsAtOpen(new Set(now));
    setExpandedCats(new Set(assignableCategories));
    setModal({ open: true, mode: 'edit', role });
  };

  const togglePerm = (key: string) => {
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleCategoryAll = (cat: string, checked: boolean) => {
    const catKeys = (groupedAssignable.get(cat) ?? []).map((p) => p.key);
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (checked) catKeys.forEach((k) => next.add(k));
      else catKeys.forEach((k) => next.delete(k));
      return next;
    });
  };

  const closeModal = () => {
    if (submitting) return;
    setConfirmOpen(false);
    setModal({ open: false, mode: 'view' });
  };

  const submitModal = async () => {
    if (!modal.role || modal.mode !== 'edit') return;
    // Only assignable keys are ever submitted. An empty set is VALID and means
    // "this role has zero permissions".
    const permissionKeys = Array.from(selectedPerms).filter((k) =>
      assignablePermissions.some((p) => p.key === k),
    );
    setSubmitting(true);
    try {
      let diff: RoleDiff = { added: [], removed: [] };
      const out: any = await rolesApi.update(modal.role.role as 'ADMIN' | 'BURSARY', { permissionKeys });
      if (out?.diff) diff = out.diff;
      setConfirmOpen(false);
      setModal({ open: false, mode: 'view' });
      const addedN = diff.added?.length ?? 0;
      const removedN = diff.removed?.length ?? 0;
      if (addedN === 0 && removedN === 0) {
        setAlert({ isOpen: true, title: 'No changes', message: 'Role permissions are unchanged.', type: 'info' });
      } else {
        setAlert({
          isOpen: true,
          title: 'Role saved',
          message: `+${addedN} added / -${removedN} removed. Changes are live for all users now.`,
          type: 'success',
        });
      }
      try {
        await refetchUser();
      } catch {
        /* noop — refresh silently on failure */
      }
      load();
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Failed to save', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const diff = useMemo(() => {
    const added: string[] = [];
    const removed: string[] = [];
    selectedPerms.forEach((k) => {
      if (!origPermsAtOpen.has(k)) added.push(k);
    });
    origPermsAtOpen.forEach((k) => {
      if (!selectedPerms.has(k)) removed.push(k);
    });
    return { added, removed, hasChanges: added.length + removed.length > 0 };
  }, [selectedPerms, origPermsAtOpen]);

  const content = (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Roles &amp; Permissions</h1>
          <p className="text-sm text-gray-500 mt-1">
            ADMIN is a protected super-administrator. BURSARY permissions are configurable. STUDENT access is fixed.
          </p>
        </div>
      </div>

      {loading && roles.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center text-gray-500">Loading…</div>
      )}

      {!loading && roles.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center text-gray-500">No roles found.</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {roles.map((role) => {
          const meta = ROLE_META[role.role as RoleName] ?? ROLE_META.STUDENT;
          const grouped = groupByCategory(role.permissions);
          const total = allPermissions.length || 1;
          const pct = Math.round((role.permissionsCount / total) * 100);
          const canManage = role.modifiable === true;
          return (
            <div key={role.role} className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
              <div className="p-6 border-b border-gray-100">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <Shield className={`h-5 w-5 shrink-0 ${meta.iconClass}`} />
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-bold border ${meta.badgeClass}`}>
                        {role.role}
                      </span>
                      {role.isSuperAdmin && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200 bg-gray-50 text-gray-700">
                          <Lock className="h-3 w-3" /> Protected
                        </span>
                      )}
                      {!canManage && !role.isSuperAdmin && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200 bg-gray-50 text-gray-700">
                          System Role
                        </span>
                      )}
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200 bg-white text-gray-700">
                        {role.permissionsCount}/{allPermissions.length || 0} permissions
                      </span>
                    </div>
                    <div className="text-xl font-bold text-gray-900 mt-1">{meta.kind}</div>
                    <p className="text-sm text-gray-500 mt-1">{role.description}</p>
                    <div className={`mt-4 h-2 w-full rounded-full ${meta.trackClass} overflow-hidden`}>
                      <div
                        className={`h-full ${meta.barClass} rounded-full transition-[width] duration-500 ease-out`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  {canManage ? (
                    <button
                      onClick={() => openEdit(role)}
                      className="inline-flex items-center gap-1.5 text-blue-700 hover:text-blue-900 px-3 py-1.5 rounded-lg hover:bg-blue-50 text-sm font-medium shrink-0 border border-transparent hover:border-blue-100 transition-colors"
                    >
                      <Pencil className="h-4 w-4" /> Manage Permissions
                    </button>
                  ) : (
                    <button
                      onClick={() => openView(role)}
                      className="inline-flex items-center gap-1.5 text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-lg hover:bg-gray-50 text-sm font-medium shrink-0 border border-transparent hover:border-gray-200 transition-colors"
                    >
                      <Eye className="h-4 w-4" /> View Permissions
                    </button>
                  )}
                </div>
              </div>

              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">
                    {role.isSuperAdmin ? 'All system permissions (cannot be modified)' : `Assigned permissions (${role.permissionsCount})`}
                  </h3>
                </div>

                <div className="space-y-4">
                  {allCategories.map((cat) => {
                    const catPerms = grouped.get(cat) ?? [];
                    const catTotal = groupedAllPerms.get(cat)?.length ?? 0;
                    if (catPerms.length === 0 && catTotal === 0) return null;
                    return (
                      <div key={cat} className="border border-gray-100 rounded-xl overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleCat(cat)}
                          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50/70 hover:bg-gray-50 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-gray-800">{cat}</span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-white border border-gray-200 text-gray-600">
                              {catPerms.length}/{catTotal}
                            </span>
                          </div>
                          {expandedCats.has(cat) ? (
                            <ChevronDown className="h-4 w-4 text-gray-500" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-gray-500" />
                          )}
                        </button>
                        {expandedCats.has(cat) && catPerms.length === 0 && (
                          <div className="px-4 py-6 text-center text-xs text-gray-500">No permissions assigned in this category.</div>
                        )}
                        {expandedCats.has(cat) && catPerms.length > 0 && (
                          <div className="divide-y divide-gray-50">
                            {catPerms.map((perm) => (
                              <div key={perm.key} className="px-4 py-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="font-semibold text-gray-900 text-sm">{perm.name}</div>
                                    <div className="font-mono text-xs text-gray-500 mt-0.5">{perm.key}</div>
                                    {perm.description && (
                                      <p className="text-xs text-gray-600 mt-1">{perm.description}</p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* === Permission modal: read-only (view) or editable (edit) === */}
      <Modal
        isOpen={modal.open}
        onClose={closeModal}
        title={
          modal.mode === 'view'
            ? `Permissions: ${modal.role?.role ?? ''}`
            : `Manage Permissions: ${modal.role?.role ?? ''}`
        }
        footer={
          modal.mode === 'view' ? (
            <button
              onClick={closeModal}
              className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold"
            >
              Close
            </button>
          ) : (
            <>
              <button
                onClick={closeModal}
                disabled={submitting}
                className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm disabled:opacity-50 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={submitting || !diff.hasChanges}
                className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2 transition-colors"
                title={!diff.hasChanges && !submitting ? 'Make a change to enable saving' : ''}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    {diff.hasChanges
                      ? `Review & Save (${selectedPerms.size} selected)`
                      : 'Save'}
                  </>
                )}
              </button>
            </>
          )
        }
      >
        <div className="space-y-4">
          {modal.mode === 'view' && (
            <div className="flex items-start gap-3 rounded-xl border border-gray-100 bg-gray-50 p-3">
              <Lock className="h-4 w-4 text-gray-500 mt-0.5 shrink-0" />
              <div className="text-xs text-gray-600">
                ADMIN is a protected super-administrator and always holds the complete permission
                set. Its permissions cannot be modified.
              </div>
            </div>
          )}

          {modal.mode === 'edit' && diff.hasChanges && (
            <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
              <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-blue-900">Pending changes</div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  <span className="inline-flex items-center px-2 py-1 rounded-full bg-white border border-gray-200 text-gray-700 font-medium">
                    Permissions selected: {selectedPerms.size}
                  </span>
                  {diff.added.length > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 font-medium">
                      +{diff.added.length} added
                    </span>
                  )}
                  {diff.removed.length > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-rose-50 border border-rose-200 text-rose-800 font-medium">
                      -{diff.removed.length} removed
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
          {modal.mode === 'edit' && !diff.hasChanges && !submitting && (
            <div className="flex items-start gap-3 rounded-xl border border-gray-100 bg-gray-50 p-3">
              <AlertTriangle className="h-4 w-4 text-gray-500 mt-0.5 shrink-0" />
              <div className="text-xs text-gray-600">
                Toggle any permission to enable the <span className="font-semibold">Save</span> button.
              </div>
            </div>
          )}

          {modal.mode === 'edit' ? (
            <div className="pt-2 border-t border-gray-100">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-gray-800">
                  Permissions ({selectedPerms.size}/{assignablePermissions.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedPerms(new Set(assignablePermissions.map((p) => p.key)))}
                    disabled={submitting}
                    className="text-xs px-2.5 py-1 rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 font-medium transition-colors"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedPerms(new Set())}
                    disabled={submitting}
                    className="text-xs px-2.5 py-1 rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 font-medium transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-500 mb-3">
                ADMIN-only permissions are not listed here — they can never be granted to this role.
              </p>
              <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
                {assignableCategories.map((cat) => {
                  const catPerms = groupedAssignable.get(cat) ?? [];
                  if (catPerms.length === 0) return null;
                  const catChecked = catPerms.every((p) => selectedPerms.has(p.key));
                  const catSomeChecked = catPerms.some((p) => selectedPerms.has(p.key));
                  return (
                    <div key={cat} className="border border-gray-100 rounded-xl overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-3 bg-gray-50/70">
                        <div className="flex items-center gap-2">
                          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={catChecked}
                              ref={(el) => {
                                if (el) el.indeterminate = !catChecked && catSomeChecked;
                              }}
                              onChange={(e) => toggleCategoryAll(cat, e.target.checked)}
                              disabled={submitting}
                              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-60"
                            />
                            <span className="text-sm font-semibold text-gray-800">{cat}</span>
                          </label>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-white border border-gray-200 text-gray-600">
                            {catPerms.filter((p) => selectedPerms.has(p.key)).length}/{catPerms.length}
                          </span>
                        </div>
                      </div>
                      <div className="px-4 py-3 space-y-2.5">
                        {catPerms.map((perm) => {
                          const isChecked = selectedPerms.has(perm.key);
                          const wasAdded = isChecked && !origPermsAtOpen.has(perm.key);
                          const wasRemoved = !isChecked && origPermsAtOpen.has(perm.key);
                          const rowClass = wasAdded
                            ? 'bg-emerald-50/60 border border-emerald-100 rounded-lg px-2 -mx-2'
                            : wasRemoved
                            ? 'bg-rose-50/60 border border-rose-100 rounded-lg px-2 -mx-2'
                            : '';
                          return (
                            <div key={perm.key} className={rowClass}>
                              <label className={`flex items-start gap-3 cursor-pointer p-1 rounded transition-colors ${submitting ? 'cursor-not-allowed opacity-80' : 'hover:bg-gray-50'}`}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => togglePerm(perm.key)}
                                  disabled={submitting}
                                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0 disabled:opacity-60"
                                />
                                <div className="min-w-0 flex-1 py-0.5">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <div className="text-sm font-medium text-gray-900">{perm.name}</div>
                                    {wasAdded && (
                                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                                        ADDED
                                      </span>
                                    )}
                                    {wasRemoved && (
                                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200">
                                        REMOVED
                                      </span>
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
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-3 max-h-[55vh] overflow-y-auto pr-1">
              {allCategories.map((cat) => {
                const catPerms = groupByCategory(modal.role?.permissions ?? []).get(cat) ?? [];
                if (catPerms.length === 0) return null;
                return (
                  <div key={cat} className="border border-gray-100 rounded-xl overflow-hidden">
                    <div className="px-4 py-2.5 bg-gray-50/70 text-sm font-semibold text-gray-800">
                      {cat} <span className="text-xs font-normal text-gray-500">({catPerms.length})</span>
                    </div>
                    <div className="divide-y divide-gray-50">
                      {catPerms.map((perm) => (
                        <div key={perm.key} className="px-4 py-2.5">
                          <div className="text-sm font-medium text-gray-900">{perm.name}</div>
                          <div className="font-mono text-xs text-gray-500 mt-0.5">{perm.key}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      {/* === Confirmation dialog before replacing role permissions === */}
      <Modal
        isOpen={confirmOpen}
        onClose={() => !submitting && setConfirmOpen(false)}
        title={`Confirm permission change: ${modal.role?.role ?? ''}`}
        footer={
          <>
            <button
              onClick={() => setConfirmOpen(false)}
              disabled={submitting}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm disabled:opacity-50 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Back
            </button>
            <button
              onClick={submitModal}
              disabled={submitting}
              className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2 transition-colors"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                'Confirm & Save'
              )}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-gray-700">
          <p>
            You are about to replace the permissions of the{' '}
            <span className="font-semibold">{modal.role?.role}</span> role. This takes effect
            immediately for every signed-in user with that role.
          </p>
          <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
            <div className="text-sm font-semibold text-gray-900">
              Permissions selected: {selectedPerms.size}
            </div>
            <div className="mt-1 text-xs text-gray-600">
              Added: {diff.added.length} · Removed: {diff.removed.length}
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={alert.isOpen}
        onClose={() => setAlert({ ...alert, isOpen: false })}
        title={alert.title}
        footer={
          <button
            onClick={() => setAlert({ ...alert, isOpen: false })}
            className={`px-6 py-2 rounded-lg font-bold text-sm transition-colors ${
              alert.type === 'success'
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            OK
          </button>
        }
      >
        <div className="flex items-start gap-3">
          {alert.type === 'success' && (
            <CheckCircle2 className="h-5 w-5 text-emerald-500 mt-0.5 shrink-0" />
          )}
          {alert.type === 'info' && (
            <Info className="h-5 w-5 text-blue-500 mt-0.5 shrink-0" />
          )}
          {alert.type === 'error' && (
            <AlertTriangle className="h-5 w-5 text-rose-500 mt-0.5 shrink-0" />
          )}
          <p className="text-gray-700 whitespace-pre-wrap break-words select-text text-sm flex-1">{alert.message}</p>
        </div>
      </Modal>
    </div>
  );

  return (
    <PortalShell
      role="ADMIN"
      activePath="/admin/roles"
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

export default RolesPage;
