import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18n, students, statusLabels, studentTypes } from '../../i18n/en';
import Modal from '../../components/Modal';
import ConfirmAction from '../../components/ConfirmAction';
import PortalShell from '../../components/PortalShell';
import api, { navCounters, NavCounters } from '../../services/api';
import type { AxiosRequestConfig } from 'axios';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Copy, Eye, EyeOff, RefreshCw, CheckCircle2, Loader2, XCircle, AlertTriangle, GraduationCap } from 'lucide-react';

type ProgrammeOption = {
  id: number;
  name: string;
  code?: string | null;
  departmentName?: string | null;
  collegeName?: string | null;
};
type LevelOption = { id: number; level: number; programmeId?: number | null };
type SessionOption = { id: number; name: string; isActive?: boolean };

type StudentRow = {
  id: number;
  email: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  matricNumber?: string | null;
  admissionNumber?: string | null;
  jambNumber?: string | null;
  college?: string | null;
  department?: string | null;
  program?: string | null;
  level?: number | null;
  academicSession?: string | null;
  studentType?: string | null;
  entryMode?: string | null;
  admissionYear?: number | null;
  graduationYear?: number | null;
  phoneNumber?: string | null;
  address?: string | null;
  accountStatus: keyof typeof statusLabels;
  wallet?: { balance?: string | number } | null;
  createdAt?: string;
};

type AlertState = {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'error' | 'success' | 'info';
  actionLabel?: string;
  onAction?: () => void;
};

const STUDENT_TYPES = ['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER'] as const;
const STATUSES = ['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN'] as const;

function generateStrongPassword(length = 14): string {
  const uppers = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lowers = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const syms = '!@#$%^&*';
  const all = uppers + lowers + digits + syms;
  let out = uppers[Math.floor(Math.random() * uppers.length)];
  out += lowers[Math.floor(Math.random() * lowers.length)];
  out += digits[Math.floor(Math.random() * digits.length)];
  out += syms[Math.floor(Math.random() * syms.length)];
  for (let i = 4; i < length; i++) out += all[Math.floor(Math.random() * all.length)];
  return out.split('').sort(() => Math.random() - 0.5).join('');
}

type StudentInputState = {
  email: string;
  firstName: string;
  middleName: string;
  lastName: string;
  password: string;
  matricNumber: string;
  programmeId: string;
  levelId: string;
  academicSessionId: string;
  studentType: string;
  phoneNumber: string;
  accountStatus: string;
};

const emptyInput = (): StudentInputState => ({
  email: '', firstName: '', middleName: '', lastName: '',
  password: generateStrongPassword(),
  matricNumber: '', programmeId: '', levelId: '', academicSessionId: '',
  studentType: 'UNDERGRADUATE', phoneNumber: '', accountStatus: 'ACTIVE',
});

const StatusPill: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, string> = {
    ACTIVE: 'bg-green-50 text-green-700 border-green-200',
    SUSPENDED: 'bg-red-50 text-red-700 border-red-200',
    GRADUATED: 'bg-gray-100 text-gray-700 border-gray-200',
    WITHDRAWN: 'bg-amber-50 text-amber-700 border-amber-200',
  };
  const cls = map[status] ?? 'bg-gray-100 text-gray-700 border-gray-200';
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${cls}`}>
      {(statusLabels as any)[status] ?? status}
    </span>
  );
};

const StudentsPage: React.FC<{ role: 'ADMIN' | 'BURSARY'; brand: string; userText: string; onLogout: () => void; goBack: () => void; dashboardTo: string; }> = ({ role, brand, userText, onLogout, goBack, dashboardTo }) => {
  const { user } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const viewMode = searchParams.get('view') ?? 'list';
  const canBulk = role === 'ADMIN';
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  void goBack;
  void dashboardTo;

  // Hierarchy dropdown options (Programmes / Levels / Sessions) — populated
  // once on mount. If the user hasn't set up Programme/Level/Session yet
  // (clean slate Option B), we show helpful empty-state callouts.
  const [programmeOptions, setProgrammeOptions] = useState<ProgrammeOption[]>([]);
  const [levelOptions, setLevelOptions] = useState<LevelOption[]>([]);
  const [sessionOptions, setSessionOptions] = useState<SessionOption[]>([]);
  const [hierarchyLoading, setHierarchyLoading] = useState(true);
  const [hierarchyErr, setHierarchyErr] = useState<string | null>(null);

  useEffect(() => {
    navCounters().then(setNavCounts);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setHierarchyLoading(true);
      setHierarchyErr(null);
      try {
        const [progs, levels, sess] = await Promise.all([
          api.get<any>('/academic/programmes?limit=500').then((r) => {
            const d = r.data?.data?.items ?? r.data?.data;
            if (!Array.isArray(d)) return [];
            return d.map((x: any): ProgrammeOption => ({
              id: Number(x.id),
              name: String(x.name ?? ''),
              code: x.code ?? null,
              departmentName: String(x.department?.name ?? ''),
              collegeName: String(x.department?.faculty?.name ?? ''),
            }));
          }),
          api.get<any>('/academic/levels?limit=500').then((r) => {
            const d = r.data?.data?.items ?? r.data?.data;
            if (!Array.isArray(d)) return [];
            return d.map((x: any): LevelOption => ({
              id: Number(x.id),
              level: Number(x.level),
              programmeId: x.programmeId ?? null,
            }));
          }),
          api.get<any>('/academic/sessions?limit=200').then((r) => {
            const d = r.data?.data?.items ?? r.data?.data;
            if (!Array.isArray(d)) return [];
            return d.map((x: any): SessionOption => ({
              id: Number(x.id),
              name: String(x.name ?? ''),
              isActive: x.isActive,
            }));
          }),
        ]);
        if (cancelled) return;
        setProgrammeOptions(progs);
        setLevelOptions(levels);
        setSessionOptions(sess);
      } catch (e: any) {
        if (!cancelled) setHierarchyErr(e?.message ?? 'Failed to load');
      } finally {
        if (!cancelled) setHierarchyLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (viewMode === 'create') {
      setEditorState(emptyInput());
      setEditingId(null);
      setEditorOpen('create');
    } else if (viewMode === 'upload') {
      resetBulk();
      setBulkOpen(true);
    } else if (viewMode === 'history') {
      setTimeout(() => {
        const el = document.getElementById('import-history');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [viewMode]);

  // ---- query state --------------------------------------------------------
  const [query, setQuery] = useState({
    q: '', matric: '', college: '', department: '', program: '',
    level: '', session: '', studentType: '', accountStatus: '',
    page: '1', pageSize: '25', sort: 'createdAt', order: 'desc',
  });
  type StudentsPageDataNormalized = { students: StudentRow[]; total: number; page: number; pageSize: number; pageCount?: number };
  type StudentsPageData =
    | { students: StudentRow[]; total: number; page: number; pageSize: number; pageCount?: number }
    | { items: StudentRow[]; total: number; page: number; pageSize: number; pageCount?: number };
  const [data, setData] = useState<StudentsPageDataNormalized | null>(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const loadedOnceRef = useRef(false);

  const loadStudents = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      (Object.keys(query) as (keyof typeof query)[]).forEach((k) => {
        const v = query[k].trim();
        if (v) params[k] = v;
      });
      const cfg: AxiosRequestConfig = { params };
      if (signal) cfg.signal = signal;
      const res = await api.get<{ data: StudentsPageData }>('/students', cfg);
      const payload = res.data?.data;
      if (payload) {
        const rows = 'items' in payload ? payload.items : payload.students;
        setData({
          students: rows ?? [],
          total: payload.total,
          page: payload.page,
          pageSize: payload.pageSize,
          pageCount: (payload as any).pageCount,
        });
      } else {
        setData(null);
      }
      loadedOnceRef.current = true;
    } catch (err: any) {
      if (signal?.aborted) return;
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      setAlert({ isOpen: true, title: 'Failed to load', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [query]);

  const scheduleLoad = useCallback(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => loadStudents(), 220);
  }, [loadStudents]);

  React.useEffect(() => {
    const ctrl = new AbortController();
    loadStudents(ctrl.signal);
    return () => ctrl.abort();
  }, [query.page, query.pageSize, query.sort, query.order]);

  React.useEffect(() => {
    if (!loadedOnceRef.current) return;
    scheduleLoad();
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query.q, query.matric, query.college, query.department, query.program, query.level, query.session, query.studentType, query.accountStatus]);

  // ---- alerts and toast ---------------------------------------------------
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'error' });

  // ---- create/edit modal -------------------------------------------------
  const [editorOpen, setEditorOpen] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editorState, setEditorState] = useState<StudentInputState>(emptyInput());
  const [editorSubmitting, setEditorSubmitting] = useState(false);

  const openEdit = (s: StudentRow) => {
    setEditingId(s.id);
    setEditorState({
      email: s.email, firstName: s.firstName, middleName: s.middleName ?? '', lastName: s.lastName,
      password: '',
      matricNumber: s.matricNumber ?? '',
      programmeId: '',
      levelId: '',
      academicSessionId: '',
      studentType: s.studentType ?? 'UNDERGRADUATE',
      phoneNumber: s.phoneNumber ?? '',
      accountStatus: s.accountStatus,
    });
    setEditorOpen('edit');
  };

  const patchEditor = (patch: Partial<StudentInputState>) => setEditorState((s) => ({ ...s, ...patch }));

  const [editorValidityCheck, setEditorValidityCheck] = useState(0);
  const selectedProgramme = programmeOptions.find((p) => String(p.id) === editorState.programmeId) ?? null;

  const requiredChecksCreate = (): Array<{ field: string; ok: boolean }> => {
    const v = editorState;
    return [
      { field: 'First Name', ok: !!v.firstName.trim() },
      { field: 'Last Name', ok: !!v.lastName.trim() },
      { field: 'Email', ok: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) },
      { field: 'Matric Number', ok: !!v.matricNumber.trim() },
      { field: 'Programme', ok: !!v.programmeId },
      { field: 'Level', ok: !!v.levelId },
      { field: 'Academic Session', ok: !!v.academicSessionId },
      { field: 'Temporary Password', ok: editorOpen === 'edit' ? true : (v.password.length >= 8) },
    ];
  };
  const formReadyCreate = requiredChecksCreate().every((c) => c.ok);

  const submitEditor = async () => {
    setEditorValidityCheck((x) => x + 1);
    if (editorOpen === 'create' && !formReadyCreate) return;
    setEditorSubmitting(true);
    try {
      const payload: Record<string, any> = {};
      (Object.keys(editorState) as (keyof StudentInputState)[]).forEach((k) => {
        const v = editorState[k];
        if (v === '' || v === undefined || v === null) return;
        if (k === 'password' && editorOpen === 'edit') return;
        if (k === 'programmeId' || k === 'levelId' || k === 'academicSessionId') {
          const n = Number(v);
          if (!Number.isNaN(n) && n > 0) payload[k] = n;
        } else {
          payload[k] = v;
        }
      });
      if (editorOpen === 'create') {
        await api.post('/students', payload);
        setAlert({ isOpen: true, title: 'Created', message: i18n.dashboard.admin.addStudentSuccess, type: 'success' });
      } else if (editorOpen === 'edit' && editingId !== null) {
        await api.patch(`/students/${editingId}`, payload);
        setAlert({ isOpen: true, title: 'Saved', message: 'Student updated successfully.', type: 'success' });
      }
      setEditorOpen(null);
      setEditingId(null);
      setSearchParams({});
      loadStudents();
    } catch (err: any) {
      setAlert({ isOpen: true, title: editorOpen === 'create' ? i18n.dashboard.admin.addStudentFailed : 'Save failed', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setEditorSubmitting(false);
    }
  };

  // ---- reset password ----------------------------------------------------
  const [resetOpen, setResetOpen] = useState<StudentRow | null>(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const submitReset = async () => {
    if (!resetOpen) return;
    setResetSubmitting(true);
    setTempPassword(null);
    try {
      const res = await api.post<{ data: { temporaryPassword: string } }>(`/students/${resetOpen.id}/reset-password`);
      const tp = res.data?.data?.temporaryPassword;
      setTempPassword(tp ?? null);
    } catch (err: any) {
      setAlert({ isOpen: true, title: 'Failed to reset password', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setResetSubmitting(false);
    }
  };

  // ---- set status --------------------------------------------------------
  const [setStatusStudent, setSetStatusStudent] = useState<{ student: StudentRow; status: typeof STATUSES[number] } | null>(null);
  const [setStatusSubmitting, setSetStatusSubmitting] = useState(false);

  const submitSetStatus = async (payload: { reason?: string }) => {
    if (!setStatusStudent) return;
    setSetStatusSubmitting(true);
    try {
      await api.post(`/students/${setStatusStudent.student.id}/status`, {
        status: setStatusStudent.status,
        reason: payload.reason,
      });
      const { student, status } = setStatusStudent;
      setSetStatusStudent(null);
      loadStudents();
      setAlert({ isOpen: true, title: 'Status updated', message: `${student.firstName} ${student.lastName} is now ${(statusLabels as any)[status]}.`, type: 'success' });
    } catch (err: any) {
      setAlert({ isOpen: true, title: 'Failed to change status', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setSetStatusSubmitting(false);
    }
  };

  const statusIsDestructive = (st: typeof STATUSES[number]): boolean =>
    st === 'SUSPENDED' || st === 'WITHDRAWN' || st === 'GRADUATED';

  // ---- bulk upload -------------------------------------------------------
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkStep, setBulkStep] = useState<1 | 2 | 3>(1);
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkStage, setBulkStage] = useState<any>(null);
  const [bulkStrategy, setBulkStrategy] = useState<'SKIP' | 'UPDATE' | 'CANCEL'>('SKIP');
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: number; failed: number } | null>(null);

  const resetBulk = () => {
    setBulkFile(null); setBulkStage(null); setBulkResult(null);
    setBulkStep(1); setBulkStrategy('SKIP'); setBulkConfirming(false);
  };

  const pickFile = (f: File) => {
    setBulkResult(null);
    const okExt = /\.(csv|xlsx|xls)$/i.test(f.name);
    if (!okExt) {
      setAlert({ isOpen: true, title: 'Invalid file', message: students.uploadInvalidType, type: 'error' });
      return;
    }
    if (f.size > 20 * 1024 * 1024) {
      setAlert({ isOpen: true, title: 'File too large', message: 'Maximum file size is 20 MB.', type: 'error' });
      return;
    }
    setBulkFile(f);
  };

  const submitBulkFile = async () => {
    if (!bulkFile) return;
    setBulkUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', bulkFile);
      const res = await api.post<{ data: any }>('/admin/students/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setBulkStage(res.data.data);
      setBulkStep(2);
    } catch (err: any) {
      setAlert({ isOpen: true, title: students.uploadParseError, message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setBulkUploading(false);
    }
  };

  const downloadErrorsCsv = () => {
    if (!bulkStage?.uploadId) return;
    const w = window.open(`${api.defaults.baseURL}/admin/students/upload/${bulkStage.uploadId}/errors.csv?t=${Date.now()}`, '_blank', 'noopener,noreferrer');
    if (w) w.focus();
  };

  const confirmBulk = async () => {
    if (!bulkStage?.uploadId) return;
    setBulkConfirming(true);
    try {
      const res = await api.post<{ data: any }>(`/admin/students/upload/${bulkStage.uploadId}/confirm`, { duplicateStrategy: bulkStrategy });
      const d = res.data?.data ?? {};
      setBulkResult({
        created: Number(d.created ?? d.successfulRecords ?? 0),
        skipped: Number(d.skipped ?? d.duplicateRecords ?? 0),
        failed: Number(d.failed ?? d.failedRecords ?? 0),
      });
      setBulkStep(3);
      setSearchParams({});
      loadStudents();
    } catch (err: any) {
      setAlert({ isOpen: true, title: 'Import failed', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setBulkConfirming(false);
    }
  };

  // ---- UI helpers: val / password visibility -----------------------------
  const [showPassword, setShowPassword] = useState(false);
  const [copiedPw, setCopiedPw] = useState(false);
  const copyPw = async () => {
    try {
      await navigator.clipboard.writeText(editorState.password);
      setCopiedPw(true);
      setTimeout(() => setCopiedPw(false), 1500);
    } catch (_) {}
  };
  const rerollPw = () => patchEditor({ password: generateStrongPassword() });

  type Validity = 'idle' | 'ok' | 'warn' | 'err';
  const borderFor = (validity: Validity): string => {
    switch (validity) {
      case 'ok': return 'border-green-400 focus:ring-green-500 focus:border-green-500';
      case 'warn': return 'border-amber-400 focus:ring-amber-500 focus:border-amber-500';
      case 'err': return 'border-red-400 focus:ring-red-500 focus:border-red-500';
      default: return 'border-gray-300 focus:ring-blue-500 focus:border-blue-500';
    }
  };
  const Field: React.FC<{
    label: string;
    hint?: string;
    required?: boolean;
    validity?: Validity;
    children: React.ReactNode;
  }> = ({ label, hint, required, validity = 'idle', children }) => {
    const state = (editorValidityCheck > 0 || validity === 'ok') ? validity : 'idle';
    return (
      <div className="space-y-1">
        <label className="flex items-center gap-1 text-[13px] font-semibold text-gray-800">
          {label}
          {required && <span className="text-red-500 leading-none">*</span>}
          {state === 'ok' && <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />}
          {state === 'warn' && <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />}
          {state === 'err' && <XCircle className="w-3.5 h-3.5 text-red-600" />}
        </label>
        {children}
        {hint && state !== 'err' && <p className="text-[11px] text-gray-500 leading-tight">{hint}</p>}
      </div>
    );
  };
  const baseInputCls = 'w-full px-3 py-2 rounded-lg border text-sm bg-white transition';
  // String variant kept for legacy uses (filters table, bulk wizard) that don't pass validity.
  // Use `validInput(validity)` inside the Add/Edit Student modal for colored borders.
  const validInput = (validity?: Validity) => `${baseInputCls} ${borderFor(validity ?? 'idle')}`;
  const inputCls: string = validInput();

  const sectionHead = (title: string, icon: React.ReactNode, subtitle?: string) => (
    <div className="flex items-start gap-3 pb-2 mb-3 border-b border-gray-100">
      <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-700 flex items-center justify-center shrink-0">{icon}</div>
      <div>
        <h3 className="text-sm font-bold text-gray-900">{title}</h3>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );

  // ---- Validity helpers per field (for Create mode). Edit mode = permissive.
  const emailOK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editorState.email);
  const emailValidity: Validity = !editorState.email ? (editorValidityCheck > 0 ? 'err' : 'idle') : emailOK ? 'ok' : 'warn';
  const textReq = (s: string) => !s ? (editorValidityCheck > 0 ? 'err' : 'idle') : 'ok' as Validity;

  // ---- pagination --------------------------------------------------------
  const totalPages = Math.max(1, data ? Math.ceil(data.total / Math.max(1, Number(query.pageSize) || 25)) : 1);
  const currentPage = Number(query.page) || 1;
  const setPage = (p: number) => setQuery({ ...query, page: String(Math.max(1, Math.min(totalPages, p))) });

  const rows = data?.students ?? [];

  const studentTypeLabel = (v: string | null | undefined) =>
    v ? (studentTypes as any)[v] ?? v : '—';

  const walletBalance = (s: StudentRow) => {
    if (s.wallet && typeof s.wallet.balance === 'string') return `₦${Number(s.wallet.balance).toLocaleString()}`;
    if (s.wallet && typeof s.wallet.balance === 'number') return `₦${s.wallet.balance.toLocaleString()}`;
    return '—';
  };

  return (
    <PortalShell
      role={role}
      activePath={location.pathname + location.search}
      brand={brand}
      userText={userText}
      userEmail={user?.email ?? undefined}
      onLogout={onLogout}
      userPermissions={(user?.permissions as string[]) ?? []}
      showGlobalSearch
      navCounters={navCounts}
    >
      <div className="w-full space-y-8">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{students.pageTitle}</h1>
            <p className="text-gray-500 mt-1">{students.pageSubtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => { setSearchParams({ view: 'create' }); }} className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm">
              {students.createButton}
            </button>
            {canBulk && (
              <button onClick={() => { setSearchParams({ view: 'upload' }); }} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-lg font-medium text-sm">
                {students.uploadButton}
              </button>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <Field label="Search">
              <input className={inputCls} placeholder={students.searchPlaceholder} value={query.q} onChange={(e) => setQuery({ ...query, q: e.target.value, page: '1' })} />
            </Field>
            <Field label="Matric">
              <input className={inputCls} placeholder="2023/SCI/1000" value={query.matric} onChange={(e) => setQuery({ ...query, matric: e.target.value, page: '1' })} />
            </Field>
            <Field label={students.filterCollege}>
              <input className={inputCls} placeholder={i18n.dashboard.admin.collegePlaceholder} value={query.college} onChange={(e) => setQuery({ ...query, college: e.target.value, page: '1' })} />
            </Field>
            <Field label={students.filterDepartment}>
              <input className={inputCls} placeholder={i18n.dashboard.admin.departmentPlaceholder} value={query.department} onChange={(e) => setQuery({ ...query, department: e.target.value, page: '1' })} />
            </Field>
            <Field label={students.filterProgram}>
              <input className={inputCls} placeholder="B.Sc. Computer Science" value={query.program} onChange={(e) => setQuery({ ...query, program: e.target.value, page: '1' })} />
            </Field>
            <Field label={students.filterLevel}>
              <select className={inputCls} value={query.level} onChange={(e) => setQuery({ ...query, level: e.target.value, page: '1' })}>
                <option value="">{students.filterAll}</option>
                {[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((l) => <option key={l} value={String(l)}>{l} Level</option>)}
              </select>
            </Field>
            <Field label={students.filterSession}>
              <input className={inputCls} placeholder="2024/2025" value={query.session} onChange={(e) => setQuery({ ...query, session: e.target.value, page: '1' })} />
            </Field>
            <Field label={students.filterStudentType}>
              <select className={inputCls} value={query.studentType} onChange={(e) => setQuery({ ...query, studentType: e.target.value, page: '1' })}>
                <option value="">{students.filterAll}</option>
                {STUDENT_TYPES.map((s) => <option key={s} value={s}>{studentTypeLabel(s)}</option>)}
              </select>
            </Field>
            <Field label={students.filterAccountStatus}>
              <select className={inputCls} value={query.accountStatus} onChange={(e) => setQuery({ ...query, accountStatus: e.target.value, page: '1' })}>
                <option value="">{students.filterAll}</option>
                {STATUSES.map((s) => <option key={s} value={s}>{(statusLabels as any)[s]}</option>)}
              </select>
            </Field>
            <Field label={students.sortBy}>
              <select className={inputCls} value={query.sort} onChange={(e) => setQuery({ ...query, sort: e.target.value })}>
                <option value="createdAt">{students.sortCreatedAt}</option>
                <option value="firstName">{students.sortFirstName}</option>
                <option value="lastName">{students.sortLastName}</option>
                <option value="email">{students.sortEmail}</option>
                <option value="matricNumber">{students.sortMatricNumber}</option>
                <option value="level">{students.sortLevel}</option>
              </select>
            </Field>
            <Field label={students.order}>
              <select className={inputCls} value={query.order} onChange={(e) => setQuery({ ...query, order: e.target.value })}>
                <option value="asc">{students.orderAsc}</option>
                <option value="desc">{students.orderDesc}</option>
              </select>
            </Field>
            <Field label={students.pageSize}>
              <select className={inputCls} value={query.pageSize} onChange={(e) => setQuery({ ...query, pageSize: e.target.value, page: '1' })}>
                {[10, 25, 50, 100].map((n) => <option key={n} value={String(n)}>{n}</option>)}
              </select>
            </Field>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {[
                    students.headerMatric, students.headerName, students.headerEmail, students.headerPhone,
                    students.headerCollege, students.headerDepartment, students.headerProgram,
                    students.headerLevel, students.headerSession, students.headerStudentType,
                    students.headerAccountStatus, students.headerWalletBalance, students.headerCreated,
                    students.headerActions,
                  ].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {loading && !loadedOnceRef.current ? (
                  <tr><td colSpan={14} className="px-4 py-12 text-center text-gray-500">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={14} className="px-4 py-12 text-center text-gray-500">{students.empty}</td></tr>
                ) : rows.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50/60">
                    <td className="px-4 py-3 font-mono text-xs text-gray-800 whitespace-nowrap">{s.matricNumber ?? '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{s.firstName} {s.middleName ?? ''} {s.lastName}</div>
                      <div className="text-xs text-gray-500">#{s.id}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap break-all">{s.email}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{s.phoneNumber ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{s.college ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{s.department ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{s.program ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{s.level ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{s.academicSession ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{studentTypeLabel(s.studentType)}</td>
                    <td className="px-4 py-3 whitespace-nowrap"><StatusPill status={s.accountStatus} /></td>
                    <td className="px-4 py-3 text-gray-900 font-medium whitespace-nowrap">{walletBalance(s)}</td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">{s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button className="text-blue-600 hover:text-blue-800 text-sm font-medium" onClick={() => openEdit(s)}>{students.editAction}</button>
                        <button className="text-amber-700 hover:text-amber-900 text-sm font-medium" onClick={() => { setTempPassword(null); setResetOpen(s); }}>{students.resetPasswordAction}</button>
                        <select
                          className="border border-gray-300 rounded-md text-xs px-2 py-1 bg-white"
                          defaultValue=""
                          onChange={(e) => {
                            const val = e.target.value as any;
                            if (val && STATUSES.includes(val)) setSetStatusStudent({ student: s, status: val });
                            e.target.value = '';
                          }}
                        >
                          <option value="" disabled>{students.setStatusAction}</option>
                          {STATUSES.map((st) => (
                            <option key={st} value={st} disabled={s.accountStatus === st}>
                              {(statusLabels as any)[st]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-6 py-4 border-t border-gray-100 bg-gray-50/50 text-sm text-gray-600">
            <div>
              {data ? `${data.pageSize * (data.page - 1) + (rows.length ? 1 : 0)}–${data.pageSize * (data.page - 1) + rows.length} ${students.of} ${data.total}` : loadedOnceRef.current ? '0 results' : ''}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1 || !data} className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50">
                {students.prev}
              </button>
              <span className="font-medium text-gray-900 min-w-[4rem] text-center">
                {students.page} {currentPage} {students.of} {totalPages}
              </span>
              <button onClick={() => setPage(currentPage + 1)} disabled={currentPage >= totalPages || !data} className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50">
                {students.next}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Alert (toast-ish modal) */}
      <Modal
        isOpen={alert.isOpen}
        onClose={() => setAlert({ ...alert, isOpen: false })}
        title={alert.title}
        footer={
          alert.onAction && alert.actionLabel ? (
            <>
              <button
                onClick={() => setAlert({ ...alert, isOpen: false })}
                className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium"
              >
                Close
              </button>
              <button
                onClick={() => {
                  const fn = alert.onAction;
                  setAlert({ ...alert, isOpen: false });
                  setTimeout(() => fn?.(), 0);
                }}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold"
              >
                {alert.actionLabel}
              </button>
            </>
          ) : (
            <button
              onClick={() => setAlert({ ...alert, isOpen: false })}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold"
            >
              OK
            </button>
          )
        }
      >
        <p className="text-gray-700 whitespace-pre-wrap break-words select-text">{alert.message}</p>
      </Modal>

      {/* Create / Edit */}
      <Modal
        isOpen={editorOpen !== null}
        size="lg"
        onClose={() => { setEditorOpen(null); setEditingId(null); setSearchParams({}); setEditorValidityCheck(0); setShowPassword(false); }}
        title={editorOpen === 'create' ? students.createTitle : students.editTitle}
        footer={
          <div className="flex w-full flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            {editorOpen === 'create' && (
              <div className="flex flex-wrap gap-1.5 items-center">
                {requiredChecksCreate().map((c) => (
                  <span key={c.field} className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] border ${c.ok ? 'bg-green-50 text-green-700 border-green-200' : editorValidityCheck > 0 ? 'bg-red-50 text-red-700 border-red-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                    {c.ok ? <CheckCircle2 className="w-3 h-3" /> : editorValidityCheck > 0 ? <XCircle className="w-3 h-3" /> : null}
                    {c.field}
                  </span>
                ))}
              </div>
            )}
            <div className="flex justify-end items-center gap-3 ml-auto">
              <button
                onClick={() => { setEditorOpen(null); setEditingId(null); setSearchParams({}); setEditorValidityCheck(0); setShowPassword(false); }}
                className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium text-sm"
              >
                {students.cancelButton}
              </button>
              <button
                onClick={submitEditor}
                disabled={editorSubmitting || (editorOpen === 'create' && editorValidityCheck > 0 && !formReadyCreate)}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg font-bold inline-flex items-center gap-2 text-sm"
              >
                {editorSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {editorSubmitting ? students.submitting : (editorOpen === 'create' ? students.createSubmit : students.editSubmit)}
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-1">
          {/* SECTION 1: PERSONAL */}
          {sectionHead('Personal Information', <span className="text-lg">👤</span>, editorOpen === 'create' ? 'Core identifying details for the new student.' : 'Update student personal details.')}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={students.fieldFirstName} required validity={textReq(editorState.firstName)}>
              <input autoComplete="off" className={validInput(textReq(editorState.firstName))} value={editorState.firstName} onChange={(e) => patchEditor({ firstName: e.target.value })} placeholder="e.g. Adebayo" />
            </Field>
            <Field label={students.fieldLastName} required validity={textReq(editorState.lastName)}>
              <input autoComplete="off" className={validInput(textReq(editorState.lastName))} value={editorState.lastName} onChange={(e) => patchEditor({ lastName: e.target.value })} placeholder="e.g. Okafor" />
            </Field>
            <div className="sm:col-span-2">
              <Field label={students.fieldMiddleName} hint="Optional — will be omitted from receipts if blank.">
                <input autoComplete="off" className={validInput()} value={editorState.middleName} onChange={(e) => patchEditor({ middleName: e.target.value })} placeholder="e.g. Chinedu (optional)" />
              </Field>
            </div>
            <Field label={students.fieldEmail} required validity={emailValidity}>
              <input type="email" autoComplete="off" className={validInput(emailValidity)} value={editorState.email} onChange={(e) => patchEditor({ email: e.target.value })} placeholder="student.name@university.edu.ng" />
            </Field>
            <Field label={students.fieldPhoneNumber} hint="Optional. Used for SMS notifications if configured.">
              <input autoComplete="off" inputMode="tel" className={validInput()} value={editorState.phoneNumber} onChange={(e) => patchEditor({ phoneNumber: e.target.value })} placeholder="0801 234 5678" />
            </Field>
            <div className="sm:col-span-2">
              <Field label={students.fieldMatricNumber} required validity={textReq(editorState.matricNumber)} hint="Unique identifier. Used later by Bursary/Admin to issue DIRECT BILLS to this student.">
                <input autoComplete="off" className={`${validInput(textReq(editorState.matricNumber))} font-mono tracking-wide`} value={editorState.matricNumber} onChange={(e) => patchEditor({ matricNumber: e.target.value })} placeholder="e.g. 2025/ENG/0001" />
              </Field>
            </div>
          </div>

          {/* SECTION 2: ACADEMIC PLACEMENT */}
          {sectionHead('Academic Placement', <GraduationCap className="w-4 h-4" />, editorOpen === 'create' ? 'Pick Programme — College & Department are auto-filled for you.' : 'Programme changes auto cascade to Department & College.')}
          {hierarchyLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 px-3 py-4 bg-gray-50 rounded-lg">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading programmes, levels and sessions…
            </div>
          ) : hierarchyErr ? (
            <div className="flex items-start gap-2 text-sm text-red-700 px-3 py-4 bg-red-50 border border-red-200 rounded-lg">
              <XCircle className="w-4 h-4 mt-0.5" />
              <div>
                Couldn't load the academic setup. Make sure your session is valid or refresh the page.
                <div className="text-xs text-red-600 mt-1">{hierarchyErr}</div>
              </div>
            </div>
          ) : (
            <>
              {programmeOptions.length === 0 && (
                <div className="text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3 mb-4 flex gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-semibold">No programmes set up yet.</div>
                    <div className="mt-0.5">Go to <span className="font-medium">ACADEMIC STRUCTURE → Programmes</span> to define at least one Programme (with a parent Department & Faculty). Then return here.</div>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Field label="Programme" required validity={textReq(editorState.programmeId)} hint="Once selected, Department and College are auto-inferred for you.">
                    <select className={validInput(textReq(editorState.programmeId))} value={editorState.programmeId} onChange={(e) => patchEditor({ programmeId: e.target.value })}>
                      <option value="">— Select a Programme —</option>
                      {programmeOptions.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name}{p.code ? ` (${p.code})` : ''}{p.departmentName && p.collegeName ? ` — ${p.departmentName}, ${p.collegeName}` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {selectedProgramme && (selectedProgramme.departmentName || selectedProgramme.collegeName) && (
                  <div className="sm:col-span-2 -mt-1 mb-1 grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-blue-50/60 border border-blue-100 rounded-lg">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-600">College (auto)</div>
                      <div className="text-sm text-gray-800 mt-0.5">{selectedProgramme.collegeName || '—'}</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-600">Department (auto)</div>
                      <div className="text-sm text-gray-800 mt-0.5">{selectedProgramme.departmentName || '—'}</div>
                    </div>
                  </div>
                )}

                <Field label={students.fieldLevel} required validity={textReq(editorState.levelId)}>
                  <select className={validInput(textReq(editorState.levelId))} value={editorState.levelId} onChange={(e) => patchEditor({ levelId: e.target.value })}>
                    <option value="">— Select Level —</option>
                    {levelOptions.length > 0 ? levelOptions.map((l) => (
                      <option key={l.id} value={String(l.id)}>{l.level} Level</option>
                    )) : [100, 200, 300, 400, 500, 600].map((n) => (
                      <option key={n} value="" disabled>{n} Level (add in Academic Structure first)</option>
                    ))}
                  </select>
                </Field>

                <Field label={students.fieldAcademicSession} required validity={textReq(editorState.academicSessionId)}>
                  <select className={validInput(textReq(editorState.academicSessionId))} value={editorState.academicSessionId} onChange={(e) => patchEditor({ academicSessionId: e.target.value })}>
                    <option value="">— Select Session —</option>
                    {sessionOptions.map((s) => (
                      <option key={s.id} value={String(s.id)}>{s.name}{s.isActive === false ? ' (inactive)' : ''}</option>
                    ))}
                  </select>
                </Field>

                <Field label={students.fieldStudentType}>
                  <select className={validInput()} value={editorState.studentType} onChange={(e) => patchEditor({ studentType: e.target.value })}>
                    {STUDENT_TYPES.map((s) => <option key={s} value={s}>{studentTypeLabel(s)}</option>)}
                  </select>
                </Field>

                {editorOpen === 'edit' && (
                  <Field label={students.fieldAccountStatus}>
                    <select className={validInput()} value={editorState.accountStatus} onChange={(e) => patchEditor({ accountStatus: e.target.value })}>
                      {STATUSES.map((s) => <option key={s} value={s}>{(statusLabels as any)[s]}</option>)}
                    </select>
                  </Field>
                )}
              </div>
            </>
          )}

          {/* SECTION 3: ACCESS */}
          {sectionHead('Student Login Access', <span className="text-lg">🔐</span>, editorOpen === 'create' ? 'Strong temporary password is auto-generated for you. Share it securely.' : 'Leave the password field blank to keep the existing one.')}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Field
                label={students.fieldPassword}
                required={editorOpen === 'create'}
                validity={editorOpen === 'edit' ? 'idle' : (editorState.password.length >= 8 ? 'ok' : (editorValidityCheck > 0 ? 'err' : 'idle'))}
                hint={editorOpen === 'create' ? 'At least 8 characters. Copy this password and share it with the student in person or via secure email.' : 'Leave blank to keep their current password.'}
              >
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    readOnly={editorOpen === 'edit' && !editorState.password}
                    className={`${validInput(editorOpen === 'edit' ? 'idle' : (editorState.password.length >= 8 ? 'ok' : (editorValidityCheck > 0 ? 'err' : 'idle')))} font-mono tracking-wider pr-[120px]`}
                    value={editorOpen === 'edit' && !editorState.password ? '•••••••• (unchanged)' : editorState.password}
                    onChange={(e) => patchEditor({ password: e.target.value })}
                  />
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 pr-1">
                    {editorOpen === 'create' && (
                      <>
                        <button
                          type="button"
                          onClick={copyPw}
                          title="Copy password"
                          className={`w-8 h-8 rounded-md text-xs inline-flex items-center justify-center hover:bg-gray-100 ${copiedPw ? 'text-green-700' : 'text-gray-600'}`}
                        >
                          {copiedPw ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </button>
                        <button type="button" onClick={rerollPw} title="Generate new password" className="w-8 h-8 rounded-md text-gray-600 hover:bg-gray-100 inline-flex items-center justify-center">
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => setShowPassword((s) => !s)} title={showPassword ? 'Hide password' : 'Show password'} className="w-8 h-8 rounded-md text-gray-600 hover:bg-gray-100 inline-flex items-center justify-center">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </Field>
            </div>
          </div>
        </div>
      </Modal>

      {/* Reset password */}
      <Modal
        isOpen={resetOpen !== null}
        onClose={() => setResetOpen(null)}
        title={students.resetTitle}
        footer={
          <>
            <button
              onClick={() => setResetOpen(null)}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium"
            >
              {students.cancelButton}
            </button>
            {tempPassword ? (
              <button
                onClick={() => setResetOpen(null)}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold"
              >
                Close
              </button>
            ) : (
              <button
                onClick={submitReset}
                disabled={resetSubmitting}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold disabled:opacity-50"
              >
                {resetSubmitting ? students.submitting : students.resetSubmit}
              </button>
            )}
          </>
        }
      >
        {tempPassword ? (
          <div>
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3">
              {students.tempPasswordReturned}
            </p>
            <div className="font-mono select-all px-4 py-3 border border-gray-200 bg-gray-50 rounded-lg text-lg break-all">{tempPassword}</div>
          </div>
        ) : (
          <p className="text-gray-700">{students.resetConfirm}</p>
        )}
      </Modal>

      {/* Set status via ConfirmAction */}
      <ConfirmAction
        isOpen={setStatusStudent !== null}
        onClose={() => setSetStatusStudent(null)}
        onConfirm={submitSetStatus}
        title={setStatusStudent ? students.setStatusTitle((statusLabels as any)[setStatusStudent.status]) : ''}
        description={
          setStatusStudent
            ? students.setStatusConfirm(
                `${setStatusStudent.student.firstName} ${setStatusStudent.student.lastName}`,
                (statusLabels as any)[setStatusStudent.status],
              )
            : ''
        }
        resourceLabel={
          setStatusStudent
            ? `Student: ${setStatusStudent.student.firstName} ${setStatusStudent.student.lastName} (${setStatusStudent.student.matricNumber ?? '#' + setStatusStudent.student.id})`
            : ''
        }
        reasonRequired={setStatusStudent ? statusIsDestructive(setStatusStudent.status) : false}
        confirmVariant={setStatusStudent && statusIsDestructive(setStatusStudent.status) ? 'danger' : 'warning'}
        confirmLabel={students.setStatusSubmit}
        loading={setStatusSubmitting}
      />

      {/* Bulk Upload Wizard */}
      <Modal
        isOpen={bulkOpen}
        onClose={() => { setBulkOpen(false); setSearchParams({}); }}
        title={students.uploadTitle}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <div className="flex items-center gap-1 text-sm text-gray-500">
              <span className={bulkStep >= 1 ? 'text-blue-700 font-semibold' : ''}>1. {students.uploadStep1}</span>
              <span className="mx-2">›</span>
              <span className={bulkStep >= 2 ? 'text-blue-700 font-semibold' : ''}>2. {students.uploadStep2}</span>
              <span className="mx-2">›</span>
              <span className={bulkStep >= 3 ? 'text-blue-700 font-semibold' : ''}>3. {students.uploadStep3}</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  if (bulkStep === 1) { setBulkOpen(false); setSearchParams({}); }
                  else if (bulkStep === 2) { resetBulk(); }
                  else { setBulkOpen(false); setSearchParams({}); loadStudents(); }
                }}
                className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium"
              >
                {bulkStep === 1 || bulkStep === 3 ? 'Close' : 'Start over'}
              </button>
              {bulkStep === 1 && (
                <button
                  onClick={submitBulkFile}
                  disabled={!bulkFile || bulkUploading}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {bulkUploading ? students.uploadSubmitting : 'Upload and preview'}
                </button>
              )}
              {bulkStep === 2 && (
                <button
                  onClick={() => setBulkStep(3)}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold"
                >
                  Continue
                </button>
              )}
              {bulkStep === 3 && !bulkResult && (
                <button
                  onClick={confirmBulk}
                  disabled={bulkConfirming}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-bold disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {bulkConfirming ? students.uploadSubmitting : students.uploadSubmit}
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
          {bulkStep === 1 && (
            <div>
              <label className="block">
                <div
                  onDragOver={(e) => { e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) pickFile(f); }}
                  className="border-2 border-dashed border-gray-300 hover:border-blue-500 rounded-2xl p-8 text-center cursor-pointer bg-gray-50"
                  onClick={() => (document.getElementById('bulk-file-input') as HTMLInputElement | null)?.click()}
                >
                  <p className="text-gray-700 font-medium mb-1">{students.uploadDropzone}</p>
                  <p className="text-xs text-gray-500 mb-3">{students.uploadSizeLimit}</p>
                  {bulkFile ? (
                    <div className="inline-flex items-center gap-2 px-3 py-2 bg-white rounded-lg border border-gray-200 text-sm text-gray-800">
                      {bulkFile.name} — {(bulkFile.size / 1024).toFixed(1)} KB
                    </div>
                  ) : (
                    <div className="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">
                      Choose file
                    </div>
                  )}
                  <input
                    id="bulk-file-input"
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); }}
                  />
                </div>
              </label>
            </div>
          )}

          {bulkStep === 2 && bulkStage && (
            <div>
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <p className="text-sm font-semibold text-blue-900 mb-2">
                  {students.uploadSummary} — {bulkStage.uploadId}
                </p>
                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-gray-600">{students.uploadTotalRows}</dt><dd className="font-semibold text-gray-900">{bulkStage.totalRows ?? 0}</dd></div>
                  <div><dt className="text-gray-600">{students.uploadValidRows}</dt><dd className="font-semibold text-green-700">{bulkStage.validCount ?? 0}</dd></div>
                  <div><dt className="text-gray-600">{students.uploadProblemRows}</dt><dd className="font-semibold text-red-700">{bulkStage.problemCount ?? 0}</dd></div>
                  <div><dt className="text-gray-600">{students.uploadMissingHeader}</dt><dd className="font-semibold text-gray-900">{(bulkStage.missingColumns ?? []).join(', ') || '—'}</dd></div>
                  <div><dt className="text-gray-600">{students.uploadWithinFileDupes}</dt><dd className="font-semibold text-gray-900">{bulkStage.withinFileDuplicateCount ?? 0}</dd></div>
                  <div><dt className="text-gray-600">{students.uploadDbDupes}</dt><dd className="font-semibold text-gray-900">{bulkStage.dbDuplicateCount ?? 0}</dd></div>
                </dl>
                {(bulkStage.problemCount ?? 0) > 0 && (
                  <div className="mt-3">
                    <button onClick={downloadErrorsCsv} className="text-sm underline text-blue-700 hover:text-blue-900 font-medium">
                      {students.uploadErrorsCsv}
                    </button>
                  </div>
                )}
              </div>

              {bulkStage.preview?.validSample?.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm font-semibold text-gray-900 mb-2">{students.uploadValidSample}</p>
                  <div className="max-h-60 overflow-auto border border-gray-200 rounded-xl">
                    <table className="min-w-full text-xs divide-y divide-gray-200">
                      <thead className="bg-gray-50"><tr>{Object.keys(bulkStage.preview.validSample[0]).map((k) => <th key={k} className="px-3 py-2 text-left text-gray-700 whitespace-nowrap">{k}</th>)}</tr></thead>
                      <tbody className="divide-y divide-gray-100">
                        {bulkStage.preview.validSample.map((r: any, i: number) => (
                          <tr key={i}>{Object.values(r).map((v, j) => <td key={j} className="px-3 py-1.5 whitespace-nowrap text-gray-800">{String(v ?? '')}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {bulkStage.preview?.problemSample?.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm font-semibold text-gray-900 mb-2">{students.uploadProblemSample}</p>
                  <div className="max-h-60 overflow-auto border border-red-100 rounded-xl">
                    <table className="min-w-full text-xs divide-y divide-red-100">
                      <thead className="bg-red-50/60">
                        <tr>
                          <th className="px-3 py-2 text-left text-gray-700 whitespace-nowrap">row</th>
                          <th className="px-3 py-2 text-left text-gray-700 whitespace-nowrap">errors</th>
                          <th className="px-3 py-2 text-left text-gray-700 whitespace-nowrap">record</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {(bulkStage.preview.problemSample as any[]).map((pr: any, i: number) => (
                          <tr key={i} className="bg-red-50/30">
                            <td className="px-3 py-1.5 whitespace-nowrap">{pr.row}</td>
                            <td className="px-3 py-1.5 whitespace-nowrap text-red-700">
                              {(pr.errors ?? []).map((e: any, k: number) => (
                                <span key={k} className="inline-block mr-2 text-xs">
                                  <span className="font-semibold">{e.code}</span>{e.message ? `: ${e.message}` : ''}
                                </span>
                              ))}
                            </td>
                            <td className="px-3 py-1.5 whitespace-nowrap text-gray-800">
                              {Object.entries(pr.record ?? {}).map(([kk, vv]) => (
                                <span key={kk} className="mr-2"><span className="text-gray-500">{kk}=</span>{String(vv ?? '')}</span>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {bulkStep === 3 && !bulkResult && (
            <div>
              <div className="space-y-3">
                <div>
                  <p className="font-semibold text-gray-900 mb-1">{students.uploadStrategyTitle}</p>
                  <p className="text-sm text-gray-600 mb-2">{students.uploadStrategyDesc}</p>
                  <div className="space-y-2">
                    {(['SKIP', 'UPDATE', 'CANCEL'] as const).map((s) => {
                      const labelMap = { SKIP: students.uploadStrategySkip, UPDATE: students.uploadStrategyUpdate, CANCEL: students.uploadStrategyCancel };
                      return (
                        <label key={s} className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer ${bulkStrategy === s ? 'bg-blue-50 border-blue-300' : 'bg-white border-gray-200'}`}>
                          <input type="radio" className="mt-0.5" checked={bulkStrategy === s} onChange={() => setBulkStrategy(s)} />
                          <div className="text-sm text-gray-800">{labelMap[s]}</div>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm text-gray-700">
                  {students.uploadConfirmDesc(bulkStage?.validCount ?? 0, bulkStage?.problemCount ?? 0, bulkStrategy)}
                </div>
              </div>
            </div>
          )}

          {bulkStep === 3 && bulkResult && (
            <div>
              <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                <p className="text-sm font-semibold text-green-900 mb-2">{students.uploadDone}</p>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-gray-600">{students.uploadSuccessCreated}</dt><dd className="font-semibold text-green-700">{bulkResult.created}</dd></div>
                  <div><dt className="text-gray-600">{students.uploadSuccessSkipped}</dt><dd className="font-semibold text-gray-700">{bulkResult.skipped}</dd></div>
                  <div><dt className="text-gray-600">{students.uploadSuccessFailed}</dt><dd className="font-semibold text-red-700">{bulkResult.failed}</dd></div>
                </dl>
                <p className="mt-2 text-sm text-green-800">{students.uploadDoneMessage(bulkResult.created, bulkResult.skipped, bulkResult.failed)}</p>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </PortalShell>
  );
};

export default StudentsPage;
