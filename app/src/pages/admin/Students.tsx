import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18n, students, statusLabels, studentTypes } from '../../i18n/en';
import Modal from '../../components/Modal';
import ConfirmAction from '../../components/ConfirmAction';
import PortalShell from '../../components/PortalShell';
import api, { navCounters, NavCounters, downloadBlob, apiErrorMessage } from '../../services/api';
import type { AxiosRequestConfig } from 'axios';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Copy, Download, Eye, EyeOff, RefreshCw, CheckCircle2, Loader2, XCircle, AlertTriangle, GraduationCap, ShieldAlert, Key, Lock, Send, Trash2 } from 'lucide-react';
import { programmesApi } from '../../services/academicApi';
import { emailResendCredentialsApi } from '../../services/adminApi';
import { studentCategoriesApi, StudentCategory } from '../../services/studentCategoriesApi';
import ImportHistoryPage from './ImportHistoryPage';

type ProgrammeOption = {
  id: number;
  name: string;
  code?: string | null;
  departmentName?: string | null;
  collegeName?: string | null;
};

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
  studentCategory?: { id: number; name: string; code: string | null; isActive: boolean } | null;
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
  details?: string[] | null;
  actionLabel?: string;
  onAction?: () => void;
};

type ConfirmState = {
  isOpen: boolean;
  title: string;
  description: string;
  resourceLabel: string;
  onConfirm: (payload: { reason?: string }) => Promise<void> | void;
  loading: boolean;
};

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
  studentCategoryId: string;
  phoneNumber: string;
  accountStatus: string;
};

type ImportRunStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

/**
 * Normalised progress view of a background import run, consumed by the wizard UI.
 */
type ImportRunProgress = {
  uuid: string;
  status: ImportRunStatus;
  totalRows: number;
  successCount: number;
  failCount: number;
  skippedCount: number;
  percent: number;
};

/**
 * Raw shape of GET /admin/students/imports/:uuid — run counters are flattened
 * next to a `progress` object.
 */
interface ImportRunStatusResponse {
  status?: ImportRunStatus;
  totalRows?: number;
  successCount?: number;
  failCount?: number;
  skippedCount?: number;
  progress?: {
    totalRows?: number;
    processedRows?: number;
    successCount?: number;
    failCount?: number;
    skippedCount?: number;
    percent?: number;
  };
}

/**
 * Data envelope of POST /admin/students/upload/:uploadId/confirm.
 * CANCEL returns only `summary.cancelledRecords`; SKIP/UPDATE additionally
 * return the queued `run` and a `summary` of the staged file.
 */
interface BulkConfirmResponse {
  strategy?: 'SKIP' | 'UPDATE' | 'CANCEL';
  importNumber?: string;
  queued?: boolean;
  run?: {
    importRunId?: number;
    uuid?: string;
    totalRows?: number;
    status?: ImportRunStatus;
    sendCredentialEmails?: boolean;
  };
  summary?: {
    total?: number;
    valid?: number;
    invalid?: number;
    duplicateWithinFile?: number;
    duplicateExistingDb?: number;
    cancelledRecords?: number;
  };
}

const emptyInput = (): StudentInputState => ({
  email: '', firstName: '', middleName: '', lastName: '',
  password: generateStrongPassword(),
  matricNumber: '', programmeId: '',
  studentCategoryId: '', phoneNumber: '', accountStatus: 'ACTIVE',
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

type Validity = 'idle' | 'ok' | 'warn' | 'err';

const baseInputCls = 'w-full px-3 py-2 rounded-lg border text-sm bg-white transition';

const borderFor = (validity: Validity): string => {
  switch (validity) {
    case 'ok': return 'border-green-400 focus:ring-green-500 focus:border-green-500';
    case 'warn': return 'border-amber-400 focus:ring-amber-500 focus:border-amber-500';
    case 'err': return 'border-red-400 focus:ring-red-500 focus:border-red-500';
    default: return 'border-gray-300 focus:ring-blue-500 focus:border-blue-500';
  }
};

const validInput = (validity?: Validity): string => `${baseInputCls} ${borderFor(validity ?? 'idle')}`;

const Field: React.FC<{
  label: string;
  hint?: string;
  required?: boolean;
  validity?: Validity;
  forceValidation?: boolean;
  children: React.ReactNode;
}> = ({ label, hint, required, validity = 'idle', forceValidation = false, children }) => {
  const state = (forceValidation || validity === 'ok') ? validity : 'idle';
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1 text-[13px] font-semibold text-gray-800">
        {label}
        <span className={`text-red-500 leading-none ${required ? '' : 'hidden'}`}>*</span>
        <CheckCircle2 className={`w-3.5 h-3.5 text-green-600 ${state === 'ok' ? '' : 'hidden'}`} />
        <AlertTriangle className={`w-3.5 h-3.5 text-amber-600 ${state === 'warn' ? '' : 'hidden'}`} />
        <XCircle className={`w-3.5 h-3.5 text-red-600 ${state === 'err' ? '' : 'hidden'}`} />
      </label>
      {children}
      <p className={`text-[11px] text-gray-500 leading-tight ${hint && state !== 'err' ? '' : 'hidden'}`}>{hint ?? ''}</p>
    </div>
  );
};

const StudentsPage: React.FC<{ role: 'ADMIN' | 'BURSARY'; brand: string; userText: string; onLogout: () => void; goBack: () => void; dashboardTo: string; }> = ({ role, brand, userText, onLogout, goBack, dashboardTo }) => {
  const { user } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const viewMode = searchParams.get('view') ?? 'list';
  // ADMIN role boundary + the canonical BULK_UPLOAD_STUDENTS capability. A
  // NORMAL ADMIN without it cannot bulk-import; only a PROTECTED SUPER ADMIN
  // bypasses the capability.
  const bulkPerms = ((user as any)?.permissions as string[] | undefined) ?? [];
  const bulkIsSuper = user?.role === 'ADMIN' && (user as any)?.isSuperAdmin === true;
  const canBulk = role === 'ADMIN' && (bulkIsSuper || bulkPerms.includes('BULK_UPLOAD_STUDENTS'));
  // Import-history READING is a SEPARATE capability (VIEW_IMPORT_HISTORY) from
  // bulk upload/import EXECUTION (BULK_UPLOAD_STUDENTS). It is never implied by
  // the upload capability, for either role.
  const canViewHistory = bulkIsSuper || bulkPerms.includes('VIEW_IMPORT_HISTORY');
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  void goBack;
  void dashboardTo;

  // Hierarchy dropdown options (Programmes) — populated once on
  // mount. If the user hasn't set up Programme yet (clean slate), we
  // show helpful empty-state callouts. Level is intentionally NOT required on
  // the student record — it can be derived later from programme duration, and
  // the filter/sort bars still allow filtering by numeric level column.
  const [programmeOptions, setProgrammeOptions] = useState<ProgrammeOption[]>([]);
  const [hierarchyLoading, setHierarchyLoading] = useState(true);
  const [hierarchyErr, setHierarchyErr] = useState<string | null>(null);

  // Student Categories (admin-managed reference data). Only ACTIVE categories are
  // offered in the pickers/filter; when editing a student who is already assigned
  // to a now-inactive category we still surface that one so the assignment isn't
  // silently dropped.
  const [categoryOptions, setCategoryOptions] = useState<StudentCategory[]>([]);
  const [categoryLoading, setCategoryLoading] = useState(true);
  const [categoryErr, setCategoryErr] = useState<string | null>(null);

  // Guard refs — set synchronously during render from downstream state vars
  // declared later (editorOpen, bulkOpen). Allows the viewMode useEffect (L181)
  // to check them without TS "used before declaration" errors.
  const editorOpenRef = useRef<'create' | 'edit' | null>(null);
  const bulkOpenRef = useRef(false);

  useEffect(() => {
    navCounters().then(setNavCounts);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setHierarchyLoading(true);
      setHierarchyErr(null);
      try {
        const progsResp = await programmesApi.list({ page: 1, pageSize: 500 });
        if (cancelled) return;
        const progs: ProgrammeOption[] = progsResp.items.map((x: any) => ({
          id: Number(x.id),
          name: String(x.name ?? ''),
          code: x.code ?? null,
          departmentName: String(x.department?.name ?? ''),
          collegeName: String(x.department?.faculty?.name ?? ''),
        }));
        setProgrammeOptions(progs);
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
    let cancelled = false;
    async function load() {
      setCategoryLoading(true);
      setCategoryErr(null);
      try {
        const result = await studentCategoriesApi.list({ page: 1, limit: 200, isActive: true });
        if (cancelled) return;
        setCategoryOptions(result.rows);
      } catch (e: unknown) {
        if (!cancelled) setCategoryErr(apiErrorMessage(e, 'Failed to load student categories'));
      } finally {
        if (!cancelled) setCategoryLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (viewMode === 'create') {
      if (editorOpenRef.current === 'create' || editorOpenRef.current === 'edit') return;
      setEditorState(emptyInput());
      setEditingId(null);
      setEditorOpen('create');
    } else if (viewMode === 'upload') {
      if (bulkOpenRef.current) return;
      resetBulk();
      setBulkOpen(true);
    }
  }, [viewMode]);

  // ---- query state --------------------------------------------------------
  const [query, setQuery] = useState({
    q: '', matric: '', college: '', department: '', program: '',
    studentCategoryId: '', accountStatus: '',
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
  }, [query.q, query.matric, query.college, query.department, query.program, query.studentCategoryId, query.accountStatus]);

  // ---- alerts and toast ---------------------------------------------------
  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'error' });

  // ---- confirm action (delete student) ------------------------------------
  const [confirm, setConfirm] = useState<ConfirmState>({
    isOpen: false,
    title: '',
    description: '',
    resourceLabel: '',
    onConfirm: () => {},
    loading: false,
  });

  // ---- create/edit modal -------------------------------------------------
  const [editorOpen, setEditorOpen] = useState<'create' | 'edit' | null>(null);
  editorOpenRef.current = editorOpen;
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
      studentCategoryId: s.studentCategory ? String(s.studentCategory.id) : '',
      phoneNumber: s.phoneNumber ?? '',
      accountStatus: s.accountStatus,
    });
    setEditorOpen('edit');
  };

  // Category options for the create/edit picker: all ACTIVE categories, plus the
  // student's current category when it is no longer active, so an existing
  // assignment is never silently cleared.
  const editorCategoryOptions: StudentCategory[] = (() => {
    const opts = [...categoryOptions];
    const currentId = editorState.studentCategoryId;
    if (!currentId) return opts;
    const exists = opts.some((c) => String(c.id) === currentId);
    if (exists) return opts;
    const assigned = editingId !== null ? data?.students.find((s) => s.id === editingId)?.studentCategory ?? null : null;
    if (assigned && String(assigned.id) === currentId) {
      opts.push({ id: assigned.id, name: assigned.name, code: assigned.code, description: null, isActive: assigned.isActive, sortOrder: null, createdAt: '', updatedAt: '', _count: { students: 0 } });
    }
    return opts;
  })();

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
        if (k === 'programmeId' || k === 'studentCategoryId') {
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
      const fallbackTitle = editorOpen === 'create' ? i18n.dashboard.admin.addStudentFailed : 'Save failed';
      const backendTitle: string = err?.response?.data?.message ?? err?.message ?? i18n.errors.generic;
      const rawDetails: Array<{ path?: string; message?: string; received?: any; expected?: any }> | undefined = err?.response?.data?.details;
      let details: string[] | null = null;
      if (Array.isArray(rawDetails)) {
        details = rawDetails.slice(0, 8).map((d: any) => {
          const p = d?.path ? `${d.path}: ` : '';
          const m = d?.message ?? 'Invalid value';
          const r = d?.received !== undefined && String(d.received) !== '' ? ` (received: ${JSON.stringify(d.received)})` : '';
          return `${p}${m}${r}`;
        });
        if (rawDetails.length > 8) details.push(`…and ${rawDetails.length - 8} more`);
      }
      setAlert({
        isOpen: true,
        title: backendTitle || fallbackTitle,
        message: details && details.length > 0 ? 'Please correct the highlighted fields below.' : (backendTitle || fallbackTitle),
        details,
        type: 'error',
      });
    } finally {
      setEditorSubmitting(false);
    }
  };

  // ---- reset password ----------------------------------------------------
  const [resetOpen, setResetOpen] = useState<StudentRow | null>(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [showResetPw, setShowResetPw] = useState(false);
  const [copiedResetPw, setCopiedResetPw] = useState(false);

  const submitReset = async () => {
    if (!resetOpen) return;
    setResetSubmitting(true);
    setTempPassword(null);
    setShowResetPw(false);
    setCopiedResetPw(false);
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

  const copyResetPw = async () => {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopiedResetPw(true);
      setTimeout(() => setCopiedResetPw(false), 1500);
    } catch (_) {}
  };

  // ---- set status --------------------------------------------------------
  const [setStatusStudent, setSetStatusStudent] = useState<{ student: StudentRow; status: typeof STATUSES[number] } | null>(null);
  const [setStatusSubmitting, setSetStatusSubmitting] = useState(false);

  // ---- resend credentials ------------------------------------------------
  const [resendStudent, setResendStudent] = useState<StudentRow | null>(null);
  const [resendSubmitting, setResendSubmitting] = useState(false);

  const submitResendCredentials = async () => {
    if (!resendStudent) return;
    setResendSubmitting(true);
    try {
      const resp = await emailResendCredentialsApi.resend(resendStudent.id);
      const deliveryLogId = resp?.deliveryLogId;
      const message = resp?.message || 'Credentials email queued for delivery.';
      setResendStudent(null);
      setAlert({
        isOpen: true,
        title: 'Credentials Email Queued',
        message: `${message}${deliveryLogId ? ` (Delivery log ID: ${String(deliveryLogId).slice(0, 12)}…)` : ''} The student will receive a NEW temporary password via email.`,
        type: 'success',
      });
      loadStudents();
    } catch (err: any) {
      setAlert({ isOpen: true, title: 'Failed to queue credentials email', message: err?.message ?? i18n.errors.generic, type: 'error' });
    } finally {
      setResendSubmitting(false);
    }
  };

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

  // ---- delete student (financial integrity gate) -------------------------
  const openDeleteStudent = (s: StudentRow) => {
    setConfirm({
      isOpen: true,
      title: 'Delete this student permanently?',
      description:
        'This action is only allowed when the student has no financial or billing history and cannot be undone. ' +
        'Students with invoices, receipts, transactions, refunds, or direct-bill assignments cannot be removed.',
      resourceLabel: `Student: ${s.firstName} ${s.lastName} (${s.matricNumber ?? '#' + s.id} · ${s.email})`,
      loading: false,
      onConfirm: async () => {
        setConfirm((c) => ({ ...c, loading: true }));
        try {
          await api.delete(`/students/${s.id}`);
          setConfirm((c) => ({ ...c, isOpen: false, loading: false }));
          setAlert({
            isOpen: true,
            title: 'Student deleted',
            message: `${s.firstName} ${s.lastName} has been permanently removed.`,
            type: 'success',
          });
          loadStudents();
        } catch (err: any) {
          setConfirm((c) => ({ ...c, loading: false }));
          if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
          const payload = err?.payload ?? err?.response?.data;
          const code = payload?.code;
          const breakdown: string[] = payload?.breakdown ?? [];
          const errMsg =
            payload?.error ??
            payload?.message ??
            err?.message ??
            i18n.errors.generic;
          if (code === 'STUDENT_HAS_FINANCIAL_RECORDS') {
            setAlert({
              isOpen: true,
              title: 'Cannot delete — financial records exist',
              type: 'error',
              message:
                'This student cannot be deleted because financial or billing records exist. ' +
                'Suspend or withdraw the student account instead.',
              details: breakdown.length > 0 ? breakdown : undefined,
            });
          } else {
            setAlert({
              isOpen: true,
              title: 'Delete failed',
              type: 'error',
              message: String(errMsg).slice(0, 500),
              details: breakdown.length > 0 ? breakdown : undefined,
            });
          }
        }
      },
    });
  };

  // ---- bulk upload -------------------------------------------------------
  const [bulkOpen, setBulkOpen] = useState(false);
  bulkOpenRef.current = bulkOpen;
  const [bulkStep, setBulkStep] = useState<1 | 2 | 3>(1);
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkStage, setBulkStage] = useState<any>(null);
  const [bulkStrategy, setBulkStrategy] = useState<'SKIP' | 'UPDATE' | 'CANCEL'>('SKIP');
  const [bulkSendEmails, setBulkSendEmails] = useState(false);
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bulkRun, setBulkRun] = useState<ImportRunProgress | null>(null);
  const [bulkRunError, setBulkRunError] = useState<string | null>(null);
  const bulkPollRef = useRef<number | null>(null);

  const stopBulkPolling = () => {
    if (bulkPollRef.current !== null) {
      window.clearInterval(bulkPollRef.current);
      bulkPollRef.current = null;
    }
  };

  const resetBulk = () => {
    stopBulkPolling();
    setBulkFile(null); setBulkStage(null); setBulkRun(null); setBulkRunError(null);
    setBulkStep(1); setBulkStrategy('SKIP'); setBulkConfirming(false); setBulkSendEmails(false);
  };

  // Stop polling when the wizard closes or the page unmounts so a background
  // interval is never leaked after navigation.
  useEffect(() => {
    if (!bulkOpen) stopBulkPolling();
  }, [bulkOpen]);
  useEffect(() => () => stopBulkPolling(), []);

  const pickFile = (f: File) => {
    setBulkRun(null);
    setBulkRunError(null);
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

  // Authenticated CSV download of the staged-upload problem rows. Previously this
  // opened a URL with the bearer token in the query string, which both leaked the
  // token and was unauthenticated when the token key differed. downloadBlob sends
  // the standard Authorization header instead.
  const downloadErrorsCsv = async () => {
    if (!bulkStage?.uploadId) return;
    try {
      await downloadBlob(`/admin/students/upload/${bulkStage.uploadId}/errors.csv`, 'student-import-errors.csv');
    } catch (err: unknown) {
      setAlert({ isOpen: true, title: 'Could not download error report', message: apiErrorMessage(err, i18n.errors.generic), type: 'error' });
    }
  };

  const downloadCredentialsCsv = async (uuid: string) => {
    try {
      await downloadBlob(`/admin/students/imports/${uuid}/credentials.csv`, `student-credentials-${uuid}.csv`);
    } catch (err: unknown) {
      setAlert({ isOpen: true, title: 'Could not download credentials', message: apiErrorMessage(err, i18n.errors.generic), type: 'error' });
    }
  };

  const pollImportRun = (uuid: string) => {
    stopBulkPolling();
    bulkPollRef.current = window.setInterval(async () => {
      try {
        const res = await api.get<{ data: ImportRunStatusResponse }>(`/admin/students/imports/${uuid}`);
        const d: ImportRunStatusResponse = res.data?.data ?? {};
        const progress = d.progress ?? {};
        const status: ImportRunStatus = d.status ?? 'PROCESSING';
        const total = Number(progress.totalRows ?? d.totalRows ?? 0);
        const successCount = Number(d.successCount ?? progress.successCount ?? 0);
        const failCount = Number(d.failCount ?? progress.failCount ?? 0);
        const skippedCount = Number(d.skippedCount ?? progress.skippedCount ?? 0);
        const processed = Number(progress.processedRows ?? (successCount + failCount + skippedCount));
        const percent = Number(progress.percent ?? (total > 0 ? Math.round((processed / total) * 100) : 0));
        setBulkRun({
          uuid,
          status,
          totalRows: total,
          successCount,
          failCount,
          skippedCount,
          percent: Math.max(0, Math.min(100, percent)),
        });
        if (status === 'COMPLETED' || status === 'FAILED') {
          stopBulkPolling();
          if (status === 'COMPLETED') loadStudents();
          if (status === 'FAILED') setBulkRunError(students.uploadRunFailed);
        }
      } catch (err: unknown) {
        stopBulkPolling();
        // Run-status reads are gated on VIEW_IMPORT_HISTORY. An operator who may
        // execute an upload but not READ import history is denied here — report
        // that accurately instead of claiming a lost connection.
        const status = (err as any)?.response?.status;
        if (status === 401 || status === 403) {
          setBulkRunError('Live progress tracking is not available for your account. The import continues in the background.');
        } else {
          setBulkRunError(apiErrorMessage(err, 'Lost connection while tracking the import. Open Import History to see the final result.'));
        }
      }
    }, 1500);
  };

  const confirmBulk = async () => {
    if (!bulkStage?.uploadId) return;
    setBulkConfirming(true);
    setBulkRunError(null);
    try {
      const res = await api.post<{ data: BulkConfirmResponse }>(
        `/admin/students/upload/${bulkStage.uploadId}/confirm`,
        { duplicateStrategy: bulkStrategy, sendCredentialEmails: bulkSendEmails },
      );
      const d: BulkConfirmResponse = res.data?.data ?? {};

      if (bulkStrategy === 'CANCEL') {
        // 200 shape — the server cancelled the staged upload (no background run).
        setSearchParams({});
        setBulkOpen(false);
        resetBulk();
        setAlert({
          isOpen: true,
          title: students.uploadCancelled,
          message: `The import was cancelled. ${Number(d.summary?.cancelledRecords ?? 0)} staged record(s) were discarded.`,
          type: 'success',
        });
        return;
      }

      // 202 shape — a background, chunked run was queued. Poll for live progress.
      const run: NonNullable<BulkConfirmResponse['run']> = d.run ?? {};
      const uuid: string = run.uuid ?? '';
      setBulkStep(3);
      setSearchParams({});
      if (!uuid) {
        setBulkRunError('The import was queued but no run identifier was returned. Open Import History to check its status.');
        return;
      }
      setBulkRun({
        uuid,
        status: run.status ?? 'PENDING',
        totalRows: Number(run.totalRows ?? d.summary?.total ?? bulkStage?.totalRows ?? 0),
        successCount: 0,
        failCount: 0,
        skippedCount: 0,
        percent: 0,
      });
      pollImportRun(uuid);
    } catch (err: unknown) {
      setAlert({ isOpen: true, title: 'Import failed', message: apiErrorMessage(err, i18n.errors.generic), type: 'error' });
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

  // Prefer the admin-managed category name; fall back to the legacy studentType
  // label for rows imported before categories existed.
  const categoryLabel = (s: StudentRow): string =>
    s.studentCategory?.name ?? (s.studentType ? studentTypeLabel(s.studentType) : '—');

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
            <div className="flex rounded-xl border border-gray-200 bg-white p-1.5 shadow-sm">
              <button
                onClick={() => setSearchParams({})}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors inline-flex items-center gap-2 ${
                  !viewMode || viewMode === 'list'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                📋 {students.pageTitle}
              </button>
              {canBulk && (
                <button
                  onClick={() => { setSearchParams({ view: 'upload' }); }}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors inline-flex items-center gap-2 ${
                    viewMode === 'upload'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  📦 {students.uploadButton}
                </button>
              )}
              {canViewHistory && (
                <button
                  onClick={() => { setSearchParams({ view: 'history' }); }}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors inline-flex items-center gap-2 ${
                    viewMode === 'history'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  🕘 {students.historyTab}
                </button>
              )}
            </div>
            <button onClick={() => { setSearchParams({ view: 'create' }); }} className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm shadow-sm">
              ＋ {students.createButton}
            </button>
          </div>
        </div>

        {viewMode === 'history' && canViewHistory ? (
          <ImportHistoryPage />
        ) : viewMode === 'history' ? (
          // Direct-URL denial: ?view=history without VIEW_IMPORT_HISTORY must
          // never render import-history data — show an explicit Access Denied.
          <div
            role="alert"
            data-testid="import-history-access-denied"
            className="bg-white border border-red-200 rounded-2xl p-8 text-center max-w-xl mx-auto"
          >
            <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
              <XCircle className="h-7 w-7 text-red-600" />
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">Access Denied</h2>
            <p className="text-gray-500 mb-6">
              Your account does not have the required permissions to view Import History.
            </p>
            <button
              onClick={() => setSearchParams({})}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-sm shadow-sm"
            >
              Back to Students
            </button>
          </div>
        ) : (
          <>
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
            <Field label={students.filterStudentCategory}>
              <select className={inputCls} value={query.studentCategoryId} onChange={(e) => setQuery({ ...query, studentCategoryId: e.target.value, page: '1' })}>
                <option value="">{students.filterAll}</option>
                {categoryOptions.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
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
                    students.headerStudentCategory,
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
                  <tr><td colSpan={12} className="px-4 py-12 text-center text-gray-500">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={12} className="px-4 py-12 text-center text-gray-500">{students.empty}</td></tr>
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
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{categoryLabel(s)}</td>
                    <td className="px-4 py-3 whitespace-nowrap"><StatusPill status={s.accountStatus} /></td>
                    <td className="px-4 py-3 text-gray-900 font-medium whitespace-nowrap">{walletBalance(s)}</td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">{s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button className="text-blue-600 hover:text-blue-800 text-sm font-medium" onClick={() => openEdit(s)}>{students.editAction}</button>
                        <button className="text-amber-700 hover:text-amber-900 text-sm font-medium" onClick={() => { setTempPassword(null); setResetOpen(s); }}>{students.resetPasswordAction}</button>
                        <button
                          className="inline-flex items-center gap-1 text-indigo-700 hover:text-indigo-900 text-sm font-medium"
                          onClick={() => setResendStudent(s)}
                          title="Force reset password & resend credentials email"
                        >
                          <Send className="w-3.5 h-3.5" /> Resend Creds
                        </button>
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
                        <button
                          className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 hover:bg-red-50 px-2 py-1 rounded text-xs font-medium"
                          title="Delete student permanently"
                          onClick={() => openDeleteStudent(s)}
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
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
          </>
        )}
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
        <div className="flex items-start gap-3">
          <div
          className={
            'shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ' +
            (alert.type === 'success'
              ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
              : alert.type === 'error'
              ? 'bg-red-50 text-red-600 border border-red-100'
              : 'bg-blue-50 text-blue-600 border border-blue-100')
          }
        >
          {alert.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5" />
          ) : alert.type === 'error' ? (
            <XCircle className="w-5 h-5" />
          ) : (
            <AlertTriangle className="w-5 h-5" />
          )}
        </div>
          <div className="flex-1 min-w-0">
          <p className="text-gray-700 whitespace-pre-wrap break-words select-text leading-relaxed">{alert.message}</p>
          {alert.details && alert.details.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {alert.details.map((d, i) => (
                <li key={i} className="text-xs leading-relaxed pl-3 border-l-2 border-black/10 ml-0.5">
                  <span className="opacity-80">{d}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
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
        <div className="space-y-6">
          {/* SECTION 1: PERSONAL */}
          {sectionHead('Personal Information', <span className="text-lg">👤</span>, editorOpen === 'create' ? 'Core identifying details for the new student.' : 'Update student personal details.')}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={students.fieldFirstName} required validity={textReq(editorState.firstName)} forceValidation={editorValidityCheck > 0}>
              <input key="create-student-firstname" autoComplete="off" className={validInput(textReq(editorState.firstName))} value={editorState.firstName} onChange={(e) => patchEditor({ firstName: e.target.value })} placeholder="e.g. Adebayo" />
            </Field>
            <Field label={students.fieldLastName} required validity={textReq(editorState.lastName)} forceValidation={editorValidityCheck > 0}>
              <input key="create-student-lastname" autoComplete="off" className={validInput(textReq(editorState.lastName))} value={editorState.lastName} onChange={(e) => patchEditor({ lastName: e.target.value })} placeholder="e.g. Okafor" />
            </Field>
            <div className="sm:col-span-2">
              <Field label={students.fieldMiddleName} hint="Optional — will be omitted from receipts if blank.">
                <input key="create-student-middlename" autoComplete="off" className={validInput()} value={editorState.middleName} onChange={(e) => patchEditor({ middleName: e.target.value })} placeholder="e.g. Chinedu (optional)" />
              </Field>
            </div>
            <Field label={students.fieldEmail} required validity={emailValidity} forceValidation={editorValidityCheck > 0}>
              <input key="create-student-email" type="email" autoComplete="off" className={validInput(emailValidity)} value={editorState.email} onChange={(e) => patchEditor({ email: e.target.value })} placeholder="student.name@university.edu.ng" />
            </Field>
            <Field label={students.fieldPhoneNumber} hint="Optional. Used for SMS notifications if configured.">
              <input key="create-student-phone" autoComplete="off" inputMode="tel" className={validInput()} value={editorState.phoneNumber} onChange={(e) => patchEditor({ phoneNumber: e.target.value })} placeholder="0801 234 5678" />
            </Field>
            <div className="sm:col-span-2">
              <Field label={students.fieldMatricNumber} required validity={textReq(editorState.matricNumber)} forceValidation={editorValidityCheck > 0} hint="Unique identifier. Used later by Bursary/Admin to issue DIRECT BILLS to this student.">
                <input key="create-student-matric" autoComplete="off" className={`${validInput(textReq(editorState.matricNumber))} font-mono tracking-wide`} value={editorState.matricNumber} onChange={(e) => patchEditor({ matricNumber: e.target.value })} placeholder="e.g. 2025/ENG/0001" />
              </Field>
            </div>
          </div>

          {/* SECTION 2: ACADEMIC PLACEMENT */}
          {sectionHead('Academic Placement', <GraduationCap className="w-4 h-4" />, editorOpen === 'create' ? 'Pick Programme — College & Department are auto-filled for you.' : 'Programme changes auto cascade to Department & College.')}
          {hierarchyLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 px-3 py-4 bg-gray-50 rounded-lg">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading programmes and sessions…
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
                    <div className="mt-0.5">Go to <span className="font-medium">ACADEMIC STRUCTURE → Programmes</span> to define at least one Programme (with a parent Department & College). Then return here.</div>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Field label="Programme" required validity={textReq(editorState.programmeId)} forceValidation={editorValidityCheck > 0} hint="Once selected, Department and College are auto-inferred for you.">
                    <select
                      key="create-student-programme"
                      className={validInput(textReq(editorState.programmeId))}
                      value={editorState.programmeId}
                      onChange={(e) => patchEditor({ programmeId: e.target.value })}
                    >
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

                <Field
                  label={students.fieldStudentCategory}
                  hint={categoryErr ?? students.fieldStudentCategoryHint}
                >
                  <select
                    key="create-student-category"
                    className={validInput()}
                    value={editorState.studentCategoryId}
                    onChange={(e) => patchEditor({ studentCategoryId: e.target.value })}
                    disabled={categoryLoading}
                  >
                    <option value="">{categoryLoading ? 'Loading…' : '— Select a Student Category —'}</option>
                    {editorCategoryOptions.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.name}{c.isActive ? '' : ' (inactive)'}
                      </option>
                    ))}
                  </select>
                </Field>

                {editorOpen === 'edit' && (
                  <Field label={students.fieldAccountStatus}>
                    <select key="create-student-status" className={validInput()} value={editorState.accountStatus} onChange={(e) => patchEditor({ accountStatus: e.target.value })}>
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
                    key="create-student-password"
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
              <div className="flex items-center gap-2">
                <button
                  onClick={submitReset}
                  disabled={resetSubmitting}
                  className="px-4 py-2 rounded-lg font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 border border-gray-200 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-4 h-4 ${resetSubmitting ? 'animate-spin' : ''}`} />
                  Regenerate
                </button>
                <button
                  onClick={() => setResetOpen(null)}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 rounded-lg font-bold shadow-sm"
                >
                  Done
                </button>
              </div>
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
          <div className="space-y-5">
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <ShieldAlert className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <div className="text-sm font-semibold text-amber-900">
                  Temporary password issued
                </div>
                <div className="text-xs text-amber-800 leading-relaxed">
                  This password will be shown ONLY ONCE — save or share it securely.
                  On first login, the student <strong>must change it immediately</strong>.
                </div>
              </div>
            </div>

            <div className="p-5 bg-gradient-to-br from-indigo-50 via-blue-50 to-cyan-50 border border-indigo-100 rounded-2xl">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] uppercase font-bold tracking-wider text-indigo-600">
                  Temporary Password
                </div>
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-semibold">
                  <Key className="w-3 h-3" />
                  14 chars · Strong
                </div>
              </div>

              <div className="relative">
                <input
                  readOnly
                  type={showResetPw ? 'text' : 'password'}
                  value={tempPassword}
                  className="w-full font-mono tracking-wider pr-[140px] pl-4 py-3.5 text-lg rounded-xl border border-indigo-200 bg-white text-gray-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                <div className="absolute inset-y-0 right-2 flex items-center gap-1.5 pr-1">
                  <button
                    type="button"
                    onClick={() => setShowResetPw((s) => !s)}
                    title={showResetPw ? 'Hide' : 'Show'}
                    className="p-1.5 rounded-lg hover:bg-indigo-100 text-indigo-600 transition"
                  >
                    {showResetPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={copyResetPw}
                    title={copiedResetPw ? 'Copied!' : 'Copy to clipboard'}
                    className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-semibold text-xs transition ${
                      copiedResetPw
                        ? 'bg-emerald-500 text-white shadow-sm'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm'
                    }`}
                  >
                    {copiedResetPw ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" /> Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-3 p-4 bg-gray-50 border border-gray-200 rounded-xl">
              <Lock className="w-4 h-4 text-gray-500 mt-0.5 shrink-0" />
              <div className="text-[12px] text-gray-600 leading-relaxed">
                <div className="font-semibold text-gray-800 mb-0.5">Security guidance</div>
                Share this password via an encrypted or in-person channel (never plain email/SMS).
                The student's next login is blocked until they choose a NEW personal password.
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-gray-700 leading-relaxed">{students.resetConfirm}</p>
            {resetOpen && (
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-100 text-sm">
                <div className="font-semibold text-gray-800">
                  {resetOpen.firstName} {resetOpen.middleName ? `${resetOpen.middleName} ` : ''}{resetOpen.lastName}
                </div>
                <div className="text-xs text-gray-500 mt-0.5 font-mono">
                  {resetOpen.matricNumber ?? `User #${resetOpen.id}`} · {resetOpen.email}
                </div>
              </div>
            )}
          </div>
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

      {/* Resend Credentials Confirmation */}
      <ConfirmAction
        isOpen={resendStudent !== null}
        onClose={() => !resendSubmitting && setResendStudent(null)}
        onConfirm={() => submitResendCredentials()}
        title="Force Resend Credentials Email?"
        description="This will RESET the student's current password to a new random temporary one and send the new password via email to the address on file. The student will be required to choose a new password on next login."
        resourceLabel={
          resendStudent
            ? `Student: ${resendStudent.firstName} ${resendStudent.lastName}${resendStudent.matricNumber ? ` (${resendStudent.matricNumber})` : ''} → ${resendStudent.email}`
            : ''
        }
        confirmLabel="Yes — Reset Password & Email New Credentials"
        confirmVariant="warning"
        cancelLabel="Cancel"
        loading={resendSubmitting}
      />

      {/* Delete Student Confirmation */}
      <ConfirmAction
        isOpen={confirm.isOpen}
        onClose={() => !confirm.loading && setConfirm({ ...confirm, isOpen: false })}
        onConfirm={confirm.onConfirm}
        title={confirm.title}
        description={confirm.description}
        resourceLabel={confirm.resourceLabel}
        confirmLabel="Delete permanently"
        confirmVariant="danger"
        cancelLabel="Cancel"
        loading={confirm.loading}
      />

      {/* Bulk Upload Wizard */}
      <Modal
        isOpen={bulkOpen}
        onClose={() => { setBulkOpen(false); setSearchParams({}); }}
        title={students.uploadTitle}
        size="xl"
        footer={
          <div className="flex w-full flex-col-reverse md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${bulkStep >= 1 ? 'bg-blue-100 text-blue-800 ring-1 ring-blue-200' : 'bg-gray-100 text-gray-500 ring-1 ring-gray-200'}`}>
                {bulkStep > 1 ? '✓' : '1.'} {students.uploadStep1}
              </span>
              <span className="text-gray-300">→</span>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${bulkStep >= 2 ? 'bg-blue-100 text-blue-800 ring-1 ring-blue-200' : 'bg-gray-100 text-gray-500 ring-1 ring-gray-200'}`}>
                {bulkStep > 2 ? '✓' : '2.'} {students.uploadStep2}
              </span>
              <span className="text-gray-300">→</span>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${bulkStep >= 3 ? 'bg-blue-100 text-blue-800 ring-1 ring-blue-200' : 'bg-gray-100 text-gray-500 ring-1 ring-gray-200'}`}>
                3. {students.uploadStep3}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  if (bulkStep === 1) { setBulkOpen(false); setSearchParams({}); }
                  else if (bulkStep === 2) { resetBulk(); }
                  else { setBulkOpen(false); setSearchParams({}); loadStudents(); }
                }}
                className="px-4 py-2 text-gray-600 hover:text-gray-800 font-medium rounded-lg border border-gray-200 hover:bg-gray-50"
              >
                {bulkStep === 1 || bulkStep === 3 ? 'Close' : 'Start over'}
              </button>
              {bulkStep === 1 && (
                <button
                  onClick={submitBulkFile}
                  disabled={!bulkFile || bulkUploading}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-bold disabled:opacity-50 inline-flex items-center gap-2 shadow-sm"
                >
                  {bulkUploading ? students.uploadSubmitting : 'Upload and preview →'}
                </button>
              )}
              {bulkStep === 2 && (
                <button
                  onClick={() => setBulkStep(3)}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-bold shadow-sm"
                >
                  Continue →
                </button>
              )}
              {bulkStep === 3 && !bulkRun && (
                <button
                  onClick={confirmBulk}
                  disabled={bulkConfirming}
                  className="bg-green-600 hover:bg-green-700 text-white px-6 py-2.5 rounded-lg font-bold disabled:opacity-50 inline-flex items-center gap-2 shadow-sm"
                >
                  {bulkConfirming ? students.uploadSubmitting : '✓ ' + students.uploadSubmit}
                </button>
              )}
              {bulkStep === 3 && bulkRun && (
                <button
                  onClick={() => { setBulkOpen(false); setSearchParams({}); loadStudents(); }}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-bold shadow-sm"
                >
                  Done →
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          {bulkStep === 1 && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center rounded-2xl border border-blue-100 bg-blue-50/60 p-5">
                <div className="flex-1">
                  <h3 className="text-base font-bold text-gray-900 mb-1 flex items-center gap-2">
                    📥 Before you start
                  </h3>
                  <p className="text-sm text-gray-700 max-w-2xl">
                    Required columns: <span className="font-semibold">firstName, lastName, matricNumber, email, phoneNumber, programmeCode/ID</span>.
                    Optional columns: college, department, programme, academicSession, password. College + Department are auto-populated from the selected Programme. Leave the password column blank to auto-generate temporary passwords for new students.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      void downloadBlob('/admin/students/template.csv', 'students-template.csv');
                    }}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-blue-300 text-blue-700 rounded-lg text-sm font-semibold hover:bg-blue-50 shadow-sm"
                  >
                    📄 Download .CSV Template
                  </a>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      void downloadBlob('/admin/students/template.xlsx', 'students-template.xlsx');
                    }}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-green-50 border border-green-300 text-green-700 rounded-lg text-sm font-semibold hover:bg-green-100 shadow-sm"
                  >
                    📗 Download .XLSX Template (2 sheets)
                  </a>
                </div>
              </div>
              <label className="block">
                <div
                  onDragOver={(e) => { e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) pickFile(f); }}
                  className={`border-2 border-dashed rounded-3xl p-10 text-center cursor-pointer transition-colors ${
                    bulkFile ? 'border-blue-400 bg-blue-50 shadow-inner' : 'border-gray-300 hover:border-blue-500 bg-gray-50 hover:bg-blue-50/40'
                  }`}
                  onClick={() => (document.getElementById('bulk-file-input') as HTMLInputElement | null)?.click()}
                >
                  <div className="text-6xl mb-4 select-none">{bulkFile ? '✅' : '☁️'}</div>
                  <p className="text-lg font-semibold text-gray-800 mb-1">
                    {bulkFile ? 'File ready for upload' : students.uploadDropzone}
                  </p>
                  <p className="text-xs text-gray-500 mb-5">{students.uploadSizeLimit} — CSV, XLSX, or XLS accepted.</p>
                  {bulkFile ? (
                    <div className="inline-flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 bg-white rounded-xl border border-blue-200 text-sm text-gray-800 shadow-sm">
                      <span className="font-semibold text-gray-900">{bulkFile.name}</span>
                      <span className="text-gray-400 hidden sm:inline">·</span>
                      <span className="text-gray-600">{(bulkFile.size / 1024).toFixed(1)} KB</span>
                      <span className="text-gray-400 hidden sm:inline">·</span>
                      <span className="text-xs text-blue-600 font-medium">Ready — click "Upload and preview" below</span>
                    </div>
                  ) : (
                    <div className="inline-flex items-center px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold shadow-sm">
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
            <div className="space-y-6">
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5">
                <p className="text-base font-bold text-blue-900 mb-3 flex items-center gap-2">
                  📊 {students.uploadSummary}
                  <span className="text-xs font-mono bg-white px-2 py-0.5 rounded-md border border-blue-200 text-blue-700">
                    {bulkStage.uploadId}
                  </span>
                </p>
                <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div className="bg-white rounded-xl px-3 py-3 border border-blue-100 text-center"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadTotalRows}</dt><dd className="text-xl font-bold text-gray-900">{bulkStage.totalRows ?? 0}</dd></div>
                  <div className="bg-white rounded-xl px-3 py-3 border border-green-100 text-center"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadValidRows}</dt><dd className="text-xl font-bold text-green-700">{bulkStage.validCount ?? 0}</dd></div>
                  <div className="bg-white rounded-xl px-3 py-3 border border-red-100 text-center"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadProblemRows}</dt><dd className="text-xl font-bold text-red-700">{bulkStage.problemCount ?? 0}</dd></div>
                  <div className="bg-white rounded-xl px-3 py-3 border border-blue-100"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadMissingHeader}</dt><dd className="text-sm font-semibold text-gray-900">{(bulkStage.missingColumns ?? []).join(', ') || '—'}</dd></div>
                  <div className="bg-white rounded-xl px-3 py-3 border border-blue-100"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadWithinFileDupes}</dt><dd className="text-sm font-semibold text-gray-900">{bulkStage.withinFileDuplicateCount ?? 0}</dd></div>
                  <div className="bg-white rounded-xl px-3 py-3 border border-blue-100"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadDbDupes}</dt><dd className="text-sm font-semibold text-gray-900">{bulkStage.dbDuplicateCount ?? 0}</dd></div>
                </dl>
                {(bulkStage.problemCount ?? 0) > 0 && (
                  <div className="mt-4">
                    <button onClick={downloadErrorsCsv} className="text-sm font-semibold bg-white border border-red-200 text-red-700 hover:bg-red-50 px-3 py-2 rounded-lg shadow-sm inline-flex items-center gap-1.5">
                      📥 {students.uploadErrorsCsv}
                    </button>
                  </div>
                )}
              </div>

              {bulkStage.preview?.validSample?.length > 0 && (
                <div>
                  <p className="text-sm font-bold text-gray-900 mb-2 flex items-center gap-2">✅ {students.uploadValidSample}</p>
                  <div className="max-h-72 overflow-auto border border-gray-200 rounded-2xl shadow-sm">
                    <table className="min-w-full text-xs divide-y divide-gray-200">
                      <thead className="bg-gray-50 sticky top-0 z-10"><tr>{Object.keys(bulkStage.preview.validSample[0]).map((k) => <th key={k} className="px-4 py-2.5 text-left text-gray-700 whitespace-nowrap bg-gray-50">{k}</th>)}</tr></thead>
                      <tbody className="divide-y divide-gray-100">
                        {bulkStage.preview.validSample.map((r: any, i: number) => (
                          <tr key={i} className="hover:bg-gray-50">{Object.values(r).map((v, j) => <td key={j} className="px-4 py-2 whitespace-nowrap text-gray-800">{String(v ?? '')}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {bulkStage.preview?.problemSample?.length > 0 && (
                <div>
                  <p className="text-sm font-bold text-red-700 mb-2 flex items-center gap-2">⚠️ {students.uploadProblemSample}</p>
                  <div className="max-h-72 overflow-auto border border-red-100 rounded-2xl bg-red-50/20 shadow-sm">
                    <table className="min-w-full text-xs divide-y divide-red-100">
                      <thead className="bg-red-50 sticky top-0 z-10">
                        <tr>
                          <th className="px-4 py-2.5 text-left text-gray-700 whitespace-nowrap bg-red-50">row</th>
                          <th className="px-4 py-2.5 text-left text-gray-700 whitespace-nowrap bg-red-50">errors</th>
                          <th className="px-4 py-2.5 text-left text-gray-700 whitespace-nowrap bg-red-50">record</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-red-50">
                        {(bulkStage.preview.problemSample as any[]).map((pr: any, i: number) => (
                          <tr key={i} className="bg-red-50/40 hover:bg-red-50/60">
                            <td className="px-4 py-2 whitespace-nowrap font-mono text-xs">{pr.row}</td>
                            <td className="px-4 py-2 whitespace-nowrap text-red-700">
                              {(pr.errors ?? []).map((e: any, k: number) => (
                                <span key={k} className="inline-block mr-2 text-xs bg-white rounded-md px-2 py-0.5 border border-red-200 my-0.5">
                                  <span className="font-bold">{e.code}</span>{e.message ? `: ${e.message}` : ''}
                                </span>
                              ))}
                            </td>
                            <td className="px-4 py-2 whitespace-nowrap text-gray-800">
                              {Object.entries(pr.record ?? {}).map(([kk, vv]) => (
                                <span key={kk} className="inline-block mr-2 my-0.5 text-xs bg-white rounded-md px-2 py-0.5 border border-gray-200"><span className="text-gray-500">{kk}=</span>{String(vv ?? '')}</span>
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

          {bulkStep === 3 && !bulkRun && (
            <div className="space-y-5">
              <div>
                <p className="text-base font-bold text-gray-900 mb-1 flex items-center gap-2">⚖️ {students.uploadStrategyTitle}</p>
                <p className="text-sm text-gray-600 mb-3">{students.uploadStrategyDesc}</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {(['SKIP', 'UPDATE', 'CANCEL'] as const).map((s) => {
                    const labelMap = { SKIP: students.uploadStrategySkip, UPDATE: students.uploadStrategyUpdate, CANCEL: students.uploadStrategyCancel };
                    const descMap = {
                      SKIP: 'Keep existing, only add truly new students.',
                      UPDATE: 'Update existing records with newer data from this sheet.',
                      CANCEL: 'Abort entirely — do nothing — if any duplicates exist.',
                    };
                    const color = { SKIP: 'blue', UPDATE: 'amber', CANCEL: 'red' }[s];
                    return (
                      <label key={s} className={`flex items-start gap-3 p-4 border-2 rounded-2xl cursor-pointer transition-all ${
                        bulkStrategy === s
                          ? color === 'blue' ? 'bg-blue-50 border-blue-400 ring-2 ring-blue-100 shadow-md'
                            : color === 'amber' ? 'bg-amber-50 border-amber-400 ring-2 ring-amber-100 shadow-md'
                            : 'bg-red-50 border-red-400 ring-2 ring-red-100 shadow-md'
                          : 'bg-white border-gray-200 hover:bg-gray-50'
                      }`}>
                        <input type="radio" className="mt-1" checked={bulkStrategy === s} onChange={() => setBulkStrategy(s)} />
                        <div>
                            <div className="text-sm font-bold text-gray-900">{labelMap[s]}</div>
                            <div className="text-xs text-gray-500 mt-1">{descMap[s] ?? ''}</div>
                          </div>
                      </label>
                    );
                  })}
                </div>
              </div>
              {bulkStrategy !== 'CANCEL' && (
                <label className="flex items-start gap-3 p-4 border border-gray-200 rounded-2xl bg-white cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={bulkSendEmails}
                    onChange={(e) => setBulkSendEmails(e.target.checked)}
                  />
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{students.uploadSendEmails}</div>
                    <div className="text-xs text-gray-500 mt-1">{students.uploadSendEmailsHint}</div>
                  </div>
                </label>
              )}
              <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 text-sm text-gray-700 shadow-inner">
                {students.uploadConfirmDesc(bulkStage?.validCount ?? 0, bulkStage?.problemCount ?? 0, bulkStrategy)}
              </div>
            </div>
          )}

          {bulkStep === 3 && bulkRun && (
            <div className="space-y-5">
              {bulkRun.status === 'FAILED' ? (
                <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-5">
                  <p className="text-base font-bold text-red-900 mb-2 flex items-center gap-2">⚠️ {students.uploadRunFailed}</p>
                  {bulkRunError && <p className="text-sm text-red-800">{bulkRunError}</p>}
                </div>
              ) : bulkRun.status === 'COMPLETED' ? (
                <div className="bg-green-50 border-2 border-green-200 rounded-2xl p-5">
                  <p className="text-base font-bold text-green-900 mb-3 flex items-center gap-2">🎉 {students.uploadDone}</p>
                  <p className="text-sm text-green-800 font-medium">
                    {students.uploadDoneMessage(bulkRun.successCount, bulkRun.skippedCount, bulkRun.failCount)}
                  </p>
                </div>
              ) : (
                <div className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-5">
                  <p className="text-base font-bold text-blue-900 mb-1 flex items-center gap-2">⏳ {students.uploadQueued}</p>
                  <p className="text-sm text-blue-800">{students.uploadQueuedHint}</p>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-semibold text-gray-800">{students.uploadProgress}</span>
                  <span className="text-sm font-bold text-gray-900">{bulkRun.percent}%</span>
                </div>
                <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden" role="progressbar" aria-valuenow={bulkRun.percent} aria-valuemin={0} aria-valuemax={100}>
                  <div
                    className={`h-3 rounded-full transition-all duration-500 ${bulkRun.status === 'FAILED' ? 'bg-red-500' : bulkRun.status === 'COMPLETED' ? 'bg-green-600' : 'bg-blue-600'}`}
                    style={{ width: `${bulkRun.percent}%` }}
                  />
                </div>
                {bulkRun.status === 'PENDING' || bulkRun.status === 'PROCESSING' ? (
                  <p className="text-xs text-gray-500 mt-1.5">{students.uploadRunning}</p>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="bg-white rounded-xl px-4 py-4 border border-gray-100 text-center shadow-sm"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadTotalRows}</dt><dd className="text-2xl font-bold text-gray-900">{bulkRun.totalRows}</dd></div>
                <div className="bg-white rounded-xl px-4 py-4 border border-green-100 text-center shadow-sm"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadSuccessCount}</dt><dd className="text-2xl font-bold text-green-700">{bulkRun.successCount}</dd></div>
                <div className="bg-white rounded-xl px-4 py-4 border border-red-100 text-center shadow-sm"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadFailCount}</dt><dd className="text-2xl font-bold text-red-700">{bulkRun.failCount}</dd></div>
                <div className="bg-white rounded-xl px-4 py-4 border border-gray-100 text-center shadow-sm"><dt className="text-xs text-gray-500 uppercase tracking-wide mb-1">{students.uploadSkippedCount}</dt><dd className="text-2xl font-bold text-gray-700">{bulkRun.skippedCount}</dd></div>
              </dl>

              {bulkRun.status === 'COMPLETED' && bulkRun.successCount > 0 && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <button
                    onClick={() => void downloadCredentialsCsv(bulkRun.uuid)}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold shadow-sm"
                  >
                    <Download className="w-4 h-4" /> {students.uploadDownloadCredentials}
                  </button>
                  <span className="text-xs text-gray-500">{students.uploadDownloadCredentialsHint}</span>
                </div>
              )}

              {bulkRunError && bulkRun.status !== 'FAILED' && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">{bulkRunError}</div>
              )}
            </div>
          )}
        </div>
      </Modal>
    </PortalShell>
  );
};

export default StudentsPage;
