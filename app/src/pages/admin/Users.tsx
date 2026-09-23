import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Ban, Plus, Search, Key, Shield } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import ConfirmAction from '../../components/ConfirmAction';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import {
  usersApi,
  UserOut,
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
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-500">
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
