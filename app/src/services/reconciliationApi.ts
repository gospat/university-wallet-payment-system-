import api from './api';

export type Classification =
  | 'MATCHED'
  | 'AMOUNT_MISMATCH'
  | 'MISSING_INTERNAL'
  | 'MISSING_GATEWAY'
  | 'DUPLICATE_REFERENCE'
  | 'REVERSED_TXN'
  | 'MISSING_RECEIPT'
  | 'PENDING_ATTEMPT'
  | 'FAILED_ATTEMPT'
  | 'UNABLE_TO_VERIFY';

export type GatewayAvailability =
  | 'AVAILABLE'
  | 'PARTIALLY_AVAILABLE'
  | 'UNAVAILABLE'
  | 'NOT_REQUESTED';

export type ChargeSource = 'ALL' | 'CATALOGUE' | 'DIRECT_BILL';

export type ReconciliationSummary = {
  systemRecords: number;
  gatewayRecords: number;
  matched: number;
  amountMismatch: number;
  missingInternal: number;
  missingGateway: number;
  duplicateReference: number;
  reversedTxn: number;
  missingReceipt: number;
  pendingAttempts: number;
  failedAttempts: number;
  unableToVerify: number;
  providerAvailability: {
    paystack: GatewayAvailability;
    alatpay: GatewayAvailability;
  };
  incompleteCoverage: boolean;
};

export type ReconciliationItem = {
  date?: string;
  gateway: 'PAYSTACK' | 'ALATPAY';
  gatewayReference: string | null;
  providerReference?: string | null;
  paymentReference: string | null;
  classification: Classification;
  expectedAmount: number;
  actualAmount: number;
  studentName?: string | null;
  studentId?: number | null;
  chargeSource?: 'DIRECT_BILL' | 'CATALOGUE';
  assignmentId?: number | null;
  verificationMethod?: string;
  providerAvailable?: boolean;
};

export type ReconciliationPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type ReconciliationItemsResponse = {
  items: ReconciliationItem[];
  pagination: ReconciliationPagination;
  summary: ReconciliationSummary;
  filters: Record<string, unknown>;
};

export type SummaryFilters = {
  dateFrom: string;
  dateTo: string;
  feeId?: number | null;
  gateway?: 'PAYSTACK' | 'ALATPAY';
  chargeSource?: ChargeSource;
};

export type ItemsFilters = SummaryFilters & {
  page?: number;
  limit?: number;
  classification?: Classification;
};

export async function getReconciliationSummary(
  filters: SummaryFilters,
  signal?: AbortSignal,
): Promise<ReconciliationSummary> {
  const params: Record<string, string | number> = {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
  };
  if (filters.feeId != null) params.feeId = filters.feeId;
  if (filters.gateway) params.gateway = filters.gateway;
  if (filters.chargeSource) params.chargeSource = filters.chargeSource;

  const res = await api.get('/bursary/reconciliation/summary', { params, signal });
  return res.data?.data?.summary as ReconciliationSummary;
}

export async function getReconciliationItems(
  filters: ItemsFilters,
  signal?: AbortSignal,
): Promise<ReconciliationItemsResponse> {
  const params: Record<string, string | number> = {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
  };
  if (filters.page != null) params.page = filters.page;
  if (filters.limit != null) params.limit = filters.limit;
  if (filters.classification) params.classification = filters.classification;
  if (filters.feeId != null) params.feeId = filters.feeId;
  if (filters.gateway) params.gateway = filters.gateway;
  if (filters.chargeSource) params.chargeSource = filters.chargeSource;

  const res = await api.get('/bursary/reconciliation/items', { params, signal });
  return res.data?.data as ReconciliationItemsResponse;
}

export function buildReportCsvUrl(filters: ItemsFilters): string {
  const params = new URLSearchParams();
  params.set('dateFrom', filters.dateFrom);
  params.set('dateTo', filters.dateTo);
  params.set('format', 'csv');
  if (filters.feeId != null) params.set('feeId', String(filters.feeId));
  if (filters.gateway) params.set('gateway', filters.gateway);
  if (filters.chargeSource) params.set('chargeSource', filters.chargeSource);
  return `/bursary/reconciliation/report?${params.toString()}`;
}
