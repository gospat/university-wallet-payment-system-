import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Info,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { auditApi, AuditLog, AuditLogFilters } from '../../services/audit';
import i18n from '../../i18n/en';
import Modal from '../../components/Modal';
import { useLocation } from 'react-router-dom';
import { navCounters, NavCounters } from '../../services/api';

const fmtDateTime = (s?: string | null) =>
  s
    ? new Date(s).toLocaleString('en-NG', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const DEFAULT_PAGE_SIZE = 25;

const ENTITY_OPTIONS = [
  'USER', 'WALLET', 'TRANSACTION', 'INVOICE', 'RECEIPT',
  'FEE', 'FEE_CATEGORY', 'FEE_ASSIGNMENT', 'REFUND', 'STUDENT_IMPORT',
  'WEBHOOK_EVENT', 'GENERAL_LEDGER', 'WALLET_LEDGER',
];
const ACTION_OPTIONS = [
  'CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'DEPOSIT',
  'WITHDRAWAL', 'TRANSFER', 'FEE_PAYMENT', 'REFUND', 'APPROVE', 'REJECT',
  'IMPORT', 'VOID', 'VERIFY',
];

const roleChip = (role?: string) =>
  role === 'ADMIN'
    ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200'
    : role === 'BURSARY'
    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
    : role === 'STUDENT'
    ? 'bg-sky-50 text-sky-700 ring-1 ring-sky-200'
    : 'bg-slate-50 text-slate-600 ring-1 ring-slate-200';

const AdminAuditLogs: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<AuditLog[]>([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState<number>(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [filters, setFilters] = useState<AuditLogFilters>({
    action: '',
    entity: '',
    entityId: undefined,
    userId: undefined,
    dateFrom: '',
    dateTo: '',
  });
  const [detail, setDetail] = useState<AuditLog | null>(null);
  const [navCounts, setNavCounts] = useState<NavCounters>({});

  const fullName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();

  const doSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload: AuditLogFilters = { page, limit };
      if (filters.action) payload.action = filters.action;
      if (filters.entity) payload.entity = filters.entity;
      if (filters.entityId) payload.entityId = Number(filters.entityId);
      if (filters.userId) payload.userId = Number(filters.userId);
      if (filters.dateFrom) payload.dateFrom = filters.dateFrom;
      if (filters.dateTo) payload.dateTo = filters.dateTo;
      const res = await auditApi.list(payload);
      setItems(res.items || []);
      setTotal(res.pagination?.total ?? 0);
      setTotalPages(res.pagination?.totalPages ?? 1);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to load audit log');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [page, limit, filters]);

  useEffect(() => { doSearch(); }, [doSearch]);

  useEffect(() => {
    navCounters().then(setNavCounts);
  }, []);

  const reset = () => {
    setFilters({ action: '', entity: '', entityId: undefined, userId: undefined, dateFrom: '', dateTo: '' });
    setSearch('');
    setPage(1);
  };

  const visible = useMemo(() => {
    if (!search.trim()) return items;
    const needle = search.trim().toLowerCase();
    return items.filter((l) =>
      (l.summary || '').toLowerCase().includes(needle) ||
      (l.action || '').toLowerCase().includes(needle) ||
      (l.entity || '').toLowerCase().includes(needle) ||
      (l.user?.email || '').toLowerCase().includes(needle) ||
      (l.user?.firstName || '').toLowerCase().includes(needle) ||
      (l.user?.lastName || '').toLowerCase().includes(needle) ||
      String(l.entityId ?? '').includes(needle)
    );
  }, [items, search]);

  return (
    <PortalShell
      role="ADMIN"
      activePath={location.pathname}
      brand={i18n.portals.admin.dashboardBrand}
      userText={fullName || i18n.portals.admin.dashboardGreeting('')}
      userEmail={user?.email ?? undefined}
      onLogout={logout}
      userPermissions={(user?.permissions as string[]) ?? []}
      showGlobalSearch
      navCounters={navCounts}
    >
      <div className="w-full space-y-6">
        <div className="flex flex-col md:flex-row items-start md:items-center md:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <Info className="w-6 h-6 text-slate-500" /> Audit Logs
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              System-wide audit trail of create/update/delete and financial actions across the platform.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={auditApi.exportUrl(filters)}
              download
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-semibold hover:bg-emerald-100"
            >
              <Download className="w-4 h-4" /> CSV export
            </a>
            <button onClick={() => setFiltersOpen((x) => !x)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 text-sm hover:bg-slate-50">
              <Filter className="w-4 h-4" /> Filters
            </button>
            <button onClick={doSearch} disabled={loading} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 text-sm hover:bg-slate-50 disabled:opacity-50">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
          <aside className={`space-y-4 ${filtersOpen ? '' : 'hidden lg:block'}`}>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 text-sm">Filters</h3>
                <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-700">Reset</button>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">Action</label>
                <select
                  value={filters.action || ''}
                  onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, action: e.target.value })); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
                >
                  <option value="">All actions</option>
                  {ACTION_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">Entity</label>
                <select
                  value={filters.entity || ''}
                  onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, entity: e.target.value })); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
                >
                  <option value="">All entities</option>
                  {ENTITY_OPTIONS.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">Entity ID</label>
                <input
                  type="number"
                  value={(filters.entityId as any) ?? ''}
                  onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, entityId: e.target.value ? Number(e.target.value) : undefined })); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
                  placeholder="e.g. 42"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">Actor User ID</label>
                <input
                  type="number"
                  value={(filters.userId as any) ?? ''}
                  onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, userId: e.target.value ? Number(e.target.value) : undefined })); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
                  placeholder="e.g. 3"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">From</label>
                <input
                  type="date"
                  value={filters.dateFrom || ''}
                  onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, dateFrom: e.target.value })); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">To</label>
                <input
                  type="date"
                  value={filters.dateTo || ''}
                  onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, dateTo: e.target.value })); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">Per Page</label>
                <select
                  value={limit}
                  onChange={(e) => { setPage(1); setLimit(Number(e.target.value)); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 text-xs text-slate-500 space-y-1">
              <div className="flex justify-between"><span>Total records:</span><span className="font-semibold text-slate-700">{total}</span></div>
              <div className="flex justify-between"><span>Total pages:</span><span className="font-semibold text-slate-700">{totalPages}</span></div>
              <div className="flex justify-between"><span>Showing:</span><span className="font-semibold text-slate-700">{visible.length}</span></div>
            </div>
          </aside>

          <section className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search summary, action, actor, entity..."
                  className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border border-slate-200 focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
                />
              </div>
              {error && (
                <div className="text-xs text-rose-600 bg-rose-50 px-3 py-1.5 rounded-lg ring-1 ring-rose-100">{error}</div>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100 text-sm">
                <thead className="bg-slate-50 text-slate-500 uppercase tracking-wide text-[11px]">
                  <tr>
                    <th className="px-5 py-3 text-left font-semibold">Time</th>
                    <th className="px-5 py-3 text-left font-semibold">Actor</th>
                    <th className="px-5 py-3 text-left font-semibold">Action</th>
                    <th className="px-5 py-3 text-left font-semibold">Entity</th>
                    <th className="px-5 py-3 text-left font-semibold">Summary</th>
                    <th className="px-5 py-3 text-left font-semibold">IP</th>
                    <th className="px-5 py-3 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {loading && items.length === 0 && (
                    <tr><td colSpan={7} className="px-5 py-16 text-center text-slate-400">
                      <Loader2 className="w-6 h-6 mx-auto animate-spin mb-2" /> Loading audit log…
                    </td></tr>
                  )}
                  {!loading && visible.length === 0 && (
                    <tr><td colSpan={7} className="px-5 py-16 text-center text-slate-400">
                      No audit records match your filters.
                    </td></tr>
                  )}
                  {visible.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3 text-slate-600 text-xs whitespace-nowrap">{fmtDateTime(l.createdAt)}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center text-[11px] font-bold text-slate-600">
                            {l.user?.firstName?.[0] || '?'}{l.user?.lastName?.[0] || ''}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm text-slate-800 truncate max-w-[180px]">
                              {l.user ? `${l.user.firstName || ''} ${l.user.lastName || ''}`.trim() || l.user.email : `User #${l.userId}`}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${roleChip(l.user?.role)}`}>
                                {l.user?.role || 'UNKNOWN'}
                              </span>
                              <span className="text-[11px] text-slate-400 truncate max-w-[130px]">
                                {l.user?.email || `#${l.userId}`}
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 ring-1 ring-slate-200">
                          {l.action}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="text-sm text-slate-700">{l.entity}</div>
                        {l.entityId != null && <div className="text-[11px] text-slate-400">#{l.entityId}</div>}
                      </td>
                      <td className="px-5 py-3">
                        <div className="text-sm text-slate-700 max-w-lg truncate">{l.summary || '—'}</div>
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap">{l.ipAddress || '—'}</td>
                      <td className="px-5 py-3">
                        <button
                          onClick={() => setDetail(l)}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                          title="View details / JSON diff"
                        >
                          <Info className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50/60">
                  <tr>
                    <td colSpan={7} className="px-5 py-3 flex items-center justify-between text-sm text-slate-600">
                      <div>Page <span className="font-semibold text-slate-800">{page}</span> of <span className="font-semibold text-slate-800">{totalPages}</span> · {total} total</div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                          disabled={page === 1 || loading}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-white disabled:opacity-40 hover:bg-slate-50"
                        ><ChevronLeft className="w-4 h-4" /></button>
                        <button
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                          disabled={page >= totalPages || loading}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 bg-white disabled:opacity-40 hover:bg-slate-50"
                        ><ChevronRight className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </div>
      </div>

      <Modal
        isOpen={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `Audit #${detail.id} · ${detail.action} ${detail.entity}` : 'Audit Details'}
      >
        {detail && (
          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Time</div>
                <div className="text-slate-800">{fmtDateTime(detail.createdAt)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Actor</div>
                <div className="text-slate-800">
                  {detail.user ? `${detail.user.firstName || ''} ${detail.user.lastName || ''}`.trim() : `User #${detail.userId}`}
                  <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-md ${roleChip(detail.user?.role)}`}>{detail.user?.role || ''}</span>
                </div>
                {detail.user?.email && <div className="text-xs text-slate-500">{detail.user.email}</div>}
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Action / Entity</div>
                <div className="text-slate-800">{detail.action} · {detail.entity}{detail.entityId != null ? ` #${detail.entityId}` : ''}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Origin</div>
                <div className="text-slate-800">{detail.ipAddress || '—'} <span className="text-xs text-slate-400">UA: {(detail.userAgent || '—').slice(0, 48)}</span></div>
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Summary</div>
              <div className="text-slate-800 whitespace-pre-wrap">{detail.summary || 'No summary recorded.'}</div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500">Old value (before)</div>
                  <button onClick={() => navigator.clipboard?.writeText(JSON.stringify(detail.oldValue, null, 2))} className="text-[11px] text-slate-500 hover:text-slate-700">Copy JSON</button>
                </div>
                <pre className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-[11px] text-slate-700 whitespace-pre-wrap break-words max-h-64 overflow-auto font-mono leading-relaxed">
                  {detail.oldValue === null || detail.oldValue === undefined ? 'null' : JSON.stringify(detail.oldValue, null, 2)}
                </pre>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500">New value (after)</div>
                  <button onClick={() => navigator.clipboard?.writeText(JSON.stringify(detail.newValue, null, 2))} className="text-[11px] text-slate-500 hover:text-slate-700">Copy JSON</button>
                </div>
                <pre className="bg-emerald-50 border border-emerald-100 rounded-lg p-3 text-[11px] text-slate-700 whitespace-pre-wrap break-words max-h-64 overflow-auto font-mono leading-relaxed">
                  {detail.newValue === null || detail.newValue === undefined ? 'null' : JSON.stringify(detail.newValue, null, 2)}
                </pre>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button onClick={() => setDetail(null)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm hover:bg-slate-800">
                <X className="w-4 h-4" /> Close
              </button>
            </div>
          </div>
        )}
      </Modal>
    </PortalShell>
  );
};

export default AdminAuditLogs;
