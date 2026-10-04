// =============================================================================
// Admin Fee Pages: Fees list CRUD, Categories CRUD, Assignments wizard, Bulk upload
// -----------------------------------------------------------------------------
// Single shared component AdminFeesPage, mounted for /admin/fees/:tab? and
// /bursary/fees/:tab? via App.tsx (role-based visibility of mutation buttons).
// =============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, FileText, Settings2, Trash2, Power } from 'lucide-react';
import PortalShell from '../../components/PortalShell';
import Modal from '../../components/Modal';
import ConfirmAction from '../../components/ConfirmAction';
import DirectBillForm from '../../components/fees/DirectBillForm';
import { useAuth } from '../../context/AuthContext';
import { navCounters, NavCounters, downloadBlob } from '../../services/api';
import {
  adminFees,
  feeCategories as FEE_CATEGORY_PRESETS,
  i18n,
  semesterLabels,
  studentTypes,
} from '../../i18n/en';
import feeApi, {
  type CategoryOut,
  type CloneFeeInput,
  type CreateAssignmentInput,
  type CreateCategoryInput,
  type CreateFeeInput,
  type FeeOut,
  type FeeAssignmentOut,
  type GenerateResp,
  type DirectStudentBillSuccessResp,
  type MatricStudentResp,
} from '../../services/adminFees';
import MatricStudentInput from '../../components/fees/MatricStudentInput';

type AlertState = { isOpen: boolean; title: string; message: string; type: 'success' | 'error' | 'info'; details?: string[] | null; };

const fmtNgn = (n: number | string | null | undefined) => {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 2 }).format(v);
};
const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });
};
const toISODate = (s: string | null | undefined) => (s ? new Date(s).toISOString().slice(0, 10) : '');

const BoolPill: React.FC<{ value: boolean; yes?: string; no?: string; }> = ({ value, yes = 'Yes', no = 'No' }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${value ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>{value ? yes : no}</span>
);

const ActivePill: React.FC<{ value: boolean; }> = ({ value }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${value ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600'}`}>
    {value ? adminFees.common.active : adminFees.common.inactive}
  </span>
);

function initialToForm(x: FeeOut | undefined, categories: CategoryOut[]): CreateFeeInput {
  return {
    feeCode: x?.feeCode ?? '',
    name: x?.name ?? '',
    description: x?.description ?? undefined,
    categoryId: x?.categoryId ?? (categories[0]?.id ?? 0),
    academicSession: x?.academicSession ?? undefined,
    college: x?.college ?? undefined,
    department: x?.department ?? undefined,
    program: x?.program ?? undefined,
    studentType: x?.studentType ?? undefined,
    semester: x?.semester ?? undefined,
    isMandatory: x?.isMandatory ?? true,
    isActive: x?.isActive ?? true,
    amount: Number(x?.amount ?? 0) || 0,
    paymentDeadline: x?.paymentDeadline ?? undefined,
  };
}

type FeeFormProps = {
  open: boolean;
  kind: 'create' | 'edit';
  initial?: FeeOut;
  categories: CategoryOut[];
  onClose: () => void;
  onSubmit: (body: CreateFeeInput) => Promise<void> | void;
  submitting?: boolean;
  frozen?: boolean;
  standalone?: boolean;
  onBack?: () => void;
};
const FeeForm: React.FC<FeeFormProps> = ({ open, kind, initial, categories, onClose, onSubmit, submitting, frozen, standalone, onBack }) => {
  const t = adminFees.fees;
  const tC = adminFees.common;
  const [form, setForm] = useState<CreateFeeInput>(() => initialToForm(initial, categories));
  const [showAdvanced, setShowAdvanced] = useState(false);
  useEffect(() => { if (open || standalone) { setForm(initialToForm(initial, categories)); setShowAdvanced(kind === 'edit'); } }, [open, standalone, initial, kind, categories]);
  const title = kind === 'create' ? t.createTitle : initial ? t.editTitle(initial.name) : t.createTitle;

  const submitHandler = (e: React.FormEvent) => {
    e.preventDefault();
    void onSubmit(form);
  };

  const previewCode = useMemo(() => {
    const cat = categories.find((c) => c.id === Number(form.categoryId));
    const nameSlug = (form.name || 'fee').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase().slice(0, 18);
    const code = (cat?.code || cat?.name || 'FEE').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '-').slice(0, 8);
    return `FEE-${code}-${nameSlug}`.slice(0, 32);
  }, [form.name, form.categoryId, categories]);

  const selectedCat = categories.find((c) => c.id === Number(form.categoryId));

  const headerBanner = (
    <div className={standalone ? 'mb-6' : '-mx-6 -mt-4 mb-5'}>
      <div className={`bg-gradient-to-r from-indigo-600 via-indigo-600 to-blue-600 text-white ${standalone ? 'rounded-2xl' : 'rounded-t-2xl'} px-6 py-4 border-b border-white/10`}>
        <div className="flex items-start gap-3.5">
          <div className="h-12 w-12 shrink-0 rounded-2xl bg-white/15 backdrop-blur border border-white/20 flex items-center justify-center ring-2 ring-white/20 shadow-lg shadow-indigo-900/20">
            <FileText size={22} strokeWidth={2.1} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-semibold leading-tight tracking-tight">{title}</h2>
              <span className="inline-flex items-center rounded-full bg-white/15 backdrop-blur px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/90 border border-white/20">
                {kind === 'create' ? 'New Bill' : 'Edit Bill'}
              </span>
            </div>
            <p className="text-[13px] text-white/80 mt-0.5 leading-relaxed">
              {kind === 'create'
                ? 'Publish a bill to the catalogue — it appears instantly for matching students to pay.'
                : `Editing: ${initial?.name ?? ''}. Changes apply to the catalogue immediately after save.`}
            </p>
          </div>
          <div className="hidden md:flex flex-col items-end text-[11px] text-white/80 leading-tight gap-1">
            <div>STEP 1 OF 1</div>
            <div>Fill basic fields · 3 easy sections</div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 text-[11.5px] font-medium">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 backdrop-blur px-3 py-1 border border-white/10 text-white">
            <span className="h-4 w-4 rounded-full bg-white/25 border border-white/30 flex items-center justify-center text-[9.5px] font-bold">1</span>
            Bill details
          </span>
          <span className="h-px flex-1 bg-white/15" />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 backdrop-blur px-3 py-1 border border-white/10 text-white/80">
            <span className="h-4 w-4 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-[9.5px] font-bold">2</span>
            Visibility
          </span>
          <span className="h-px flex-1 bg-white/15" />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 backdrop-blur px-3 py-1 border border-white/10 text-white/80">
            <span className="h-4 w-4 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-[9.5px] font-bold">3</span>
            Advanced
          </span>
        </div>
      </div>
    </div>
  );

  const actions = (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2 sm:gap-3 pt-1 w-full">
      <div className="flex items-center gap-2 text-xs text-gray-500 flex-1">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
        Autosave-ready · {kind === 'create' ? 'creates immediately when you click Create Bill' : 'edits applied on Save'}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack ?? onClose} className="px-5 py-2.5 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition">
          {onBack ? '← Back to Bills' : tC.cancel}
        </button>
        <button
          type="submit"
          form="fee-form"
          disabled={submitting}
          className="px-6 py-2.5 rounded-lg bg-gradient-to-br from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-md shadow-indigo-600/20 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition"
        >
          {submitting
            ? <span className="inline-flex items-center gap-2"><span className="h-3.5 w-3.5 rounded-full border-2 border-white/60 border-t-white animate-spin" /> {tC.submitting}</span>
            : kind === 'create' ? 'Create Bill' : tC.save}
        </button>
      </div>
    </div>
  );

  const body = (
    <form id="fee-form" onSubmit={submitHandler} className="space-y-5 text-sm">
      <section className="rounded-2xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between gap-3 bg-gradient-to-br from-gray-50 to-white">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 shrink-0 rounded-lg bg-blue-50 border border-blue-100 text-blue-700 flex items-center justify-center font-bold text-[12px]">01</div>
            <div>
              <h3 className="text-sm font-bold text-gray-900 leading-tight">Bill details</h3>
              <p className="text-[11.5px] text-gray-500 mt-0.5">Core fields students will see first in the catalogue</p>
            </div>
          </div>
          <span className="hidden md:inline-flex items-center rounded-full bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider">Required · 4 fields</span>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
          <Field label={t.fieldFeeName}>
            <div className="relative">
              <input
                required
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition placeholder:text-gray-400"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Convocation gown"
              />
            </div>
          </Field>
          <Field label={t.fieldCategory}>
            <select
              required
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
              value={String(form.categoryId)}
              onChange={(e) => setForm((f) => ({ ...f, categoryId: Number(e.target.value) }))}
              disabled={frozen}
            >
              <option value="">Select bill category…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {selectedCat && (
              <div className="mt-2 flex items-start gap-2 text-[11.5px]">
                <span className="inline-flex items-center rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100 px-1.5 py-0.5 font-mono text-[10.5px] leading-none">{selectedCat.code}</span>
                <span className="text-gray-500 leading-snug">{selectedCat.description ? selectedCat.description.slice(0, 100) : 'System category'}</span>
              </div>
            )}
          </Field>
          <Field label={t.fieldAmount}>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold text-sm select-none">₦</span>
              <input
                required
                type="number"
                min={0}
                step="0.01"
                className="w-full rounded-lg border border-gray-300 bg-white pl-8 pr-3 py-2.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition placeholder:text-gray-400"
                value={form.amount as any}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                disabled={frozen}
                placeholder="0.00"
              />
            </div>
          </Field>
          <Field label={t.fieldFeeCode}>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Code</span>
              </div>
              <input
                className="w-full rounded-lg border border-dashed border-gray-300 bg-gray-50/80 pl-16 pr-28 py-2.5 font-mono text-[13px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition"
                placeholder={previewCode}
                value={form.feeCode}
                onChange={(e) => setForm((f) => ({ ...f, feeCode: e.target.value }))}
                pattern="^[A-Za-z0-9\-_]{0,32}$"
                disabled={kind === 'edit'}
              />
              <div className="absolute inset-y-1.5 right-1.5 my-auto flex items-center">
                <span className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-100 text-indigo-700 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Auto
                </span>
              </div>
            </div>
            <p className="mt-2 text-[11.5px] text-gray-500 leading-snug">
              {kind === 'edit'
                ? 'Bill code cannot be changed after creation.'
                : 'Leave empty — a friendly code is auto-generated. Override if you need a custom code.'}
            </p>
          </Field>
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between gap-3 bg-gradient-to-br from-gray-50 to-white">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 shrink-0 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-[12px]">02</div>
            <div>
              <h3 className="text-sm font-bold text-gray-900 leading-tight">Visibility scope</h3>
              <p className="text-[11.5px] text-gray-500 mt-0.5">Narrow who sees this bill — leave blank for every student</p>
            </div>
          </div>
          <span className="hidden md:inline-flex items-center rounded-full bg-gray-50 text-gray-600 border border-gray-200 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider">Optional · 5 filters</span>
        </div>
        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-indigo-100 bg-gradient-to-br from-indigo-50 via-blue-50/60 to-white text-indigo-900 px-4 py-3.5 flex items-start gap-3">
            <div className="h-7 w-7 shrink-0 rounded-md bg-white/90 border border-indigo-100 text-indigo-700 flex items-center justify-center text-base shadow-sm">🎯</div>
            <div className="text-[12.5px] leading-relaxed">
              <strong className="font-semibold text-indigo-900">Leave all scope filters blank</strong> to make this bill visible to every student.
              Use the filters below to narrow it to a specific College, Department, Programme, or Student Type.
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
            <Field label={t.fieldCollege}>
              <input
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                placeholder="All colleges"
                value={form.college ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, college: e.target.value || undefined }))}
              />
            </Field>
            <Field label={t.fieldDepartment}>
              <input
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                placeholder="All departments"
                value={form.department ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, department: e.target.value || undefined }))}
              />
            </Field>
            <Field label={t.fieldProgram}>
              <input
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                placeholder="All programmes"
                value={form.program ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, program: e.target.value || undefined }))}
              />
            </Field>
            <Field label={t.fieldStudentType}>
              <select
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                value={form.studentType ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, studentType: e.target.value || undefined }))}
              >
                <option value="">All student types</option>
                {Object.keys(studentTypes).map((s) => <option key={s} value={s}>{(studentTypes as any)[s] ?? s}</option>)}
              </select>
            </Field>
            <Field label={t.fieldSemester} full>
              <select
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                value={form.semester ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, semester: e.target.value || undefined }))}
              >
                <option value="">All semesters</option>
                {Object.keys(semesterLabels).map((s) => <option key={s} value={s}>{(semesterLabels as any)[s] ?? s}</option>)}
              </select>
            </Field>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-gray-50/60 transition"
        >
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 shrink-0 rounded-lg bg-gradient-to-br from-gray-100 to-gray-50 border border-gray-200 text-gray-700 flex items-center justify-center font-bold text-[12px]">03</div>
            <div className="flex items-center gap-2.5">
              <Settings2 size={15} className="text-gray-500" />
              <div className="text-left">
                <h3 className="text-sm font-bold text-gray-900 leading-tight">Advanced settings</h3>
                <p className="text-[11.5px] text-gray-500 mt-0.5">Session, description, deadline &amp; flags — tweak when you need precision</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden md:inline-flex items-center rounded-full bg-gray-50 text-gray-600 border border-gray-200 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider">Optional · 6 fields</span>
            <div className="h-8 w-8 rounded-lg bg-gray-50 border border-gray-200 text-gray-500 flex items-center justify-center">
              {showAdvanced ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </div>
          </div>
        </button>
        {showAdvanced && (
          <div className="border-t border-gray-100 px-5 py-5 bg-gradient-to-br from-gray-50/40 to-white grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
            <Field label={t.fieldDeadline}>
              <input
                type="date"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                value={toISODate(form.paymentDeadline)}
                onChange={(e) => setForm((f) => ({ ...f, paymentDeadline: e.target.value || undefined }))}
                disabled={frozen}
              />
              <p className="mt-2 text-[11.5px] text-gray-500">Catalogue bills are evergreen. Deadlines only apply to direct student bills.</p>
            </Field>
            <Field label={t.fieldDescription} full>
              <textarea
                rows={2}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition resize-none"
                placeholder="Optional — explain what the bill covers (e.g. Academic gown + cap + scarf to be collected from faculty office)."
                value={form.description ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value || undefined }))}
              />
            </Field>
            <div className="md:col-span-2 rounded-xl border border-gray-200 bg-white px-4 py-3.5 grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex items-center justify-between gap-3 cursor-pointer rounded-lg border border-transparent hover:border-gray-200 hover:bg-gray-50/60 px-3 py-2.5 transition">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-700 flex items-center justify-center text-base">📌</div>
                  <div className="text-left">
                    <div className="text-[13px] font-semibold text-gray-900 leading-tight">{t.fieldIsMandatory}</div>
                    <div className="text-[11.5px] text-gray-500 mt-0.5">Appears in Outstanding bills for matching students</div>
                  </div>
                </div>
                <input type="checkbox" checked={!!form.isMandatory} onChange={(e) => setForm((f) => ({ ...f, isMandatory: e.target.checked }))} disabled={frozen} className="h-5 w-5 cursor-pointer rounded-md border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              </label>
              <label className="flex items-center justify-between gap-3 cursor-pointer rounded-lg border border-transparent hover:border-gray-200 hover:bg-gray-50/60 px-3 py-2.5 transition">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700 flex items-center justify-center text-base">✔️</div>
                  <div className="text-left">
                    <div className="text-[13px] font-semibold text-gray-900 leading-tight">{t.fieldIsActive}</div>
                    <div className="text-[11.5px] text-gray-500 mt-0.5">Untick to hide from catalogue without deleting</div>
                  </div>
                </div>
                <input type="checkbox" checked={!!form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} className="h-5 w-5 cursor-pointer rounded-md border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              </label>
            </div>
          </div>
        )}
      </section>
    </form>
  );

  if (standalone) {
    return (
      <div className="w-full">
        {headerBanner}
        <div className="bg-white rounded-2xl shadow-[0_1px_3px_rgba(16,24,40,0.06),0_1px_2px_rgba(16,24,40,0.04)] border border-gray-200 overflow-hidden">
          <div className="p-5 md:p-6 lg:p-8">
            {body}
          </div>
          <div className="border-t border-gray-200 bg-gradient-to-br from-gray-50/80 to-white px-5 md:px-6 lg:px-8 py-4 sticky bottom-0 z-10">
            {actions}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Modal
      isOpen={open}
      title={undefined}
      size="xl"
      onClose={onClose}
      footer={actions}
    >
      {headerBanner}
      {body}
    </Modal>
  );
};

const CloneFeeModal: React.FC<{
  open: boolean; fee?: FeeOut; categories?: CategoryOut[]; onClose: () => void; submitting?: boolean;
  onSubmit: (body: CloneFeeInput) => Promise<void> | void;
}> = ({ open, fee, onClose, submitting, onSubmit }) => {
  const t = adminFees.fees;
  const tC = adminFees.common;
  const [form, setForm] = useState<CloneFeeInput>({});
  useEffect(() => {
    if (open && fee) setForm({
      amount: Number(fee.amount) || undefined,
      college: fee.college ?? undefined,
      department: fee.department ?? undefined,
      program: fee.program ?? undefined,
      semester: fee.semester ?? undefined,
    });
  }, [open, fee]);
  if (!fee) return null;
  const defaultCodePreview = `${fee.feeCode.slice(0, 22)}-V2`;
  return (
    <Modal isOpen={open} title={undefined} size="lg" onClose={onClose} footer={
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2 sm:gap-3 pt-1 w-full">
        <div className="flex items-center gap-2 text-xs text-gray-500 flex-1">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
          Empty fields auto-fill from the original bill
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="px-5 py-2.5 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition">{tC.cancel}</button>
          <button
            form="clone-form"
            type="submit"
            disabled={submitting}
            className="px-6 py-2.5 rounded-lg bg-gradient-to-br from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-md shadow-indigo-600/20 transition"
          >
            {submitting
              ? <span className="inline-flex items-center gap-2"><span className="h-3.5 w-3.5 rounded-full border-2 border-white/60 border-t-white animate-spin" /> {tC.submitting}</span>
              : t.cloneCta}
          </button>
        </div>
      </div>
    }>
      <div className="-mx-6 -mt-4 mb-5">
        <div className="bg-gradient-to-r from-indigo-600 via-indigo-600 to-blue-600 text-white rounded-t-2xl px-6 py-4 border-b border-white/10">
          <div className="flex items-start gap-3.5">
            <div className="h-12 w-12 shrink-0 rounded-2xl bg-white/15 backdrop-blur border border-white/20 flex items-center justify-center ring-2 ring-white/20 shadow-lg shadow-indigo-900/20">
              <ChevronDown size={22} className="-rotate-90" strokeWidth={2.2} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-semibold leading-tight tracking-tight">{t.cloneTitle(fee.name)}</h2>
                <span className="inline-flex items-center rounded-full bg-white/15 backdrop-blur px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/90 border border-white/20">Duplicate</span>
              </div>
              <p className="text-[13px] text-white/80 mt-0.5 leading-relaxed">
                Duplicating <span className="font-semibold">{fee.name}</span> — adjust the options below to tailor the new copy. Empty fields auto-fill from sensible defaults.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Amount', value: `₦${Number(fee.amount).toLocaleString()}`, tone: 'from-emerald-50 to-white border-emerald-100 text-emerald-800' },
          { label: 'Session', value: fee.academicSession, tone: 'from-indigo-50 to-white border-indigo-100 text-indigo-800' },
          { label: 'Scope', value: fee.college || fee.department || fee.program ? (fee.program || fee.department || fee.college)?.slice(0, 22) || 'All' : 'All students', tone: 'from-blue-50 to-white border-blue-100 text-blue-800' },
          { label: 'Status', value: fee.isActive ? 'Active' : 'Inactive', tone: fee.isActive ? 'from-emerald-50 to-white border-emerald-100 text-emerald-800' : 'from-slate-50 to-white border-slate-100 text-slate-800' },
        ].map((s) => (
          <div key={s.label} className={`rounded-xl border px-3.5 py-2.5 bg-gradient-to-br ${s.tone}`}>
            <div className="text-[10.5px] uppercase tracking-wider font-semibold opacity-80">{s.label}</div>
            <div className="text-[13px] font-semibold mt-0.5 leading-tight truncate">{s.value}</div>
          </div>
        ))}
      </div>

      <form id="clone-form" onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}>
        <section className="rounded-2xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
          <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between gap-3 bg-gradient-to-br from-gray-50 to-white">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 shrink-0 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-[12px]">01</div>
              <div>
                <h3 className="text-sm font-bold text-gray-900 leading-tight">Override values</h3>
                <p className="text-[11.5px] text-gray-500 mt-0.5">Leave blank to inherit from the original bill</p>
              </div>
            </div>
            <span className="hidden md:inline-flex items-center rounded-full bg-gray-50 text-gray-600 border border-gray-200 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider">All optional</span>
          </div>
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
            <Field label={t.cloneFieldFeeCode}>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Code</span>
                </div>
                <input className="w-full rounded-lg border border-dashed border-gray-300 bg-gray-50/80 pl-16 pr-28 py-2.5 font-mono text-[13px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition" placeholder={defaultCodePreview} value={form.feeCode ?? ''} onChange={(e) => setForm((f) => ({ ...f, feeCode: e.target.value || undefined }))} />
                <div className="absolute inset-y-1.5 right-1.5 my-auto flex items-center">
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-100 text-indigo-700 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Auto
                  </span>
                </div>
              </div>
            </Field>
            <Field label={t.cloneFieldAmount}>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold text-sm select-none">₦</span>
                <input type="number" min={0} step="0.01" className="w-full rounded-lg border border-gray-300 bg-white pl-8 pr-3 py-2.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition placeholder:text-gray-400" value={(form.amount as any) ?? ''} placeholder={`Original: ₦${Number(fee.amount).toLocaleString()}`} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value ? Number(e.target.value) : undefined }))} />
              </div>
            </Field>
            <Field label={t.cloneFieldSemester}>
              <select className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition" value={form.semester ?? ''} onChange={(e) => setForm((f) => ({ ...f, semester: e.target.value || undefined }))}>
                <option value="">Keep original ({fee.semester ? (semesterLabels as any)[fee.semester] : 'All'})</option>
                {Object.keys(semesterLabels).map((s) => <option key={s} value={s}>{(semesterLabels as any)[s] ?? s}</option>)}
              </select>
            </Field>
            <Field label={t.cloneFieldCollege}><input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition" placeholder={`Keep original: ${fee.college || 'All colleges'}`} value={form.college ?? ''} onChange={(e) => setForm((f) => ({ ...f, college: e.target.value || undefined }))} /></Field>
            <Field label={t.cloneFieldDepartment}><input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition" placeholder={`Keep original: ${fee.department || 'All departments'}`} value={form.department ?? ''} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value || undefined }))} /></Field>
            <Field label={t.cloneFieldProgram}><input className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition" placeholder={`Keep original: ${fee.program || 'All programmes'}`} value={form.program ?? ''} onChange={(e) => setForm((f) => ({ ...f, program: e.target.value || undefined }))} /></Field>
            <Field label={t.fieldStudentType}><select className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition" value={form.studentType ?? ''} onChange={(e) => setForm((f) => ({ ...f, studentType: e.target.value || undefined }))}>
              <option value="">{`Keep original: ${fee.studentType ? (studentTypes as any)[fee.studentType] : 'All types'}`}</option>
              {Object.keys(studentTypes).map((s) => <option key={s} value={s}>{(studentTypes as any)[s] ?? s}</option>)}
            </select></Field>
          </div>
        </section>
      </form>
    </Modal>
  );
};

const CategoryModal: React.FC<{
  open: boolean; kind: 'create' | 'edit'; initial?: CategoryOut; onClose: () => void; onSubmit: (body: CreateCategoryInput) => Promise<void> | void; submitting?: boolean;
}> = ({ open, kind, initial, onClose, onSubmit, submitting }) => {
  const t = adminFees.categories;
  const tC = adminFees.common;
  const [form, setForm] = useState<CreateCategoryInput>({ code: '', name: '', description: '' });
  useEffect(() => { if (open) setForm({ code: initial?.code ?? '', name: initial?.name ?? '', description: initial?.description ?? undefined }); }, [open, initial]);
  const title = kind === 'create' ? t.createTitle : initial ? t.editTitle(initial.name) : t.createTitle;
  return (
    <Modal isOpen={open} title={title} onClose={onClose} footer={
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-800">{tC.cancel}</button>
        <button form="category-form" type="submit" disabled={submitting} className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium">{submitting ? tC.submitting : tC.save}</button>
      </div>
    }>
      <form id="category-form" onSubmit={(e) => { e.preventDefault(); onSubmit(form); }} className="space-y-4 text-sm">
        <Field label={t.fieldCode}>
          <input required disabled={kind === 'edit' && initial?.isSystemDefault} className="w-full rounded-md border border-gray-300 px-3 py-2 uppercase" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} pattern="^[A-Z0-9_]{3,30}$" />
        </Field>
        <Field label={t.fieldName}>
          <input required className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label={t.fieldDescription}>
          <textarea rows={2} className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.description ?? ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value || undefined }))} />
        </Field>
      </form>
    </Modal>
  );
};

type AssignmentWizardState = { step: 1 | 2 | 3 | 4 | 5; noteToStudent?: string | null; } & Partial<CreateAssignmentInput>;

const StudentTargetField: React.FC<{
  state: AssignmentWizardState;
  set: (patch: Partial<CreateAssignmentInput>) => void;
  label: string;
}> = ({ state, set, label }) => {
  const [matric, setMatric] = useState<string>(
    state.targetStudentId != null ? '' : '',
  );
  const [useNumeric, setUseNumeric] = useState<boolean>(
    state.targetStudentId != null,
  );
  useEffect(() => {
    if (state.targetStudentId != null && !useNumeric && matric === '') {
      setUseNumeric(true);
    }
  }, [state.targetStudentId, useNumeric, matric]);

  if (useNumeric) {
    return (
      <div className="space-y-2">
        <Field label={label}>
          <input
            type="number"
            className="w-full rounded-md border border-gray-300 px-3 py-2"
            value={(state.targetStudentId as any) ?? ''}
            onChange={(e) =>
              set({ targetStudentId: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="Internal numeric student ID (e.g. 3)"
          />
        </Field>
        <button
          type="button"
          onClick={() => setUseNumeric(false)}
          className="text-[11px] text-blue-700 hover:text-blue-900 underline underline-offset-2"
        >
          Switch to matric-number search instead
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <MatricStudentInput
        value={matric}
        onChange={(v) => {
          setMatric(v);
          if (v === '') set({ targetStudentId: undefined });
        }}
        onResolved={(s: MatricStudentResp | null, errMsg: string | null) => {
          if (s) set({ targetStudentId: Number(s.id) });
          else if (errMsg) set({ targetStudentId: undefined });
        }}
        label={label}
        placeholder="Enter a matric number, then press Enter or blur the field"
        autoResolveOnMount={false}
      />
      <button
        type="button"
        onClick={() => setUseNumeric(true)}
        className="text-[11px] text-gray-500 hover:text-gray-800 underline underline-offset-2"
      >
        Switch to numeric student ID input
      </button>
    </div>
  );
};

const AssignmentWizardModal: React.FC<{
  open: boolean; fees: FeeOut[]; initial?: FeeAssignmentOut; onClose: () => void; onSubmit: (body: CreateAssignmentInput, force: boolean, generateNow: boolean) => Promise<GenerateResp | null | undefined> | void; submitting?: boolean;
}> = ({ open, fees, initial, onClose, onSubmit, submitting }) => {
  const t = adminFees.assignments;
  const tC = adminFees.common;
  const [state, setState] = useState<AssignmentWizardState>({ step: 1 });
  const [force, setForce] = useState(false);
  const [generateNow, setGenerateNow] = useState(false);
  const [result, setResult] = useState<GenerateResp | null>(null);
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setState({
        step: 5,
        feeId: initial.feeId,
        assignmentType: initial.assignmentType,
        targetStudentId: initial.targetStudentId ?? undefined,
        targetProgramme: initial.targetProgramme ?? undefined,
        targetDepartment: initial.targetDepartment ?? undefined,
        targetFaculty: initial.targetFaculty ?? undefined,
        targetSession: initial.targetSession ?? undefined,
        targetStudentType: initial.targetStudentType ?? undefined,
        overrideAmount: initial.overrideAmount ? Number(initial.overrideAmount) : undefined,
        overrideDeadline: initial.overrideDeadline ?? undefined,
        isActive: initial.isActive,
        noteToStudent: initial.noteToStudent ?? undefined,
      });
      setGenerateNow(false);
    } else setState({ step: 1 });
    setResult(null);
  }, [open, initial]);

  const types: Array<{ value: string; label: string; field: keyof CreateAssignmentInput; labelFn: () => string; }> = [
    { value: 'STUDENT', label: t.typeStudent, field: 'targetStudentId', labelFn: () => t.targetLabelStudent },
    { value: 'PROGRAMME', label: t.typeProgramme, field: 'targetProgramme', labelFn: () => t.targetLabelProgramme },
    { value: 'DEPARTMENT', label: t.typeDepartment, field: 'targetDepartment', labelFn: () => t.targetLabelDepartment },
    { value: 'FACULTY', label: t.typeFaculty, field: 'targetFaculty', labelFn: () => t.targetLabelFaculty },
    { value: 'STUDENT_TYPE', label: t.typeStudentType, field: 'targetStudentType', labelFn: () => t.targetLabelStudentType },
  ];
  const type = types.find((x) => x.value === state.assignmentType);
  const selectedFee = fees.find((f) => f.id === state.feeId);

  const set = (patch: Partial<CreateAssignmentInput>) => setState((s) => ({ ...s, ...patch }));
  const goTo = (step: AssignmentWizardState['step']) => setState((s) => ({ ...s, step }));
  const canProceedTo = (target: AssignmentWizardState['step']) => {
    if (target >= 2 && !state.assignmentType) return false;
    if (target >= 3 && type && (state as any)[type.field] === undefined) return false;
    if (target >= 4 && !state.feeId) return false;
    return true;
  };

  const buildBody = (): CreateAssignmentInput => ({
    feeId: state.feeId!,
    assignmentType: state.assignmentType!,
    targetStudentId: state.targetStudentId,
    targetProgramme: state.targetProgramme,
    targetDepartment: state.targetDepartment,
    targetFaculty: state.targetFaculty,
    targetSession: state.targetSession,
    targetStudentType: state.targetStudentType,
    overrideAmount: state.overrideAmount,
    overrideDeadline: state.overrideDeadline,
    isActive: state.isActive ?? true,
    noteToStudent: state.noteToStudent ?? undefined,
  });

  const isEditMode = !!initial;

  if (isEditMode) {
    const targetValue = type ? (state as any)[type.field] ?? '' : '';
    return (
      <Modal isOpen={open} title={`Edit Bill Assignment #${initial!.id}`} onClose={onClose} footer={
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-3 pt-1 w-full">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Changes apply immediately. Changing amount/deadline affects matching student bill displays.
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-5 py-2.5 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition">{tC.cancel}</button>
            <button
              type="button"
              disabled={submitting}
              onClick={async () => {
                const body = buildBody();
                const r = await onSubmit(body, false, false);
                if (r) setResult(r);
              }}
              className="px-6 py-2.5 rounded-lg bg-gradient-to-br from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-md shadow-indigo-600/20 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition"
            >
              {submitting
                ? <span className="inline-flex items-center gap-2"><span className="h-3.5 w-3.5 rounded-full border-2 border-white/60 border-t-white animate-spin" /> {tC.submitting}</span>
                : 'Save changes'}
            </button>
          </div>
        </div>
      }>
        <div className="space-y-5 text-sm">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-gray-50 to-white px-4 py-3">
              <div className="text-[10.5px] uppercase tracking-wider font-semibold text-gray-500">Type</div>
              <div className="text-[13px] font-semibold text-gray-900 mt-1 leading-tight">{type?.label ?? state.assignmentType}</div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-gray-50 to-white px-4 py-3">
              <div className="text-[10.5px] uppercase tracking-wider font-semibold text-gray-500">Fee</div>
              <div className="text-[13px] font-semibold text-gray-900 mt-1 leading-tight truncate">
                {selectedFee ? `[${selectedFee.feeCode}] ${selectedFee.name}` : '—'}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-gray-50 to-white px-4 py-3">
              <div className="text-[10.5px] uppercase tracking-wider font-semibold text-gray-500">Target</div>
              <div className="text-[13px] font-semibold text-gray-900 mt-1 leading-tight truncate">
                {type ? `${type.label}=${targetValue}` : '—'}
              </div>
            </div>
          </div>

          {result && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm">
              {t.generateResult(result.matchingStudents, result.alreadyInvoiced, result.created, result.skipped)}
            </div>
          )}

          <section className="rounded-2xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-3 bg-gradient-to-br from-gray-50 to-white">
              <div className="h-8 w-8 shrink-0 rounded-lg bg-blue-50 border border-blue-100 text-blue-700 flex items-center justify-center font-bold text-[12px]">01</div>
              <div>
                <h3 className="text-sm font-bold text-gray-900 leading-tight">Override settings</h3>
                <p className="text-[11.5px] text-gray-500 mt-0.5">Adjust per-assignment overrides and status</p>
              </div>
            </div>
            <div className="p-5 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
                <Field label={t.overrideAmount}>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold text-sm select-none">₦</span>
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      className="w-full rounded-lg border border-gray-300 bg-white pl-8 pr-3 py-2.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition placeholder:text-gray-400"
                      value={(state.overrideAmount as any) ?? ''}
                      onChange={(e) => set({ overrideAmount: e.target.value ? Number(e.target.value) : undefined })}
                      placeholder="0.00"
                    />
                  </div>
                  <p className="mt-2 text-[11.5px] text-gray-500 leading-snug">
                    Leave blank to use the fee template amount: {fmtNgn(selectedFee?.amount)}
                  </p>
                </Field>
                <Field label={t.overrideDeadline}>
                  <input
                    type="date"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition"
                    value={toISODate(state.overrideDeadline)}
                    onChange={(e) => set({ overrideDeadline: e.target.value || undefined })}
                  />
                  <p className="mt-2 text-[11.5px] text-gray-500 leading-snug">
                    Template default: {fmtDate(selectedFee?.paymentDeadline)}. Leave blank to use template.
                  </p>
                </Field>
              </div>
              <Field label="Note to Student" full>
                <textarea
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 transition resize-none"
                  placeholder="Optional — this note will appear on the generated invoice for the student to see."
                  value={state.noteToStudent ?? ''}
                  onChange={(e) => setState((s) => ({ ...s, noteToStudent: e.target.value || undefined }))}
                />
              </Field>
              <label className="flex items-center justify-between gap-3 cursor-pointer rounded-lg border border-transparent hover:border-gray-200 hover:bg-gray-50/60 px-3 py-2.5 transition">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700 flex items-center justify-center text-base">✔️</div>
                  <div className="text-left">
                    <div className="text-[13px] font-semibold text-gray-900 leading-tight">{adminFees.common.active}</div>
                    <div className="text-[11.5px] text-gray-500 mt-0.5">Untick to disable this assignment without deleting it</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={!!state.isActive}
                  onChange={(e) => set({ isActive: e.target.checked })}
                  className="h-5 w-5 cursor-pointer rounded-md border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
              </label>
            </div>
          </section>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={open} title={t.wizardTitle} onClose={onClose} footer={
      <div className="flex justify-between items-center">
        <div>
          {state.step > 1 && <button onClick={() => goTo(Math.max(1, (state.step as number) - 1) as any)} className="px-3 py-1.5 rounded-md border border-gray-300 text-sm mr-2">Back</button>}
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-800">{tC.cancel}</button>
          {state.step >= 4 && (
            <button
              type="button"
              disabled={submitting}
              onClick={async () => {
                const body = buildBody();
                const r = await onSubmit(body, force, generateNow);
                if (r) setResult(r);
              }}
              className="px-4 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium"
            >
              {submitting ? tC.submitting : initial ? tC.save : t.generateCta}
            </button>
          )}
        </div>
      </div>
    }>
      <ol className="text-xs text-gray-500 flex gap-2 mb-4 flex-wrap">
        {['wizardStepType','wizardStepTarget','wizardStepFee','wizardStepOverrides','wizardStepReview'].map((k, idx) => {
          const active = (state.step as number) >= idx + 1;
          return <li key={k} className={`px-2 py-1 rounded ${active ? 'bg-blue-50 text-blue-800' : 'bg-gray-100 text-gray-500'}`}>{(t as any)[k]}</li>;
        })}
      </ol>

      {state.step === 1 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {types.map((ty) => (
            <button
              key={ty.value}
              type="button"
              onClick={() => { set({ assignmentType: ty.value, targetStudentId: undefined, targetProgramme: undefined, targetDepartment: undefined, targetFaculty: undefined, targetStudentType: undefined }); goTo(2); }}
              className={`text-left p-3 rounded-md border text-sm ${state.assignmentType === ty.value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}
            >
              <div className="font-medium text-gray-900">{ty.label}</div>
              <div className="text-xs text-gray-500 mt-0.5">{ty.value}</div>
            </button>
          ))}
        </div>
      )}

      {state.step === 2 && type && (
        <div className="space-y-4">
          {type.field === 'targetStudentId' ? (
            <StudentTargetField
              state={state}
              set={set}
              label={type.labelFn()}
            />
          ) : type.field === 'targetStudentType' ? (
            <Field label={type.labelFn()}>
              <select className="w-full rounded-md border border-gray-300 px-3 py-2" value={state.targetStudentType ?? ''} onChange={(e) => set({ targetStudentType: e.target.value || undefined })}>
                <option value="">—</option>
                {Object.keys(studentTypes).map((s) => <option key={s} value={s}>{(studentTypes as any)[s] ?? s}</option>)}
              </select>
            </Field>
          ) : (
            <Field label={type.labelFn()}>
              <input className="w-full rounded-md border border-gray-300 px-3 py-2" value={(state as any)[type.field] ?? ''} onChange={(e) => set({ [type.field]: e.target.value || undefined } as any)} />
            </Field>
          )}
          <button disabled={!canProceedTo(3)} type="button" onClick={() => goTo(3)} className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-300 text-sm">Next</button>
        </div>
      )}

      {state.step === 3 && (
        <div className="space-y-4">
          <Field label="Select fee">
            <select className="w-full rounded-md border border-gray-300 px-3 py-2" value={String(state.feeId ?? '')} onChange={(e) => set({ feeId: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">—</option>
              {fees.filter((f) => f.isActive).map((f) => <option key={f.id} value={f.id}>[{f.feeCode}] {f.name} — {f.academicSession} — {fmtNgn(f.amount)}</option>)}
            </select>
          </Field>
          <button disabled={!canProceedTo(4)} type="button" onClick={() => goTo(4)} className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-300 text-sm">Next</button>
        </div>
      )}

      {state.step === 4 && (
        <div className="space-y-4">
          <h4 className="font-semibold text-sm">{t.overrideSection}</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label={t.overrideAmount}><input type="number" step="0.01" min={0} className="w-full rounded-md border border-gray-300 px-3 py-2" value={(state.overrideAmount as any) ?? ''} onChange={(e) => set({ overrideAmount: e.target.value ? Number(e.target.value) : undefined })} /></Field>
            <Field label={t.overrideDeadline}><input type="date" className="w-full rounded-md border border-gray-300 px-3 py-2" value={toISODate(state.overrideDeadline)} onChange={(e) => set({ overrideDeadline: e.target.value || undefined })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!state.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
            {adminFees.common.active}
          </label>
          <div className="pt-4 border-t border-gray-100 space-y-3">
            {!initial && (
              <>
                <div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={generateNow} onChange={(e) => setGenerateNow(e.target.checked)} />
                    <span className="font-medium">{t.generateCta.replace(' Save & ', '')} immediately after saving</span>
                  </label>
                  <div className="mt-2 ml-6 rounded-md border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-xs">
                    ⚠️ <strong>Not recommended for the default a-la-carte flow.</strong> Generating now creates UNPAID invoice rows for every matching student upfront. Use this <em>only</em> if you specifically want to track pre-issued invoices per student (e.g. legacy debt rollover). Otherwise, simply save the assignment — students will self-select from the catalogue when they're ready to pay.
                  </div>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input className="mt-0.5" type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  <div>
                    <div>{t.forceLabel}</div>
                    <div className="text-xs text-gray-500">{t.forceHint}</div>
                  </div>
                </label>
              </>
            )}
            <button disabled={!canProceedTo(5)} type="button" onClick={() => goTo(5)} className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-300 text-sm">Review</button>
          </div>
        </div>
      )}

      {state.step === 5 && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-gray-500 text-xs">{adminFees.assignments.headerType}</dt><dd className="font-medium">{type?.label ?? state.assignmentType}</dd></div>
            <div><dt className="text-gray-500 text-xs">Fee</dt><dd className="font-medium">{fees.find((f) => f.id === state.feeId)?.feeCode ?? '—'}</dd></div>
            <div className="col-span-2"><dt className="text-gray-500 text-xs">{adminFees.assignments.headerTarget}</dt><dd className="font-medium">{type ? `${type.label} = ${(state as any)[type.field] ?? ''}` : '—'}</dd></div>
            {state.overrideAmount !== undefined && <div><dt className="text-gray-500 text-xs">{adminFees.assignments.overrideAmount}</dt><dd>{fmtNgn(state.overrideAmount)}</dd></div>}
            {state.overrideDeadline !== undefined && <div><dt className="text-gray-500 text-xs">{adminFees.assignments.overrideDeadline}</dt><dd>{toISODate(state.overrideDeadline)}</dd></div>}
          </dl>
          {result && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm">
              {t.generateResult(result.matchingStudents, result.alreadyInvoiced, result.created, result.skipped)}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

const UploadWizard: React.FC<{ role: 'ADMIN' | 'BURSARY'; }> = ({ role }) => {
  const t = adminFees.upload;
  const [stageId, setStageId] = useState<string | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<'SKIP' | 'UPDATE' | 'ERROR'>('SKIP');
  const [done, setDone] = useState<{ created: number; skipped: number; failed: number; } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canImport = role === 'ADMIN' || role === 'BURSARY';

  const onPickFile = async (file: File) => {
    setLoading(true); setErr(null);
    try {
      const stage = await feeApi.uploadStage(file);
      const newStageId = stage?.uploadId ?? stage?.stageId ?? stage?.stage?.stageId ?? stage?.stage?.uploadId ?? null;
      if (!newStageId) throw new Error(t.stageNotFound ?? 'Stage was not created');
      setStageId(newStageId);
      const pv = await feeApi.uploadPreview(newStageId);
      setPreview(pv);
      setStep(2);
    } catch (e: any) { setErr(e?.message ?? t.parseError); }
    finally { setLoading(false); }
  };

  const reloadPreview = useCallback(async () => {
    if (!stageId) return;
    try { const pv = await feeApi.uploadPreview(stageId); setPreview(pv); } catch (e: any) { setErr(e?.message ?? t.stageNotFound); }
  }, [stageId]);
  useEffect(() => { if (stageId && step === 2) reloadPreview(); }, [stageId, step, reloadPreview]);

  const confirm = async () => {
    if (!stageId || !canImport) return;
    setLoading(true); setErr(null);
    try {
      const r = await feeApi.uploadConfirm(stageId, strategy);
      setDone({ created: r?.created ?? 0, skipped: r?.skipped ?? 0, failed: r?.failed ?? 0 });
      setStep(3);
    } catch (e: any) { setErr(e?.message ?? 'Import failed'); }
    finally { setLoading(false); }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">{t.pageTitle}</h2>
        <p className="text-sm text-gray-500 mt-1">{t.pageSubtitle}</p>
      </div>

      <ol className="text-xs text-gray-500 flex gap-2 overflow-x-auto">
        {[t.step1, t.step2, t.step3].map((s, idx) => (
          <li key={s} className={`px-2 py-1 rounded whitespace-nowrap ${(step as number) >= idx + 1 ? 'bg-blue-50 text-blue-800' : 'bg-gray-100 text-gray-500'}`}>{s}</li>
        ))}
      </ol>

      {err && <div className="rounded-md border border-red-200 bg-red-50 text-red-800 px-4 py-2 text-sm">{err}</div>}

      {step === 1 && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <h3 className="text-sm font-bold text-blue-900">📋 Before you start — Fee bulk import guide</h3>
                <ul className="text-xs text-blue-800/90 space-y-1 list-disc pl-5 max-w-3xl">
                  <li><span className="font-semibold">Required columns:</span> feeCode, name, categoryCode, amount.</li>
                  <li><span className="font-semibold">Optional columns:</span> academicSession, level, collegeCode, departmentCode, programmeCode.</li>
                  <li>Leave <span className="font-mono">collegeCode / departmentCode / programmeCode</span> EMPTY for a GLOBAL fee (every student sees it).</li>
                  <li>Scope by College first if you need a Dept/Programme scoped fee (Dept lives under College; Programme lives under Dept).</li>
                  <li>Match fee categories by <span className="font-mono">categoryCode</span> (TUITION, ACCEPTANCE, LIBRARY, OTHER…) from the Categories tab.</li>
                  <li>Accepted formats: UTF-8 CSV (.csv) or Excel (.xlsx, .xls). Amounts accept up to 2 decimal places, NGN only.</li>
                </ul>
              </div>
              <div className="shrink-0 flex flex-wrap gap-2">
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void downloadBlob('/fees/template.csv', 'fees-template.csv');
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-blue-300 text-blue-700 hover:bg-blue-100 text-sm font-semibold shadow-sm"
                >
                  📄 Download .CSV Template
                </a>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void downloadBlob('/fees/template.xlsx', 'fees-template.xlsx');
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-green-50 border border-green-300 text-green-700 hover:bg-green-100 text-sm font-semibold shadow-sm"
                >
                  📗 Download .XLSX Template (2 sheets)
                </a>
              </div>
            </div>
          </div>
          <div>
            <input ref={inputRef} type="file" className="hidden" accept=".csv,.xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickFile(f); }} disabled={!canImport || loading} />
            <button type="button" disabled={!canImport || loading} onClick={() => inputRef.current?.click()} className="w-full border-2 border-dashed border-gray-300 hover:border-blue-400 rounded-xl py-10 text-sm text-gray-600 disabled:opacity-60">
              <div className="font-semibold">{t.dropzone}</div>
              <div className="text-xs text-gray-500 mt-2 max-w-2xl mx-auto">{t.sizeLimit}</div>
            </button>
          </div>
        </div>
      )}

      {step === 2 && preview && (
        <div className="space-y-4">
          <h3 className="font-medium text-gray-900">{t.summary}</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            <Stat label={t.totalRows} value={preview.totalRows} />
            <Stat label={t.validRows} value={preview.validRows} />
            <Stat label={t.problemRows} value={preview.problemRows} />
            <Stat label={t.withinFileDupes} value={preview.withinFileDupes} />
            <Stat label={t.dbDupes} value={preview.dbDupes} />
            <Stat label={t.missingHeader} value={preview.missingHeaders ? String(preview.missingHeaders) : '—'} />
          </div>
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <h4 className="text-sm font-semibold mb-2">{t.validSample}</h4>
              <div className="overflow-x-auto border border-gray-200 rounded-md max-h-60">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>{(preview.validSample?.[0] ? Object.keys(preview.validSample[0]) : []).slice(0, 10).map((k) => <th key={k} className="px-2 py-1.5 text-left">{k}</th>)}</tr>
                  </thead>
                  <tbody>
                    {(preview.validSample ?? []).slice(0, 20).map((row: any, idx: number) => (
                      <tr key={idx}>{Object.values(row).slice(0, 10).map((v, i) => <td key={i} className="px-2 py-1 border-t border-gray-100">{String(v ?? '')}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-semibold mb-2">{t.problemSample}</h4>
              <div className="overflow-x-auto border border-gray-200 rounded-md max-h-60">
                {(preview.problemSample?.length ?? 0) === 0 ? (
                  <div className="p-4 text-sm text-gray-500">{t.noErrors}</div>
                ) : (
                  <table className="min-w-full text-xs">
                    <thead className="bg-gray-50"><tr>{Object.keys(preview.problemSample[0]).slice(0, 10).map((k) => <th key={k} className="px-2 py-1.5 text-left">{k}</th>)}</tr></thead>
                    <tbody>
                      {preview.problemSample.slice(0, 20).map((row: any, idx: number) => (
                        <tr key={idx}>{Object.values(row).slice(0, 10).map((v, i) => <td key={i} className="px-2 py-1 border-t border-gray-100">{String(v ?? '')}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {stageId && (preview.problemRows ?? 0) > 0 && (
                <a href={feeApi.uploadErrorsUrl(stageId)} target="_blank" rel="noreferrer" className="inline-block mt-3 text-sm text-blue-700 hover:underline">⬇ {t.errorsCsv}</a>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 p-4 space-y-3">
            <h4 className="font-semibold text-gray-900 text-sm">{t.strategyTitle}</h4>
            <p className="text-xs text-gray-500">{t.strategyDesc}</p>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={strategy === 'SKIP'} onChange={() => setStrategy('SKIP')} />{t.strategySkip}</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={strategy === 'UPDATE'} onChange={() => setStrategy('UPDATE')} />{t.strategyUpdate}</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={strategy === 'ERROR'} onChange={() => setStrategy('ERROR')} />{t.strategyCancel}</label>
            <p className="text-xs text-gray-500">{t.confirmDesc(preview.validRows ?? 0, preview.problemRows ?? 0, strategy)}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setStep(1)} className="px-3 py-1.5 border border-gray-300 rounded-md text-sm">{adminFees.common.cancel}</button>
              <button disabled={!canImport || loading} onClick={confirm} className="px-4 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium">{loading ? t.submitting : t.submit}</button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && done && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-4 space-y-2 text-sm">
          <h3 className="font-semibold text-emerald-900">{t.done}</h3>
          <p className="text-emerald-900">{t.doneMessage(done.created, done.skipped, done.failed)}</p>
          <button type="button" onClick={() => { setStep(1); setStageId(null); setPreview(null); setDone(null); setStrategy('SKIP'); setErr(null); }} className="mt-2 px-3 py-1.5 rounded-md border border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100 text-sm">Start another import</button>
        </div>
      )}
    </div>
  );

  function Stat({ label, value }: { label: string; value: any }) {
    return <div className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2"><div className="text-xs text-gray-500">{label}</div><div className="font-semibold text-gray-900">{String(value ?? '—')}</div></div>;
  }
};

const Field: React.FC<{ label: string; full?: boolean; children: React.ReactNode; }> = ({ label, children, full }) => (
  <div className={full ? 'md:col-span-2' : ''}>
    <label className="block text-xs text-gray-600 mb-1 font-medium">{label}</label>
    {children}
  </div>
);

export type FeeTab = 'fees' | 'categories' | 'assignments' | 'upload' | 'create';

const AdminFeesPage: React.FC<{ role: 'ADMIN' | 'BURSARY'; brand: string; userText: string; onLogout: () => void; goBack: () => void; dashboardTo: string; initialTab?: FeeTab; }> = ({ role, brand, userText, onLogout, goBack, dashboardTo, initialTab }) => {
  const { user } = useAuth();
  const location = useLocation();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const canMutate = role === 'ADMIN';
  const [navCounts, setNavCounts] = useState<NavCounters>({});
  void goBack;
  void dashboardTo;

  useEffect(() => {
    navCounters().then(setNavCounts);
  }, []);

  const paramTab = (params as any).tab as FeeTab | undefined;
  const searchTab = searchParams.get('tab') as FeeTab | null;
  const resolvedTab: FeeTab = (searchTab ?? paramTab ?? initialTab ?? 'fees') as FeeTab;
  const [activeTab, setActiveTab] = useState<FeeTab>(resolvedTab);

  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'info', details: null });
  const notify = (title: string, message: string, type: AlertState['type'] = 'success', details?: string[] | null) => setAlert({ isOpen: true, title, message, type, details: details ?? null });
  const onMutateErr = (prefix: string, err: any) => {
    const resp = (err as any)?.response?.data;
    const msg = resp?.message ?? err?.message ?? 'An unexpected error occurred.';
    const rawDetails = resp?.details;
    let details: string[] | undefined;
    if (Array.isArray(rawDetails)) {
      details = rawDetails
        .slice(0, 8)
        .map((d: any) => {
          const p = d?.path ? `${d.path}: ` : '';
          const m = d?.message ?? 'Invalid value';
          const r = d?.received !== undefined && d.received !== '' ? ` (received: ${JSON.stringify(d.received)})` : '';
          return `${p}${m}${r}`;
        });
      if (rawDetails.length > details.length) {
        details.push(`…and ${rawDetails.length - details.length} more issue${rawDetails.length - details.length === 1 ? '' : 's'}`);
      }
    }
    notify(prefix, msg, 'error', details);
  };

  useEffect(() => {
    const newResolvedTab: FeeTab = (searchTab ?? paramTab ?? initialTab ?? 'fees') as FeeTab;
    setActiveTab(newResolvedTab);
  }, [searchTab, paramTab, initialTab]);

  interface DestructiveConfirmState {
    isOpen: boolean;
    title: string;
    description: string;
    resourceLabel: string;
    reasonRequired: boolean;
    confirmVariant: 'danger' | 'warning' | 'primary';
    confirmLabel?: string;
    loading: boolean;
    onConfirm: (payload: { reason?: string }) => Promise<void>;
  }
  const [confirm, setConfirm] = useState<DestructiveConfirmState>({
    isOpen: false,
    title: '',
    description: '',
    resourceLabel: '',
    reasonRequired: true,
    confirmVariant: 'danger',
    confirmLabel: undefined,
    loading: false,
    onConfirm: async () => {},
  });
  const closeConfirm = () => setConfirm((s) => ({ ...s, isOpen: false }));

  const [categories, setCategories] = useState<CategoryOut[]>([]);
  const [fees, setFees] = useState<FeeOut[]>([]);

  const [feesLoading, setFeesLoading] = useState(false);
  const [feesResp, setFeesResp] = useState<{ total: number; page: number; pageSize: number; } | null>(null);
  const fq = useFeeQueryState();

  const loadCategories = useCallback(async () => {
    try { const r = await feeApi.listCategories({ pageSize: 500 }); setCategories(r.categories ?? []); }
    catch (e) { /* silent */ }
  }, []);
  useEffect(() => { loadCategories(); }, [loadCategories]);

  const loadFees = useCallback(async () => {
    setFeesLoading(true);
    try {
      const r = await feeApi.listFees(fq.query);
      setFees(r.fees ?? []);
      setFeesResp({ total: r.total, page: r.page, pageSize: r.pageSize });
    } catch (e: any) { onMutateErr('Could not load fees', e); }
    finally { setFeesLoading(false); }
  }, [fq.sigkey]);

  useEffect(() => { if (activeTab === 'fees' || activeTab === 'assignments') loadFees(); }, [activeTab, loadFees]);

  const [feeModal, setFeeModal] = useState<{ open: boolean; kind: 'create' | 'edit'; initial?: FeeOut; }>({ open: false, kind: 'create' });
  const [cloneModal, setCloneModal] = useState<{ open: boolean; fee?: FeeOut }>({ open: false });
  const [feeSubmitting, setFeeSubmitting] = useState(false);
  const [catModal, setCatModal] = useState<{ open: boolean; kind: 'create' | 'edit'; initial?: CategoryOut }>({ open: false, kind: 'create' });
  const [catSubmitting, setCatSubmitting] = useState(false);
  const [assignModal, setAssignModal] = useState<{ open: boolean; initial?: FeeAssignmentOut; }>({ open: false });
  const [assignSubmitting, setAssignSubmitting] = useState(false);
  const [directBillModalOpen, setDirectBillModalOpen] = useState(false);

  const [catsLoading, setCatsLoading] = useState(false);
  const [catsResp, setCatsResp] = useState<{ total: number; page: number; pageSize: number; } | null>(null);
  const cq = useCategoryQueryState();
  const loadCategoriesList = useCallback(async () => {
    setCatsLoading(true);
    try { const r = await feeApi.listCategories(cq.query); setCategories(r.categories ?? []); setCatsResp({ total: r.total, page: r.page, pageSize: r.pageSize }); }
    catch (e: any) { onMutateErr('Could not load categories', e); }
    finally { setCatsLoading(false); }
  }, [cq.sigkey]);
  useEffect(() => { if (activeTab === 'categories') loadCategoriesList(); }, [activeTab, loadCategoriesList]);

  const [assignments, setAssignments] = useState<FeeAssignmentOut[]>([]);
  const [assignResp, setAssignResp] = useState<{ total: number; page: number; pageSize: number; } | null>(null);
  const [assignLoading, setAssignLoading] = useState(false);
  const aq = useAssignmentQueryState();
  const loadAssignments = useCallback(async () => {
    setAssignLoading(true);
    try { const r = await feeApi.listAssignments(aq.query); setAssignments(r.assignments ?? []); setAssignResp({ total: r.total, page: r.page, pageSize: r.pageSize }); }
    catch (e: any) { onMutateErr('Could not load assignments', e); }
    finally { setAssignLoading(false); }
  }, [aq.sigkey]);
  useEffect(() => { if (activeTab === 'assignments') loadAssignments(); }, [activeTab, loadAssignments]);

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
      <div className="w-full space-y-6">
        {activeTab !== 'create' && (
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">
                {activeTab === 'fees' && adminFees.fees.pageTitle}
                {activeTab === 'categories' && adminFees.categories.pageTitle}
                {activeTab === 'upload' && adminFees.upload.pageTitle}
                {activeTab === 'assignments' && adminFees.assignments.pageTitle}
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                {activeTab === 'fees' && adminFees.fees.pageSubtitle}
                {activeTab === 'categories' && adminFees.categories.pageSubtitle}
                {activeTab === 'upload' && adminFees.upload.pageSubtitle}
                {activeTab === 'assignments' && adminFees.assignments.pageSubtitle}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="flex rounded-lg border border-gray-200 bg-white p-1">
                {(['fees', 'categories', 'assignments', 'upload'] as const).map((t) => {
                  const labelMap: Record<string, string> = {
                    fees: 'Bills', categories: 'Categories', assignments: 'Bill Assignments', upload: 'Bulk Upload',
                  };
                  return (
                    <button
                      key={t}
                      onClick={() => setSearchParams({ tab: t })}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        activeTab === t ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      {labelMap[t]}
                    </button>
                  );
                })}
              </div>
              {activeTab === 'fees' && canMutate && (
                <button className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium" onClick={() => setSearchParams({ tab: 'create' })}>{adminFees.common.createFee}</button>
              )}
              {activeTab === 'categories' && canMutate && (
                <button className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium" onClick={() => { setSearchParams({ tab: 'categories' }); setCatModal({ open: true, kind: 'create' }); }}>{adminFees.common.createCategory}</button>
              )}
            {canMutate && (
              <button
                type="button"
                onClick={() => setDirectBillModalOpen(true)}
                className="px-4 py-2 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium inline-flex items-center gap-1.5 shadow-sm"
                title="Bill one specific student by matric number (shortcut — no assignment wizard needed)"
              >
                ⚡ Bill a Student (Direct)
              </button>
            )}
          </div>
        </header>
        )}

        {activeTab === 'create' && canMutate && (
          <FeeForm
            open={false}
            kind="create"
            categories={categories}
            standalone
            onBack={() => setSearchParams({ tab: 'fees' })}
            onClose={() => setSearchParams({ tab: 'fees' })}
            submitting={feeSubmitting}
            onSubmit={async (body) => {
              setFeeSubmitting(true);
              try {
                let displayCode: string = body.feeCode || (body.name || 'New bill').slice(0, 24);
                const r = await feeApi.createFee(body);
                displayCode = (r as any)?.fee?.feeCode || displayCode;
                notify('Fee created', displayCode, 'success');
                setSearchParams({ tab: 'fees' });
                await loadFees();
              } catch (e: any) { onMutateErr('Create failed', e); }
              finally { setFeeSubmitting(false); }
            }}
          />
        )}

        {activeTab === 'fees' && (
          <FeesList
            fq={fq}
            loading={feesLoading}
            resp={feesResp}
            fees={fees}
            categories={categories}
            canMutate={canMutate}
            onEdit={(f) => setFeeModal({ open: true, kind: 'edit', initial: f })}
            onClone={(f) => setCloneModal({ open: true, fee: f })}
            onActivate={async (f) => { try { await feeApi.activateFee(f.id); notify('Fee activated', `${f.feeCode} active now`, 'success'); await loadFees(); } catch (e: any) { onMutateErr('Activate failed', e); } }}
            onDisable={(f) => {
              setConfirm({
                isOpen: true,
                title: 'Disable Fee',
                description: 'Disabling this fee will prevent it from being assigned to students or cohorts.',
                resourceLabel: `Fee: ${f.feeCode} — ${f.name}`,
                reasonRequired: true,
                confirmVariant: 'danger',
                confirmLabel: adminFees.fees.disableAction,
                loading: false,
                onConfirm: async (_payload) => {
                  setConfirm((s) => ({ ...s, loading: true }));
                  try {
                    await feeApi.disableFee(f.id);
                    notify('Fee disabled', `${f.feeCode} inactive`, 'info');
                    closeConfirm();
                    await loadFees();
                  } catch (e: any) {
                    setConfirm((s) => ({ ...s, loading: false }));
                    onMutateErr('Disable failed', e);
                  }
                },
              });
            }}
            onDelete={(f) => {
              setConfirm({
                isOpen: true,
                title: 'Delete Bill (permanent)',
                description: 'Permanently removes this bill from the catalogue. Cannot be undone. If this bill already has assigned students, invoices, or paid transactions, you will see an error with specific counts — use Disable (soft-deactivate) instead to preserve history.',
                resourceLabel: `Bill: ${f.feeCode} — ${f.name}`,
                reasonRequired: false,
                confirmVariant: 'danger',
                confirmLabel: 'Delete bill',
                loading: false,
                onConfirm: async (_payload) => {
                  setConfirm((s) => ({ ...s, loading: true }));
                  try {
                    await feeApi.deleteFee(f.id);
                    notify('Bill deleted', `${f.feeCode} — ${f.name}`, 'success');
                    closeConfirm();
                    await loadFees();
                  } catch (e: any) {
                    setConfirm((s) => ({ ...s, loading: false }));
                    onMutateErr('Delete bill failed', e);
                  }
                },
              });
            }}
          />
        )}

        {activeTab === 'categories' && (
          <CategoriesList
            cq={cq}
            loading={catsLoading}
            resp={catsResp}
            categories={categories}
            canMutate={canMutate}
            onEdit={(c) => setCatModal({ open: true, kind: 'edit', initial: c })}
            onDelete={(c) => {
              setConfirm({
                isOpen: true,
                title: 'Delete Fee Category',
                description: adminFees.common.deleteConfirm,
                resourceLabel: `Category: ${c.code} — ${c.name}`,
                reasonRequired: true,
                confirmVariant: 'danger',
                confirmLabel: adminFees.common.deleteCta,
                loading: false,
                onConfirm: async (_payload) => {
                  setConfirm((s) => ({ ...s, loading: true }));
                  try {
                    await feeApi.deleteCategory(c.id);
                    notify('Category deleted', c.name, 'success');
                    closeConfirm();
                    await loadCategoriesList();
                  } catch (e: any) {
                    setConfirm((s) => ({ ...s, loading: false }));
                    onMutateErr('Delete failed', { message: (c._count?.fees ? adminFees.categories.deleteFailed(c._count.fees) : e?.message) ?? 'Could not delete' });
                  }
                },
              });
            }}
          />
        )}

        {activeTab === 'assignments' && (
          <AssignmentsList
            aq={aq}
            loading={assignLoading}
            resp={assignResp}
            assignments={assignments}
            canMutate={canMutate}
            onEdit={(a) => setAssignModal({ open: true, initial: a })}
            onGenerate={async (a, force) => {
              try { const r = await feeApi.generateInvoices(a.id, force); notify('Invoices generated', adminFees.assignments.generateResult(r.matchingStudents, r.alreadyInvoiced, r.created, r.skipped), 'success'); await loadAssignments(); }
              catch (e: any) { onMutateErr('Generate failed', e); }
            }}
            onToggleActive={async (a) => {
              try {
                if (a.isActive) { await feeApi.disableAssignment(a.id); }
                else { await feeApi.enableAssignment(a.id); }
                await loadAssignments();
              } catch (e: any) { onMutateErr('Toggle active failed', e); }
            }}
            onDelete={async (a) => {
              const ok = window.confirm('Cannot be undone. Related UNPAID invoices removed.');
              if (!ok) return;
              try { await feeApi.deleteAssignment(a.id); await loadAssignments(); }
              catch (e: any) { onMutateErr('Delete assignment failed', e); }
            }}
          />
        )}

        {activeTab === 'upload' && <UploadWizard role={role} />}
      </div>

      <FeeForm
        open={feeModal.open}
        kind={feeModal.kind}
        initial={feeModal.initial}
        categories={categories}
        submitting={feeSubmitting}
        frozen={(feeModal.initial?._count?.invoices ?? 0) > 0 && feeModal.kind === 'edit'}
        standalone={false}
        onClose={() => {
          setFeeModal((x) => ({ ...x, open: false }));
          if (searchTab === 'create') setSearchParams({ tab: 'fees' });
        }}
        onSubmit={async (body) => {
          setFeeSubmitting(true);
          try {
            let displayCode: string = body.feeCode || (body.name || 'New bill').slice(0, 24);
            if (feeModal.kind === 'create') {
              const r = await feeApi.createFee(body);
              displayCode = (r as any)?.fee?.feeCode || displayCode;
              notify('Fee created', displayCode, 'success');
            } else if (feeModal.initial) {
              await feeApi.updateFee(feeModal.initial.id, body);
              displayCode = body.feeCode || feeModal.initial.feeCode;
              notify('Fee updated', displayCode, 'success');
            }
            setFeeModal({ open: false, kind: 'create' });
            if (searchTab === 'create') setSearchParams({ tab: 'fees' });
            await loadFees();
          } catch (e: any) { onMutateErr(feeModal.kind === 'create' ? 'Create failed' : 'Update failed', e); }
          finally { setFeeSubmitting(false); }
        }}
      />

      <CloneFeeModal
        open={cloneModal.open}
        fee={cloneModal.fee}
        categories={categories}
        submitting={feeSubmitting}
        onClose={() => setCloneModal({ open: false })}
        onSubmit={async (body) => {
          if (!cloneModal.fee) return;
          setFeeSubmitting(true);
          try {
            const r = await feeApi.cloneFee(cloneModal.fee.id, body);
            const newCode = (r as any)?.fee?.feeCode || cloneModal.fee.feeCode;
            notify('Fee cloned', newCode, 'success');
            setCloneModal({ open: false });
            await loadFees();
          } catch (e: any) { onMutateErr('Clone failed', e); }
          finally { setFeeSubmitting(false); }
        }}
      />

      <CategoryModal
        open={catModal.open}
        kind={catModal.kind}
        initial={catModal.initial}
        submitting={catSubmitting}
        onClose={() => setCatModal({ open: false, kind: 'create' })}
        onSubmit={async (body) => {
          setCatSubmitting(true);
          try {
            if (catModal.kind === 'create') { await feeApi.createCategory(body); notify('Category created', body.code, 'success'); }
            else if (catModal.initial) { await feeApi.updateCategory(catModal.initial.id, body); notify('Category updated', body.code, 'success'); }
            setCatModal({ open: false, kind: 'create' });
            await loadCategoriesList();
          } catch (e: any) { onMutateErr(catModal.kind === 'create' ? 'Create failed' : 'Update failed', e); }
          finally { setCatSubmitting(false); }
        }}
      />

      <AssignmentWizardModal
        open={assignModal.open}
        fees={fees}
        initial={assignModal.initial}
        submitting={assignSubmitting}
        onClose={() => setAssignModal({ open: false })}
        onSubmit={async (body, force, generateNow) => {
          setAssignSubmitting(true);
          try {
            let created: FeeAssignmentOut | null = null;
            if (assignModal.initial) { await feeApi.updateAssignment(assignModal.initial.id, body); }
            else { const r = await feeApi.createAssignment(body); created = r.assignment; }
            await loadAssignments();
            let result: GenerateResp | null = null;
            if (generateNow && (created || assignModal.initial)) {
              const id = created?.id ?? assignModal.initial!.id;
              result = await feeApi.generateInvoices(id, force);
              notify('Assignment saved', adminFees.assignments.generateResult(result.matchingStudents, result.alreadyInvoiced, result.created, result.skipped), 'success');
              setAssignModal({ open: false });
              return result;
            }
            notify('Assignment saved', 'Assignment saved successfully', 'success');
            setAssignModal({ open: false });
            return null;
          } catch (e: any) { onMutateErr(assignModal.initial ? 'Update failed' : 'Create failed', e); return null; }
          finally { setAssignSubmitting(false); }
        }}
      />

      <ConfirmAction
        isOpen={confirm.isOpen}
        onClose={closeConfirm}
        onConfirm={confirm.onConfirm}
        title={confirm.title}
        description={confirm.description}
        resourceLabel={confirm.resourceLabel}
        reasonRequired={confirm.reasonRequired}
        confirmVariant={confirm.confirmVariant}
        confirmLabel={confirm.confirmLabel}
        loading={confirm.loading}
      />

      <Modal isOpen={alert.isOpen} title={alert.title} onClose={() => setAlert({ ...alert, isOpen: false })}
        footer={
          <div className="w-full flex justify-end">
            <button
              type="button"
              onClick={() => setAlert({ ...alert, isOpen: false })}
              className={`px-5 py-2 rounded-lg text-sm font-semibold text-white shadow-sm focus:outline-none focus:ring-2 transition ${
                alert.type === 'error'
                  ? 'bg-gradient-to-br from-red-600 to-rose-600 hover:from-red-700 hover:to-rose-700 focus:ring-red-500/30'
                  : alert.type === 'success'
                  ? 'bg-gradient-to-br from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 focus:ring-emerald-500/30'
                  : 'bg-gradient-to-br from-slate-600 to-gray-600 hover:from-slate-700 hover:to-gray-700 focus:ring-slate-500/30'
              }`}
            >
              OK
            </button>
          </div>
        }
      >
        <div className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${
          alert.type === 'error' ? 'border-red-200 bg-red-50 text-red-900'
          : alert.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
          : 'border-blue-200 bg-blue-50 text-blue-900'
        }`}>
          <div className={`h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-base font-bold ${
            alert.type === 'error' ? 'bg-red-100 text-red-700'
            : alert.type === 'success' ? 'bg-emerald-100 text-emerald-700'
            : 'bg-blue-100 text-blue-700'
          }`}>
            {alert.type === 'error' ? '!' : alert.type === 'success' ? '✓' : 'i'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium leading-relaxed">{alert.message}</p>
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

      <Modal
        isOpen={directBillModalOpen}
        title="Bill a Specific Student by Matric (Direct)"
        size="lg"
        onClose={() => setDirectBillModalOpen(false)}
      >
        <p className="text-xs text-gray-500 mb-4">
          One-click shortcut for raising a targeted charge for a single student. The bill appears on
          their Make Payment catalogue (pinned top, DIRECT BILL badge) and in their invoices list
          immediately after submit.
        </p>
        <DirectBillForm
          actorRole={role}
          onCancel={() => setDirectBillModalOpen(false)}
          onSuccess={async (_r: DirectStudentBillSuccessResp) => {
            void loadAssignments();
            window.setTimeout(() => {
              setDirectBillModalOpen(false);
              notify(
                'Direct bill issued',
                `Invoice generated. Switch to the Assignments tab to see ${_r.matricNumber ?? ''}.`,
                'success',
              );
            }, 600);
          }}
        />
      </Modal>
    </PortalShell>
  );
};

function useFeeQueryState() {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [college, setCollege] = useState('');
  const [department, setDepartment] = useState('');
  const [program, setProgram] = useState('');
  const [studentType, setStudentType] = useState('');
  const [semester, setSemester] = useState('');
  const [isActive, setIsActive] = useState('');
  const [isMandatory, setIsMandatory] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<'createdAt' | 'name' | 'feeCode' | 'academicSession' | 'amount'>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const reset = () => { setQ(''); setCategory(''); setCollege(''); setDepartment(''); setProgram(''); setStudentType(''); setSemester(''); setIsActive(''); setIsMandatory(''); setPage(1); };
  const query: any = { page, pageSize, sort, order };
  if (q) query.q = q;
  if (category) query.category = isNaN(Number(category)) ? category : Number(category);
  if (college) query.college = college;
  if (department) query.department = department;
  if (program) query.program = program;
  if (studentType) query.studentType = studentType;
  if (semester) query.semester = semester;
  if (isActive) query.isActive = isActive === 'true';
  if (isMandatory) query.isMandatory = isMandatory === 'true';
  const sigkey = [q, category, college, department, program, studentType, semester, isActive, isMandatory, page, pageSize, sort, order].join('|');
  return { query, sigkey, reset,
    bind: { q, setQ, category, setCategory, college, setCollege, department, setDepartment, program, setProgram, studentType, setStudentType, semester, setSemester, isActive, setIsActive, isMandatory, setIsMandatory, page, setPage, pageSize, setPageSize, sort, setSort, order, setOrder },
  };
}

function useCategoryQueryState() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const query: any = { page, pageSize, sort: 'code' as const, order: 'asc' as const };
  if (q) query.q = q;
  const sigkey = [q, page, pageSize].join('|');
  return { query, sigkey, q, setQ, page, setPage, pageSize, setPageSize };
}

function useAssignmentQueryState() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [feeId, setFeeId] = useState<string>('');
  const [studentType, setStudentType] = useState('');
  const [isActive, setIsActive] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const query: any = { page, pageSize };
  if (q) query.q = q;
  if (type) query.assignmentType = type;
  if (feeId) query.feeId = Number(feeId);
  if (studentType) query.targetStudentType = studentType;
  if (isActive) query.isActive = isActive === 'true';
  const sigkey = [q, type, feeId, studentType, isActive, page, pageSize].join('|');
  return { query, sigkey, q, setQ, type, setType, feeId, setFeeId, studentType, setStudentType, isActive, setIsActive, page, setPage, pageSize, setPageSize };
}

const FeesList: React.FC<{
  fq: ReturnType<typeof useFeeQueryState>;
  loading: boolean;
  resp: { total: number; page: number; pageSize: number; } | null;
  fees: FeeOut[];
  categories: CategoryOut[];
  canMutate: boolean;
  onEdit: (f: FeeOut) => void;
  onClone: (f: FeeOut) => void;
  onActivate: (f: FeeOut) => void;
  onDisable: (f: FeeOut) => void;
  onDelete: (f: FeeOut) => void;
}> = ({ fq, loading, resp, fees, categories, canMutate, onEdit, onClone, onActivate, onDisable, onDelete }) => {
  const t = adminFees.fees;
  const tC = adminFees.common;
  const totalPages = Math.max(1, Math.ceil((resp?.total ?? 0) / (resp?.pageSize ?? 25)));
  const b = fq.bind;
  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <div className="lg:col-span-2"><label className="text-xs text-gray-600 font-medium">{tC.search}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder={t.searchPlaceholder} value={b.q} onChange={(e) => { b.setQ(e.target.value); b.setPage(1); }} /></div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterCategory}</label>
            <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.category} onChange={(e) => { b.setCategory(e.target.value); b.setPage(1); }}>
              <option value="">{tC.all}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </select>
          </div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterCollege}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.college} onChange={(e) => { b.setCollege(e.target.value); b.setPage(1); }} /></div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterDepartment}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.department} onChange={(e) => { b.setDepartment(e.target.value); b.setPage(1); }} /></div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterProgram}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.program} onChange={(e) => { b.setProgram(e.target.value); b.setPage(1); }} /></div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterStudentType}</label>
            <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.studentType} onChange={(e) => { b.setStudentType(e.target.value); b.setPage(1); }}>
              <option value="">{tC.all}</option>
              {Object.keys(studentTypes).map((s) => <option key={s} value={s}>{(studentTypes as any)[s] ?? s}</option>)}
            </select>
          </div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterSemester}</label>
            <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.semester} onChange={(e) => { b.setSemester(e.target.value); b.setPage(1); }}>
              <option value="">{tC.all}</option>
              {Object.keys(semesterLabels).map((s) => <option key={s} value={s}>{(semesterLabels as any)[s] ?? s}</option>)}
            </select>
          </div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterIsActive}</label>
            <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.isActive} onChange={(e) => { b.setIsActive(e.target.value); b.setPage(1); }}>
              <option value="">{tC.all}</option>
              <option value="true">{tC.active}</option>
              <option value="false">{tC.inactive}</option>
            </select>
          </div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterIsMandatory}</label>
            <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.isMandatory} onChange={(e) => { b.setIsMandatory(e.target.value); b.setPage(1); }}>
              <option value="">{tC.all}</option>
              <option value="true">{t.headerMandatory}</option>
              <option value="false">Optional</option>
            </select>
          </div>
          <div className="col-span-2 md:col-span-4 lg:col-span-6 flex items-end justify-between">
            <div>
              <button type="button" onClick={() => fq.reset()} className="px-3 py-1.5 rounded-md border border-gray-300 text-sm">{tC.resetFilters}</button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span>{tC.page}</span>
              <input type="number" min={1} value={b.page} onChange={(e) => b.setPage(Math.max(1, Number(e.target.value) || 1))} className="w-16 rounded-md border border-gray-300 px-2 py-1" />
              <span>{tC.of} {totalPages}</span>
              <select value={b.pageSize} onChange={(e) => { b.setPageSize(Number(e.target.value)); b.setPage(1); }} className="rounded-md border border-gray-300 px-2 py-1">
                {[10,25,50,100,250].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">{t.headerCode}</th>
                <th className="px-4 py-3 text-left font-medium">{t.headerName}</th>
                <th className="px-4 py-3 text-left font-medium">{t.headerCategory}</th>
                <th className="px-4 py-3 text-left font-medium">{t.headerSession}</th>
                <th className="px-4 py-3 text-left font-medium">{t.headerScope}</th>
                <th className="px-4 py-3 text-right font-medium">{t.headerAmount}</th>
                <th className="px-4 py-3 text-center font-medium">{t.headerMandatory}</th>
                <th className="px-4 py-3 text-left font-medium">{t.headerStatus}</th>
                <th className="px-4 py-3 text-right font-medium">{t.headerActions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && <tr><td colSpan={9} className="text-center py-10 text-gray-500">Loading…</td></tr>}
              {!loading && fees.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-gray-500">{t.empty}</td></tr>}
              {fees.map((f) => {
                const cat = categories.find((c) => c.id === f.categoryId) ?? f.category;
                const scope = [f.college, f.department, f.program, f.level ? `${f.level}L` : null, f.studentType, f.semester ? (semesterLabels as any)[f.semester] : null].filter(Boolean).join(' · ') || 'All';
                return (
                  <tr key={f.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-800">{f.feeCode}</td>
                    <td className="px-4 py-3 text-gray-900 font-medium">{f.name}</td>
                    <td className="px-4 py-3 text-gray-700">{cat ? `${cat.code}` : '—'}</td>
                    <td className="px-4 py-3 text-gray-700">{f.academicSession}</td>
                    <td className="px-4 py-3 text-gray-600 max-w-[280px] truncate" title={scope}>{scope}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmtNgn(f.amount)}</td>
                    <td className="px-4 py-3 text-center"><BoolPill value={f.isMandatory} yes={tC.mandatoryLabel} no="Optional" /></td>
                    <td className="px-4 py-3"><ActivePill value={f.isActive} />{f._count?.invoices ? <span className="ml-2 text-xs text-gray-500">({f._count.invoices} invoices)</span> : null}</td>
                    <td className="px-4 py-3">
                      {canMutate && (
                        <div className="flex items-center justify-end gap-1 text-xs">
                          <button onClick={() => onEdit(f)} className="text-blue-700 hover:text-blue-900 px-2 py-1 rounded hover:bg-blue-50">{t.editAction}</button>
                          <button onClick={() => onClone(f)} className="text-sky-700 hover:text-sky-900 px-2 py-1 rounded hover:bg-sky-50">{t.cloneAction}</button>
                          {f.isActive ? (
                            <button onClick={() => onDisable(f)} className="text-amber-700 hover:text-amber-900 px-2 py-1 rounded hover:bg-amber-50">{t.disableAction}</button>
                          ) : (
                            <button onClick={() => onActivate(f)} className="text-emerald-700 hover:text-emerald-900 px-2 py-1 rounded hover:bg-emerald-50">{t.activateAction}</button>
                          )}
                          <button type="button" onClick={() => onDelete(f)} title="Delete" className="inline-flex items-center justify-center h-8 w-8 rounded-md text-gray-600 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const CategoriesList: React.FC<{
  cq: ReturnType<typeof useCategoryQueryState>;
  loading: boolean;
  resp: { total: number; page: number; pageSize: number; } | null;
  categories: CategoryOut[];
  canMutate: boolean;
  onEdit: (c: CategoryOut) => void;
  onDelete: (c: CategoryOut) => void;
}> = ({ cq, loading, resp, categories, canMutate, onEdit, onDelete }) => {
  const t = adminFees.categories;
  const tC = adminFees.common;
  const totalPages = Math.max(1, Math.ceil((resp?.total ?? 0) / (resp?.pageSize ?? 50)));
  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex-1 min-w-[260px]">
          <label className="text-xs text-gray-600 font-medium">{tC.search}</label>
          <input className="mt-1 w-full max-w-md rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="Search code or name" value={cq.q} onChange={(e) => { cq.setQ(e.target.value); cq.setPage(1); }} />
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span>{tC.page}</span>
          <input type="number" min={1} value={cq.page} onChange={(e) => cq.setPage(Math.max(1, Number(e.target.value) || 1))} className="w-16 rounded-md border border-gray-300 px-2 py-1" />
          <span>{tC.of} {totalPages}</span>
          <select value={cq.pageSize} onChange={(e) => { cq.setPageSize(Number(e.target.value)); cq.setPage(1); }} className="rounded-md border border-gray-300 px-2 py-1">
            {[10,25,50,100,500].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-3 text-left font-medium">{t.headerCode}</th>
              <th className="px-4 py-3 text-left font-medium">{t.headerName}</th>
              <th className="px-4 py-3 text-left font-medium">{t.headerDescription}</th>
              <th className="px-4 py-3 text-center font-medium">{t.headerFeesCount}</th>
              <th className="px-4 py-3 text-right font-medium">{t.headerActions}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && <tr><td colSpan={5} className="text-center py-10 text-gray-500">Loading…</td></tr>}
            {!loading && categories.length === 0 && <tr><td colSpan={5} className="text-center py-10 text-gray-500">{t.empty}</td></tr>}
            {categories.map((c) => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs text-gray-800">{c.code}{c.isSystemDefault && <span className="ml-2 text-[10px] uppercase tracking-wide bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">Default</span>}</td>
                <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                <td className="px-4 py-3 text-gray-600 max-w-md truncate" title={c.description ?? undefined}>{c.description ?? (FEE_CATEGORY_PRESETS as any)[c.code]?.description ?? '—'}</td>
                <td className="px-4 py-3 text-center tabular-nums">{c._count?.fees ?? 0}</td>
                <td className="px-4 py-3 text-right">
                  {canMutate && (
                    <div className="flex items-center justify-end gap-1 text-xs">
                      <button onClick={() => onEdit(c)} className="text-blue-700 hover:text-blue-900 px-2 py-1 rounded hover:bg-blue-50">{adminFees.fees.editAction}</button>
                      <button onClick={() => onDelete(c)} disabled={c.isSystemDefault} className="text-red-700 hover:text-red-900 px-2 py-1 rounded hover:bg-red-50 disabled:opacity-40">{tC.deleteCta}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const AssignmentsList: React.FC<{
  aq: ReturnType<typeof useAssignmentQueryState>;
  loading: boolean;
  resp: { total: number; page: number; pageSize: number; } | null;
  assignments: FeeAssignmentOut[];
  canMutate: boolean;
  onEdit: (a: FeeAssignmentOut) => void;
  onGenerate: (a: FeeAssignmentOut, force?: boolean) => void;
  onToggleActive: (a: FeeAssignmentOut) => Promise<void> | void;
  onDelete: (a: FeeAssignmentOut) => Promise<void> | void;
}> = ({ aq, loading, resp, assignments, canMutate, onEdit, onGenerate, onToggleActive, onDelete }) => {
  const t = adminFees.assignments;
  const tC = adminFees.common;
  const totalPages = Math.max(1, Math.ceil((resp?.total ?? 0) / (resp?.pageSize ?? 25)));
  const TYPES = ['STUDENT','PROGRAMME','DEPARTMENT','FACULTY','STUDENT_TYPE'] as const;

  const isDirectBill = (a: FeeAssignmentOut) =>
    a.assignmentType === 'STUDENT' && a.targetStudentId != null;

  const matricOf = (a: FeeAssignmentOut) => a.targetStudent?.matricNumber ?? null;
  const fullNameOf = (a: FeeAssignmentOut) =>
    [a.targetStudent?.firstName, a.targetStudent?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim() || null;

  const targetDisplay = (a: FeeAssignmentOut): string => {
    if (isDirectBill(a)) {
      const name = fullNameOf(a);
      const m = matricOf(a);
      if (name && m) return `${name} · ${m}`;
      if (name) return name;
      if (m) return m;
      return `#${a.targetStudentId}`;
    }
    const parts: Array<string | number> = [];
    if (a.targetProgramme) parts.push(a.targetProgramme);
    if (a.targetDepartment) parts.push(a.targetDepartment);
    if (a.targetFaculty) parts.push(a.targetFaculty);
    if (a.targetSession) parts.push(a.targetSession);
    if (a.targetStudentType) parts.push(a.targetStudentType);
    return parts.join(' · ') || '—';
  };

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
        <div className="md:col-span-2"><label className="text-xs text-gray-600 font-medium">{tC.search}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="Programme, department, college, session, matric number, fee name/code…" value={aq.q} onChange={(e) => { aq.setQ(e.target.value); aq.setPage(1); }} /></div>
        <div><label className="text-xs text-gray-600 font-medium">{t.filterType}</label>
          <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={aq.type} onChange={(e) => { aq.setType(e.target.value); aq.setPage(1); }}>
            <option value="">{tC.all}</option>
            {TYPES.map((v) => <option key={v} value={v}>{(t as any)[`type${v.split('_').map((x) => x[0]+x.slice(1).toLowerCase()).join('')}`] ?? v}</option>)}
          </select>
        </div>
        <div><label className="text-xs text-gray-600 font-medium">{t.filterIsActive}</label>
          <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={aq.isActive} onChange={(e) => { aq.setIsActive(e.target.value); aq.setPage(1); }}>
            <option value="">{tC.all}</option>
            <option value="true">{tC.active}</option>
            <option value="false">{tC.inactive}</option>
          </select>
        </div>
        <div className="flex items-center justify-end gap-2 text-sm">
          <span>{tC.page}</span>
          <input type="number" min={1} value={aq.page} onChange={(e) => aq.setPage(Math.max(1, Number(e.target.value) || 1))} className="w-16 rounded-md border border-gray-300 px-2 py-1" />
          <span>{tC.of} {totalPages}</span>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-3 text-left font-medium">{t.headerType}</th>
              <th className="px-4 py-3 text-left font-medium">Matric / Target</th>
              <th className="px-4 py-3 text-left font-medium">{t.headerFee}</th>
              <th className="px-4 py-3 text-left font-medium">{t.headerOverride}</th>
              <th className="px-4 py-3 text-left font-medium">{t.headerActive}</th>
              <th className="px-4 py-3 text-right font-medium">{t.headerActions}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && <tr><td colSpan={6} className="text-center py-10 text-gray-500">Loading…</td></tr>}
            {!loading && assignments.length === 0 && <tr><td colSpan={6} className="text-center py-10 text-gray-500">{t.empty}</td></tr>}
            {assignments.map((a) => {
              const direct = isDirectBill(a);
              const matric = matricOf(a);
              const studentName = fullNameOf(a);
              return (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {a.assignmentType}
                      {direct && (
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-indigo-50 text-indigo-700 border border-indigo-200"
                          title="Direct bill — assigned to one student by matric"
                        >
                          DIRECT
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 min-w-[200px]">
                    {direct ? (
                      <div>
                        <div className="font-medium text-gray-900">{studentName ?? targetDisplay(a)}</div>
                        {matric && (
                          <div className="font-mono text-[11px] text-indigo-700 mt-0.5 bg-indigo-50/70 inline-block px-1.5 py-0.5 rounded border border-indigo-100">
                            {matric}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-gray-700">{targetDisplay(a)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    <div className="font-medium text-gray-900">{a.fee?.feeCode ?? a.feeId}</div>
                    <div className="text-xs text-gray-500">{a.fee?.name ?? '—'} · {a.fee?.academicSession ?? ''} · {fmtNgn(a.overrideAmount ?? a.fee?.amount ?? 0)}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-700 text-xs">
                    {a.overrideAmount ? <div>{fmtNgn(a.overrideAmount)}</div> : null}
                    {a.overrideDeadline ? <div>{fmtDate(a.overrideDeadline)}</div> : (!a.overrideAmount ? <span className="text-gray-400">—</span> : null)}
                  </td>
                  <td className="px-4 py-3"><ActivePill value={a.isActive} /></td>
                  <td className="px-4 py-3 text-right">
                    {canMutate && (
                      <div className="flex items-center justify-end gap-1 text-xs">
                        <button onClick={() => onEdit(a)} className="text-blue-700 hover:text-blue-900 px-2 py-1 rounded hover:bg-blue-50">{t.editAction}</button>
                        {!direct && (
                          <button onClick={() => onGenerate(a)} className="text-emerald-700 hover:text-emerald-900 px-2 py-1 rounded hover:bg-emerald-50">{t.generateAction}</button>
                        )}
                        {direct && (
                          <span
                            className="text-[10px] uppercase tracking-wide text-gray-400 px-2 py-1"
                            title="Direct bills auto-generate an invoice at creation; use Bill a Student again to adjust."
                          >
                            INV AUTO
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => onToggleActive(a)}
                          title={a.isActive ? 'Disable' : 'Enable'}
                          className={`inline-flex items-center justify-center h-8 w-8 rounded-md border border-transparent transition-colors ${
                            a.isActive
                              ? 'text-amber-700 hover:text-amber-800 hover:bg-amber-50 hover:border-amber-200'
                              : 'text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50 hover:border-emerald-200'
                          }`}
                        >
                          <Power className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(a)}
                          title="Delete"
                          className="inline-flex items-center justify-center h-8 w-8 rounded-md text-gray-600 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---------------- URL-tab driven wrapper components for App ----------------
const AdminFeesRoot: React.FC<{ role: 'ADMIN' | 'BURSARY'; initialTab?: FeeTab; }> = ({ role, initialTab }) => {
  const { user, logout } = useAuth();
  const dashboardTo = role === 'ADMIN' ? '/admin/dashboard' : '/bursary/dashboard';
  const brand = role === 'ADMIN' ? i18n.portals.admin.dashboardBrand : i18n.portals.bursary.dashboardBrand;
  const userText = role === 'ADMIN'
    ? i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin')
    : `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
  return (
    <AdminFeesPage
      role={role}
      brand={brand}
      userText={userText}
      onLogout={logout}
      goBack={() => { /* nav via tabs */ }}
      dashboardTo={dashboardTo}
      initialTab={initialTab}
    />
  );
};

export const AdminFeesWrapped = () => <AdminFeesRoot role="ADMIN" />;
export const BursaryFeesWrapped = () => <AdminFeesRoot role="BURSARY" />;
export const AdminCreateBillWrapped = () => <AdminFeesRoot role="ADMIN" initialTab="create" />;
export const BursaryCreateBillWrapped = () => <AdminFeesRoot role="BURSARY" initialTab="create" />;
export default AdminFeesPage;