import axios from 'axios';
import { Prisma, TransactionStatus, TransactionType, PaymentGateway, Role } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { generatePaymentReference, generateReceiptReference, generateVerificationToken, kobo } from '../utils/paystack';
import { nextYearlyCounter, yearFromSession } from '../utils/yearlyCounter';
import { getActiveAlatpaySecretKey, getAlatpayBaseUrl, normalizeAlatStatus, isAlatpayUuid } from '../utils/alatpay';
import Papa from 'papaparse';

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

export type VerificationMethod =
  | 'GATEWAY_LIST'
  | 'GATEWAY_INDIVIDUAL_LOOKUP'
  | 'NOT_VERIFIED'
  | 'PROVIDER_UNAVAILABLE';

export type PaystackTxRow = {
  reference: string;
  amount?: number;
  status?: string;
  channel?: string;
  transaction_date?: string;
  paid_at?: string;
  created_at?: string;
  reversed?: boolean;
  customer?: { email?: string } | null;
  metadata?: any;
  [key: string]: any;
};

export type AlatpayTxRow = {
  Id?: string;
  id?: string;
  transactionId?: string;
  reference?: string;
  orderId?: string;
  Amount?: number;
  amount?: number;
  Status?: string;
  status?: string;
  Channel?: string;
  channel?: string;
  Currency?: string;
  currency?: string;
  FeeAmount?: number;
  feeAmount?: number;
  UpdatedAt?: string;
  updatedAt?: string;
  CreatedAt?: string;
  createdAt?: string;
  Customer?: { Email?: string; FirstName?: string; LastName?: string; email?: string } | null;
  customer?: { email?: string } | null;
  Metadata?: string | null;
  metadata?: any;
  [key: string]: any;
};

export type GatewayTxRow =
  | ({ gateway: 'PAYSTACK' } & PaystackTxRow)
  | ({ gateway: 'ALATPAY' } & AlatpayTxRow);

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
  gateway: PaymentGateway;
  gatewayReference: string | null;
  paymentReference: string | null;
  classification: Classification;
  expectedAmount: number;
  actualAmount: number;
  studentName?: string | null;
  studentId?: number | null;
  chargeSource?: 'DIRECT_BILL' | 'CATALOGUE';
  assignmentId?: number | null;
  verificationMethod: VerificationMethod;
  providerReference?: string | null;
  providerAvailable?: boolean;
  rawInternal?: any;
  rawGateway?: any;
};

export type RunCompareResult = {
  summary: ReconciliationSummary;
  items: ReconciliationItem[];
  effectiveRange: {
    from: string;
    to: string;
    timezone: string;
    inclusive: boolean;
  };
};

const CLASSIFICATION_PRIORITY: Classification[] = [
  'DUPLICATE_REFERENCE',
  'MISSING_RECEIPT',
  'REVERSED_TXN',
  'AMOUNT_MISMATCH',
  'MISSING_INTERNAL',
  'MISSING_GATEWAY',
  'UNABLE_TO_VERIFY',
  'PENDING_ATTEMPT',
  'FAILED_ATTEMPT',
  'MATCHED',
];

const AMOUNT_TOLERANCE_KOBO = 50; // 0.50 NGN in minor units
const JSON_DB_NULL = Prisma.JsonNull;

// Bells University business timezone: Africa/Lagos = UTC+01:00 (no DST).
// All reconciliation calendar-day selections are interpreted in this timezone
// regardless of server-local or browser timezone.
const LAGOS_OFFSET_MS = 60 * 60 * 1000; // UTC+1

/**
 * Convert a user-supplied date range into an effective UTC range that
 * represents the selected Lagos calendar days, using an EXCLUSIVE upper
 * boundary to avoid 23:59:59.999 precision problems.
 *
 * The frontend sends date-only values (e.g. "2026-10-15"). z.coerce.date()
 * parses these as midnight UTC (2026-10-15T00:00:00.000Z). We treat the
 * Y-M-D components as the Lagos calendar day selected by the user.
 *
 * Lagos day 15 Oct 2026:
 *   >= 2026-10-14T23:00:00.000Z  (15 Oct 00:00 Lagos)
 *   <  2026-10-15T23:00:00.000Z  (16 Oct 00:00 Lagos, exclusive)
 *
 * @returns { from, to } where `to` is exclusive.
 */
export function lagosBusinessDayRange(dateFrom: Date, dateTo: Date): {
  from: Date;
  to: Date;
  timezone: string;
} {
  // Take the UTC Y-M-D components of the parsed input. For date-only strings
  // this is exactly the selected calendar day. We never rely on the local
  // timezone of the server.
  const fromY = dateFrom.getUTCFullYear();
  const fromM = dateFrom.getUTCMonth();
  const fromD = dateFrom.getUTCDate();
  const toY = dateTo.getUTCFullYear();
  const toM = dateTo.getUTCMonth();
  const toD = dateTo.getUTCDate();

  // Start of the first selected Lagos day = that UTC calendar day's midnight
  // minus one hour (Lagos is UTC+1).
  const fromUtcMidnight = Date.UTC(fromY, fromM, fromD);
  const from = new Date(fromUtcMidnight - LAGOS_OFFSET_MS);

  // Exclusive upper bound: start of the Lagos day AFTER the last selected day.
  // = UTC midnight of (last selected day + 1) minus one hour
  // = UTC midnight of last selected day + 23 hours.
  const toUtcMidnight = Date.UTC(toY, toM, toD);
  const to = new Date(toUtcMidnight + 23 * 60 * 60 * 1000);

  return { from, to, timezone: 'Africa/Lagos' };
}

export async function fetchPaystackTxListRange(params: {
  from: Date;
  to: Date;
}): Promise<{ rows: PaystackTxRow[]; available: boolean }> {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return { rows: [], available: false };
  }
  const fromIso = params.from.toISOString();
  const toIso = params.to.toISOString();
  const fromMs = params.from.getTime();
  const toMs = params.to.getTime();
  let page = 1;
  const perPage = 100;
  const all: PaystackTxRow[] = [];
  let available = true;
  while (true) {
    try {
      const url = `https://api.paystack.co/transaction?from=${encodeURIComponent(
        fromIso,
      )}&to=${encodeURIComponent(toIso)}&page=${page}&perPage=${perPage}&status=success`;
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${secret}` },
        timeout: 15000,
      });
      const data = res?.data?.data ?? [];
      if (!Array.isArray(data) || data.length === 0) break;
      for (const row of data) {
        // Ensure the record actually falls within the requested date range,
        // using paid_at (the documented transaction settlement timestamp).
        const tsStr = row.paid_at ?? row.transaction_date ?? row.created_at;
        if (tsStr) {
          const t = new Date(tsStr).getTime();
          if (Number.isFinite(t) && (t < fromMs || t > toMs)) continue;
        }
        all.push(row as PaystackTxRow);
      }
      if (data.length < perPage) break;
      page += 1;
    } catch (err: any) {
      available = false;
      throw new AppError(
        `Paystack list fetch failed: ${err?.response?.data?.message || err?.message || 'unknown'}`,
        502,
      );
    }
  }
  return { rows: all, available };
}

export async function fetchAlatpayTxListRange(params: {
  from: Date;
  to: Date;
}): Promise<{ rows: AlatpayTxRow[]; available: boolean }> {
  try {
    const secret = getActiveAlatpaySecretKey();
    const baseUrl = getAlatpayBaseUrl();
    const fromIso = params.from.toISOString();
    const toIso = params.to.toISOString();
    const all: AlatpayTxRow[] = [];
    let page = 1;
    const perPage = 100;
    let available = true;
    let lastStatus: number | null = null;
    while (true) {
      try {
        const candidates = [
          `${baseUrl}/alatpaytransaction/api/v1/transactions?from=${encodeURIComponent(
            fromIso,
          )}&to=${encodeURIComponent(toIso)}&page=${page}&pageSize=${perPage}`,
          `${baseUrl}/transaction/api/v1/transactions?from=${encodeURIComponent(
            fromIso,
          )}&to=${encodeURIComponent(toIso)}&page=${page}&pageSize=${perPage}`,
        ];
        let payload: any = null;
        let lastErr: any = null;
        for (const url of candidates) {
          try {
            const r = await axios.get(url, {
              headers: {
                'Ocp-Apim-Subscription-Key': secret,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              timeout: 15000,
            });
            payload = r?.data?.data ?? r?.data?.Value?.Data ?? r?.data;
            if (Array.isArray(payload) && payload.length > 0) break;
            if (Array.isArray(payload?.items)) { payload = payload.items; break; }
            if (Array.isArray(payload?.Items)) { payload = payload.Items; break; }
          } catch (err: any) {
            lastErr = err;
            lastStatus = err?.response?.status ?? null;
          }
        }
        if (!Array.isArray(payload) || payload.length === 0) {
          if (lastErr && page === 1) {
            // Provider API returned an error (404/401/403/500/timeout) — this is
            // NOT a successful empty result. Mark unavailable so internal
            // transactions are NOT classified as MISSING_GATEWAY.
            available = false;
            if (process.env.NODE_ENV !== 'test') {
              console.warn(
                `[recon:alatpay] list endpoint unavailable (status=${lastStatus}) — ALATPay list reconciliation disabled:`,
                lastErr?.message,
              );
            }
          }
          break;
        }
        for (const row of payload) all.push(row as AlatpayTxRow);
        if (payload.length < perPage) break;
        page += 1;
      } catch (err: any) {
        available = false;
        if (process.env.NODE_ENV === 'test') break;
        throw new AppError(
          `ALAT Pay list fetch failed: ${err?.response?.data?.message || err?.message || 'unknown'}`,
          502,
        );
      }
    }
    return { rows: all, available };
  } catch (err: any) {
    if (process.env.NODE_ENV === 'test') return { rows: [], available: false };
    if (err instanceof AppError) throw err;
    console.warn('[recon:alatpay] config unavailable — skipping ALAT Pay pull:', err?.message);
    return { rows: [], available: false };
  }
}

/**
 * READ-ONLY individual ALATPay transaction lookup.
 * Uses the same GET /transactions/{uuid} endpoint as the payment verification
 * flow, but NEVER writes financial state. Used by reconciliation to
 * independently compare provider transaction identifier, status, and gross
 * amount against internal records.
 *
 * Matching identifier preference:
 *   1. alatpayFinalTransactionId (the provider UUID stored after webhook)
 *   2. alatpayReference (only when it is a validated provider UUID)
 *
 * Returns null when no valid provider identifier is available or the lookup
 * fails. Callers must treat null as PROVIDER_UNAVAILABLE and NOT classify the
 * internal transaction as MISSING_GATEWAY or MATCHED.
 */
export async function fetchAlatpayTxById(params: {
  providerId: string;
}): Promise<{ row: AlatpayTxRow | null; available: boolean; notFound: boolean }> {
  const providerId = String(params.providerId ?? '').trim();
  if (!providerId) return { row: null, available: false, notFound: false };
  try {
    const secret = getActiveAlatpaySecretKey();
    const baseUrl = getAlatpayBaseUrl();
    const safeRef = encodeURIComponent(providerId);
    const candidates = [
      `${baseUrl}/alatpaytransaction/api/v1/transactions/${safeRef}`,
      `${baseUrl}/transaction/api/v1/transactions/${safeRef}`,
    ];
    let lastErr: any = null;
    let lastStatus: number | null = null;
    for (const url of candidates) {
      try {
        const r = await axios.get(url, {
          headers: {
            'Ocp-Apim-Subscription-Key': secret,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 15000,
        });
        const payload = r?.data?.data ?? r?.data?.Value?.Data ?? r?.data;
        if (payload && (payload.Id || payload.id || payload.transactionId)) {
          return { row: payload as AlatpayTxRow, available: true, notFound: false };
        }
        // 2xx response but no transaction body — treat as definitive not-found.
        return { row: null, available: true, notFound: true };
      } catch (err: any) {
        lastErr = err;
        lastStatus = err?.response?.status ?? null;
      }
    }
    // Distinguish definitive not-found (404) from transport/availability errors.
    // Only an HTTP 404 proves the transaction does not exist at the provider.
    const notFound = lastStatus === 404;
    if (!notFound && process.env.NODE_ENV !== 'test') {
      console.warn(
        `[recon:alatpay] individual lookup failed for ${providerId}:`,
        lastStatus,
        lastErr?.message,
      );
    }
    return { row: null, available: !notFound, notFound };
  } catch (err: any) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[recon:alatpay] individual lookup unavailable for ${providerId}:`, err?.message);
    }
    return { row: null, available: false, notFound: false };
  }
}

export const _reconciliationInternals: {
  fetchPaystackTxListRange: typeof fetchPaystackTxListRange;
  fetchAlatpayTxListRange: typeof fetchAlatpayTxListRange;
  fetchAlatpayTxById: typeof fetchAlatpayTxById;
} = {
  fetchPaystackTxListRange,
  fetchAlatpayTxListRange,
  fetchAlatpayTxById,
};

function money(n: any): number {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

function pickHighestPriority(flags: Set<Classification>): Classification {
  for (const c of CLASSIFICATION_PRIORITY) {
    if (flags.has(c)) return c;
  }
  return 'MATCHED';
}

function gatewayTxRef(row: GatewayTxRow): string {
  if (row.gateway === PaymentGateway.PAYSTACK) {
    return String(row.reference ?? '').trim();
  }
  return String(row.Id ?? row.id ?? row.transactionId ?? row.reference ?? row.orderId ?? '').trim();
}

function gatewayTxAmountMinor(row: GatewayTxRow): number {
  if (row.gateway === PaymentGateway.PAYSTACK) {
    return Number(row.amount ?? 0);
  }
  const amt = Number(row.Amount ?? row.amount ?? 0);
  return kobo.fromNaira(money(amt));
}

function gatewayTxStatusSuccess(row: GatewayTxRow): boolean {
  if (row.gateway === PaymentGateway.PAYSTACK) {
    return String(row.status ?? '').toLowerCase() === 'success';
  }
  const s = String(row.Status ?? row.status ?? '').trim();
  return normalizeAlatStatus(s) === 'success';
}

function gatewayTxReversed(row: GatewayTxRow): boolean {
  if (row.gateway === PaymentGateway.PAYSTACK) {
    return row.reversed === true;
  }
  const s = String(row.Status ?? row.status ?? '').trim().toLowerCase();
  return s.includes('reverse') || s.includes('reversed') || s.includes('refund');
}

function gatewayTxDate(row: GatewayTxRow): string | undefined {
  if (row.gateway === PaymentGateway.PAYSTACK) {
    return row.paid_at ?? row.transaction_date ?? row.created_at;
  }
  return row.UpdatedAt ?? row.updatedAt ?? row.CreatedAt ?? row.createdAt;
}

function gatewayTxEmail(row: GatewayTxRow): string | null {
  if (row.gateway === PaymentGateway.PAYSTACK) {
    return String(row.customer?.email ?? '').trim() || null;
  }
  return String(row.Customer?.Email ?? row.Customer?.email ?? row.customer?.email ?? '').trim() || null;
}

type ChargeSourceFilter = 'ALL' | 'CATALOGUE' | 'DIRECT_BILL';

export class ReconciliationService {
  static async runCompare(params: {
    dateFrom: Date;
    dateTo: Date;
    feeId?: number;
    gateway?: PaymentGateway;
    chargeSource?: ChargeSourceFilter;
  }): Promise<RunCompareResult> {
    const { dateFrom, dateTo, feeId, gateway, chargeSource = 'ALL' } = params;

    // The API is authoritative for interpreting the user-supplied date range.
    // The frontend sends date-only values (e.g. "2026-10-15") which
    // z.coerce.date() parses as midnight UTC. We interpret those calendar days
    // in the Bells University business timezone (Africa/Lagos, UTC+1) and use
    // an EXCLUSIVE upper boundary for safe database queries.
    const effective = lagosBusinessDayRange(dateFrom, dateTo);
    const fromMs = effective.from.getTime();
    const toMs = effective.to.getTime();

    // Authoritative financial date differs by status:
    //   SUCCESS  -> receipt.paidAt (provider paid timestamp), fallback createdAt
    //   FAILED/PENDING/REVERSED -> createdAt (attempt creation)
    // The Prisma OR catches transactions whose attempt was created in range OR
    // whose receipt (successful payment) was issued in range. In-memory filtering
    // then applies the precise authoritative financial date.
    const internalWhere: Prisma.TransactionWhereInput = {
      OR: [
        { createdAt: { gte: effective.from, lt: effective.to } },
        { receipts: { some: { paidAt: { gte: effective.from, lt: effective.to } } } },
      ],
    };
    if (feeId !== undefined && feeId !== null) {
      internalWhere.invoice = { feeId: Number(feeId) };
    }
    if (gateway !== undefined) {
      internalWhere.gateway = gateway;
    }

    const internalTxsRaw = await prisma.transaction.findMany({
      where: internalWhere,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, matricNumber: true } },
        invoice: { select: { id: true, feeId: true } },
        receipts: { select: { id: true, transactionId: true, paidAt: true, isVoided: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Determine chargeSource for each internal transaction and apply filter
    type InternalTx = (typeof internalTxsRaw)[number] & { chargeSource?: 'DIRECT_BILL' | 'CATALOGUE'; assignmentId?: number | null };
    const internalTxsAll: InternalTx[] = internalTxsRaw as InternalTx[];
    const invoiceFeeIds = Array.from(new Set(internalTxsAll.map((t) => t.invoice?.feeId).filter((n) => n != null) as number[]));
    const directByFeeByStudent = new Map<string, number>(); // "studentId:feeId" -> assignmentId
    if (invoiceFeeIds.length > 0) {
      const asgs = await prisma.feeAssignment.findMany({
        where: {
          assignmentType: 'STUDENT' as any,
          isActive: true,
          feeId: { in: invoiceFeeIds },
        },
        select: { id: true, targetStudentId: true, feeId: true },
      });
      for (const a of asgs) {
        if (a.targetStudentId && a.feeId) directByFeeByStudent.set(`${a.targetStudentId}:${a.feeId}`, a.id);
      }
    }
    for (const tx of internalTxsAll) {
      const key = `${tx.userId}:${tx.invoice?.feeId}`;
      const asgId = directByFeeByStudent.get(key) ?? null;
      (tx as any).chargeSource = asgId != null ? 'DIRECT_BILL' : 'CATALOGUE';
      (tx as any).assignmentId = asgId;
    }

    let internalTxs: InternalTx[];
    if (chargeSource === 'ALL') {
      internalTxs = internalTxsAll;
    } else if (chargeSource === 'DIRECT_BILL') {
      internalTxs = internalTxsAll.filter((t) => t.chargeSource === 'DIRECT_BILL');
    } else {
      internalTxs = internalTxsAll.filter((t) => t.chargeSource === 'CATALOGUE');
    }

    // Filter by authoritative financial-payment date:
    //   SUCCESS  -> receipt.paidAt (provider paid timestamp, authoritative)
    //               fallback: createdAt (stable attempt time when no receipt exists)
    //   FAILED/PENDING/REVERSED -> createdAt (attempt creation time)
    // Note: updatedAt is intentionally NOT used as it can be bumped by any
    // later edit, not just the status transition to SUCCESS.
    const financialDateOf = (tx: InternalTx): Date => {
      if (tx.status === TransactionStatus.SUCCESS) {
        const rct = (tx.receipts ?? []).find((r) => !(r as any).isVoided) ?? (tx.receipts ?? [])[0];
        if (rct && (rct as any).paidAt) return (rct as any).paidAt;
        return tx.createdAt;
      }
      return tx.createdAt;
    };
    internalTxs = internalTxs.filter((t) => {
      const ms = financialDateOf(t).getTime();
      return ms >= fromMs && ms < toMs;
    });

    type ByKey = Map<string, InternalTx[]>;
    const internalByKey = new Map<PaymentGateway, ByKey>();

    for (const tx of internalTxs) {
      const g = tx.gateway ?? PaymentGateway.ALATPAY;
      if (gateway !== undefined && g !== gateway) continue;
      let ref: string | null = null;
      if (g === PaymentGateway.PAYSTACK) {
        ref = tx.paystackReference || tx.reference;
      } else if (g === PaymentGateway.ALATPAY) {
        // Prefer the final transaction UUID stored after webhook, then the
        // alatpayReference only when it is a validated provider UUID.
        ref =
          (tx as any).alatpayFinalTransactionId ||
          (isAlatpayUuid((tx as any).alatpayReference) ? (tx as any).alatpayReference : null) ||
          tx.alatpayReference ||
          tx.paystackReference ||
          tx.reference;
      } else {
        ref = tx.reference;
      }
      if (!ref) continue;
      if (!internalByKey.has(g)) internalByKey.set(g, new Map());
      const byRef = internalByKey.get(g)!;
      const arr = byRef.get(ref) || [];
      arr.push(tx);
      byRef.set(ref, arr);
    }

    const gatewaysToPull: PaymentGateway[] = gateway
      ? [gateway]
      : [PaymentGateway.ALATPAY, PaymentGateway.PAYSTACK];

    const gatewayRows: GatewayTxRow[] = [];
    let paystackAvailable = false;
    let alatpayListAvailable = false;
    let alatpayIndividualAvailable = false;
    const alatpayVerifiedRefs = new Set<string>();
    // Refs whose individual lookup definitively returned NOT FOUND (HTTP 404).
    // Only these may be considered MISSING_GATEWAY under full list coverage.
    const alatpayNotFoundRefs = new Set<string>();

    for (const g of gatewaysToPull) {
      if (g === PaymentGateway.PAYSTACK) {
        try {
          const { rows, available } = await _reconciliationInternals.fetchPaystackTxListRange({
            from: effective.from,
            to: effective.to,
          });
          paystackAvailable = available;
          for (const r of rows) gatewayRows.push({ gateway: g, ...r });
        } catch (e: any) {
          paystackAvailable = false;
          if (process.env.NODE_ENV === 'test') {
            // ignore
          } else {
            console.warn('[recon:paystack] Paystack list pull failed:', e?.message);
          }
        }
      } else if (g === PaymentGateway.ALATPAY) {
        try {
          const { rows, available } = await _reconciliationInternals.fetchAlatpayTxListRange({
            from: effective.from,
            to: effective.to,
          });
          alatpayListAvailable = available;
          for (const r of rows) gatewayRows.push({ gateway: g, ...r });

          // Individually verify known internal ALATPay UUIDs that were NOT
          // returned by the list endpoint. This covers two cases:
          //   A) list endpoint unavailable (partial coverage fallback)
          //   B) list endpoint available but a known UUID is absent from the
          //      returned list (ALATPay list results may be incomplete).
          //
          // A successful individual lookup reconciles the transaction.
          // A definitive NOT FOUND (HTTP 404) may later become MISSING_GATEWAY
          // under full list coverage. A transport/5xx/timeout failure must
          // become UNABLE_TO_VERIFY — never MISSING_GATEWAY.
          const alatpayInternal = internalTxs.filter(
            (t) => (t.gateway ?? PaymentGateway.ALATPAY) === PaymentGateway.ALATPAY,
          );
          const listRefs = new Set(
            rows.map((r) =>
              String(r.Id ?? r.id ?? r.transactionId ?? r.reference ?? r.orderId ?? '').trim(),
            ),
          );
          for (const tx of alatpayInternal) {
            const providerId =
              (tx as any).alatpayFinalTransactionId ||
              (isAlatpayUuid((tx as any).alatpayReference) ? (tx as any).alatpayReference : null);
            if (!providerId) continue;
            if (listRefs.has(providerId)) continue;
            try {
              const { row, available: lookupAvailable, notFound } =
                await _reconciliationInternals.fetchAlatpayTxById({ providerId });
              if (lookupAvailable && row) {
                alatpayIndividualAvailable = true;
                gatewayRows.push({ gateway: g, ...row });
                alatpayVerifiedRefs.add(providerId);
              } else if (notFound) {
                alatpayNotFoundRefs.add(providerId);
              }
              // else: lookup failed (transport/5xx/timeout) — leave as
              // UNABLE_TO_VERIFY later; do not add to notFound set.
            } catch {
              // individual lookup threw — leave availability flags as-is;
              // this transaction will be UNABLE_TO_VERIFY, not MISSING_GATEWAY.
            }
          }
        } catch (e: any) {
          if (process.env.NODE_ENV === 'test') {
            // ignore
          } else {
            console.warn('[recon:alatpay] ALAT Pay pull failed (continuing with partial data):', e?.message);
          }
        }
      }
    }

    // Resolve per-gateway availability state:
    //   list available            -> AVAILABLE
    //   list unavailable + individual works -> PARTIALLY_AVAILABLE
    //   both unavailable          -> UNAVAILABLE
    //   not requested             -> NOT_REQUESTED
    const paystackRequested = gatewaysToPull.includes(PaymentGateway.PAYSTACK);
    const alatpayRequested = gatewaysToPull.includes(PaymentGateway.ALATPAY);
    const paystackAvailability: GatewayAvailability = paystackRequested
      ? (paystackAvailable ? 'AVAILABLE' : 'UNAVAILABLE')
      : 'NOT_REQUESTED';
    const alatpayAvailability: GatewayAvailability = alatpayRequested
      ? (alatpayListAvailable
          ? 'AVAILABLE'
          : alatpayIndividualAvailable
            ? 'PARTIALLY_AVAILABLE'
            : 'UNAVAILABLE')
      : 'NOT_REQUESTED';

    const gatewayByKey = new Map<PaymentGateway, Map<string, GatewayTxRow[]>>();
    for (const gr of gatewayRows) {
      const g = gr.gateway;
      const ref = gatewayTxRef(gr);
      if (!ref) continue;
      if (!gatewayByKey.has(g)) gatewayByKey.set(g, new Map());
      const byRef = gatewayByKey.get(g)!;
      const arr = byRef.get(ref) || [];
      arr.push(gr);
      byRef.set(ref, arr);
    }

    // Build the set of all keys. For ALATPay we also need to index internal
    // transactions by their provider UUID (alatpayFinalTransactionId or
    // alatpayReference) so individual-lookup results can match.
    const allKeys = new Set<string>();

    // Add internal keys
    for (const tx of internalTxs) {
      const g = tx.gateway ?? PaymentGateway.ALATPAY;
      if (gateway !== undefined && g !== gateway) continue;
      let ref: string | null = null;
      if (g === PaymentGateway.PAYSTACK) {
        ref = tx.paystackReference || tx.reference;
      } else if (g === PaymentGateway.ALATPAY) {
        ref =
          (tx as any).alatpayFinalTransactionId ||
          (isAlatpayUuid((tx as any).alatpayReference) ? (tx as any).alatpayReference : null) ||
          tx.alatpayReference ||
          tx.paystackReference ||
          tx.reference;
      } else {
        ref = tx.reference;
      }
      if (ref) allKeys.add(`${g}:${ref}`);
    }

    // Add gateway keys
    for (const g of gatewayByKey.keys()) {
      const byG = gatewayByKey.get(g)!;
      for (const k of byG.keys()) allKeys.add(`${g}:${k}`);
    }

    const items: ReconciliationItem[] = [];

    for (const key of allKeys) {
      const colon = key.indexOf(':');
      const g = key.slice(0, colon) as PaymentGateway;
      const ref = key.slice(colon + 1);

      const internalRows = (internalByKey.get(g)?.get(ref) || []).filter((t) => {
        const gw = t.gateway ?? PaymentGateway.ALATPAY;
        if (g === PaymentGateway.ALATPAY) {
          const tRef =
            (t as any).alatpayFinalTransactionId ||
            (isAlatpayUuid((t as any).alatpayReference) ? (t as any).alatpayReference : null) ||
            t.alatpayReference ||
            t.paystackReference ||
            t.reference;
          return tRef === ref;
        }
        const tRef = g === PaymentGateway.PAYSTACK ? t.paystackReference || t.reference : t.reference;
        return tRef === ref;
      });
      const gwRowsArr = gatewayByKey.get(g)?.get(ref) || [];

      const flags = new Set<Classification>();

      const internalSuccess = internalRows.filter((t) => t.status === TransactionStatus.SUCCESS);
      const internalReversed = internalRows.some((t) => t.status === TransactionStatus.REVERSED);
      const internalFailed = internalRows.filter((t) => t.status === TransactionStatus.FAILED);
      const internalPending = internalRows.filter((t) => t.status === TransactionStatus.PENDING);
      const gatewaySuccess = gwRowsArr.filter(gatewayTxStatusSuccess);
      const gatewayReversed = gwRowsArr.some(gatewayTxReversed);

      // Provider availability for this specific gateway.
      // providerFullAvailable = AVAILABLE (full list coverage).
      // Under PARTIALLY_AVAILABLE (individual lookup only) we can verify known
      // internal UUIDs but cannot discover gateway-only transactions, so a
      // missing gateway match must NOT become MISSING_GATEWAY.
      const gatewayAvailability =
        g === PaymentGateway.PAYSTACK ? paystackAvailability : alatpayAvailability;
      const providerFullAvailable = gatewayAvailability === 'AVAILABLE';
      const providerAvailable =
        gatewayAvailability === 'AVAILABLE' || gatewayAvailability === 'PARTIALLY_AVAILABLE';

      if (internalRows.length >= 2 || gwRowsArr.length >= 2) {
        flags.add('DUPLICATE_REFERENCE');
      }

      const hasInternalSuccess = internalSuccess.length > 0;
      const hasGatewaySuccess = gatewaySuccess.length > 0;

      const anyInternal = internalRows.length > 0;
      const anyGateway = gwRowsArr.length > 0;

      // FAILED and PENDING attempts do NOT become MISSING_GATEWAY.
      // They are reported separately.
      if (internalFailed.length > 0 && !hasInternalSuccess) {
        flags.add('FAILED_ATTEMPT');
      }
      if (internalPending.length > 0 && !hasInternalSuccess) {
        flags.add('PENDING_ATTEMPT');
      }

      const repInternal = internalSuccess[0] || internalRows[0];
      const repGateway = gatewaySuccess[0] || gwRowsArr[0];

      // MISSING_GATEWAY only when the provider has FULL list coverage
      // (AVAILABLE) and there is a genuine successful internal record with no
      // corresponding gateway record.
      //
      // For ALATPay we additionally require definitive proof of absence:
      // the internal transaction must have a usable provider UUID AND that
      // UUID must have returned a definitive NOT FOUND from the individual
      // lookup. A transport/5xx/timeout failure, or a missing provider UUID,
      // must be UNABLE_TO_VERIFY — never MISSING_GATEWAY.
      //
      // Under PARTIALLY_AVAILABLE we cannot prove the gateway record is
      // missing, so it is always UNABLE_TO_VERIFY.
      const alatpayHasUsableUuid =
        g === PaymentGateway.ALATPAY &&
        !!((repInternal as any)?.alatpayFinalTransactionId ||
          (isAlatpayUuid((repInternal as any)?.alatpayReference) ? (repInternal as any)?.alatpayReference : null));
      const alatpayDefinitivelyNotFound =
        g === PaymentGateway.ALATPAY &&
        alatpayHasUsableUuid &&
        alatpayNotFoundRefs.has(ref);

      if (
        anyInternal &&
        !anyGateway &&
        hasInternalSuccess &&
        providerFullAvailable &&
        (g === PaymentGateway.PAYSTACK || alatpayDefinitivelyNotFound)
      ) {
        flags.add('MISSING_GATEWAY');
      }
      // If provider is not fully available, or (for ALATPay) we cannot
      // definitively prove absence, classify as UNABLE_TO_VERIFY
      // (never MISSING_GATEWAY).
      const alatpayCannotProveAbsence =
        g === PaymentGateway.ALATPAY && !alatpayDefinitivelyNotFound;
      if (
        anyInternal &&
        !anyGateway &&
        hasInternalSuccess &&
        (!providerFullAvailable || alatpayCannotProveAbsence)
      ) {
        flags.add('UNABLE_TO_VERIFY');
      }

      if (anyGateway && !anyInternal) {
        flags.add('MISSING_INTERNAL');
      }

      // Amount comparison using integer minor units (kobo) to avoid float errors.
      // Compare provider GROSS amount against internal expectedAmount.
      let expectedKobo = 0;
      let actualKobo = 0;

      if (repInternal) {
        const expectedNaira = money(repInternal.expectedAmount ?? repInternal.amount ?? 0);
        expectedKobo = kobo.fromNaira(expectedNaira);
      }
      if (repGateway) {
        actualKobo = gatewayTxAmountMinor(repGateway);
      }
      if (!repInternal && repGateway) {
        expectedKobo = actualKobo;
      }
      if (!repGateway && repInternal) {
        actualKobo = expectedKobo;
      }

      if (hasInternalSuccess && hasGatewaySuccess) {
        const delta = Math.abs(expectedKobo - actualKobo);
        if (delta > AMOUNT_TOLERANCE_KOBO) {
          flags.add('AMOUNT_MISMATCH');
        }
      }

      if (internalReversed || gatewayReversed) {
        flags.add('REVERSED_TXN');
      }

      if (hasInternalSuccess && hasGatewaySuccess && !flags.has('DUPLICATE_REFERENCE')) {
        const hasReceipt =
          internalSuccess.some((t) => (t as any).receipts && (t as any).receipts.length > 0);
        if (!hasReceipt) {
          flags.add('MISSING_RECEIPT');
        }
      }

      if (flags.size === 0) {
        flags.add('MATCHED');
      }

      const classification = pickHighestPriority(flags);

      let dateStr: string | undefined;
      if (repGateway) {
        dateStr = gatewayTxDate(repGateway);
      } else if (repInternal) {
        // Display the same authoritative financial date used to include the
        // transaction in the report. For SUCCESS this is receipt.paidAt; for
        // FAILED/PENDING/etc it is createdAt. Do not display createdAt for a
        // SUCCESS transaction that was filtered in by receipt.paidAt.
        dateStr = financialDateOf(repInternal).toISOString();
      }

      let studentName: string | null = null;
      let studentId: number | null = null;
      if ((repInternal as any)?.user) {
        const u = (repInternal as any).user;
        const parts = [u.firstName, u.lastName].filter(Boolean) as string[];
        studentName = parts.join(' ').trim() || null;
        studentId = Number(u.id) || null;
      }
      if (!studentName && repGateway) {
        const email = gatewayTxEmail(repGateway);
        if (email) studentName = email;
      }

      // Determine verification method and provider reference
      let verificationMethod: VerificationMethod = 'NOT_VERIFIED';
      if (hasGatewaySuccess) {
        if (g === PaymentGateway.ALATPAY && alatpayVerifiedRefs.has(ref)) {
          verificationMethod = 'GATEWAY_INDIVIDUAL_LOOKUP';
        } else {
          verificationMethod = 'GATEWAY_LIST';
        }
      } else if (classification === 'UNABLE_TO_VERIFY') {
        verificationMethod = 'PROVIDER_UNAVAILABLE';
      }

      items.push({
        date: dateStr,
        gateway: g,
        gatewayReference: ref,
        paymentReference: repInternal ? repInternal.reference : null,
        classification,
        expectedAmount: money(kobo.toNaira(expectedKobo)),
        actualAmount: money(kobo.toNaira(actualKobo)),
        studentName,
        studentId,
        chargeSource: repInternal ? (repInternal as any).chargeSource ?? 'CATALOGUE' : undefined,
        assignmentId: repInternal ? (repInternal as any).assignmentId ?? null : undefined,
        verificationMethod,
        providerReference: repGateway ? gatewayTxRef(repGateway) : null,
        providerAvailable,
        rawInternal: repInternal ? { ...repInternal, user: undefined, invoice: undefined, receipts: undefined } : undefined,
        rawGateway: repGateway ?? undefined,
      });
    }

    type NumericSummaryKey =
      | 'matched'
      | 'amountMismatch'
      | 'missingInternal'
      | 'missingGateway'
      | 'duplicateReference'
      | 'reversedTxn'
      | 'missingReceipt'
      | 'pendingAttempts'
      | 'failedAttempts'
      | 'unableToVerify';

    // incompleteCoverage only considers gateways that were REQUESTED.
    // A gateway that was not filtered-in does not contribute to incomplete
    // coverage (e.g. ALATPay-only report must not warn about Paystack).
    const incompleteCoverage =
      (paystackRequested && paystackAvailability !== 'AVAILABLE') ||
      (alatpayRequested && alatpayAvailability !== 'AVAILABLE');

    const summary: ReconciliationSummary = items.reduce(
      (acc, it) => {
        const key = mapKey(it.classification) as NumericSummaryKey;
        acc[key] += 1;
        return acc;
      },
      {
        systemRecords: internalTxs.length,
        gatewayRecords: gatewayRows.length,
        matched: 0,
        amountMismatch: 0,
        missingInternal: 0,
        missingGateway: 0,
        duplicateReference: 0,
        reversedTxn: 0,
        missingReceipt: 0,
        pendingAttempts: 0,
        failedAttempts: 0,
        unableToVerify: 0,
        providerAvailability: {
          paystack: paystackAvailability,
          alatpay: alatpayAvailability,
        },
        incompleteCoverage,
      } as ReconciliationSummary,
    );

    return {
      summary,
      items,
      effectiveRange: {
        from: effective.from.toISOString(),
        to: effective.to.toISOString(),
        timezone: effective.timezone,
        inclusive: false,
      },
    };
  }

  static async exportReport(params: {
    format: 'csv' | 'json';
    dateFrom: Date;
    dateTo: Date;
    feeId?: number;
    gateway?: PaymentGateway;
    chargeSource?: ChargeSourceFilter;
  }): Promise<{ format: 'csv' | 'json'; payload: string | RunCompareResult; filename: string }> {
    const { summary, items, effectiveRange } = await ReconciliationService.runCompare({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      feeId: params.feeId,
      gateway: params.gateway,
      chargeSource: params.chargeSource ?? 'ALL',
    });

    if (params.format === 'json') {
      return {
        format: 'json',
        payload: { summary, items, effectiveRange },
        filename: `recon-${ts(params.dateFrom)}-${ts(params.dateTo)}.json`,
      };
    }

    const header = [
      'Date',
      'Gateway',
      'Gateway Reference',
      'Provider Reference',
      'Payment Reference',
      'Classification',
      'Verification Method',
      'Provider Available',
      'Charge Source',
      'Assignment #',
      'Expected Amount (NGN)',
      'Actual Amount (NGN)',
      'Variance (NGN)',
      'Student Name',
      'Student ID',
    ];

    const rows: any[][] = items.map((it) => [
      it.date ?? '',
      it.gateway,
      it.gatewayReference ?? '',
      it.providerReference ?? '',
      it.paymentReference ?? '',
      it.classification,
      it.verificationMethod,
      it.providerAvailable === true ? 'YES' : it.providerAvailable === false ? 'NO' : '',
      it.chargeSource ?? '',
      it.assignmentId ?? '',
      it.expectedAmount.toFixed(2),
      it.actualAmount.toFixed(2),
      (it.actualAmount - it.expectedAmount).toFixed(2),
      it.studentName ?? '',
      it.studentId ?? '',
    ]);

    let csvRows: any[][] = [header, ...rows];
    csvRows.push([]);
    csvRows.push(['', '', '', '', '', 'Category Subtotals']);

    const classOrder: Array<[string, keyof ReconciliationSummary]> = [
      ['Matched', 'matched'],
      ['Amount Mismatch', 'amountMismatch'],
      ['Missing Internal', 'missingInternal'],
      ['Missing Gateway', 'missingGateway'],
      ['Duplicate Reference', 'duplicateReference'],
      ['Reversed Transaction', 'reversedTxn'],
      ['Missing Receipt', 'missingReceipt'],
      ['Pending Attempts', 'pendingAttempts'],
      ['Failed Attempts', 'failedAttempts'],
      ['Unable To Verify', 'unableToVerify'],
    ];
    for (const [label, key] of classOrder) {
      csvRows.push(['', '', '', '', '', label, String(summary[key])]);
    }
    csvRows.push([]);
    csvRows.push(['', '', '', '', '', 'Provider Availability']);
    csvRows.push(['', '', '', '', '', 'Paystack', summary.providerAvailability.paystack]);
    csvRows.push(['', '', '', '', '', 'ALATPay', summary.providerAvailability.alatpay]);
    csvRows.push([
      '',
      '',
      '',
      '',
      '',
      'Incomplete Coverage',
      summary.incompleteCoverage ? 'YES' : 'NO',
    ]);
    if (summary.incompleteCoverage) {
      csvRows.push([
        '',
        '',
        '',
        '',
        '',
        'WARNING: Some gateway data is unavailable — reconciliation totals are incomplete.',
      ]);
    }
    csvRows.push([]);
    csvRows.push([
      '',
      '',
      '',
      '',
      '',
      'GRAND TOTAL Items',
      String(items.length),
      '',
      'System Records',
      String(summary.systemRecords),
    ]);
    csvRows.push(['', '', '', '', '', '', '', '', 'Gateway Records', String(summary.gatewayRecords)]);

    const csv = Papa.unparse(csvRows, { delimiter: ',' });
    const filename = `recon-${ts(params.dateFrom)}-${ts(params.dateTo)}.csv`;
    return { format: 'csv', payload: '\uFEFF' + csv, filename };
  }

  static async markReconciled(params: {
    paystackReference: string;
    userId: number;
    notes?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ auditId: number; paystackReference: string }> {
    const audit = await prisma.auditLog.create({
      data: {
        action: 'MARK_RECONCILED',
        entityType: 'RECONCILIATION',
        entityId: String(params.paystackReference),
        userId: params.userId,
        ipAddress: params.ipAddress ? String(params.ipAddress).slice(0, 64) : null,
        userAgent: params.userAgent ? String(params.userAgent).slice(0, 512) : null,
        oldValue: { reconciled: false } as any,
        newValue: {
          reconciled: true,
          notes: params.notes ?? null,
          paystackReference: params.paystackReference,
        } as any,
      },
    });
    return { auditId: audit.id, paystackReference: params.paystackReference };
  }

  static async createInternalFromMissing(params: {
    paystackData?: PaystackTxRow;
    alatpayData?: AlatpayTxRow;
    gatewayData?: { gateway: PaymentGateway; [k: string]: any };
    userId: number;
    ipAddress?: string | null;
    userAgent?: string | null;
    callerRole?: string;
    proofOfPaymentReference?: string;
    confirmedAmount?: number;
    approvalReason?: string;
  }): Promise<{ created: boolean; transactionId: number | null; receiptId: number | null; auditId: number | null }> {
    // TASK H10 Gate 1: ADMIN-only (not BURSARY)
    if (params.callerRole !== 'ADMIN') {
      throw new AppError('ADMIN role is required to forge internal payment records. Bursary must escalate to ADMIN for manual approval.', 403);
    }

    // TASK H10 Gate 2: proof of payment reference + confirmed numeric amount
    const proofRef = String(params.proofOfPaymentReference ?? '').trim();
    if (!proofRef) {
      throw new AppError('proofOfPaymentReference is required for manual internal payment (teller/deposit slip/bank reference).', 400);
    }
    const confirmedAmountRaw = Number(params.confirmedAmount ?? NaN);
    if (!Number.isFinite(confirmedAmountRaw) || confirmedAmountRaw <= 0) {
      throw new AppError('confirmedAmount is required for manual internal payment (numeric positive amount verified against proof document).', 400);
    }

    // TASK H10: Build internal manual approval audit-trail metadata
    const nowIso = new Date().toISOString();
    const approvalMeta = {
      approverId: params.userId,
      approverRole: 'ADMIN',
      timestamp: nowIso,
      reason: String(params.approvalReason ?? '').trim() || 'ADMIN reconciliation MISSING_INTERNAL manual approval',
      proofOfPaymentReference: proofRef,
      confirmedAmount: Number(Number(confirmedAmountRaw).toFixed(2)),
    };
    const gw: PaymentGateway = params.gatewayData?.gateway
      ?? (params.paystackData ? PaymentGateway.PAYSTACK : PaymentGateway.ALATPAY);
    const psData = params.paystackData ?? (gw === PaymentGateway.PAYSTACK ? (params.gatewayData as any) : undefined);
    const alData = params.alatpayData ?? (gw === PaymentGateway.ALATPAY ? (params.gatewayData as any) : undefined);

    let gwRef = '';
    let amountKobo = 0;
    let amountNaira = 0;
    let paidAt: Date = new Date();
    let channel: string | null = null;
    let studentEmail: string | null = null;
    const rawMetadata: Record<string, any> = {};

    if (gw === PaymentGateway.PAYSTACK && psData) {
      gwRef = String(psData.reference ?? '').trim();
      amountKobo = Number(psData.amount ?? 0);
      amountNaira = money(kobo.toNaira(amountKobo));
      paidAt = psData.paid_at
        ? new Date(psData.paid_at)
        : psData.transaction_date
          ? new Date(psData.transaction_date)
          : psData.created_at
            ? new Date(psData.created_at)
            : new Date();
      channel = String(psData.channel ?? '').trim() || null;
      studentEmail = String(psData.customer?.email ?? '').trim() || null;
      rawMetadata.paystack = { ...psData };
    } else if (gw === PaymentGateway.ALATPAY && alData) {
      gwRef = String(alData.Id ?? alData.id ?? alData.transactionId ?? alData.reference ?? alData.orderId ?? '').trim();
      amountNaira = money(Number(alData.Amount ?? alData.amount ?? 0));
      amountKobo = kobo.fromNaira(amountNaira);
      paidAt = alData.UpdatedAt
        ? new Date(alData.UpdatedAt)
        : alData.updatedAt
          ? new Date(alData.updatedAt)
          : alData.CreatedAt
            ? new Date(alData.CreatedAt)
            : alData.created_at
              ? new Date(alData.created_at)
              : new Date();
      channel = String(alData.Channel ?? alData.channel ?? '').trim() || null;
      studentEmail = String(alData.Customer?.Email ?? alData.Customer?.email ?? alData.customer?.email ?? '').trim() || null;
      rawMetadata.alatpay = { ...alData };
    }

    if (!gwRef) {
      throw new AppError('Gateway transaction reference is required', 400);
    }

    const existingWhere: Prisma.TransactionWhereInput = {
      OR: [{ reference: gwRef }],
    };
    if (gw === PaymentGateway.PAYSTACK) {
      existingWhere.OR!.push({ paystackReference: gwRef });
    } else if (gw === PaymentGateway.ALATPAY) {
      existingWhere.OR!.push({ alatpayReference: gwRef });
    }
    const existing = await prisma.transaction.findFirst({
      where: existingWhere,
      select: { id: true },
    });
    if (existing) {
      return { created: false, transactionId: existing.id, receiptId: null, auditId: null };
    }

    const metadata: Prisma.InputJsonValue = {
      reconciliation: {
        source: 'MISSING_INTERNAL',
        createdByUserId: params.userId,
        gateway: gw,
        originalGatewayRef: gwRef,
      },
      internalManualApproval: approvalMeta,
      ...rawMetadata,
    } as any;

    let studentUserId: number | null = null;
    if (studentEmail) {
      const u = await prisma.user.findFirst({
        where: { email: studentEmail },
        select: { id: true, role: true },
      });
      if (u && u.role === 'STUDENT') studentUserId = u.id;
    }
    if (!studentUserId) {
      studentUserId = params.userId;
    }

    const newRef = generatePaymentReference();

    const txData: Prisma.TransactionCreateInput = {
      reference: newRef,
      gateway: gw,
      user: { connect: { id: studentUserId } },
      type: TransactionType.FEE_PAYMENT,
      status: TransactionStatus.SUCCESS,
      expectedAmount: amountNaira,
      amount: amountNaira,
      description: `Auto-created during reconciliation (MISSING_INTERNAL) [${gw}]`,
      createdAt: paidAt,
      metadata,
    };
    if (gw === PaymentGateway.PAYSTACK) {
      txData.paystackReference = gwRef;
      txData.paystackChannel = channel;
    } else if (gw === PaymentGateway.ALATPAY) {
      txData.alatpayReference = gwRef;
    }
    // TASK H10: Attach proof-of-payment ref + confirmed amount on tx row
    (txData as any).proofOfPaymentReference = proofRef;
    if (txData.expectedAmount == null) txData.expectedAmount = Number(Number(confirmedAmountRaw).toFixed(2)) as any;
    if (txData.amount == null) txData.amount = Number(Number(confirmedAmountRaw).toFixed(2)) as any;

    const createdTx = await prisma.transaction.create({ data: txData });

    let receiptId: number | null = null;
    let receiptCounterValue: number | null = null;
    let receiptNumberUsed: string | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        const fiscalYear = String(new Date().getFullYear());
        receiptCounterValue = await (async () => {
          const r = await (tx as any).counter.upsert({
            where: { id: `receipt_seq_${fiscalYear}` },
            update: { value: { increment: 1 } },
            create: { id: `receipt_seq_${fiscalYear}`, value: 1 },
            select: { value: true },
          });
          return Number(r.value ?? 1);
        })();
        const receiptNumber = generateReceiptReference(receiptCounterValue, fiscalYear);
        receiptNumberUsed = receiptNumber;

        const verificationToken = generateVerificationToken();
        const qrUrl = `${process.env.APP_BASE_URL ?? 'http://localhost:3001'}/public/verify-receipt/${verificationToken}`;
        // TASK H12: fee columns structural invariant (base=amountNaira, other fees 0 for manual recon entries)
        const base = Number(Number(confirmedAmountRaw ?? amountNaira).toFixed(2));
        const convenienceFee = 0;
        const serviceChargeRow = 0;
        const gatewayFeeRow = 0;
        const totalAmount = Number((base + convenienceFee + serviceChargeRow + gatewayFeeRow).toFixed(2));
        const receipt = await (tx as any).receipt.create({
          data: {
            receiptNumber,
            verificationToken,
            transaction: { connect: { id: createdTx.id } },
            student: { connect: { id: studentUserId } },
            paidAmount: base,
            convenienceFee,
            serviceCharge: serviceChargeRow,
            gatewayFee: gatewayFeeRow,
            totalAmount,
            paystackReference: gw === PaymentGateway.PAYSTACK ? gwRef : null,
            paymentChannel: channel,
            paidAt,
            qrCodeData: qrUrl,
          },
        });
        receiptId = receipt.id;

        // TASK H10 Gate 3: INTERNAL_PAYMENT_APPROVED audit log entry (entityId=Transaction.id)
        await tx.auditLog.create({
          data: {
            action: 'INTERNAL_PAYMENT_APPROVED',
            entityType: 'TRANSACTION',
            entityId: String(createdTx.id),
            userId: params.userId,
            ipAddress: params.ipAddress ? String(params.ipAddress).slice(0, 64) : null,
            userAgent: params.userAgent ? String(params.userAgent).slice(0, 512) : null,
            oldValue: JSON_DB_NULL,
            newValue: {
              transactionId: createdTx.id,
              receiptId: receipt.id,
              receiptNumber,
              receiptCounterValue,
              gateway: gw,
              gatewayReference: gwRef,
              amount: totalAmount,
              proofOfPaymentReference: proofRef,
              confirmedAmountRaw,
              approvalMeta,
            } as any,
          },
        });
      }, { timeout: 15000 });
    } catch (rxErr) {
      console.warn('[recon:createInternalFromMissing] inner tx failed:', (rxErr as Error)?.message?.slice(0, 200));
      receiptId = null;
    }

    const audit = await prisma.auditLog.create({
      data: {
        action: 'CREATE_INTERNAL',
        entityType: 'RECONCILIATION',
        entityId: String(createdTx.id),
        userId: params.userId,
        ipAddress: params.ipAddress ? String(params.ipAddress).slice(0, 64) : null,
        userAgent: params.userAgent ? String(params.userAgent).slice(0, 512) : null,
        oldValue: JSON_DB_NULL,
        newValue: {
          transactionId: createdTx.id,
          receiptId,
          receiptCounterValue,
          receiptNumber: receiptNumberUsed,
          gateway: gw,
          gatewayReference: gwRef,
          amount: amountNaira,
          proofOfPaymentReference: proofRef,
          approverRole: 'ADMIN',
        } as any,
      },
    });

    return { created: true, transactionId: createdTx.id, receiptId, auditId: audit.id };
  }
}

function mapKey(c: Classification): keyof ReconciliationSummary {
  switch (c) {
    case 'MATCHED':
      return 'matched';
    case 'AMOUNT_MISMATCH':
      return 'amountMismatch';
    case 'MISSING_INTERNAL':
      return 'missingInternal';
    case 'MISSING_GATEWAY':
      return 'missingGateway';
    case 'DUPLICATE_REFERENCE':
      return 'duplicateReference';
    case 'REVERSED_TXN':
      return 'reversedTxn';
    case 'MISSING_RECEIPT':
      return 'missingReceipt';
    case 'PENDING_ATTEMPT':
      return 'pendingAttempts';
    case 'FAILED_ATTEMPT':
      return 'failedAttempts';
    case 'UNABLE_TO_VERIFY':
      return 'unableToVerify';
  }
}

function ts(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export default ReconciliationService;
