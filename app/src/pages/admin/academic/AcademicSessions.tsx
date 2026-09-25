import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Ban, Plus, Search } from 'lucide-react';
import PortalShell from '../../../components/PortalShell';
import ConfirmAction from '../../../components/ConfirmAction';
import Modal from '../../../components/Modal';
import { useAuth } from '../../../context/AuthContext';
import { sessionsApi, AcademicSessionOut, CreateSessionInput, UpdateSessionInput } from '../../../services/academicApi';
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
};

const AcademicSessionsPage: React.FC = () => {
  const { user, logout } = useAuth();
  const brand = i18n.portals.admin.dashboardBrand;
  const userText = i18n.portals.admin.dashboardGreeting(
    `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin'
  );

  const [rows, setRows] = useState<AcademicSessionOut[]>([]);
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

  const [modal, setModal] = useState<{ open: boolean; kind: 'create' | 'edit'; initial?: AcademicSessionOut }>({ open: false, kind: 'create' });
  const [form, setForm] = useState<{ name: string; code: string; startDate: string; endDate: string; isCurrent: boolean; isActive: boolean }>({ name: '', code: '', startDate: '', endDate: '', isCurrent: false, isActive: true });
  const [submitting, setSubmitting] = useState(false);

  const [confirm, setConfirm] = useState<ConfirmState>({
    isOpen: false, title: '', description: '', resourceLabel: '', onConfirm: () => {}, loading: false,
  });

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params: any = { page, pageSize };
      if (q.trim()) params.q = q.trim();
      const r = await sessionsApi.list(params);
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

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm({ name: '', code: '', startDate: '', endDate: '', isCurrent: false, isActive: true });
    setModal({ open: true, kind: 'create' });
  };

  const openEdit = (s: AcademicSessionOut) => {
    setForm({
      name: s.name,
      code: s.code,
      startDate: s.startDate ? new Date(s.startDate).toISOString().slice(0, 10) : '',
      endDate: s.endDate ? new Date(s.endDate).toISOString().slice(0, 10) : '',
      isCurrent: !!s.isCurrent,
      isActive: s.isActive,
    });
    setModal({ open: true, kind: 'edit', initial: s });
  };

  const submitModal = async () => {
    if (!form.name.trim() || !form.code.trim()) return;
    setSubmitting(true);
    try {
      if (modal.kind === 'create') {
        const payload: CreateSessionInput = {
          name: form.name.trim(),
          code: form.code.trim().toUpperCase(),
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
          isCurrent: form.isCurrent,
          isActive: form.isActive,
        };
        await sessionsApi.create(payload);
      } else if (modal.initial) {
        const payload: UpdateSessionInput = {
          name: form.name.trim(),
          code: form.code.trim().toUpperCase(),
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
          isCurrent: form.isCurrent,
          isActive: form.isActive,
        };
        await sessionsApi.update(modal.initial.id, payload);
      }
      setModal({ open: false, kind: 'create' });
      load();
    } catch (e: any) {
      setAlert({
        isOpen: true,
        type: 'error',
        title: modal.kind === 'create' ? 'Could not create session' : 'Could not update session',
        message: e?.response?.data?.message ?? e?.message ?? String(e ?? 'Unknown error'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openDeactivate = (s: AcademicSessionOut) => {
    setConfirm({
      isOpen: true,
      title: 'Deactivate Academic Session',
      description: 'This will deactivate this session. Active children that reference it (if any) will prevent deactivation.',
      resourceLabel: `Session: ${s.name} (${s.code})`,
      loading: false,
      onConfirm: async () => {
        setConfirm((c) => ({ ...c, loading: true }));
        try {
          await sessionsApi.deactivate(s.id);
          setConfirm((c) => ({ ...c, isOpen: false, loading: false }));
          load();
        } catch (e: any) {
          setConfirm((c) => ({ ...c, loading: false }));
          setAlert({
            isOpen: true,
            type: 'error',
            title: 'Could not deactivate session',
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
          <h1 className="text-2xl font-bold text-gray-900">Academic Sessions</h1>
          <p className="text-sm text-gray-500 mt-1">Manage academic sessions (e.g. 2024/2025). Bursary role has read-only access.</p>
        </div>
        <button onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm">
          <Plus className="h-4 w-4" /> Create Session
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl p-4">
        <div className="flex items-center gap-3 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input className="w-full h-9 pl-9 pr-4 rounded-lg border border-gray-200 text-sm" placeholder="Search name or code..." value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
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
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Start Date</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">End Date</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">Current</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">IsActive</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (rows?.length ?? 0) === 0 && (<tr><td colSpan={7} className="px-4 py-12 text-center text-gray-500">Loading…</td></tr>)}
              {!loading && (rows?.length ?? 0) === 0 && (<tr><td colSpan={7} className="px-4 py-12 text-center text-gray-500">No sessions found.</td></tr>)}
              {rows.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50/60">
                  <td className="px-4 py-3 font-medium text-gray-900">{s.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-800">{s.code}</td>
                  <td className="px-4 py-3 text-gray-700">{s.startDate ? new Date(s.startDate).toLocaleDateString() : '—'}</td>
                  <td className="px-4 py-3 text-gray-700">{s.endDate ? new Date(s.endDate).toLocaleDateString() : '—'}</td>
                  <td className="px-4 py-3 text-center"><ActivePill value={!!s.isCurrent} /></td>
                  <td className="px-4 py-3 text-center"><ActivePill value={s.isActive} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1 text-xs">
                      <button onClick={() => openEdit(s)} className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 px-2 py-1 rounded hover:bg-blue-50">
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      <button onClick={() => openDeactivate(s)} disabled={!s.isActive} className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 px-2 py-1 rounded hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed">
                        <Ban className="h-3.5 w-3.5" /> Deactivate
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
        title={modal.kind === 'create' ? 'Create Academic Session' : `Edit Session: ${modal.initial?.name ?? ''}`}
        footer={
          <>
            <button onClick={() => setModal({ open: false, kind: 'create' })} className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm">Cancel</button>
            <button onClick={submitModal} disabled={submitting || !form.name.trim() || !form.code.trim()} className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2">
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Name">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. 2024/2025 Academic Session" />
          </Field>
          <Field label="Code">
            <input className={inputCls} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="e.g. 2024/2025" />
          </Field>
          <Field label="Start Date">
            <input type="date" className={inputCls} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </Field>
          <Field label="End Date">
            <input type="date" className={inputCls} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
          <div className="sm:col-span-2 flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.isCurrent} onChange={(e) => setForm({ ...form, isCurrent: e.target.checked })} />
              <span>Is Current Session</span>
            </label>
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
        confirmVariant="danger"
        confirmLabel="Deactivate"
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

  const portalRole: 'ADMIN' | 'BURSARY' = user?.role === 'BURSARY' ? 'BURSARY' : 'ADMIN';
  const activePathPrefix = portalRole === 'BURSARY' ? '/bursary' : '/admin';

  return (
    <PortalShell role={portalRole} activePath={`${activePathPrefix}/academic/sessions`} brand={brand} userText={userText} userEmail={user?.email} onLogout={logout} userPermissions={user?.permissions} navCounters={navCounts}
      showGlobalSearch>
      {content}
    </PortalShell>
  );
};

export default AcademicSessionsPage;
