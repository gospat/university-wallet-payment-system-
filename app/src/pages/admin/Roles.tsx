import React, { useCallback, useEffect, useState } from 'react';
import { Shield, Plus, Pencil, ChevronDown, ChevronRight } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import { rolesApi, permissionsApi, RoleOut, PermissionOut } from '../../services/adminApi';
import { navCounters, NavCounters } from '../../services/api';
import { i18n } from '../../i18n/en';

type AlertState = {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'error' | 'success' | 'info';
};

const ROLE_META: Record<'ADMIN' | 'BURSARY', { name: string; description: string; badgeClass: string }> = {
  ADMIN: {
    name: 'ADMIN',
    description: 'Full system administrator with broad access to manage users, roles, academic structure, and system-wide settings.',
    badgeClass: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  },
  BURSARY: {
    name: 'BURSARY',
    description: 'Finance and operations role for managing bills, payments, receipts, refunds, and student financial records.',
    badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  },
};

const PERMISSION_CATEGORIES = ['Students', 'Fees', 'Payments', 'Admin'] as const;
type PermissionCategory = typeof PERMISSION_CATEGORIES[number];

const normalizeCategory = (raw: string): PermissionCategory => {
  const up = raw.toUpperCase();
  if (up.includes('STUDENT')) return 'Students';
  if (up.includes('FEE') || up.includes('BILL') || up.includes('INVOICE')) return 'Fees';
  if (up.includes('PAYMENT') || up.includes('RECEIPT') || up.includes('REFUND') || up.includes('TRANSACTION')) return 'Payments';
  return 'Admin';
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
  </div>
);

const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm';

const RolesPage: React.FC = () => {
  const { user, logout } = useAuth();
  const brand = i18n.portals.admin.dashboardBrand;
  const userText = i18n.portals.admin.dashboardGreeting(
    `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin'
  );

  const [roles, setRoles] = useState<RoleOut[]>([]);
  const [allPermissions, setAllPermissions] = useState<PermissionOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'error' });

  const [modal, setModal] = useState<{ open: boolean; kind: 'create' | 'edit'; role?: RoleOut }>({ open: false, kind: 'create' });
  const [selectedRole, setSelectedRole] = useState<'ADMIN' | 'BURSARY'>('ADMIN');
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [expandedCats, setExpandedCats] = useState<Set<PermissionCategory>>(new Set(PERMISSION_CATEGORIES));

  useEffect(() => {
    navCounters().then(setNavCounts).catch(() => setNavCounts({}));
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [rolesData, permsData] = await Promise.all([rolesApi.list(), permissionsApi.list()]);
      const filtered = rolesData.filter((r) => r.role === 'ADMIN' || r.role === 'BURSARY');
      setRoles(filtered);
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

  const toggleCat = (cat: PermissionCategory) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const groupPermsByCategory = <T extends { category: string }>(perms: T[]): Record<PermissionCategory, T[]> => {
    const result: Record<PermissionCategory, T[]> = { Students: [], Fees: [], Payments: [], Admin: [] };
    perms.forEach((p) => {
      result[normalizeCategory(p.category)].push(p);
    });
    return result;
  };

  const openCreate = () => {
    setSelectedRole('ADMIN');
    setSelectedPerms(new Set(allPermissions.map((p) => p.key)));
    setExpandedCats(new Set(PERMISSION_CATEGORIES));
    setModal({ open: true, kind: 'create' });
  };

  const openEdit = (role: RoleOut) => {
    setSelectedRole(role.role);
    setSelectedPerms(new Set(role.permissions.map((p) => p.key)));
    setExpandedCats(new Set(PERMISSION_CATEGORIES));
    setModal({ open: true, kind: 'edit', role });
  };

  const togglePerm = (key: string) => {
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleCategoryAll = (cat: PermissionCategory, checked: boolean) => {
    const grouped = groupPermsByCategory(allPermissions);
    const catKeys = grouped[cat].map((p) => p.key);
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (checked) {
        catKeys.forEach((k) => next.add(k));
      } else {
        catKeys.forEach((k) => next.delete(k));
      }
      return next;
    });
  };

  const submitModal = async () => {
    const permissionKeys = Array.from(selectedPerms);
    setSubmitting(true);
    try {
      if (modal.kind === 'create') {
        await rolesApi.assignPermissions(selectedRole, permissionKeys);
      } else if (modal.role) {
        await rolesApi.update(modal.role.role, { permissionKeys });
      }
      setModal({ open: false, kind: 'create' });
      load();
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Failed to save', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const groupedAllPerms = groupPermsByCategory(allPermissions);

  const content = (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Roles</h1>
          <p className="text-sm text-gray-500 mt-1">Manage system roles and assign permissions.</p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm"
        >
          <Plus className="h-4 w-4" /> Create Role
        </button>
      </div>

      {loading && roles.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center text-gray-500">Loading…</div>
      )}

      {!loading && roles.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center text-gray-500">No roles found.</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {roles.map((role) => {
          const meta = ROLE_META[role.role];
          const grouped = groupPermsByCategory(role.permissions);
          return (
            <div key={role.role} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
              <div className="p-6 border-b border-gray-100">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <Shield className={`h-5 w-5 ${role.role === 'ADMIN' ? 'text-indigo-600' : 'text-emerald-600'}`} />
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-bold border ${meta.badgeClass}`}>
                        {meta.name}
                      </span>
                    </div>
                    <div className="text-xl font-bold text-gray-900 mt-1">{role.name}</div>
                    <p className="text-sm text-gray-500 mt-1">{role.description}</p>
                  </div>
                  <button
                    onClick={() => openEdit(role)}
                    className="inline-flex items-center gap-1.5 text-blue-700 hover:text-blue-900 px-3 py-1.5 rounded-lg hover:bg-blue-50 text-sm font-medium shrink-0"
                  >
                    <Pencil className="h-4 w-4" /> Edit
                  </button>
                </div>
              </div>

              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">
                    Assigned permissions ({role.permissionsCount})
                  </h3>
                </div>

                <div className="space-y-4">
                  {PERMISSION_CATEGORIES.map((cat) => {
                    const catPerms = grouped[cat];
                    if (catPerms.length === 0) return null;
                    return (
                      <div key={cat} className="border border-gray-100 rounded-xl overflow-hidden">
                        <button
                          type="button"
                          onClick={() => toggleCat(cat)}
                          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50/70 hover:bg-gray-50"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-gray-800">{cat}</span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-white border border-gray-200 text-gray-600">
                              {catPerms.length}
                            </span>
                          </div>
                          {expandedCats.has(cat) ? (
                            <ChevronDown className="h-4 w-4 text-gray-500" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-gray-500" />
                          )}
                        </button>
                        {expandedCats.has(cat) && (
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

      <Modal
        isOpen={modal.open}
        onClose={() => !submitting && setModal({ open: false, kind: 'create' })}
        title={modal.kind === 'create' ? 'Create Role' : `Edit Role: ${modal.role ? ROLE_META[modal.role.role].name : ''}`}
        footer={
          <>
            <button
              onClick={() => setModal({ open: false, kind: 'create' })}
              disabled={submitting}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={submitModal}
              disabled={submitting}
              className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2"
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Role Name">
              {modal.kind === 'edit' ? (
                <div className={`${inputCls} bg-gray-50 font-bold border-gray-200 ${ROLE_META[selectedRole].badgeClass}`}>
                  {ROLE_META[selectedRole].name}
                </div>
              ) : (
                <select
                  className={inputCls}
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value as 'ADMIN' | 'BURSARY')}
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="BURSARY">BURSARY</option>
                </select>
              )}
            </Field>
            <Field label="Description">
              <div className={`${inputCls} bg-gray-50 text-gray-600 border-gray-200 text-xs leading-relaxed`}>
                {ROLE_META[selectedRole].description}
              </div>
            </Field>
          </div>

          <div className="pt-2 border-t border-gray-100">
            <div className="text-sm font-semibold text-gray-800 mb-3">
              Permissions ({selectedPerms.size}/{allPermissions.length})
            </div>
            <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
              {PERMISSION_CATEGORIES.map((cat) => {
                const catPerms = groupedAllPerms[cat];
                if (catPerms.length === 0) return null;
                const catChecked = catPerms.every((p) => selectedPerms.has(p.key));
                const catSomeChecked = catPerms.some((p) => selectedPerms.has(p.key));
                return (
                  <div key={cat} className="border border-gray-100 rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 bg-gray-50/70">
                      <div className="flex items-center gap-2">
                        <label className="inline-flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={catChecked}
                            ref={(el) => {
                              if (el) el.indeterminate = !catChecked && catSomeChecked;
                            }}
                            onChange={(e) => toggleCategoryAll(cat, e.target.checked)}
                            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
                        return (
                          <label key={perm.key} className="flex items-start gap-3 cursor-pointer p-1 -mx-1 rounded hover:bg-gray-50">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => togglePerm(perm.key)}
                              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium text-gray-900">{perm.name}</div>
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
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold text-sm"
          >
            OK
          </button>
        }
      >
        <p className="text-gray-700 whitespace-pre-wrap break-words select-text text-sm">{alert.message}</p>
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
