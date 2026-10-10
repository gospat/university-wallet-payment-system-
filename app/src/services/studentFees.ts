// ---------------------------------------------------------------------------
// Student fee + invoice API helpers (Task 10.2 frontend)
// ---------------------------------------------------------------------------
import api, { downloadBlob as _downloadBlob } from './api';

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
    gateway?: string | null;
    channel: string;
    amount: number | string;
    expectedAmount?: number | string;
    displayAmount?: number | string;
    status: string;
    paymentReference: string | null;
    paystackReference?: string | null;
    alatpayReference?: string | null;
    alatpayFinalTransactionId?: string | null;
    transactionDate: string | null;
    type?: string | null;
    description?: string | null;
    createdAt: string;
    updatedAt?: string;
  }>;
  blockingPendingTransaction?: {
    id: number;
    reference: string;
    gateway?: string | null;
    channel?: string | null;
    amount?: number | string;
    expectedAmount?: number | string;
    displayAmount?: number | string;
    status: string;
    paystackReference?: string | null;
    alatpayReference?: string | null;
    alatpayFinalTransactionId?: string | null;
    transactionDate?: string | null;
    createdAt: string;
    updatedAt?: string;
  } | null;
  pay?: {
    canPay: boolean;
    amountToPay: number;
    paymentReference: string;
    dueDate: string | null;
    activeGateway?: string | null;
    gateway_label?: string | null;
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
  noteToStudent?: string | null;
  badge?: string | null;
  assignmentId?: number | null;
  assignedAt?: string;
  assignedBy?: { firstName?: string; lastName?: string; email?: string } | null;
  invoiceId?: number | null;
  invoiceNumber?: string | null;
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

export type AlatpayPublicBusiness = {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly logoUrl: string;
};

export type AlatpayPublicCheckoutMetadata = {
  readonly bells_payment_reference: string;
  readonly order_reference: string;
  readonly init_payment_reference: string;
};

export type AlatpayPublicCheckoutFallback = {
  readonly enableRedirect: false;
  readonly enablePopup: true;
  readonly handshakeTimeoutMs: number;
};

export type AlatpayPublicCheckout = {
  readonly apiKey: string;
  readonly businessId: string;
  readonly amount: number;
  readonly currency: 'NGN';
  readonly autoCloseModal: boolean;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phone?: string;
  readonly metadata: AlatpayPublicCheckoutMetadata;
  readonly fallback: AlatpayPublicCheckoutFallback;
};

export type AlatpayRefs = {
  readonly order_reference: string;
  readonly init_payment_reference: string;
};

export type InitiatePaymentResponse = {
  reference?: string;
  authorization_url?: string;
  checkoutUrl?: string;
  access_code?: string;
  providerReference?: string;
  gateway_label?: string;
  gatewayLabel?: string;
  checkout_popup_mode?: 'hosted_url_iframe' | 'alatpay_native_modal_v1';
  alatpay_public_checkout?: AlatpayPublicCheckout;
  alatpay_refs?: AlatpayRefs;
  [k: string]: any;
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
  verifyPayment(reference: string, opts?: { providerReference?: string | null | undefined }): Promise<any> {
    const params: any = {};
    if (opts?.providerReference && String(opts.providerReference).trim()) {
      params.providerReference = String(opts.providerReference).trim();
    }
    const qs = new URLSearchParams(params).toString();
    const url = `/students/payments/verify/${encodeURIComponent(reference)}` + (qs ? `?${qs}` : '');
    return api.get(url).then((r) => unwrap(r));
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
  ensureInvoiceForAssignment(assignmentId: number): Promise<EnsureInvoiceForAssignmentResponse> {
    return api.post(`/students/fee-assignments/${assignmentId}/ensure-invoice`, {}).then((r) => unwrap(r));
  },
  initiateFeePayment(feeId: number, opts: { partialAmount?: number } = {}): Promise<any> {
    const body: any = {};
    if (typeof opts.partialAmount === 'number') body.partialAmount = opts.partialAmount;
    return api.post(`/students/fees/${feeId}/initiate`, body).then((r) => unwrap(r));
  },
  async downloadReceiptPdf(id: number | string): Promise<void> {
    const realId = Number(id);
    if (!Number.isFinite(realId) || realId <= 0) throw new Error('Invalid receipt ID');
    await _downloadBlob(
      `/students/receipts/${encodeURIComponent(String(realId))}/download`,
      `Bells-University-Receipt-${String(realId)}.pdf`,
    );
  },
  async reverifyPayment(transactionId: number | string): Promise<any> {
    const realId = Number(transactionId);
    if (!Number.isFinite(realId) || realId <= 0) throw new Error('Invalid transaction ID');
    const r = await api.post(`/students/payments/${encodeURIComponent(String(realId))}/reverify`, {});
    return unwrap<any>(r);
  },
  async getContinueOption(transactionId: number | string): Promise<any> {
    const realId = Number(transactionId);
    if (!Number.isFinite(realId) || realId <= 0) throw new Error('Invalid transaction ID');
    const r = await api.get(`/students/payments/${encodeURIComponent(String(realId))}/continue-option`);
    return (r?.data as any) ?? r;
  },
};

export default studentFeeApi;
