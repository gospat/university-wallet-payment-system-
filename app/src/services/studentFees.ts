// ---------------------------------------------------------------------------
// Student fee + invoice API helpers (Task 10.2 frontend)
// ---------------------------------------------------------------------------
import api from './api';

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

export type FeeScheduleResponse = {
  schedule: FeeScheduleSession[];
};

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
  directAssignment?: { id: number; overrideAmount?: number | string | null; overrideDeadline?: string | null; assignedAt?: string; assignedBy?: { firstName?: string; lastName?: string; email?: string } | null } | null;
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

export type InvoiceListQuery = {
  session?: string;
  status?: string;
  feeId?: number;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sort?: 'createdAt' | 'dueDate' | 'amountDue';
  order?: 'asc' | 'desc';
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

export type ReceiptListQuery = {
  page?: number;
  pageSize?: number;
  isVoided?: 'true' | 'false';
};

// ---------- Fee Catalogue (all admin-set fees) ------------------------------
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
  _isDirectBill?: boolean;
  badge?: string | null;
  assignmentId?: number | null;
  assignedAt?: string;
  assignedBy?: { firstName?: string; lastName?: string; email?: string } | null;
};
export type CatalogueQuery = {
  q?: string;
  session?: string;
  category?: string | number;
  semester?: 'FIRST' | 'SECOND';
  studentType?: string;
  page?: number;
  pageSize?: number;
  sort?: 'createdAt' | 'name' | 'feeCode' | 'academicSession' | 'amount';
  order?: 'asc' | 'desc';
};
export type CatalogueResponse = {
  fees: CatalogueFee[];
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

export const studentFeeApi = {
  schedule(): Promise<FeeScheduleResponse> {
    return api.get('/students/fees/schedule').then((r) => unwrap(r));
  },
  listInvoices(q: InvoiceListQuery = {}): Promise<InvoiceListResponse> {
    return api.get('/students/invoices', { params: q }).then((r) => unwrap(r));
  },
  getInvoice(id: number): Promise<InvoiceDetailResponse> {
    return api.get(`/students/invoices/${id}`).then((r) => unwrap(r));
  },
  listReceipts(q: ReceiptListQuery = {}): Promise<ReceiptListResponse> {
    return api.get('/students/receipts', { params: q }).then((r) => unwrap(r));
  },
  downloadReceiptPdfUrl(id: number): string {
    return `${api.defaults.baseURL || '/api/v1'}/students/receipts/${id}/download`;
  },
  initiatePayment(payload: { invoiceId: number | string; partialAmount?: number; email?: string; idempotencyKey?: string }): Promise<any> {
    const body: any = { invoiceId: payload.invoiceId };
    if (typeof payload.partialAmount === 'number') body.partialAmount = payload.partialAmount;
    if (payload.email) body.email = payload.email;
    if (payload.idempotencyKey) body.idempotencyKey = payload.idempotencyKey;
    return api.post('/students/payments/initiate', body).then((r) => unwrap(r));
  },
  verifyPayment(reference: string): Promise<any> {
    return api.get(`/students/payments/verify/${encodeURIComponent(reference)}`).then((r) => unwrap(r));
  },
  async downloadReceiptPdfByReference(reference: string): Promise<Blob> {
    const r: any = await api.get('/students/receipts', { params: { reference, limit: 1 } });
    const list = unwrap<any>(r);
    const rows = list?.rows ?? list?.receipts ?? list?.data ?? [];
    const id = rows?.[0]?.id ?? null;
    if (id) {
      const downloadResp: any = await api.get(`/students/receipts/${id}/download`, { responseType: 'blob' });
      return downloadResp.data;
    }
    throw new Error('receipt not found');
  },
  // ---------- Fee Catalogue + Fee-payment initiate helpers ----------------
  catalogue(q: CatalogueQuery = {}): Promise<CatalogueResponse> {
    return api.get('/students/fees/catalogue', { params: q }).then((r) => unwrap(r));
  },
  ensureInvoiceForFee(feeId: number): Promise<EnsureInvoiceForFeeResponse> {
    return api.post(`/students/fees/${feeId}/ensure-invoice`, {}).then((r) => unwrap(r));
  },
  initiateFeePayment(feeId: number, opts: { partialAmount?: number } = {}): Promise<any> {
    const body: any = {};
    if (typeof opts.partialAmount === 'number') body.partialAmount = opts.partialAmount;
    return api.post(`/students/fees/${feeId}/initiate`, body).then((r) => unwrap(r));
  },
};

export default studentFeeApi;
