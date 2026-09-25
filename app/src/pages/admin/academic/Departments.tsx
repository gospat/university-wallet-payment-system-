import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Ban, Plus, Trash2, Search, Download, UploadCloud } from 'lucide-react';
import PortalShell from '../../../components/PortalShell';
import ConfirmAction from '../../../components/ConfirmAction';
import Modal from '../../../components/Modal';
import { useAuth } from '../../../context/AuthContext';
import { departmentsApi, DepartmentOut, CreateDepartmentInput, UpdateDepartmentInput, facultiesApi, FacultyOut, templateDownloadUrl, departmentsTemplateXlsxUrl, BulkImportResult } from '../../../services/academicApi';
import BulkImportModal from '../../../components/academic/BulkImportModal';
import { navCounters, NavCounters } from '../../../services/api';
import { i18n } from '../../../i18n/en';

type AlertState = {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'error' | 'success' | 'info';
};

const ActivePill: React.FC<{ value: boolean }> = ({ value }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${value ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600'}`}>
    {value ? 'Yes' : 'No'}
  </span>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
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

const DepartmentsPage: React.FC = () => {
  const { user, logout } = useAuth();
  const brand = i18n.portals.admin.dashboardBrand;
  const userText = i18n.portals.admin.dashboardGreeting(
    `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin'
  );

  const [rows, setRows] = useState<DepartmentOut[]>([]);
  const [faculties, setFaculties] = useState<FacultyOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'error' });

  useEffect(() => {
    navCounters().then(setNavCounts).catch(() => setNavCounts({}));
  }, []);

  const [modal, setModal] = useState<{ open: boolean; kind: 'create' | 'edit'; initial?: DepartmentOut }>({ open: false, kind: 'create' });
  const [form, setForm] = useState<{ name: string; code: string; facultyId: string; description: string; isActive: boolean }>({ name: '', code: '', facultyId: '', description: '', isActive: true });
  const [submitting, setSubmitting] = useState(false);

  const [confirm, setConfirm] = useState<ConfirmState>({
    isOpen: false, title: '', description: '', resourceLabel: '', onConfirm: () => {}, loading: false, confirmLabel: 'Confirm', confirmVariant: 'danger',
  });

  const portalRole: 'ADMIN' | 'BURSARY' = user?.role === 'BURSARY' ? 'BURSARY' : 'ADMIN';
  const canWrite = portalRole === 'ADMIN';

  const loadFaculties = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await facultiesApi.list({ pageSize: 500, isActive: true });
      setFaculties(r?.items ?? []);
    } catch (err: any) {
      if (signal?.aborted) return;
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
    }
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params: any = { page, pageSize };
      if (q.trim()) params.q = q.trim();
      const r = await departmentsApi.list(params);
      setRows(r?.items ?? []);
      setTotal(r?.total ?? 0);
    } catch (err: any) {
      if (signal?.aborted) return;
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Failed to load', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, q]);

  useEffect(() => { load(); loadFaculties(); }, [load, loadFaculties]);

  const [bulkModal, setBulkModal] = useState(false);

  const handleBulkSuccess = (_r: BulkImportResult) => {
    load();
    loadFaculties();
  };

  const doDownloadTemplate = () => {
    const directUrl = templateDownloadUrl('department');
    const a = document.createElement('a');
    a.href = directUrl;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const doDownloadTemplateXlsx = () => {
    const directUrl = departmentsTemplateXlsxUrl();
    const a = document.createElement('a');
    a.href = directUrl;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openCreate = () => {
    setForm({ name: '', code: '', facultyId: faculties[0]?.id ? String(faculties[0].id) : '', description: '', isActive: true });
    setModal({ open: true, kind: 'create' });
  };

  const openEdit = (d: DepartmentOut) => {
    setForm({ name: d.name, code: d.code, facultyId: String(d.facultyId), description: d.description ?? '', isActive: d.isActive });
    setModal({ open: true, kind: 'edit', initial: d });
  };

  const submitModal = async () => {
    if (!form.name.trim() || !form.code.trim() || !form.facultyId) return;
    setSubmitting(true);
    try {
      const facultyId = Number(form.facultyId);
      if (modal.kind === 'create') {
        const payload: CreateDepartmentInput = {
          name: form.name.trim(),
          code: form.code.trim().toUpperCase(),
          facultyId,
          description: form.description.trim() || undefined,
          isActive: form.isActive,
        };
        await departmentsApi.create(payload);
      } else if (modal.initial) {
        const payload: UpdateDepartmentInput = {
          name: form.name.trim(),
          code: form.code.trim().toUpperCase(),
          facultyId,
          description: form.description.trim() || undefined,
          isActive: form.isActive,
        };
        await departmentsApi.update(modal.initial.id, payload);
      }
      setModal({ open: false, kind: 'create' });
      load();
    } catch (e: any) {
      setAlert({
        isOpen: true,
        type: 'error',
        title: modal.kind === 'create' ? 'Could not create department' : 'Could not update department',
        message: e?.response?.data?.message ?? e?.message ?? String(e ?? 'Unknown error'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openDeactivate = (d: DepartmentOut) => {
    setConfirm({
      isOpen: true,
      title: 'Deactivate Department',
      description: 'This will deactivate this department. Active children that reference it (if any) will prevent deactivation.',
      resourceLabel: `Department: ${d.name} (${d.code})`,
      loading: false,
      confirmLabel: 'Deactivate',
      confirmVariant: 'danger',
      onConfirm: async () => {
        setConfirm((c) => ({ ...c, loading: true }));
        try {
          await departmentsApi.deactivate(d.id);
          setConfirm((c) => ({ ...c, isOpen: false, loading: false }));
          load();
        } catch (e: any) {
          setConfirm((c) => ({ ...c, loading: false }));
          setAlert({
            isOpen: true,
            type: 'error',
            title: 'Could not deactivate department',
            message: e?.response?.data?.message ?? e?.message ?? String(e ?? 'Unknown error'),
          });
        }
      },
    });
  };

  const openDelete = (d: DepartmentOut) => {
    setConfirm({
      isOpen: true,
      title: 'Delete Department (permanent)',
      description: 'This will PERMANENTLY delete this department and all of its structure/history. It CANNOT be undone. If any programmes, students, or fees still reference this department, you will see a detailed error telling you exactly what must be removed first. To keep history and preserve references, use Deactivate (soft-delete) instead.',
      resourceLabel: `Department: ${d.name} (${d.code})`,
      loading: false,
      confirmLabel: 'Delete',
      confirmVariant: 'danger',
      onConfirm: async () => {
        setConfirm((c) => ({ ...c, loading: true }));
        try {
          await departmentsApi.remove(d.id);
          setConfirm((c) => ({ ...c, isOpen: false, loading: false }));
          load();
        } catch (e: any) {
          setConfirm((c) => ({ ...c, loading: false }));
          setAlert({
            isOpen: true,
            type: 'error',
            title: 'Could not delete department',
            message: e?.response?.data?.message ?? e?.message ?? String(e ?? 'Unknown error'),
          });
        }
      },
    });
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const content = (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Departments</h1>
          <p className="text-sm text-gray-500 mt-1">Manage academic departments within colleges. Bursary role has read-only access.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canWrite && (
            <>
              <button
                onClick={doDownloadTemplate}
                className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 rounded-lg font-medium text-sm"
              >
                <Download className="h-4 w-4" /> Download CSV Template
              </button>
              <button
                onClick={doDownloadTemplateXlsx}
                className="inline-flex items-center gap-2 px-3 py-2 border border-green-300 bg-green-50 hover:bg-green-100 text-green-700 rounded-lg font-medium text-sm"
              >
                📗 Download .XLSX Template (2 sheets)
              </button>
              <button
                onClick={() => setBulkModal(true)}
                className="inline-flex items-center gap-2 px-3 py-2 border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 rounded-lg font-medium text-sm"
              >
                <UploadCloud className="h-4 w-4" /> Upload CSV / Excel
              </button>
            </>
          )}
          <button
            onClick={openCreate}
            disabled={!canWrite}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="h-4 w-4" /> Create Department
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl p-4">
        <div className="flex items-center gap-3 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              className="w-full h-9 pl-9 pr-4 rounded-lg border border-gray-200 text-sm"
              placeholder="Search name or code..."
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
                <th className="px-4 py-3 text-left font-semibold text-gray-700">College</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">IsActive</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (rows?.length ?? 0) === 0 && (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-500">Loading…</td></tr>
              )}
              {!loading && (rows?.length ?? 0) === 0 && (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-500">No departments found.</td></tr>
              )}
              {rows.map((d) => (
                <tr key={d.id} className="hover:bg-gray-50/60">
                  <td className="px-4 py-3 font-medium text-gray-900">{d.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-800">{d.code}</td>
                  <td className="px-4 py-3 text-gray-700">{d.faculty?.name ?? faculties.find((f) => f.id === d.facultyId)?.name ?? `#${d.facultyId}`}</td>
                  <td className="px-4 py-3 text-center"><ActivePill value={d.isActive} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1 text-xs">
                      <button
                        onClick={() => openEdit(d)}
                        className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 px-2 py-1 rounded hover:bg-blue-50"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button
                        onClick={() => openDeactivate(d)}
                        disabled={!d.isActive}
                        className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 px-2 py-1 rounded hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Ban className="h-3.5 w-3.5" /> Deactivate
                      </button>
                      <button
                        onClick={() => openDelete(d)}
                        className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 px-2 py-1 rounded bg-red-50 hover:bg-red-100"
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
          <div>Showing {(rows?.length ?? 0)} of {total}</div>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50">Prev</button>
            <span className="font-medium text-gray-900 min-w-[4rem] text-center">Page {page} of {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50">Next</button>
          </div>
        </div>
      </div>

      <Modal
        isOpen={modal.open}
        onClose={() => setModal({ open: false, kind: 'create' })}
        title={modal.kind === 'create' ? 'Create Department' : `Edit Department: ${modal.initial?.name ?? ''}`}
        footer={
          <>
            <button onClick={() => setModal({ open: false, kind: 'create' })} className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm">Cancel</button>
            <button onClick={submitModal} disabled={submitting || !form.name.trim() || !form.code.trim() || !form.facultyId} className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2">
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="College">
            <select className={inputCls} value={form.facultyId} onChange={(e) => setForm({ ...form, facultyId: e.target.value })}>
              <option value="">Select college…</option>
              {faculties.map((f) => <option key={f.id} value={String(f.id)}>{f.code} — {f.name}</option>)}
            </select>
          </Field>
          <div />
          <Field label="Name">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Department of Computer Science" />
          </Field>
          <Field label="Code">
            <input className={inputCls} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="e.g. CSC" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description">
              <textarea rows={2} className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional description" />
            </Field>
          </div>
          <div className="sm:col-span-2">
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

      <BulkImportModal
        kind="department"
        isOpen={bulkModal}
        onClose={() => setBulkModal(false)}
        onSuccess={handleBulkSuccess}
      />
    </div>
  );

  const activePathPrefix = portalRole === 'BURSARY' ? '/bursary' : '/admin';

  return (
    <PortalShell
      role={portalRole}
      activePath={`${activePathPrefix}/academic/departments`}
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

export default DepartmentsPage;
