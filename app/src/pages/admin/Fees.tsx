// =============================================================================
// Admin Fee Pages: Fees list CRUD, Categories CRUD, Assignments wizard, Bulk upload
// -----------------------------------------------------------------------------
// Single shared component AdminFeesPage, mounted for /admin/fees/:tab? and
// /bursary/fees/:tab? via App.tsx (role-based visibility of mutation buttons).
// =============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import Modal from '../../components/Modal';
import ConfirmAction from '../../components/ConfirmAction';
import { useAuth } from '../../context/AuthContext';
import { navCounters, NavCounters } from '../../services/api';
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
} from '../../services/adminFees';

type AlertState = { isOpen: boolean; title: string; message: string; type: 'success' | 'error' | 'info'; };

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

// ---------------- Fee CRUD modals ----------------
const FeeFormModal: React.FC<{
  open: boolean;
  kind: 'create' | 'edit';
  initial?: FeeOut;
  categories: CategoryOut[];
  onClose: () => void;
  onSubmit: (body: CreateFeeInput) => Promise<void> | void;
  submitting?: boolean;
  frozen?: boolean;
}> = ({ open, kind, initial, categories, onClose, onSubmit, submitting, frozen }) => {
  const t = adminFees.fees;
  const tC = adminFees.common;
  const [form, setForm] = useState<CreateFeeInput>(() => initialToForm(initial));
  useEffect(() => { if (open) setForm(initialToForm(initial)); }, [open, initial]);
  const title = kind === 'create' ? t.createTitle : initial ? t.editTitle(initial.name) : t.createTitle;

  return (
    <Modal isOpen={open} title={title} onClose={onClose} footer={
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-800">{tC.cancel}</button>
        <button type="submit" form="fee-form" disabled={submitting} className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium">{submitting ? tC.submitting : tC.save}</button>
      </div>
    }>
      {frozen && (
        <div className="rounded-md border border-amber-200 bg-amber-50 text-amber-800 px-3 py-2 text-sm mb-4">{t.versionedWarning}</div>
      )}
      <form id="fee-form" onSubmit={(e) => { e.preventDefault(); onSubmit(form); }} className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <Field label={t.fieldFeeCode}>
          <input required className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.feeCode} onChange={(e) => setForm((f) => ({ ...f, feeCode: e.target.value }))} pattern="^[A-Za-z0-9\-_]{2,40}$" disabled={kind === 'edit'} />
        </Field>
        <Field label={t.fieldFeeName}>
          <input required className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label={t.fieldCategory}>
          <select required className="w-full rounded-md border border-gray-300 px-3 py-2" value={String(form.categoryId)} onChange={(e) => setForm((f) => ({ ...f, categoryId: Number(e.target.value) }))} disabled={frozen}>
            <option value="">—</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </select>
        </Field>
        <Field label={t.fieldAcademicSession}>
          <input required className="w-full rounded-md border border-gray-300 px-3 py-2" placeholder="2025/2026" value={form.academicSession} onChange={(e) => setForm((f) => ({ ...f, academicSession: e.target.value }))} pattern="^\d{4}\/\d{4}$" disabled={kind === 'edit'} />
        </Field>
        <Field label={t.fieldCollege}>
          <input className="w-full rounded-md border border-gray-300 px-3 py-2" placeholder="Leave blank — visible to all students" value={form.college ?? ''} onChange={(e) => setForm((f) => ({ ...f, college: e.target.value || undefined }))} />
        </Field>
        <Field label={t.fieldDepartment}>
          <input className="w-full rounded-md border border-gray-300 px-3 py-2" placeholder="Leave blank — visible to all students" value={form.department ?? ''} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value || undefined }))} />
        </Field>
        <Field label={t.fieldProgram}>
          <input className="w-full rounded-md border border-gray-300 px-3 py-2" placeholder="Leave blank — visible to all students" value={form.program ?? ''} onChange={(e) => setForm((f) => ({ ...f, program: e.target.value || undefined }))} />
        </Field>
        <Field label={t.fieldLevel}>
          <input type="number" min={100} step={100} className="w-full rounded-md border border-gray-300 px-3 py-2" placeholder="Leave blank → all levels (e.g. 100, 200)" value={form.level ?? ''} onChange={(e) => setForm((f) => ({ ...f, level: e.target.value ? Number(e.target.value) : undefined }))} />
        </Field>
        <Field label={t.fieldStudentType}>
          <select className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.studentType ?? ''} onChange={(e) => setForm((f) => ({ ...f, studentType: e.target.value || undefined }))}>
            <option value="">{adminFees.common.all} (visible to every student)</option>
            {Object.keys(studentTypes).map((s) => <option key={s} value={s}>{(studentTypes as any)[s] ?? s}</option>)}
          </select>
        </Field>
        <Field label={t.fieldSemester}>
          <select className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.semester ?? ''} onChange={(e) => setForm((f) => ({ ...f, semester: e.target.value || undefined }))}>
            <option value="">{adminFees.common.all} semesters</option>
            {Object.keys(semesterLabels).map((s) => <option key={s} value={s}>{(semesterLabels as any)[s] ?? s}</option>)}
          </select>
        </Field>
        <div className="md:col-span-2">
          <div className="rounded-md border border-blue-100 bg-blue-50 text-blue-800 px-3 py-2 text-xs font-medium">
            💡 Scope filters narrow which students see this fee in their catalogue. You do <strong>NOT</strong> need to create an Assignment to publish this fee — saving it makes it visible immediately to matching (or all) students.
          </div>
        </div>
        <Field label={t.fieldAmount}>
          <input required type="number" min={0} step="0.01" className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.amount as any} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} disabled={frozen} />
        </Field>
        <Field label={t.fieldDeadline}>
          <input type="date" className="w-full rounded-md border border-gray-300 px-3 py-2" value={toISODate(form.paymentDeadline)} onChange={(e) => setForm((f) => ({ ...f, paymentDeadline: e.target.value || undefined }))} disabled={frozen} />
        </Field>
        <Field label={t.fieldDescription} full>
          <textarea rows={2} className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.description ?? ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value || undefined }))} />
        </Field>
        <div className="flex items-center gap-4 md:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.isMandatory} onChange={(e) => setForm((f) => ({ ...f, isMandatory: e.target.checked }))} disabled={frozen} />
            <span>{t.fieldIsMandatory}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
            <span>{t.fieldIsActive}</span>
          </label>
        </div>
      </form>
    </Modal>
  );

  function initialToForm(x?: FeeOut): CreateFeeInput {
    return {
      feeCode: x?.feeCode ?? '',
      name: x?.name ?? '',
      description: x?.description ?? undefined,
      categoryId: x?.categoryId ?? (categories[0]?.id ?? 0),
      academicSession: x?.academicSession ?? '',
      college: x?.college ?? undefined,
      department: x?.department ?? undefined,
      program: x?.program ?? undefined,
      level: x?.level ?? undefined,
      studentType: x?.studentType ?? undefined,
      semester: x?.semester ?? undefined,
      isMandatory: x?.isMandatory ?? true,
      isActive: x?.isActive ?? true,
      amount: Number(x?.amount ?? 0) || 0,
      paymentDeadline: x?.paymentDeadline ?? undefined,
    };
  }
};

const CloneFeeModal: React.FC<{
  open: boolean; fee?: FeeOut; categories?: CategoryOut[]; onClose: () => void; submitting?: boolean;
  onSubmit: (body: CloneFeeInput) => Promise<void> | void;
}> = ({ open, fee, onClose, submitting, onSubmit }) => {
  const t = adminFees.fees;
  const tC = adminFees.common;
  const [form, setForm] = useState<CloneFeeInput>({ academicSession: '' });
  useEffect(() => {
    if (open && fee) setForm({
      academicSession: fee.academicSession,
      amount: Number(fee.amount) || undefined,
      college: fee.college ?? undefined,
      department: fee.department ?? undefined,
      program: fee.program ?? undefined,
      level: fee.level ?? undefined,
      semester: fee.semester ?? undefined,
      feeCode: '',
      paymentDeadline: fee.paymentDeadline ?? undefined,
    });
  }, [open, fee]);
  if (!fee) return null;
  return (
    <Modal isOpen={open} title={t.cloneTitle(fee.name)} onClose={onClose} footer={
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-800">{tC.cancel}</button>
        <button form="clone-form" type="submit" disabled={submitting} className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium">{submitting ? tC.submitting : t.cloneCta}</button>
      </div>
    }>
      <form id="clone-form" onSubmit={(e) => { e.preventDefault(); onSubmit(form); }} className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <Field label={t.cloneFieldSession}>
          <input required className="w-full rounded-md border border-gray-300 px-3 py-2" placeholder="2026/2027" value={form.academicSession} onChange={(e) => setForm((f) => ({ ...f, academicSession: e.target.value }))} pattern="^\d{4}\/\d{4}$" />
        </Field>
        <Field label={t.cloneFieldFeeCode}>
          <input className="w-full rounded-md border border-gray-300 px-3 py-2" placeholder={`${fee.feeCode}_V2 (auto-generated if blank)`} value={form.feeCode ?? ''} onChange={(e) => setForm((f) => ({ ...f, feeCode: e.target.value || undefined }))} />
        </Field>
        <Field label={t.cloneFieldAmount}>
          <input type="number" min={0} step="0.01" className="w-full rounded-md border border-gray-300 px-3 py-2" value={(form.amount as any) ?? ''} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value ? Number(e.target.value) : undefined }))} />
        </Field>
        <Field label={t.cloneFieldDeadline}>
          <input type="date" className="w-full rounded-md border border-gray-300 px-3 py-2" value={toISODate(form.paymentDeadline)} onChange={(e) => setForm((f) => ({ ...f, paymentDeadline: e.target.value || undefined }))} />
        </Field>
        <Field label={t.cloneFieldCollege}><input className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.college ?? ''} onChange={(e) => setForm((f) => ({ ...f, college: e.target.value || undefined }))} /></Field>
        <Field label={t.cloneFieldDepartment}><input className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.department ?? ''} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value || undefined }))} /></Field>
        <Field label={t.cloneFieldProgram}><input className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.program ?? ''} onChange={(e) => setForm((f) => ({ ...f, program: e.target.value || undefined }))} /></Field>
        <Field label={t.cloneFieldLevel}><input type="number" min={100} step={100} className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.level as any ?? ''} onChange={(e) => setForm((f) => ({ ...f, level: e.target.value ? Number(e.target.value) : undefined }))} /></Field>
        <Field label={t.cloneFieldSemester}>
          <select className="w-full rounded-md border border-gray-300 px-3 py-2" value={form.semester ?? ''} onChange={(e) => setForm((f) => ({ ...f, semester: e.target.value || undefined }))}>
            <option value="">Keep original</option>
            {Object.keys(semesterLabels).map((s) => <option key={s} value={s}>{(semesterLabels as any)[s] ?? s}</option>)}
          </select>
        </Field>
      </form>
    </Modal>
  );
};

// ---------------- Category modal ----------------
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

// ---------------- Assignment wizard ----------------
type AssignmentWizardState = { step: 1 | 2 | 3 | 4 | 5; } & Partial<CreateAssignmentInput>;

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
        targetLevel: initial.targetLevel ?? undefined,
        targetSession: initial.targetSession ?? undefined,
        targetStudentType: initial.targetStudentType ?? undefined,
        overrideAmount: initial.overrideAmount ? Number(initial.overrideAmount) : undefined,
        overrideDeadline: initial.overrideDeadline ?? undefined,
        isActive: initial.isActive,
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
    { value: 'LEVEL', label: t.typeLevel, field: 'targetLevel', labelFn: () => t.targetLabelLevel },
    { value: 'SESSION', label: t.typeSession, field: 'targetSession', labelFn: () => t.targetLabelSession },
    { value: 'STUDENT_TYPE', label: t.typeStudentType, field: 'targetStudentType', labelFn: () => t.targetLabelStudentType },
  ];
  const type = types.find((x) => x.value === state.assignmentType);

  const set = (patch: Partial<CreateAssignmentInput>) => setState((s) => ({ ...s, ...patch }));
  const goTo = (step: AssignmentWizardState['step']) => setState((s) => ({ ...s, step }));
  const canProceedTo = (target: AssignmentWizardState['step']) => {
    if (target >= 2 && !state.assignmentType) return false;
    if (target >= 3 && type && (state as any)[type.field] === undefined) return false;
    if (target >= 4 && !state.feeId) return false;
    return true;
  };

  return (
    <Modal isOpen={open} title={t.wizardTitle} onClose={onClose} footer={
      <div className="flex justify-between items-center">
        <div>
          {state.step > 1 && <button onClick={() => goTo(Math.max(1, (state.step as number) - 1) as any)} className="px-3 py-1.5 rounded-md border border-gray-300 text-sm mr-2">{tC.cancel === 'Cancel' ? 'Back' : 'Back'}</button>}
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border border-gray-300 text-sm text-gray-800">{tC.cancel}</button>
          {state.step >= 4 && (
            <button
              type="button"
              disabled={submitting}
              onClick={async () => {
                const body: CreateAssignmentInput = {
                  feeId: state.feeId!,
                  assignmentType: state.assignmentType!,
                  targetStudentId: state.targetStudentId,
                  targetProgramme: state.targetProgramme,
                  targetDepartment: state.targetDepartment,
                  targetFaculty: state.targetFaculty,
                  targetLevel: state.targetLevel,
                  targetSession: state.targetSession,
                  targetStudentType: state.targetStudentType,
                  overrideAmount: state.overrideAmount,
                  overrideDeadline: state.overrideDeadline,
                  isActive: state.isActive ?? true,
                };
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
              onClick={() => { set({ assignmentType: ty.value, targetStudentId: undefined, targetProgramme: undefined, targetDepartment: undefined, targetFaculty: undefined, targetLevel: undefined, targetSession: undefined, targetStudentType: undefined }); goTo(2); }}
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
          {type.field === 'targetLevel' ? (
            <Field label={type.labelFn()}><input type="number" min={100} step={100} className="w-full rounded-md border border-gray-300 px-3 py-2" value={(state.targetLevel as any) ?? ''} onChange={(e) => set({ targetLevel: e.target.value ? Number(e.target.value) : undefined })} /></Field>
          ) : type.field === 'targetStudentId' ? (
            <Field label={type.labelFn()}><input type="number" className="w-full rounded-md border border-gray-300 px-3 py-2" value={(state.targetStudentId as any) ?? ''} onChange={(e) => set({ targetStudentId: e.target.value ? Number(e.target.value) : undefined })} placeholder="Student ID (number)" /></Field>
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
            <div><dt className="text-gray-500 text-xs">{adminFees.categories.headerFeesCount === 'Linked Fees' ? 'Fee' : 'Fee'}</dt><dd className="font-medium">{fees.find((f) => f.id === state.feeId)?.feeCode ?? '—'}</dd></div>
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

// ---------------- Bulk Upload Wizard ----------------
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
        <div>
          <input ref={inputRef} type="file" className="hidden" accept=".csv,.xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickFile(f); }} disabled={!canImport || loading} />
          <button type="button" disabled={!canImport || loading} onClick={() => inputRef.current?.click()} className="w-full border-2 border-dashed border-gray-300 hover:border-blue-400 rounded-xl py-10 text-sm text-gray-600 disabled:opacity-60">
            <div className="font-semibold">{t.dropzone}</div>
            <div className="text-xs text-gray-500 mt-2 max-w-2xl mx-auto">{t.sizeLimit}</div>
          </button>
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

// ---------------- Field helper ----------------
const Field: React.FC<{ label: string; full?: boolean; children: React.ReactNode; }> = ({ label, children, full }) => (
  <div className={full ? 'md:col-span-2' : ''}>
    <label className="block text-xs text-gray-600 mb-1 font-medium">{label}</label>
    {children}
  </div>
);

// ---------------- AdminFeesPage root ----------------
export type FeeTab = 'fees' | 'categories' | 'assignments' | 'upload';

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
  const searchTab = searchParams.get('tab') as FeeTab | 'create' | null;
  const resolvedTab: FeeTab = searchTab === 'create' ? 'fees' : (searchTab ?? paramTab ?? initialTab ?? 'fees');
  const [activeTab, setActiveTab] = useState<FeeTab>(resolvedTab);

  const [alert, setAlert] = useState<AlertState>({ isOpen: false, title: '', message: '', type: 'info' });
  const notify = (title: string, message: string, type: AlertState['type'] = 'success') => setAlert({ isOpen: true, title, message, type });
  const onMutateErr = (prefix: string, err: any) => notify(prefix, err?.message ?? 'An unexpected error occurred.', 'error');

  useEffect(() => {
    const newResolvedTab: FeeTab = searchTab === 'create' ? 'fees' : (searchTab ?? paramTab ?? initialTab ?? 'fees');
    setActiveTab(newResolvedTab);
    if (searchTab === 'create') {
      setFeeModal({ open: true, kind: 'create' });
    }
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

  // shared
  const [categories, setCategories] = useState<CategoryOut[]>([]);
  const [fees, setFees] = useState<FeeOut[]>([]);

  // ---------------- Fees list state ----------------
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

  // ---------------- Categories list state ----------------
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

  // ---------------- Assignments list state ----------------
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
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">
              {activeTab === 'fees' && adminFees.fees.pageTitle}
              {activeTab === 'categories' && adminFees.categories.pageTitle}
              {activeTab === 'assignments' && adminFees.assignments.pageTitle}
              {activeTab === 'upload' && adminFees.upload.pageTitle}
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {activeTab === 'fees' && adminFees.fees.pageSubtitle}
              {activeTab === 'categories' && adminFees.categories.pageSubtitle}
              {activeTab === 'assignments' && adminFees.assignments.pageSubtitle}
              {activeTab === 'upload' && adminFees.upload.pageSubtitle}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="flex rounded-lg border border-gray-200 bg-white p-1">
              {(['fees', 'categories', 'assignments', 'upload'] as const).map((t) => {
                const labelMap = {
                  fees: 'Bills',
                  categories: 'Categories',
                  assignments: 'Assignments',
                  upload: 'Bulk Upload',
                };
                return (
                  <button
                    key={t}
                    onClick={() => setSearchParams({ tab: t })}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      activeTab === t
                        ? 'bg-blue-600 text-white'
                        : 'text-gray-700 hover:bg-gray-100'
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
            {activeTab === 'assignments' && canMutate && (
              <button className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium" onClick={() => { setSearchParams({ tab: 'assignments' }); setAssignModal({ open: true }); }}>{adminFees.common.createAssignment}</button>
            )}
          </div>
        </header>

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
          />
        )}

        {activeTab === 'upload' && <UploadWizard role={role} />}
      </div>

      <FeeFormModal
        open={feeModal.open}
        kind={feeModal.kind}
        initial={feeModal.initial}
        categories={categories}
        submitting={feeSubmitting}
        frozen={(feeModal.initial?._count?.invoices ?? 0) > 0 && feeModal.kind === 'edit'}
        onClose={() => { setFeeModal((x) => ({ ...x, open: false })); if (searchTab === 'create') setSearchParams({ tab: 'fees' }); }}
        onSubmit={async (body) => {
          setFeeSubmitting(true);
          try {
            if (feeModal.kind === 'create') { await feeApi.createFee(body); notify('Fee created', body.feeCode, 'success'); }
            else if (feeModal.initial) { await feeApi.updateFee(feeModal.initial.id, body); notify('Fee updated', body.feeCode, 'success'); }
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
          try { await feeApi.cloneFee(cloneModal.fee.id, body); notify('Fee cloned', body.academicSession, 'success'); setCloneModal({ open: false }); await loadFees(); }
          catch (e: any) { onMutateErr('Clone failed', e); }
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

      <Modal isOpen={alert.isOpen} title={alert.title} onClose={() => setAlert({ ...alert, isOpen: false })}>
        <p className="text-sm text-gray-800">{alert.message}</p>
      </Modal>
    </PortalShell>
  );
};

// ---------------- Query state hooks ----------------
function useFeeQueryState() {
  const [q, setQ] = useState('');
  const [session, setSession] = useState('');
  const [category, setCategory] = useState('');
  const [college, setCollege] = useState('');
  const [department, setDepartment] = useState('');
  const [program, setProgram] = useState('');
  const [level, setLevel] = useState<string>('');
  const [studentType, setStudentType] = useState('');
  const [semester, setSemester] = useState('');
  const [isActive, setIsActive] = useState('');
  const [isMandatory, setIsMandatory] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<'createdAt' | 'name' | 'feeCode' | 'academicSession' | 'amount'>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const reset = () => { setQ(''); setSession(''); setCategory(''); setCollege(''); setDepartment(''); setProgram(''); setLevel(''); setStudentType(''); setSemester(''); setIsActive(''); setIsMandatory(''); setPage(1); };
  const query: any = { page, pageSize, sort, order };
  if (q) query.q = q;
  if (session) query.session = session;
  if (category) query.category = isNaN(Number(category)) ? category : Number(category);
  if (college) query.college = college;
  if (department) query.department = department;
  if (program) query.program = program;
  if (level) query.level = Number(level);
  if (studentType) query.studentType = studentType;
  if (semester) query.semester = semester;
  if (isActive) query.isActive = isActive === 'true';
  if (isMandatory) query.isMandatory = isMandatory === 'true';

  const sigkey = [q, session, category, college, department, program, level, studentType, semester, isActive, isMandatory, page, pageSize, sort, order].join('|');
  return { query, sigkey, reset,
    bind: { q, setQ, session, setSession, category, setCategory, college, setCollege, department, setDepartment, program, setProgram, level, setLevel, studentType, setStudentType, semester, setSemester, isActive, setIsActive, isMandatory, setIsMandatory, page, setPage, pageSize, setPageSize, sort, setSort, order, setOrder },
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
  const [session, setSession] = useState('');
  const [level, setLevel] = useState<string>('');
  const [studentType, setStudentType] = useState('');
  const [isActive, setIsActive] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const query: any = { page, pageSize };
  if (q) query.q = q;
  if (type) query.assignmentType = type;
  if (feeId) query.feeId = Number(feeId);
  if (session) query.targetSession = session;
  if (level) query.targetLevel = Number(level);
  if (studentType) query.targetStudentType = studentType;
  if (isActive) query.isActive = isActive === 'true';
  const sigkey = [q, type, feeId, session, level, studentType, isActive, page, pageSize].join('|');
  return { query, sigkey, q, setQ, type, setType, feeId, setFeeId, session, setSession, level, setLevel, studentType, setStudentType, isActive, setIsActive, page, setPage, pageSize, setPageSize };
}

// ---------------- List views ----------------
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
}> = ({ fq, loading, resp, fees, categories, canMutate, onEdit, onClone, onActivate, onDisable }) => {
  const t = adminFees.fees;
  const tC = adminFees.common;
  const totalPages = Math.max(1, Math.ceil((resp?.total ?? 0) / (resp?.pageSize ?? 25)));
  const b = fq.bind;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <div className="lg:col-span-2"><label className="text-xs text-gray-600 font-medium">{tC.search}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder={t.searchPlaceholder} value={b.q} onChange={(e) => { b.setQ(e.target.value); b.setPage(1); }} /></div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterSession}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="2025/2026" value={b.session} onChange={(e) => { b.setSession(e.target.value); b.setPage(1); }} /></div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterCategory}</label>
            <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.category} onChange={(e) => { b.setCategory(e.target.value); b.setPage(1); }}>
              <option value="">{tC.all}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </select>
          </div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterCollege}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.college} onChange={(e) => { b.setCollege(e.target.value); b.setPage(1); }} /></div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterDepartment}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.department} onChange={(e) => { b.setDepartment(e.target.value); b.setPage(1); }} /></div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterProgram}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.program} onChange={(e) => { b.setProgram(e.target.value); b.setPage(1); }} /></div>
          <div><label className="text-xs text-gray-600 font-medium">{t.filterLevel}</label><input type="number" className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={b.level} onChange={(e) => { b.setLevel(e.target.value); b.setPage(1); }} /></div>
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
              {loading && (
                <tr><td colSpan={9} className="text-center py-10 text-gray-500">Loading…</td></tr>
              )}
              {!loading && fees.length === 0 && (
                <tr><td colSpan={9} className="text-center py-10 text-gray-500">{t.empty}</td></tr>
              )}
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
}> = ({ aq, loading, resp, assignments, canMutate, onEdit, onGenerate }) => {
  const t = adminFees.assignments;
  const tC = adminFees.common;
  const totalPages = Math.max(1, Math.ceil((resp?.total ?? 0) / (resp?.pageSize ?? 25)));
  const TYPES = ['STUDENT','PROGRAMME','DEPARTMENT','FACULTY','LEVEL','SESSION','STUDENT_TYPE'] as const;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
        <div className="md:col-span-2"><label className="text-xs text-gray-600 font-medium">{tC.search}</label><input className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="Programme, department, faculty, session, fee name/code…" value={aq.q} onChange={(e) => { aq.setQ(e.target.value); aq.setPage(1); }} /></div>
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
              <th className="px-4 py-3 text-left font-medium">{t.headerTarget}</th>
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
              const parts: Array<string | number> = [];
              if (a.targetProgramme) parts.push(a.targetProgramme);
              if (a.targetDepartment) parts.push(a.targetDepartment);
              if (a.targetFaculty) parts.push(a.targetFaculty);
              if (a.targetLevel) parts.push(`${a.targetLevel}L`);
              if (a.targetSession) parts.push(a.targetSession);
              if (a.targetStudentType) parts.push(a.targetStudentType);
              if (a.targetStudentId) parts.push(`#${a.targetStudentId}`);
              const target = parts.join(' · ') || '—';
              return (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900">{a.assignmentType}</td>
                  <td className="px-4 py-3 text-gray-700">{target}</td>
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
                        <button onClick={() => onGenerate(a)} className="text-emerald-700 hover:text-emerald-900 px-2 py-1 rounded hover:bg-emerald-50">{t.generateAction}</button>
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
export default AdminFeesPage;
