// STAGE 5 F5 — Scheduled Reports (R20) — ADMIN-only CRUD table.
// Guard: hasPermission('REPORTS_SCHEDULE'). BURSARY never inherits it (explicitly excluded per perm manifest).
// CRUD: list / create (modal) / pause-resume / soft-delete (pause).

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { navCounters, NavCounters } from '../../services/api';
import { i18n } from '../../i18n/en';
import {
  ArrowLeft, Plus, PauseCircle, PlayCircle, FileSpreadsheet, FileText,
  Loader2, AlertTriangle, CheckCircle2, Clock, Trash2, Edit3,
  ChevronLeft, ChevronRight, Calendar, Mail, ShieldAlert, X,
} from 'lucide-react';
import {
  listScheduledReports, createScheduledReport, updateScheduledReport, pauseScheduledReport,
} from '../../services/reportsApi';

type Role = 'BURSARY' | 'ADMIN';
export interface ScheduledReportsPageProps { role: Role; activePath: string; }

const hasPerm = (p: string, perms?: string[], role?: Role) => {
  if (role === 'ADMIN') return true;
  return perms?.includes(p) ?? false;
};

type ToastKind = 'ok' | 'err' | 'info';
interface ToastState { kind: ToastKind; text: string; }

type FrequencyType = 'DAILY_COLLECTION_SUMMARY' | 'WEEKLY_COLLECTION' | 'MONTHLY_REVENUE' | 'MONTHLY_RECONCILIATION' | 'OUTSTANDING_PAYMENTS' | 'CUSTOM_CRON';
const FREQ_LABELS: Record<FrequencyType, string> = {
  DAILY_COLLECTION_SUMMARY: 'Daily Collection Summary',
  WEEKLY_COLLECTION: 'Weekly Collections',
  MONTHLY_REVENUE: 'Monthly Revenue',
  MONTHLY_RECONCILIATION: 'Monthly Reconciliation',
  OUTSTANDING_PAYMENTS: 'Outstanding Payments Reminder',
  CUSTOM_CRON: 'Custom Cron',
};
const FREQ_CRON_DEFAULTS: Record<Exclude<FrequencyType, 'CUSTOM_CRON'>, string> = {
  DAILY_COLLECTION_SUMMARY: '0 1 * * *',
  WEEKLY_COLLECTION: '0 2 * * 1',
  MONTHLY_REVENUE: '0 3 1 * *',
  MONTHLY_RECONCILIATION: '0 4 1 * *',
  OUTSTANDING_PAYMENTS: '0 6 * * 3',
};

const REPORT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'daily-collections', label: 'Daily Collections' },
  { value: 'monthly-collections', label: 'Monthly Collections' },
  { value: 'payment-register', label: 'Master Payment Register' },
  { value: 'revenue-by-bill', label: 'Revenue by Bill' },
  { value: 'outstanding-debtors', label: 'Outstanding Debtors' },
  { value: 'refunds', label: 'Refund Report' },
  { value: 'settlement', label: 'Settlement Report' },
  { value: 'reconciliation-exceptions', label: 'Reconciliation Exceptions' },
];

const FREQUENCY_OPTIONS: Array<{ value: FrequencyType; label: string }> = [
  { value: 'DAILY_COLLECTION_SUMMARY', label: FREQ_LABELS.DAILY_COLLECTION_SUMMARY },
  { value: 'WEEKLY_COLLECTION', label: FREQ_LABELS.WEEKLY_COLLECTION },
  { value: 'MONTHLY_REVENUE', label: FREQ_LABELS.MONTHLY_REVENUE },
  { value: 'MONTHLY_RECONCILIATION', label: FREQ_LABELS.MONTHLY_RECONCILIATION },
  { value: 'OUTSTANDING_PAYMENTS', label: FREQ_LABELS.OUTSTANDING_PAYMENTS },
  { value: 'CUSTOM_CRON', label: FREQ_LABELS.CUSTOM_CRON },
];

type CreateForm = {
  frequency: FrequencyType;
  reportType: string;
  subjectLine: string;
  format: 'XLSX' | 'PDF' | 'BOTH';
  recipientsText: string;
  cron: string;
  isActive: boolean;
};

const ScheduledReportsPage: React.FC<ScheduledReportsPageProps> = ({ role, activePath }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const userPerms = (user?.permissions as string[] | undefined) ?? [];
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(50);
  const [total, setTotal] = useState<number>(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<CreateForm>({
    frequency: 'DAILY_COLLECTION_SUMMARY',
    reportType: 'daily-collections',
    subjectLine: 'Daily Collection Summary',
    format: 'XLSX',
    recipientsText: '',
    cron: FREQ_CRON_DEFAULTS.DAILY_COLLECTION_SUMMARY,
    isActive: true,
  });

  useEffect(() => { navCounters().then(setNavCounts).catch(() => {}); }, []);

  const canSchedule = hasPerm('REPORTS_SCHEDULE', userPerms, role);

  const fetchData = () => {
    if (!canSchedule) { setLoading(false); return; }
    let mounted = true; setLoading(true); setErr(null);
    listScheduledReports({ page, pageSize })
      .then((d: any) => {
        if (!mounted) return;
        const r = Array.isArray(d) ? d : d.rows ?? d.data ?? [];
        setRows(r);
        const t = d?.total ?? d?.count ?? r.length;
        setTotal(typeof t === 'number' ? t : Number(t) || 0);
      })
      .catch((e: any) => { if (mounted) setErr(String(e?.message ?? e).slice(0, 250)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  };

  useEffect(fetchData, [page, pageSize, canSchedule]);

  const brand = role === 'BURSARY' ? i18n.portals.bursary.dashboardBrand : i18n.portals.admin.dashboardBrand;
  const userText = role === 'BURSARY'
    ? `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()
    : i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin');

  const fireToast = (kind: ToastKind, text: string, ms = 4500) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), ms);
  };

  const resetForm = () => {
    setForm({
      frequency: 'DAILY_COLLECTION_SUMMARY',
      reportType: 'daily-collections',
      subjectLine: 'Daily Collection Summary',
      format: 'XLSX',
      recipientsText: '',
      cron: FREQ_CRON_DEFAULTS.DAILY_COLLECTION_SUMMARY,
      isActive: true,
    });
    setEditingId(null);
  };

  const openCreate = () => { resetForm(); setShowCreate(true); };
  const closeCreate = () => { setShowCreate(false); resetForm(); };

  const openEdit = (r: any) => {
    setEditingId(Number(r.id) || null);
    const recips = Array.isArray(r.recipients) ? r.recipients.join(', ') : typeof r.recipients === 'string' ? r.recipients : '';
    setForm({
      frequency: (r.frequency as FrequencyType) || 'CUSTOM_CRON',
      reportType: r.reportType || r.report_key || 'daily-collections',
      subjectLine: r.subjectLine || r.subject || '',
      format: (r.format as any) || 'XLSX',
      recipientsText: recips,
      cron: r.cron || '* * * * *',
      isActive: r.isActive !== false,
    });
    setShowCreate(true);
  };

  const validate = (): string | null => {
    if (!form.frequency) return 'Frequency is required';
    if (!form.reportType) return 'Report type is required';
    if (!form.subjectLine.trim()) return 'Subject line is required';
    if (!['XLSX', 'PDF', 'BOTH'].includes(form.format)) return 'Invalid format';
    const recips = form.recipientsText.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (recips.length === 0) return 'At least one recipient email is required';
    if (recips.length > 50) return 'Maximum 50 recipients allowed';
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const e of recips) if (!emailRe.test(e)) return `Invalid email: ${e}`;
    if (form.frequency === 'CUSTOM_CRON') {
      const fields = (form.cron || '').trim().split(/\s+/);
      if (fields.length !== 5) return 'Custom cron must have exactly 5 fields';
    }
    return null;
  };

  const submitForm = async () => {
    const vErr = validate();
    if (vErr) { fireToast('err', vErr); return; }
    try {
      setSubmitting(true);
      const recips = form.recipientsText.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      const cronFinal = form.frequency === 'CUSTOM_CRON'
        ? form.cron.trim()
        : (FREQ_CRON_DEFAULTS as any)[form.frequency] || form.cron;
      const body: any = {
        frequency: form.frequency,
        reportType: form.reportType,
        subjectLine: form.subjectLine.trim(),
        format: form.format,
        recipients: recips,
        cron: cronFinal,
        isActive: form.isActive,
        filters: {},
      };
      if (editingId != null) {
        await updateScheduledReport(editingId, body);
        fireToast('ok', 'Scheduled report updated');
      } else {
        await createScheduledReport(body);
        fireToast('ok', 'Scheduled report created');
      }
      closeCreate();
      fetchData();
    } catch (e: any) {
      fireToast('err', 'Save failed: ' + String(e?.message ?? e).slice(0, 180));
    } finally {
      setSubmitting(false);
    }
  };

  const togglePause = async (r: any) => {
    try {
      await pauseScheduledReport(Number(r.id));
      fireToast('info', `Scheduled report ${r.isActive === false ? 'resumed' : 'paused'}`);
      fetchData();
    } catch (e: any) {
      fireToast('err', 'Toggle failed: ' + String(e?.message ?? e).slice(0, 180));
    }
  };

  const freqDefaultCron = (f: FrequencyType) => {
    if (f === 'CUSTOM_CRON') return form.cron;
    return (FREQ_CRON_DEFAULTS as any)[f] || form.cron;
  };

  useEffect(() => {
    if (form.frequency && form.frequency !== 'CUSTOM_CRON') {
      setForm((f) => ({ ...f, cron: freqDefaultCron(f.frequency) }));
    }
  }, [form.frequency]);

  const statSummary = useMemo(() => {
    const active = rows.filter((r) => r.isActive !== false).length;
    const paused = rows.length - active;
    return { total: rows.length, active, paused };
  }, [rows]);

  const StatusChip: React.FC<{ r: any }> = ({ r }) => {
    const active = r.isActive !== false;
    const paused = r.pausedAt || r.isActive === false;
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${
        !active ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'
      }`}>
        {active ? <CheckCircle2 className="h-3 w-3" /> : <PauseCircle className="h-3 w-3" />}
        {paused ? 'Paused' : 'Active'}
      </span>
    );
  };

  const goPage = (delta: number) => setPage((p) => Math.max(1, p + delta));

  const content = (
    <div className="px-6 py-6 md:px-8 lg:px-10">
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] inline-flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg max-w-md ${
          toast.kind === 'ok' ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
          : toast.kind === 'err' ? 'bg-red-50 text-red-800 border-red-200'
          : 'bg-sky-50 text-sky-800 border-sky-200'
        }`}>
          {toast.kind === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
          <span className="font-medium">{toast.text}</span>
          <button type="button" onClick={() => setToast(null)} className="ml-1 opacity-60 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <button type="button" onClick={() => navigate('/bursary/reports/centre')} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 mb-2">
            <ArrowLeft className="h-3 w-3" /> Back to Reports Centre
          </button>
          <div className="text-xs text-indigo-700 font-semibold tracking-widest mb-1">ACCOUNTING • ADMIN ONLY</div>
          <h1 className="text-2xl font-extrabold text-gray-900">Scheduled Reports</h1>
          <p className="text-sm text-gray-500 mt-1">Recurring bursary emails. BullMQ worker delivers on schedule to recipients.</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canSchedule}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-700 hover:bg-indigo-800 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="h-4 w-4" /> New Schedule
        </button>
      </div>

      {!canSchedule ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 text-sm text-amber-800">
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-8 w-8 shrink-0" />
            <div>
              <div className="font-bold text-lg mb-1">Restricted: REPORTS_SCHEDULE permission required</div>
              <p className="text-amber-700 mb-2">
                This page is for ADMIN role only. The BURSARY role is explicitly excluded from scheduled-report management per the security manifest.
              </p>
              <p className="text-amber-600 text-xs">
                If you believe this is in error, contact an Admin to grant <code className="bg-white px-1.5 py-0.5 rounded">REPORTS_SCHEDULE</code>.
              </p>
            </div>
          </div>
        </div>
      ) : err ? (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 font-mono">{err}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
            <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Total Schedules</div>
              <div className="mt-1 text-3xl font-black text-gray-900 tabular-nums">{statSummary.total.toLocaleString()}</div>
            </div>
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
              <div className="text-[10px] uppercase tracking-widest text-emerald-700 font-bold">Active</div>
              <div className="mt-1 text-3xl font-black text-emerald-800 tabular-nums flex items-center gap-2">
                {statSummary.active.toLocaleString()} <CheckCircle2 className="h-6 w-6" />
              </div>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <div className="text-[10px] uppercase tracking-widest text-amber-700 font-bold">Paused</div>
              <div className="mt-1 text-3xl font-black text-amber-800 tabular-nums flex items-center gap-2">
                {statSummary.paused.toLocaleString()} <PauseCircle className="h-6 w-6" />
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 flex-wrap gap-3">
              <div className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                <span className="text-gray-400 mr-1">Schedules</span>
                <span className="inline-flex items-center rounded-full bg-gray-100 text-gray-700 px-2 py-0.5 text-xs font-mono">
                  {rows.length.toLocaleString()} rows
                </span>
                {loading && <span className="inline-flex items-center gap-1 text-xs text-gray-500"><Loader2 className="h-3 w-3 animate-spin" />Loading…</span>}
              </div>
              <div className="text-xs text-gray-500">
                Page {page} • {pageSize} / page • {total.toLocaleString()} total
              </div>
            </div>

            {rows.length === 0 && !loading ? (
              <div className="p-10 text-center text-gray-500 text-sm">
                <Calendar className="h-10 w-10 text-gray-300 mx-auto mb-2" />
                No scheduled reports yet. Click <strong>New Schedule</strong> to automate email delivery.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 font-semibold text-gray-700 text-left border-b whitespace-nowrap">Report</th>
                      <th className="px-3 py-2 font-semibold text-gray-700 text-left border-b whitespace-nowrap">Frequency</th>
                      <th className="px-3 py-2 font-semibold text-gray-700 text-left border-b whitespace-nowrap">Cron</th>
                      <th className="px-3 py-2 font-semibold text-gray-700 text-left border-b whitespace-nowrap">Format</th>
                      <th className="px-3 py-2 font-semibold text-gray-700 text-left border-b whitespace-nowrap">Recipients</th>
                      <th className="px-3 py-2 font-semibold text-gray-700 text-left border-b whitespace-nowrap">Last / Next</th>
                      <th className="px-3 py-2 font-semibold text-gray-700 text-left border-b whitespace-nowrap">Status</th>
                      <th className="px-3 py-2 font-semibold text-gray-700 text-center border-b whitespace-nowrap">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r: any) => {
                      const recips = Array.isArray(r.recipients) ? r.recipients : typeof r.recipients === 'string' ? [r.recipients] : [];
                      return (
                        <tr key={String(r.id ?? Math.random())} className="border-b border-gray-50 hover:bg-amber-50/40">
                          <td className="px-3 py-2">
                            <div className="font-semibold text-gray-800">{r.subjectLine || r.subject || '—'}</div>
                            <div className="text-[10px] text-gray-500 font-mono">{r.reportType || r.report_key || ''}</div>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-gray-700">
                            {(FREQ_LABELS as any)[r.frequency] || r.frequency || '—'}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap font-mono text-gray-600">{r.cron || '—'}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              {['XLSX', 'BOTH'].includes(r.format) && <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-700" />}
                              {['PDF', 'BOTH'].includes(r.format) && <FileText className="h-3.5 w-3.5 text-rose-700" />}
                              <span className="font-mono uppercase">{r.format || '—'}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 max-w-[240px]">
                            <div className="flex items-center gap-1 text-gray-700">
                              <Mail className="h-3 w-3 text-gray-400 shrink-0" />
                              <span className="truncate" title={recips.join(', ')}>
                                {recips.length > 0 ? `${recips[0]}${recips.length > 1 ? ` +${recips.length - 1}` : ''}` : '—'}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap font-mono text-[11px] text-gray-600">
                            <div>
                              <Clock className="h-3 w-3 inline mr-1 opacity-60" />
                              {r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : '—'}
                            </div>
                            <div className="text-indigo-600">
                              ▸ {r.nextRunAt ? new Date(r.nextRunAt).toLocaleString() : '—'}
                            </div>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap"><StatusChip r={r} /></td>
                          <td className="px-3 py-2 whitespace-nowrap text-center">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openEdit(r)}
                                title="Edit"
                                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-gray-600 hover:bg-gray-100 border border-gray-200"
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => togglePause(r)}
                                title={r.isActive === false ? 'Resume' : 'Pause / Soft-delete'}
                                className={`inline-flex items-center justify-center h-7 px-2 gap-1 rounded-md text-xs font-semibold border ${
                                  r.isActive === false
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                                    : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                                }`}
                              >
                                {r.isActive === false ? (<><PlayCircle className="h-3 w-3" />Resume</>) : (<><PauseCircle className="h-3 w-3" />Pause</>)}
                              </button>
                              <button
                                type="button"
                                onClick={() => togglePause({ ...r, isActive: true })}
                                title="Soft delete (set isActive=false, pausedAt=now)"
                                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-red-600 hover:bg-red-50 border border-red-200"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 text-xs text-gray-600 font-medium">
              <span className="text-gray-500">
                {Math.min(page * pageSize, total).toLocaleString()} of {total.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <button className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                  disabled={page <= 1 || loading} onClick={() => goPage(-1)}>
                  <ChevronLeft className="h-3 w-3" />
                </button>
                <span className="px-2 font-mono tabular-nums">{page}</span>
                <button className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                  disabled={page * pageSize >= total} onClick={() => goPage(+1)}>
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {showCreate && canSchedule && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4" onClick={closeCreate}>
          <div
            className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-gray-200 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white">
              <div>
                <div className="text-xs font-bold tracking-widest text-indigo-600">{editingId != null ? 'EDIT' : 'CREATE NEW'}</div>
                <h2 className="text-xl font-black text-gray-900">{editingId != null ? 'Edit Scheduled Report' : 'New Scheduled Report'}</h2>
              </div>
              <button type="button" onClick={closeCreate} className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-gray-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Frequency *</label>
                  <select
                    value={form.frequency}
                    onChange={(e) => setForm({ ...form, frequency: e.target.value as FrequencyType })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    {FREQUENCY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Report Type *</label>
                  <select
                    value={form.reportType}
                    onChange={(e) => setForm({ ...form, reportType: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    {REPORT_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Email Subject Line *</label>
                  <input
                    type="text"
                    value={form.subjectLine}
                    onChange={(e) => setForm({ ...form, subjectLine: e.target.value })}
                    placeholder="[Bursary] Daily Collection Summary"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Format *</label>
                  <div className="flex items-center gap-2 pt-1">
                    {(['XLSX', 'PDF', 'BOTH'] as const).map((f) => (
                      <label key={f} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer ${
                        form.format === f
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'bg-white text-gray-700 border-gray-300 hover:border-indigo-300'
                      }`}>
                        <input
                          type="radio"
                          className="accent-indigo-600"
                          name="fmt"
                          checked={form.format === f}
                          onChange={() => setForm({ ...form, format: f })}
                        />
                        {f === 'XLSX' && <FileSpreadsheet className="h-3.5 w-3.5" />}
                        {f === 'PDF' && <FileText className="h-3.5 w-3.5" />}
                        {f}
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-600 mb-1">Recipient Emails * (comma or semicolon separated. Max 50)</label>
                <textarea
                  value={form.recipientsText}
                  onChange={(e) => setForm({ ...form, recipientsText: e.target.value })}
                  placeholder="finance@university.edu.ng, bursar@university.edu.ng, auditor@university.edu.ng"
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                <div className="mt-1 text-[10px] text-gray-500 font-mono">
                  {form.recipientsText.split(/[,;\s]+/).filter(Boolean).length} recipients entered
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">
                    Cron Schedule {form.frequency === 'CUSTOM_CRON' ? '(5-field custom)' : '(derived from frequency, editable only when Custom)'}
                  </label>
                  <input
                    type="text"
                    value={form.cron}
                    disabled={form.frequency !== 'CUSTOM_CRON'}
                    onChange={(e) => setForm({ ...form, cron: e.target.value })}
                    placeholder="0 1 * * *"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:bg-gray-100 disabled:text-gray-600"
                  />
                  <div className="mt-1 text-[10px] text-gray-500">
                    Field order: minute hour day-of-month month day-of-week
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Status</label>
                  <div className="flex items-center gap-3 pt-1.5">
                    <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-indigo-600 h-4 w-4"
                        checked={form.isActive}
                        onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                      />
                      Enabled (schedule will tick on next cron match)
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-2 sticky bottom-0 bg-gradient-to-t from-white via-white to-transparent">
              <button
                type="button"
                onClick={closeCreate}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitForm}
                disabled={submitting}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold bg-indigo-700 hover:bg-indigo-800 text-white disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {editingId != null ? 'Save Changes' : 'Create Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <PortalShell role={role} activePath={activePath} brand={brand} userText={userText} userEmail={user?.email}
      onLogout={logout} userPermissions={userPerms} navCounters={navCounts} showGlobalSearch>
      {content}
    </PortalShell>
  );
};

export default ScheduledReportsPage;
