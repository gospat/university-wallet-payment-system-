import api from '../utils/api';

function unwrap<T>(resp: { data?: any }): T {
  return ((resp?.data?.data) as T) ?? ((resp as any)?.data as T);
}

export type FeeScheduleSessionRow = {
  id: number;
  invoiceNumber: string;
  feeId: number;
  feeName: string;
  feeCode: string | null;
  feeCategory: string | null;
  amountDue: number;
  amountPaid: number;
  balance: number;
  status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'REFUNDED' | 'CANCELLED' | 'REVERSED' | 'PENDING' | 'FAILED';
  dueDate: string | null;
  semester: 'FIRST' | 'SECOND' | null;
  isMandatory: boolean;
};
export type FeeScheduleSession = {
  session: string;
  totalBilled: number;
  totalPaid: number;
  totalOutstanding: number;
  rows: FeeScheduleSessionRow[];
};
export type FeeScheduleResponse = { schedule: FeeScheduleSession[] };

export type InvoiceFeeMin = {
  id: number;
  feeCode: string;
  name: string;
  amount: number | string;
  description?: string | null;
  college?: string | null;
  department?: string | null;
  program?: string | null;
  level?: number | null;
  category?: { id: number; name: string; code: string } | null;
};
export type InvoiceSummary = {
  id: number;
  invoiceNumber: string;
  fee: InvoiceFeeMin;
  amountDue: number;
  amountPaid: number;
  balance: number;
  status: string;
  dueDate: string | null;
  session: string | null;
  semester: string | null;
  createdAt: string;
  transactionCount?: number;
  origin?: 'CATALOGUE' | 'DIRECT_BILL';
  directAssignment?: {
    id: number;
    overrideAmount?: number | string | null;
    overrideDeadline?: string | null;
    assignedAt?: string;
    assignedBy?: { firstName?: string; lastName?: string; email?: string } | null;
  } | null;
};
export type InvoiceListResponse = {
  invoices: InvoiceSummary[];
  total: number;
  page: number;
  pageSize: number;
};
export type InvoiceDetailResponse = {
  invoice: InvoiceSummary & { updatedAt: string };
  transactions: Array<{
    id: number;
    reference: string;
    channel: string;
    amount: number | string;
    status: string;
    paymentReference: string | null;
    transactionDate: string | null;
    createdAt: string;
  }>;
  pay?: {
    canPay: boolean;
    amountToPay: number;
    paymentReference: string;
    dueDate: string | null;
  } | null;
};
export type ReceiptSummary = {
  id: number;
  receiptNumber: string;
  verificationToken: string;
  paidAmount: number | string;
  paidAt: string;
  isVoided: boolean;
  generatedAt?: string;
  paymentChannel?: string | null;
  voidedAt?: string | null;
  invoice?: {
    fee?: { name?: string | null } | null;
    invoiceNumber?: string | null;
    session?: string | null;
    semester?: string | null;
  } | null;
  transaction?: {
    reference?: string | null;
    paystackChannel?: string | null;
    type?: string | null;
  } | null;
};
export type ReceiptListResponse = {
  items: ReceiptSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
export type CatalogueFeeCategory = { id: number; name: string; code: string };
export type CatalogueFee = {
  id: number;
  feeCode: string;
  name: string;
  description?: string | null;
  categoryId?: number | null;
  category?: CatalogueFeeCategory | null;
  amount: number | string;
  currency?: string;
  academicSession?: string;
  semester?: 'FIRST' | 'SECOND' | null;
  college?: string | null;
  department?: string | null;
  program?: string | null;
  level?: number | null;
  studentType?: string | null;
  isMandatory?: boolean;
  paymentDeadline?: string | null;
  isActive?: boolean;
  noteToStudent?: string | null;
  assignmentId?: number | null;
  assignedAt?: string;
  assignedBy?: { firstName?: string; lastName?: string; email?: string } | null;
  invoiceId?: number | null;
  invoiceNumber?: string | null;
};
export type CatalogueResponse = {
  fees: CatalogueFee[];
  assignedBills?: CatalogueFee[];
  total: number;
  page: number;
  pageSize: number;
};
export type EnsureInvoiceForFeeResponse = {
  invoiceId: number;
  invoiceNumber: string;
  created: boolean;
  fee: {
    id: number; feeCode?: string; name: string;
    amount: number; currency?: string;
    academicSession?: string; semester?: string | null;
  };
};
export type EnsureInvoiceForAssignmentResponse = {
  invoiceId: number;
  invoiceNumber: string;
  created: boolean;
};

export const studentFeeApi = {
  schedule(): Promise<FeeScheduleResponse> {
    return api.get('/students/fees/schedule').then((r) => unwrap(r));
  },
  listInvoices(q: Record<string, any> = {}): Promise<InvoiceListResponse> {
    return api.get('/students/invoices', { params: q }).then((r) => unwrap(r));
  },
  getInvoice(id: number): Promise<InvoiceDetailResponse> {
    return api.get(`/students/invoices/${id}`).then((r) => unwrap(r));
  },
  listReceipts(q: Record<string, any> = {}): Promise<ReceiptListResponse> {
    return api.get('/students/receipts', { params: q }).then((r) => unwrap(r));
  },
  downloadReceiptPdfUrl(id: number): string {
    return `${api.defaults.baseURL || '/api/v1'}/students/receipts/${id}/download`;
  },
  initiatePayment(payload: {
    invoiceId: number | string;
    partialAmount?: number;
    email?: string;
    idempotencyKey?: string;
  }): Promise<any> {
    const body: any = { invoiceId: payload.invoiceId };
    if (typeof payload.partialAmount === 'number') body.partialAmount = payload.partialAmount;
    if (payload.email) body.email = payload.email;
    if (payload.idempotencyKey) body.idempotencyKey = payload.idempotencyKey;
    return api.post('/students/payments/initiate', body).then((r) => unwrap(r));
  },
  verifyPayment(reference: string): Promise<any> {
    return api.get(`/students/payments/verify/${encodeURIComponent(reference)}`).then((r) => unwrap(r));
  },
  catalogue(q: Record<string, any> = {}): Promise<CatalogueResponse> {
    return api.get('/students/fees/catalogue', { params: q }).then((r) => unwrap(r));
  },
  ensureInvoiceForFee(feeId: number): Promise<EnsureInvoiceForFeeResponse> {
    return api.post(`/students/fees/${feeId}/ensure-invoice`, {}).then((r) => unwrap(r));
  },
  ensureInvoiceForAssignment(assignmentId: number): Promise<EnsureInvoiceForAssignmentResponse> {
    return api.post(`/students/fee-assignments/${assignmentId}/ensure-invoice`, {}).then((r) => unwrap(r));
  },
};

export default studentFeeApi;
