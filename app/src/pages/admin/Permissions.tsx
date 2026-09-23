import React, { useCallback, useEffect, useState } from 'react';
import { Shield, Search, ChevronDown, ChevronRight } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import { permissionsApi, PermissionOut } from '../../services/adminApi';
import { navCounters, NavCounters } from '../../services/api';
import { i18n } from '../../i18n/en';

type AlertState = {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'error' | 'success' | 'info';
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

const ROLE_BADGE: Record<string, string> = {
  ADMIN: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  BURSARY: 'bg-emerald-100 text-emerald-800 border-emerald-200',
};

const PermissionsPage: React.FC = () => {
  const { user, logout } = useAuth();
  const brand = i18n.portals.admin.dashboardBrand;
  const userText = i18n.portals.admin.dashboardGreeting(
    `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin'
  );

  const [permissions, setPermissions] = useState<PermissionOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'error' });
  const [q, setQ] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<PermissionCategory>>(new Set());

  useEffect(() => {
    navCounters().then(setNavCounts).catch(() => setNavCounts({}));
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const data = await permissionsApi.list();
      setPermissions(data);
      const grouped = groupPermsByCategory(data);
      const initialExpanded = new Set<PermissionCategory>();
      if (grouped['Students'].length > 0) {
        initialExpanded.add('Students');
      }
      setExpandedCats(initialExpanded);
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

  const groupPermsByCategory = (perms: PermissionOut[]): Record<PermissionCategory, PermissionOut[]> => {
    const result: Record<PermissionCategory, PermissionOut[]> = { Students: [], Fees: [], Payments: [], Admin: [] };
    perms.forEach((p) => {
      result[normalizeCategory(p.category)].push(p);
    });
    return result;
  };

  const toggleCat = (cat: PermissionCategory) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const filteredPermissions = q.trim()
    ? permissions.filter((p) => {
        const query = q.trim().toLowerCase();
        return (
          p.name.toLowerCase().includes(query) ||
          p.key.toLowerCase().includes(query) ||
          (p.description ?? '').toLowerCase().includes(query)
        );
      })
    : permissions;

  const grouped = groupPermsByCategory(filteredPermissions);

  const content = (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Permissions</h1>
          <p className="text-sm text-gray-500 mt-1">Reference of all system permissions and the roles they are assigned to.</p>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl p-4">
        <div className="flex items-center gap-3 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              className="w-full h-9 pl-9 pr-4 rounded-lg border border-gray-200 text-sm"
              placeholder="Search permissions…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
      </div>

      {loading && permissions.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center text-gray-500">Loading…</div>
      )}

      {!loading && permissions.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center text-gray-500">No permissions found.</div>
      )}

      {!loading && filteredPermissions.length === 0 && q.trim() && (
        <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center text-gray-500">No permissions match "{q}".</div>
      )}

      <div className="space-y-3">
        {PERMISSION_CATEGORIES.map((cat) => {
          const catPerms = grouped[cat];
          if (catPerms.length === 0 && !q.trim()) return null;
          const isExpanded = expandedCats.has(cat);
          return (
            <div key={cat} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
              <button
                type="button"
                onClick={() => toggleCat(cat)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50/70 transition-colors"
                aria-expanded={isExpanded}
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? (
                    <ChevronDown className="h-5 w-5 text-gray-500 shrink-0" />
                  ) : (
                    <ChevronRight className="h-5 w-5 text-gray-500 shrink-0" />
                  )}
                  <Shield className={`h-5 w-5 shrink-0 ${
                    cat === 'Students' ? 'text-blue-600' :
                    cat === 'Fees' ? 'text-amber-600' :
                    cat === 'Payments' ? 'text-emerald-600' :
                    'text-gray-600'
                  }`} />
                  <div className="text-left">
                    <div className="text-lg font-bold text-gray-900">{cat}</div>
                  </div>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-700 border border-gray-200">
                    {catPerms.length}
                  </span>
                </div>
              </button>

              {isExpanded && (
                <div className="px-5 pb-5 pt-1 space-y-3">
                  {catPerms.length === 0 ? (
                    <div className="text-sm text-gray-500 py-6 text-center">No permissions in this category match your search.</div>
                  ) : (
                    catPerms.map((perm) => (
                      <div
                        key={perm.key}
                        className="border border-gray-100 rounded-xl p-4 bg-gray-50/30 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex flex-col gap-3">
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <h4 className="text-base font-bold text-gray-900">{perm.name}</h4>
                              <div className="mt-1">
                                <code className="font-mono bg-gray-100 inline-block px-2 py-0.5 text-xs text-gray-700 rounded border border-gray-200">
                                  {perm.key}
                                </code>
                              </div>
                              {perm.description && (
                                <p className="text-sm text-gray-600 mt-2 leading-relaxed">{perm.description}</p>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
                            <span className="text-xs font-medium text-gray-500">Roles assigned:</span>
                            {perm.roles_assigned.length === 0 ? (
                              <span className="text-xs text-gray-400 italic">None</span>
                            ) : (
                              perm.roles_assigned.map((roleName) => (
                                <span
                                  key={roleName}
                                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                                    ROLE_BADGE[roleName] ?? 'bg-gray-100 text-gray-800 border-gray-200'
                                  }`}
                                >
                                  {roleName}
                                </span>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

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
      activePath="/admin/permissions"
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

export default PermissionsPage;
