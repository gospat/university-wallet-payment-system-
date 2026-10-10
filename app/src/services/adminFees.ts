import api, { API_BASE_URL } from './api';

function unwrap<T>(resp: { data?: any }): T {
  return ((resp?.data?.data) as T) ?? ((resp as any)?.data as T);
}

export type CategoryOut = {
  id: number; code: string; name: string; description: string | null;
  isSystemDefault: boolean; createdById: number | null; createdAt: string; updatedAt: string;
  _count?: { fees: number };
};

export type FeeOut = {
  id: number;
  feeCode: string;
  name: string;
  description: string | null;
  categoryId: number;
  academicSession: string;
  college: string | null;
  department: string | null;
  program: string | null;
  level: number | null;
  studentType: string | null;
  semester: string | null;
  isMandatory: boolean;
  isActive: boolean;
  amount: number | string;
  paymentDeadline: string | null;
  createdById: number | null;
  createdAt: string;
  updatedAt: string;
  category?: CategoryOut;
  _count?: { invoices: number };
};

export type FeeAssignmentOut = {
  id: number;
  feeId: number;
  assignmentType: string;
  targetStudentId: number | null;
  targetProgramme: string | null;
  targetDepartment: string | null;
  targetFaculty: string | null;
  targetLevel: number | null;
  targetSession: string | null;
  targetStudentType: string | null;
  overrideAmount: number | string | null;
  overrideDeadline: string | null;
  noteToStudent?: string | null;
  assignedById: number | null;
  assignedAt: string;
  isActive: boolean;
  fee?: FeeOut;
  assignedBy?: { id: number; email: string; firstName: string; lastName: string };
  targetStudent?: { id: number; matricNumber: string; firstName: string; lastName: string };
  invoice?: {
    id: number;
    status: string;
    invoiceNumber: string;
  } | null;
};

export type FeeListResp = { fees: FeeOut[]; total: number; page: number; pageSize: number; };
export type CategoryListResp = { categories: CategoryOut[]; total: number; page: number; pageSize: number; };
export type AssignmentListResp = { assignments: FeeAssignmentOut[]; total: number; page: number; pageSize: number; };

export type GenerateResp = {
  assignmentId: number;
  matchingStudents: number;
  alreadyInvoiced: number;
  created: number;
  skipped: number;
  sampleInvoices?: Array<{ id: number; invoiceNumber: string; studentId: number }>;
};

export type FeeQuery = {
  q?: string;
  session?: string;
  category?: number | string;
  college?: string;
  department?: string;
  program?: string;
  level?: number;
  studentType?: string;
  semester?: string;
  isActive?: boolean;
  isMandatory?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'createdAt' | 'name' | 'feeCode' | 'academicSession' | 'amount';
  order?: 'asc' | 'desc';
};

export type CategoryQuery = {
  q?: string;
  isSystemDefault?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'code' | 'name' | 'createdAt';
  order?: 'asc' | 'desc';
};

export type AssignmentQuery = {
  q?: string;
  assignmentType?: string;
  feeId?: number;
  targetSession?: string;
  targetLevel?: number;
  targetStudentType?: string;
  isActive?: boolean | 'all';
  page?: number;
  pageSize?: number;
};

export type CreateFeeInput = {
  feeCode?: string;
  name: string;
  description?: string;
  categoryId: number;
  academicSession?: string;
  college?: string;
  department?: string;
  program?: string;
  level?: number;
  studentType?: string;
  semester?: string;
  isMandatory?: boolean;
  isActive?: boolean;
  amount: number | string;
  paymentDeadline?: string;
  studentTypeHint?: string;
};
export type UpdateFeeInput = Partial<CreateFeeInput>;
export type CloneFeeInput = {
  academicSession?: string;
  feeCode?: string;
  amount?: number | string;
  paymentDeadline?: string;
  college?: string;
  department?: string;
  program?: string;
  semester?: string;
  studentType?: string;
};

export type CreateCategoryInput = { code: string; name: string; description?: string; };
export type UpdateCategoryInput = Partial<CreateCategoryInput>;

export type CreateAssignmentInput = {
  feeId: number;
  assignmentType: string;
  targetStudentId?: number;
  targetProgramme?: string;
  targetDepartment?: string;
  targetFaculty?: string;
  targetLevel?: number;
  targetSession?: string;
  targetStudentType?: string;
  overrideAmount?: number | string;
  overrideDeadline?: string;
  noteToStudent?: string;
  isActive?: boolean;
};
export type UpdateAssignmentInput = Partial<Omit<CreateAssignmentInput, 'feeId' | 'assignmentType'>>;

export type MatricStudentResp = {
  id: number;
  matricNumber: string | null;
  email: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  status: string;
  academicLevel: number | null;
  programme: string | null;
  department: string | null;
  academicSession: string | null;
};

export type CreateDirectStudentBillInput =
  | {
      matricNumber: string;
      feeId: number;
      overrideAmount?: number | string;
      overrideDeadline?: string;
      noteToStudent?: string;
    }
  | {
      matricNumber: string;
      adhocFeeName: string;
      adhocFeeCategory?: string;
      overrideAmount: number | string;
      overrideDeadline?: string;
      noteToStudent?: string;
    };

export type DirectStudentBillSuccessResp = {
  created: boolean;
  assignmentId: number;
  invoiceId: number;
  invoiceNumber: string;
  studentId: number;
  studentName: string;
  matricNumber: string | null;
  feeId: number | null;
  feeName: string;
  amount: number | string;
  deadline: string | null;
  origin: string;
};

export const feeApi = {
  // categories
  listCategories(q: CategoryQuery = {}): Promise<CategoryListResp> {
    return api.get('/fees/categories', { params: q }).then((r) => unwrap(r));
  },
  getCategory(id: number): Promise<{ category: CategoryOut }> {
    return api.get(`/fees/categories/${id}`).then((r) => unwrap(r));
  },
  createCategory(body: CreateCategoryInput): Promise<{ category: CategoryOut }> {
    return api.post('/fees/categories', body).then((r) => unwrap(r));
  },
  updateCategory(id: number, body: UpdateCategoryInput): Promise<{ category: CategoryOut }> {
    return api.patch(`/fees/categories/${id}`, body).then((r) => unwrap(r));
  },
  deleteCategory(id: number): Promise<void> {
    return api.delete(`/fees/categories/${id}`).then(() => undefined);
  },
  // fees
  listFees(q: FeeQuery = {}): Promise<FeeListResp> {
    return api.get('/fees', { params: q }).then((r) => unwrap(r));
  },
  getFee(id: number): Promise<{ fee: FeeOut & { category?: CategoryOut; _count?: { invoices: number } } }> {
    return api.get(`/fees/${id}`).then((r) => unwrap(r));
  },
  createFee(body: CreateFeeInput): Promise<{ fee: FeeOut }> {
    return api.post('/fees', sanitizeCreateFeeBody(body)).then((r) => unwrap(r));
  },
  updateFee(id: number, body: UpdateFeeInput): Promise<{ fee: FeeOut }> {
    return api.patch(`/fees/${id}`, sanitizeCreateFeeBody(body as any)).then((r) => unwrap(r));
  },
  cloneFee(id: number, body: CloneFeeInput): Promise<{ fee: FeeOut }> {
    return api.post(`/fees/${id}/clone`, sanitizeCloneFeeBody(body)).then((r) => unwrap(r));
  },
  activateFee(id: number): Promise<{ fee: FeeOut }> {
    return api.post(`/fees/${id}/activate`).then((r) => unwrap(r));
  },
  disableFee(id: number): Promise<{ fee: FeeOut }> {
    return api.post(`/fees/${id}/disable`).then((r) => unwrap(r));
  },
  deleteFee(id: number): Promise<{ deleted: { id: number; name?: string | null; feeCode?: string | null } }> {
    return api.delete(`/fees/${id}`).then((r) => unwrap(r));
  },
  // assignments
  listAssignments(q: AssignmentQuery = {}): Promise<AssignmentListResp> {
    return api.get('/fee-assignments', { params: q }).then((r) => unwrap(r));
  },
  getAssignment(id: number): Promise<{ assignment: FeeAssignmentOut }> {
    return api.get(`/fee-assignments/${id}`).then((r) => unwrap(r));
  },
  createAssignment(body: CreateAssignmentInput): Promise<{ assignment: FeeAssignmentOut }> {
    return api.post('/fee-assignments', body).then((r) => unwrap(r));
  },
  updateAssignment(id: number, body: UpdateAssignmentInput): Promise<{ assignment: FeeAssignmentOut }> {
    return api.patch(`/fee-assignments/${id}`, body).then((r) => unwrap(r));
  },
  disableAssignment(id: number): Promise<{ assignment: FeeAssignmentOut }> {
    return api.patch(`/fee-assignments/${id}`, { isActive: false }).then((r) => unwrap(r));
  },
  enableAssignment(id: number): Promise<{ assignment: FeeAssignmentOut }> {
    return api.patch(`/fee-assignments/${id}`, { isActive: true }).then((r) => unwrap(r));
  },
  deleteAssignment(id: number): Promise<{ deleted: { id: number } }> {
    return api.delete(`/fee-assignments/${id}`).then((r) => unwrap(r));
  },
  generateInvoices(id: number, force = false): Promise<GenerateResp> {
    return api.post(`/fee-assignments/${id}/generate-invoices`, null, { params: { force: force ? 'true' : 'false' } }).then((r) => unwrap(r));
  },
  // admin reuses student upload endpoints /admin/students/upload stage, preview, confirm for fees too:
  async uploadStage(file: File): Promise<any> {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/fees/bulk-upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => unwrap(r));
  },
  async uploadPreview(stageId: string): Promise<any> {
    return api.get(`/fees/bulk-upload/${stageId}`).then((r) => unwrap(r));
  },
  async uploadConfirm(stageId: string, strategy: 'SKIP' | 'UPDATE' | 'ERROR'): Promise<any> {
    return api.post(`/fees/bulk-upload/${stageId}/confirm`, { duplicateStrategy: strategy }).then((r) => unwrap(r));
  },
  uploadErrorsUrl(stageId: string) {
    const token = localStorage.getItem('token') ?? '';
    return `${API_BASE_URL}/fees/bulk-upload/${stageId}/errors.csv?access_token=${encodeURIComponent(token)}`;
  },
  feesTemplateUrl() {
    const token = localStorage.getItem('token') ?? '';
    return `${API_BASE_URL}/fees/template.csv?t=${Date.now()}&access_token=${encodeURIComponent(token)}`;
  },
  feesTemplateXlsxUrl() {
    const token = localStorage.getItem('token') ?? '';
    return `${API_BASE_URL}/fees/template.xlsx?t=${Date.now()}&access_token=${encodeURIComponent(token)}`;
  },

  getStudentByMatric(matric: string): Promise<{ student: MatricStudentResp }> {
    const safe = encodeURIComponent(matric.trim());
    return api.get(`/students/matric/${safe}`).then((r) => unwrap(r));
  },

  createDirectStudentBill(
    body: CreateDirectStudentBillInput,
    opts?: { idempotencyKey?: string },
  ): Promise<DirectStudentBillSuccessResp> {
    const headers: Record<string, string> = {};
    if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey.slice(0, 128);
    return api
      .post('/fee-assignments/student-bill', sanitizeDirectBillBody(body), { headers: Object.keys(headers).length ? headers : undefined })
      .then((r) => {
        const raw: any = unwrap(r);
        const assignment = raw.assignment;
        const invoice = raw.invoice;
        const fee = raw.fee;
        const student = raw.student;
        const nameParts = [student?.firstName, student?.middleName, student?.lastName].filter(Boolean);
        return {
          created: Boolean(raw.created ?? raw.invoiceCreated ?? raw.assignmentCreated),
          assignmentId: Number(assignment?.id ?? 0),
          invoiceId: Number(invoice?.id ?? 0),
          invoiceNumber: String(invoice?.invoiceNumber ?? ''),
          studentId: Number(student?.id ?? assignment?.targetStudentId ?? 0),
          studentName: nameParts.join(' ') || student?.email || assignment?.targetStudent?.firstName + ' ' + assignment?.targetStudent?.lastName || '',
          matricNumber: student?.matricNumber ?? assignment?.targetStudent?.matricNumber ?? null,
          feeId: fee?.id ? Number(fee.id) : (assignment?.feeId ? Number(assignment.feeId) : null),
          feeName: fee?.name ?? assignment?.fee?.name ?? '',
          amount: invoice?.amountDue ?? assignment?.overrideAmount ?? fee?.amount ?? assignment?.fee?.amount ?? 0,
          deadline: invoice?.dueDate ?? assignment?.overrideDeadline ?? fee?.paymentDeadline ?? assignment?.fee?.paymentDeadline ?? null,
          origin: 'DIRECT_BILL',
        };
      });
  },
};

function sanitizeCreateFeeBody(body: CreateFeeInput): CreateFeeInput {
  const out: any = { ...body };
  for (const k of ['feeCode', 'academicSession', 'college', 'department', 'program', 'studentType', 'semester', 'description', 'paymentDeadline'] as const) {
    if (typeof out[k] === 'string' && out[k].trim() === '') delete out[k];
  }
  if (out.amount === 0 || out.amount === '0' || out.amount === '' || out.amount === null || out.amount === undefined) {
    if (out.amount === '' || out.amount === null || out.amount === undefined) delete out.amount;
  }
  if (out.level === null || out.level === undefined || out.level === 0 || (typeof out.level === 'string' && out.level.trim() === '')) delete out.level;
  if (out.categoryId === 0 || out.categoryId === '' || out.categoryId === null || out.categoryId === undefined) delete out.categoryId;
  return out;
}

function sanitizeCloneFeeBody(body: CloneFeeInput): CloneFeeInput {
  const out: any = { ...body };
  for (const k of ['feeCode', 'academicSession', 'college', 'department', 'program', 'studentType', 'semester'] as const) {
    if (typeof out[k] === 'string' && out[k].trim() === '') delete out[k];
  }
  if (out.amount === 0 || out.amount === '0' || out.amount === '' || out.amount === null || out.amount === undefined) {
    if (out.amount !== 0 && out.amount !== '0') delete out.amount;
  }
  return out;
}

function sanitizeDirectBillBody(body: CreateDirectStudentBillInput): CreateDirectStudentBillInput {
  const out: any = { ...body };
  for (const k of ['overrideDeadline', 'noteToStudent', 'adhocFeeCategory', 'matricNumber'] as const) {
    if (typeof out[k] === 'string' && out[k].trim() === '') delete out[k];
  }
  if ((out as any).feeId === '' || (out as any).feeId === 0 || (out as any).feeId === null || (out as any).feeId === undefined) delete (out as any).feeId;
  if (out.overrideAmount === '' || out.overrideAmount === null || out.overrideAmount === undefined) delete out.overrideAmount;
  return out;
}

export const CANCEL_INVOICE_REASONS = [
  { key: 'INVOICE_CREATED_IN_ERROR', label: 'Invoice created in error' },
  { key: 'DUPLICATE_INVOICE', label: 'Duplicate invoice' },
  { key: 'WRONG_STUDENT', label: 'Wrong student' },
  { key: 'WRONG_FEE_ASSIGNMENT', label: 'Wrong fee assignment' },
  { key: 'FEE_NO_LONGER_APPLICABLE', label: 'Fee no longer applicable' },
  { key: 'ADMINISTRATIVE_CORRECTION', label: 'Administrative correction' },
  { key: 'OTHER', label: 'Other' },
] as const;

export type CancelInvoiceReasonKey = (typeof CANCEL_INVOICE_REASONS)[number]['key'];

export type CancelInvoiceInput = {
  reason: CancelInvoiceReasonKey;
  writtenExplanation?: string;
};

export type CancelInvoiceResponse = {
  invoice: { id: number; invoiceNumber: string; status: string; amountDue: string | number; amountPaid: string | number; studentId: number | null };
  auditId: number;
  auditedAt: string;
};

export async function cancelInvoice(invoiceId: number, body: CancelInvoiceInput): Promise<CancelInvoiceResponse> {
  const resp = await api.post(`/fee-assignments/invoices/${invoiceId}/cancel`, {
    reason: body.reason,
    writtenExplanation: body.writtenExplanation?.trim() ?? undefined,
  });
  return unwrap<CancelInvoiceResponse>(resp);
}

export default feeApi;
