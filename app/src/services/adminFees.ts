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
  assignedById: number | null;
  assignedAt: string;
  isActive: boolean;
  fee?: FeeOut;
  assignedBy?: { id: number; email: string; firstName: string; lastName: string };
  targetStudent?: { id: number; matricNumber: string; firstName: string; lastName: string };
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
  isActive?: boolean;
  page?: number;
  pageSize?: number;
};

export type CreateFeeInput = {
  feeCode: string;
  name: string;
  description?: string;
  categoryId: number;
  academicSession: string;
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
};
export type UpdateFeeInput = Partial<CreateFeeInput>;
export type CloneFeeInput = {
  academicSession: string;
  feeCode?: string;
  amount?: number | string;
  paymentDeadline?: string;
  college?: string;
  department?: string;
  program?: string;
  level?: number;
  semester?: string;
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
  isActive?: boolean;
};
export type UpdateAssignmentInput = Partial<Omit<CreateAssignmentInput, 'feeId' | 'assignmentType'>>;

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
    return api.post('/fees', body).then((r) => unwrap(r));
  },
  updateFee(id: number, body: UpdateFeeInput): Promise<{ fee: FeeOut }> {
    return api.patch(`/fees/${id}`, body).then((r) => unwrap(r));
  },
  cloneFee(id: number, body: CloneFeeInput): Promise<{ fee: FeeOut }> {
    return api.post(`/fees/${id}/clone`, body).then((r) => unwrap(r));
  },
  activateFee(id: number): Promise<{ fee: FeeOut }> {
    return api.post(`/fees/${id}/activate`).then((r) => unwrap(r));
  },
  disableFee(id: number): Promise<{ fee: FeeOut }> {
    return api.post(`/fees/${id}/disable`).then((r) => unwrap(r));
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
};

export default feeApi;
