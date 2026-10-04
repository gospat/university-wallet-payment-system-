// ---------------------------------------------------------------------------
// Refunds API service — T16 frontend (bursary create/list; admin approve/reject)
// ---------------------------------------------------------------------------
import api from './api';

function unwrap<T>(resp: { data?: any }): T {
  return ((resp?.data?.data) as T) ?? ((resp as any)?.data as T);
}

export type RefundStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'PAID' | 'FAILED';

export type RefundFeeMin = {
  id: number;
  name: string;
  feeCode?: string | null;
};

export type RefundInvoiceMin = {
  id: number;
  invoiceNumber: string;
  session: string | null;
  semester: string | null;
  fee?: RefundFeeMin | null;
};

export type RefundTxMin = {
  id: number;
  reference: string | null;
  paystackReference: string | null;
  amount: number;
  user?: {
    id: number;
    firstName: string;
    lastName: string;
    matricNumber: string | null;
    email: string;
  } | null;
  invoice?: RefundInvoiceMin | null;
};

export type RefundUserMin = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role?: string | null;
};

export type RefundSummary = {
  id: number;
  refundNumber: string;
  originalTransactionId: number;
  originalReceiptId: number | null;
  requestedAmount: number;
  reason: string;
  status: RefundStatus;
  requestedById: number | null;
  approvedById: number | null;
  paidAt: string | null;
  paystackRefundReference: string | null;
  notes?: any;
  createdAt: string;
  updatedAt: string;
  requestedBy: RefundUserMin | null;
  approvedBy: RefundUserMin | null;
  originalTransaction: RefundTxMin | null;
  originalReceipt: { id: number; receiptNumber: string; isVoided: boolean } | null;
};

export type RefundListResponse = {
  items: RefundSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type RefundListQuery = {
  page?: number;
  pageSize?: number;
  status?: RefundStatus;
  originalTransactionId?: number;
  studentId?: number;
  dateFrom?: string;
  dateTo?: string;
};

export type RequestRefundInput = {
  originalTransactionId: number;
  requestedAmount: number;
  reason: string;
};

export type RejectRefundInput = {
  notes: string;
};

export type ApproveRefundInput = {
  notes?: string;
};

export const bursaryRefundApi = {
  list(q: RefundListQuery = {}): Promise<RefundListResponse> {
    return api.get('/bursary/refunds', { params: q }).then((r) => unwrap(r));
  },
  request(input: RequestRefundInput): Promise<RefundSummary> {
    return api.post('/bursary/refunds', input).then((r) => unwrap(r));
  },
};

export const adminRefundApi = {
  list(q: RefundListQuery = {}): Promise<RefundListResponse> {
    return api.get('/admin/refunds', { params: q }).then((r) => unwrap(r));
  },
  approve(id: number, input: ApproveRefundInput = {}): Promise<RefundSummary> {
    return api.post(`/admin/refunds/${id}/approve`, input).then((r) => unwrap(r));
  },
  reject(id: number, input: RejectRefundInput): Promise<RefundSummary> {
    return api.post(`/admin/refunds/${id}/reject`, input).then((r) => unwrap(r));
  },
};

export default bursaryRefundApi;
