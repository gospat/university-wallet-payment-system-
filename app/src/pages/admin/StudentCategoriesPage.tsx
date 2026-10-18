import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Ban, Plus, Trash2, Search, RotateCcw } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import ConfirmAction from '../../components/ConfirmAction';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import {
  studentCategoriesApi,
  StudentCategory,
  CreateStudentCategoryInput,
  UpdateStudentCategoryInput,
} from '../../services/studentCategoriesApi';
import { navCounters, NavCounters, apiErrorMessage } from '../../services/api';
import { i18n } from '../../i18n/en';

type AlertState = {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'error' | 'success' | 'info';
};

const ActivePill: React.FC<{ value: boolean }> = ({ value }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${value ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600'}`}>
    {value ? 'Active' : 'Inactive'}
  </span>
);

const Field: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="text-[11px] text-gray-500 mt-1">{hint}</p>}
  </div>
);

const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm';

type ConfirmState = {
  isOpen: boolean;
  title: string;
  description: string;
  resourceLabel: string;
  onConfirm: (payload: { reason?: string }) => Promise<void> | void;
  loading: boolean;
  confirmLabel: string;
  confirmVariant: 'danger' | 'warning' | 'primary';
};

type CategoryForm = {
  name: string;
  code: string;
  description: string;
  isActive: boolean;
  sortOrder: string;
};

const emptyForm = (): CategoryForm => ({ name: '', code: '', description: '', isActive: true, sortOrder: '' });

/**
 * Student Categories — admin-managed reference data used to classify students
 * (Undergraduate, Postgraduate, Top-Up, …). Backed by a real DB table, so admins
 * can add categories without a code deployment.
 *
 * Reads require VIEW_STUDENTS (ADMIN + BURSARY); writes require MANAGE_STUDENTS
 * (ADMIN only). The server enforces this — the `canWrite` flag below only hides
 * controls from Bursary for a cleaner UX.
 */
const StudentCategoriesPage: React.FC = () => {
  const { user, logout } = useAuth();
  const brand = i18n.portals.admin.dashboardBrand;
  const userText = i18n.portals.admin.dashboardGreeting(
    `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin'
  );

  const [rows, setRows] = useState<StudentCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'error' });

  const [modal, setModal] = useState<{ open: boolean; kind: 'create' | 'edit'; initial?: StudentCategory }>({ open: false, kind: 'create' });
  const [form, setForm] = useState<CategoryForm>(emptyForm());
  const [submitting, setSubmitting] = useState(false);

  const [confirm, setConfirm] = useState<ConfirmState>({
    isOpen: false, title: '', description: '', resourceLabel: '', onConfirm: () => {}, loading: false, confirmLabel: 'Confirm', confirmVariant: 'danger',
  });

  const portalRole: 'ADMIN' | 'BURSARY' = user?.role === 'BURSARY' ? 'BURSARY' : 'ADMIN';
  // ADMIN role boundary + the canonical MANAGE_STUDENTS capability. A NORMAL
  // ADMIN without it cannot write; only a PROTECTED SUPER ADMIN bypasses.
  const catPerms = (user?.permissions as string[] | undefined) ?? [];
  const catIsSuper = user?.role === 'ADMIN' && (user as any)?.isSuperAdmin === true;
  const canWrite = portalRole === 'ADMIN' && (catIsSuper || catPerms.includes('MANAGE_STUDENTS'));

  useEffect(() => {
    navCounters().then(setNavCounts).catch(() => setNavCounts({}));
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const r = await studentCategoriesApi.list({
        page,
        limit: pageSize,
        search: q.trim() || undefined,
      });
      if (signal?.aborted) return;
      setRows(r.rows);
      setTotal(r.total);
      setTotalPages(Math.max(1, r.totalPages));
    } catch (err: unknown) {
      if (signal?.aborted) return;
      const e = err as { code?: string; name?: string };
      if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Failed to load categories', message: apiErrorMessage(err, i18n.errors.generic), type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, q]);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const openCreate = () => {
    setForm(emptyForm());
    setModal({ open: true, kind: 'create' });
  };

  const openEdit = (c: StudentCategory) => {
    setForm({
      name: c.name,
      code: c.code ?? '',
      description: c.description ?? '',
      isActive: c.isActive,
      sortOrder: c.sortOrder === null || c.sortOrder === undefined ? '' : String(c.sortOrder),
    });
    setModal({ open: true, kind: 'edit', initial: c });
  };

  const parseSortOrder = (raw: string): number | undefined => {
    const t = raw.trim();
    if (!t) return undefined;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0 || n > 9999) return undefined;
    return n;
  };

  const formValid = form.name.trim().length >= 2 && (form.code.trim() === '' || form.code.trim().length >= 2);

  const submitModal = async () => {
    if (!formValid) return;
    setSubmitting(true);
    try {
      const base: CreateStudentCategoryInput = {
        name: form.name.trim(),
        code: form.code.trim() ? form.code.trim().toUpperCase() : undefined,
        description: form.description.trim() || undefined,
        isActive: form.isActive,
        sortOrder: parseSortOrder(form.sortOrder),
      };
      if (modal.kind === 'create') {
        await studentCategoriesApi.create(base);
      } else if (modal.initial) {
        const payload: UpdateStudentCategoryInput = base;
        await studentCategoriesApi.update(modal.initial.id, payload);
      }
      setModal({ open: false, kind: 'create' });
      setAlert({
        isOpen: true,
        type: 'success',
        title: modal.kind === 'create' ? 'Category created' : 'Category updated',
        message: `The student category "${form.name.trim()}" was ${modal.kind === 'create' ? 'created' : 'updated'} successfully.`,
      });
      load();
    } catch (e: unknown) {
      setAlert({
        isOpen: true,
        type: 'error',
        title: modal.kind === 'create' ? 'Could not create category' : 'Could not update category',
        message: apiErrorMessage(e, 'Unknown error'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openDeactivate = (c: StudentCategory) => {
    setConfirm({
      isOpen: true,
      title: 'Deactivate Student Category',
      description: 'Deactivated categories are hidden from all student create/edit pickers. Students already assigned to this category keep it, and existing records are unaffected.',
      resourceLabel: `Category: ${c.name}${c.code ? ` (${c.code})` : ''}`,
      loading: false,
      confirmLabel: 'Deactivate',
      confirmVariant: 'warning',
      onConfirm: async () => {
        setConfirm((x) => ({ ...x, loading: true }));
        try {
          await studentCategoriesApi.deactivate(c.id);
          setConfirm((x) => ({ ...x, isOpen: false, loading: false }));
          load();
        } catch (e: unknown) {
          setConfirm((x) => ({ ...x, loading: false }));
          setAlert({ isOpen: true, type: 'error', title: 'Could not deactivate category', message: apiErrorMessage(e, 'Unknown error') });
        }
      },
    });
  };

  const reactivate = async (c: StudentCategory) => {
    try {
      await studentCategoriesApi.reactivate(c.id);
      load();
    } catch (e: unknown) {
      setAlert({ isOpen: true, type: 'error', title: 'Could not reactivate category', message: apiErrorMessage(e, 'Unknown error') });
    }
  };

  const openDelete = (c: StudentCategory) => {
    const studentCount = c._count?.students ?? 0;
    setConfirm({
      isOpen: true,
      title: 'Delete Student Category',
      description: 'This permanently removes the category. It is only allowed when no students are assigned to it. To keep history, deactivate instead.',
      resourceLabel: `Category: ${c.name}${c.code ? ` (${c.code})` : ''} — ${studentCount} student(s)`,
      loading: false,
      confirmLabel: 'Delete',
      confirmVariant: 'danger',
      onConfirm: async () => {
        setConfirm((x) => ({ ...x, loading: true }));
        try {
          await studentCategoriesApi.remove(c.id);
          setConfirm((x) => ({ ...x, isOpen: false, loading: false }));
          setAlert({ isOpen: true, type: 'success', title: 'Category deleted', message: `The student category "${c.name}" was deleted.` });
          load();
        } catch (e: unknown) {
          setConfirm((x) => ({ ...x, loading: false }));
          setAlert({ isOpen: true, type: 'error', title: 'Could not delete category', message: apiErrorMessage(e, 'Unknown error') });
        }
      },
    });
  };

  const content = (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Student Categories</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage the categories students can be classified under (e.g. Undergraduate, Postgraduate, Top-Up). Bursary role has read-only access.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={openCreate}
            disabled={!canWrite}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="h-4 w-4" /> Create Category
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl p-4">
        <div className="flex items-center gap-3 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              className="w-full h-9 pl-9 pr-4 rounded-lg border border-gray-200 text-sm"
              placeholder="Search name, code or description..."
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
            />
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Name</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Code</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Description</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">Students</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">Sort</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">Status</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-500">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-500">No student categories found.</td></tr>
              )}
              {rows.map((c) => {
                const studentCount = c._count?.students ?? 0;
                const deleteBlocked = studentCount > 0;
                return (
                  <tr key={c.id} className="hover:bg-gray-50/60">
                    <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-800">{c.code ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600 max-w-md truncate">{c.description ?? '—'}</td>
                    <td className="px-4 py-3 text-center text-gray-800">{studentCount}</td>
                    <td className="px-4 py-3 text-center text-gray-800">{c.sortOrder ?? '—'}</td>
                    <td className="px-4 py-3 text-center"><ActivePill value={c.isActive} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1 text-xs">
                        <button
                          onClick={() => openEdit(c)}
                          disabled={!canWrite}
                          className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 px-2 py-1 rounded hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </button>
                        {c.isActive ? (
                          <button
                            onClick={() => openDeactivate(c)}
                            disabled={!canWrite}
                            className="inline-flex items-center gap-1 text-amber-700 hover:text-amber-900 px-2 py-1 rounded hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <Ban className="h-3.5 w-3.5" /> Deactivate
                          </button>
                        ) : (
                          <button
                            onClick={() => reactivate(c)}
                            disabled={!canWrite}
                            className="inline-flex items-center gap-1 text-emerald-700 hover:text-emerald-900 px-2 py-1 rounded hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> Reactivate
                          </button>
                        )}
                        <button
                          onClick={() => openDelete(c)}
                          disabled={!canWrite || deleteBlocked}
                          title={deleteBlocked ? `Cannot delete — ${studentCount} student(s) are assigned to this category. Deactivate it instead.` : 'Delete category'}
                          className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 px-2 py-1 rounded bg-red-50 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50/50 text-sm text-gray-600">
          <div>Showing {rows.length} of {total}</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50"
            >
              Prev
            </button>
            <span className="font-medium text-gray-900 min-w-[4rem] text-center">Page {page} of {totalPages}</span>
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
        title={modal.kind === 'create' ? 'Create Student Category' : `Edit Student Category: ${modal.initial?.name ?? ''}`}
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
              disabled={submitting || !formValid}
              className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2"
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Name">
            <input
              className={inputCls}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Undergraduate"
            />
          </Field>
          <Field label="Code" hint="Optional. Auto-uppercased. Must be at least 2 characters.">
            <input
              className={inputCls}
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="e.g. UNDERGRADUATE"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description" hint="Optional. Max 500 characters.">
              <textarea
                rows={2}
                maxLength={500}
                className={inputCls}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Optional description"
              />
            </Field>
          </div>
          <Field label="Sort Order" hint="Optional. 0–9999. Lower numbers appear first in pickers.">
            <input
              type="number"
              min={0}
              max={9999}
              className={inputCls}
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
              placeholder="e.g. 10"
            />
          </Field>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
              <span>Active</span>
            </label>
          </div>
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
        confirmVariant={confirm.confirmVariant}
        confirmLabel={confirm.confirmLabel}
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
        <p className="text-gray-700 whitespace-pre-wrap break-words select-text text-sm">{alert.message}</p>
      </Modal>
    </div>
  );

  const activePathPrefix = portalRole === 'BURSARY' ? '/bursary' : '/admin';

  return (
    <PortalShell
      role={portalRole}
      activePath={`${activePathPrefix}/academic/student-categories`}
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

export default StudentCategoriesPage;
