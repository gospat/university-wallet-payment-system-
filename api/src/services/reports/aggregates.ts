// =============================================================================
// Bursary Reports — Shared types + server-side aggregates.
// All totals are computed server-side (never in the browser).
// Uses Prisma $queryRaw with parameterized Prisma.sql fragments only.
// H15 sort-injection protection via literal ReadonlySet + SORT_TO_FIELD.
// =============================================================================

import { Prisma, TransactionStatus, GeneralLedgerEntryType, PaymentGateway } from '@prisma/client';
import prisma from '../../config/database';
const prismaAny = prisma as any;

// ---- Money helpers ---------------------------------------------------------
export function money(n: unknown): number {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(2));
}

export function d(n: unknown): number {
  return money(n);
}

// ---- Date helpers ----------------------------------------------------------
export function dateOnly(dIn: Date | string): string {
  const dt = typeof dIn === 'string' ? new Date(dIn) : dIn;
  return dt.toISOString().slice(0, 10);
}

// ---- Shared filter context type --------------------------------------------
export interface ReportFilterCtx {
  dateFrom?: Date;
  dateTo?: Date;
  collegeId?: number;
  departmentId?: number;
  programmeId?: number;
  levelId?: number;
  levelValue?: number;
  level?: number;
  session?: string;
  semester?: 'FIRST' | 'SECOND';
  billCategoryId?: number;
  feeCategoryId?: number;
  billId?: number;
  feeId?: number;
  provider?: PaymentGateway;
  paymentStatus?: TransactionStatus;
  reconciliationStatus?: string;
  studentId?: number;
  studentMatric?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Build the WHERE fragment for SUCCESSFUL + non-voided Receipt-backed txs.
// This is the default status filter for all revenue/collections reports.
// Per spec: exclude PENDING, FAILED, CANCELLED, UNDERPAID, PROCESSING, REVERSED
// unless the report is specifically R17 status or R12 exceptions.
// ---------------------------------------------------------------------------
export const SUCCESS_STATUSES = [
  TransactionStatus.SUCCESS,
] as const;

export type TxnSortKey = 'createdAt' | 'amount' | 'status' | 'reference' | 'studentName' | 'receiptNumber' | 'paidAt' | 'gateway' | 'session' | 'college';
export type TxnOrder = 'asc' | 'desc';
export const TXN_ALLOWED_SORTS: ReadonlySet<TxnSortKey> = new Set<TxnSortKey>([
  'createdAt','amount','status','reference','studentName','receiptNumber','paidAt','gateway','session','college',
]);
export const TXN_ALLOWED_ORDERS: ReadonlySet<TxnOrder> = new Set<TxnOrder>(['asc','desc']);
export const TXN_SORT_TO_FIELD: Record<TxnSortKey, string> = {
  createdAt: 't.createdAt',
  amount: 't.amount',
  status: 't.status',
  reference: 't.reference',
  studentName: 'u.lastName',
  receiptNumber: 'r.receiptNumber',
  paidAt: 'r.paidAt',
  gateway: 't.gateway',
  session: 'i.session',
  college: 'u.college',
};

// ---------------------------------------------------------------------------
// Build the common SQL WHERE (parameterized Prisma.sql) for SUCCESS txs
// that have a non-voided Receipt attached, joined with user/invoice/fee/receipt.
// Handles parameter-name aliasing: routes.ts uses feeCategoryId / feeId / level,
// while historical aggregator code used billCategoryId / billId / levelValue.
// reconciliationStatus requires an extra settlements LEFT JOIN at call-site.
// ---------------------------------------------------------------------------
function buildSuccessReceiptTxCtx(f: ReportFilterCtx): { where: Prisma.Sql; params: any[] } {
  const conds: Prisma.Sql[] = [];
  conds.push(Prisma.sql`t.status IN (${Prisma.raw(Array.from(SUCCESS_STATUSES).map(s => `'${s}'`).join(','))})`);
  conds.push(Prisma.sql`r.isVoided = 0`);
  if (f.dateFrom) conds.push(Prisma.sql`r.paidAt >= ${f.dateFrom}`);
  if (f.dateTo)   conds.push(Prisma.sql`r.paidAt <= ${f.dateTo}`);
  if (f.provider) conds.push(Prisma.sql`t.gateway = ${f.provider}`);
  if (f.studentId) conds.push(Prisma.sql`t.userId = ${f.studentId}`);
  if (f.studentMatric) conds.push(Prisma.sql`u.matricNumber = ${f.studentMatric}`);
  const resolvedBillId = f.billId ?? f.feeId;
  const resolvedCategoryId = f.billCategoryId ?? f.feeCategoryId;
  const resolvedLevel = f.levelValue ?? f.level;
  if (resolvedBillId) conds.push(Prisma.sql`i.feeId = ${resolvedBillId}`);
  if (resolvedCategoryId) conds.push(Prisma.sql`fe.categoryId = ${resolvedCategoryId}`);
  if (f.session) conds.push(Prisma.sql`i.session = ${f.session}`);
  if (f.semester) conds.push(Prisma.sql`i.semester = ${f.semester}`);
  if (resolvedLevel) conds.push(Prisma.sql`fe.level = ${resolvedLevel}`);
  if (f.collegeId) {
    conds.push(Prisma.sql`u.facultyId = ${f.collegeId}`);
  }
  if (f.departmentId) {
    conds.push(Prisma.sql`u.departmentId = ${f.departmentId}`);
  }
  if (f.programmeId) {
    conds.push(Prisma.sql`u.programmeId = ${f.programmeId}`);
  }
  const where = Prisma.join(conds, ' AND ');
  return { where, params: [] };
}

// Helper to build extra reconciliationStatus fragment (caller must LEFT JOIN settlements s ON s.transactionId=t.id)
export function buildReconciliationStatusFilter(f: ReportFilterCtx): Prisma.Sql | null {
  if (!f.reconciliationStatus) return null;
  return Prisma.sql`COALESCE(s.status, 'PENDING_SETTLEMENT') = ${f.reconciliationStatus}`;
}

// ---------------------------------------------------------------------------
// R1 — Dashboard 12 summary cards.
// ---------------------------------------------------------------------------
export async function dashboardSummaryCards(f: ReportFilterCtx) {
  const { where } = buildSuccessReceiptTxCtx(f);
  const sql = Prisma.sql`
    SELECT
      COUNT(DISTINCT t.id)                                    AS txCount,
      COUNT(DISTINCT t.userId)                               AS uniquePayers,
      COALESCE(SUM(r.paidAmount),0)                          AS totalCollected,
      COALESCE(AVG(r.paidAmount),0)                          AS avgPayment,
      COALESCE(SUM(CASE WHEN t.gateway='PAYSTACK'  THEN r.paidAmount ELSE 0 END),0) AS paystackCollected,
      COALESCE(SUM(CASE WHEN t.gateway='ALATPAY'   THEN r.paidAmount ELSE 0 END),0) AS alatpayCollected,
      COALESCE(SUM(r.convenienceFee),0)                      AS convenienceFee,
      COALESCE(SUM(r.serviceCharge),0)                       AS serviceCharge,
      COALESCE(SUM(r.gatewayFee),0)                          AS gatewayFee
    FROM transactions t
      INNER JOIN receipts r        ON r.transactionId = t.id
      INNER JOIN users u           ON u.id = t.userId
      LEFT  JOIN invoices i        ON i.id = t.invoiceId
      LEFT  JOIN fees fe           ON fe.id = i.feeId
    WHERE ${where}
  `;
  const rows = await prisma.$queryRaw<[{
    txCount: string | number; uniquePayers: string | number;
    totalCollected: string | number; avgPayment: string | number;
    paystackCollected: string | number; alatpayCollected: string | number;
    convenienceFee: string | number; serviceCharge: string | number; gatewayFee: string | number;
  }][]>(sql) as unknown as Array<{
    txCount: string | number; uniquePayers: string | number;
    totalCollected: string | number; avgPayment: string | number;
    paystackCollected: string | number; alatpayCollected: string | number;
    convenienceFee: string | number; serviceCharge: string | number; gatewayFee: string | number;
  }>;
  const base = Array.isArray(rows) && rows.length > 0 ? rows[0] : {} as any;

  // Refunds COMPLETED only (per spec: Net = grossSuccessCollected − refundedIssued where refund COMPLETED/PAID)
  const refundWhere: Prisma.Sql[] = [Prisma.sql`rf.status = 'PAID'`];
  if (f.dateFrom) refundWhere.push(Prisma.sql`rf.updatedAt >= ${f.dateFrom}`);
  if (f.dateTo)   refundWhere.push(Prisma.sql`rf.updatedAt <= ${f.dateTo}`);
  const refundSql = Prisma.sql`
    SELECT COALESCE(SUM(rf.requestedAmount),0) AS refunded
    FROM refunds rf
    WHERE ${Prisma.join(refundWhere, ' AND ')}
  `;
  const rRows = await prisma.$queryRaw<[{ refunded: string | number }][]>(refundSql) as unknown as Array<{ refunded: string | number }>;
  const refunds = d(Array.isArray(rRows) && rRows.length > 0 ? rRows[0].refunded : 0);

  // Reconciliation: count SUCCESS txs that are matched vs unmatched via receipts existence + nonvoided
  // Reconciled = SUCCESS tx with Receipt that has R11 settlement MATCHED / SETTLED status
  const reconConds: Prisma.Sql[] = [where];
  const extraRecon = buildReconciliationStatusFilter(f);
  if (extraRecon) reconConds.push(extraRecon);
  const reconWhere = Prisma.join(reconConds, ' AND ');
  const reconSql = Prisma.sql`
    SELECT
      SUM(CASE WHEN s.status IN ('MATCHED','SETTLED','PARTIALLY_MATCHED') THEN 1 ELSE 0 END) AS reconciledCount,
      SUM(CASE WHEN s.status IN ('MATCHED','SETTLED','PARTIALLY_MATCHED') THEN r.paidAmount ELSE 0 END) AS reconciledAmt,
      SUM(CASE WHEN s.status IS NULL OR s.status IN ('PENDING_SETTLEMENT','VARIANCE','UNMATCHED','UNDER_REVIEW') THEN 1 ELSE 0 END) AS unreconciledCount,
      SUM(CASE WHEN s.status IS NULL OR s.status IN ('PENDING_SETTLEMENT','VARIANCE','UNMATCHED','UNDER_REVIEW') THEN r.paidAmount ELSE 0 END) AS unreconciledAmt
    FROM transactions t
      INNER JOIN receipts r ON r.transactionId = t.id
      LEFT  JOIN settlements s ON s.transactionId = t.id
    WHERE ${reconWhere}
  `;
  const rcon = await prisma.$queryRaw<Array<{
    reconciledCount: string|number; reconciledAmt: string|number;
    unreconciledCount: string|number; unreconciledAmt: string|number;
  }>>(reconSql);
  const reconRow = Array.isArray(rcon) && rcon.length > 0 ? rcon[0] : {} as any;

  const gross = d(base.totalCollected);
  const net = d(gross - refunds);
  return {
    totalCollected: gross,
    numSuccessfulPayments: Number(base.txCount ?? 0),
    uniquePayers: Number(base.uniquePayers ?? 0),
    avgPayment: d(base.avgPayment),
    paystackCollected: d(base.paystackCollected),
    alatpayCollected: d(base.alatpayCollected),
    convenienceFee: d(base.convenienceFee),
    serviceCharge: d(base.serviceCharge),
    gatewayFees: d(base.gatewayFee),
    refunds,
    netCollection: net,
    reconciledAmount: d(reconRow.reconciledAmt),
    reconciledCount: Number(reconRow.reconciledCount ?? 0),
    unreconciledAmount: d(reconRow.unreconciledAmt),
    unreconciledCount: Number(reconRow.unreconciledCount ?? 0),
  };
}

// ---------------------------------------------------------------------------
// R2 — Daily Collection Report
// ---------------------------------------------------------------------------
export async function dailyCollections(f: ReportFilterCtx) {
  const { where } = buildSuccessReceiptTxCtx(f);
  const sql = Prisma.sql`
    SELECT
      agg.day                                              AS day,
      agg.txCount                                          AS txCount,
      agg.studentCount                                     AS studentCount,
      agg.gross                                            AS gross,
      agg.convenienceFee                                   AS convenienceFee,
      agg.serviceCharge                                    AS serviceCharge,
      agg.gatewayFee                                       AS gatewayFee,
      agg.total                                            AS total,
      COALESCE(ref.refunds,0)                              AS refunds,
      agg.total - COALESCE(ref.refunds,0)                  AS net
    FROM (
      SELECT
        DATE(r.paidAt)                                            AS day,
        COUNT(DISTINCT t.id)                                      AS txCount,
        COUNT(DISTINCT t.userId)                                  AS studentCount,
        COALESCE(SUM(r.paidAmount),0)                             AS gross,
        COALESCE(SUM(r.convenienceFee),0)                         AS convenienceFee,
        COALESCE(SUM(r.serviceCharge),0)                          AS serviceCharge,
        COALESCE(SUM(r.gatewayFee),0)                             AS gatewayFee,
        COALESCE(SUM(r.paidAmount + r.convenienceFee + r.serviceCharge + r.gatewayFee),0) AS total
      FROM transactions t
        INNER JOIN receipts r ON r.transactionId = t.id
        INNER JOIN users u    ON u.id = t.userId
        LEFT  JOIN invoices i ON i.id = t.invoiceId
        LEFT  JOIN fees fe    ON fe.id = i.feeId
      WHERE ${where}
      GROUP BY DATE(r.paidAt)
    ) agg
    LEFT JOIN (
      SELECT DATE(rf.updatedAt) AS refundDay, COALESCE(SUM(rf.requestedAmount),0) AS refunds
      FROM refunds rf
      WHERE rf.status = 'PAID'
      GROUP BY DATE(rf.updatedAt)
    ) ref ON ref.refundDay = agg.day
    ORDER BY agg.day DESC
  `;
  const rows = await prisma.$queryRaw<any[]>(sql);
  return (Array.isArray(rows) ? rows : []).map((r: any) => ({
    day: dateOnly(r.day),
    txCount: Number(r.txCount ?? 0),
    studentCount: Number(r.studentCount ?? 0),
    gross: d(r.gross),
    convenienceFee: d(r.convenienceFee),
    serviceCharge: d(r.serviceCharge),
    gatewayFee: d(r.gatewayFee),
    refunds: d(r.refunds),
    net: d(r.net),
    totalCharges: d(Number(r.total ?? 0) - d(r.gross)),
  }));
}

// ---------------------------------------------------------------------------
// R3 — Monthly Collection Report (aggregated)
// ---------------------------------------------------------------------------
export async function monthlyCollections(f: ReportFilterCtx) {
  const { where } = buildSuccessReceiptTxCtx(f);
  const sql = Prisma.sql`
    SELECT
      agg.month                                              AS month,
      agg.monthStart                                         AS monthStart,
      agg.txCount                                            AS txCount,
      agg.uniquePayers                                       AS uniquePayers,
      agg.gross                                              AS gross,
      agg.charges                                            AS charges,
      agg.gatewayFee                                         AS gatewayFee,
      agg.convenienceFee                                     AS convenienceFee,
      agg.serviceCharge                                      AS serviceCharge,
      COALESCE(ref.refunds,0)                                AS refunds,
      (agg.gross + agg.charges) - COALESCE(ref.refunds,0)    AS net
    FROM (
      SELECT
        DATE_FORMAT(r.paidAt, '%Y-%m')                           AS month,
        MIN(DATE(r.paidAt))                                      AS monthStart,
        COUNT(DISTINCT t.id)                                     AS txCount,
        COUNT(DISTINCT t.userId)                                 AS uniquePayers,
        COALESCE(SUM(r.paidAmount),0)                            AS gross,
        COALESCE(SUM(r.convenienceFee + r.serviceCharge + r.gatewayFee),0) AS charges,
        COALESCE(SUM(r.gatewayFee),0)                            AS gatewayFee,
        COALESCE(SUM(r.convenienceFee),0)                        AS convenienceFee,
        COALESCE(SUM(r.serviceCharge),0)                         AS serviceCharge
      FROM transactions t
        INNER JOIN receipts r ON r.transactionId = t.id
        INNER JOIN users u    ON u.id = t.userId
        LEFT  JOIN invoices i ON i.id = t.invoiceId
        LEFT  JOIN fees fe    ON fe.id = i.feeId
      WHERE ${where}
      GROUP BY DATE_FORMAT(r.paidAt, '%Y-%m')
    ) agg
    LEFT JOIN (
      SELECT DATE_FORMAT(rf.updatedAt, '%Y-%m') AS refundMonth, COALESCE(SUM(rf.requestedAmount),0) AS refunds
      FROM refunds rf
      WHERE rf.status = 'PAID'
      GROUP BY DATE_FORMAT(rf.updatedAt, '%Y-%m')
    ) ref ON ref.refundMonth = agg.month
    ORDER BY agg.month DESC
  `;
  const rows = await prisma.$queryRaw<any[]>(sql);
  return (Array.isArray(rows) ? rows : []).map((r: any) => ({
    month: String(r.month),
    monthStart: dateOnly(r.monthStart),
    txCount: Number(r.txCount ?? 0),
    uniquePayers: Number(r.uniquePayers ?? 0),
    gross: d(r.gross),
    charges: d(r.charges),
    convenienceFee: d(r.convenienceFee),
    serviceCharge: d(r.serviceCharge),
    gatewayFee: d(r.gatewayFee),
    refunds: d(r.refunds),
    net: d(r.net),
  }));
}

// ---------------------------------------------------------------------------
// R3b — Monthly Payers Register drilldown (paginated raw rows for a month)
// ---------------------------------------------------------------------------
export async function monthlyPayersRegister(f: ReportFilterCtx & { month?: string }) {
  const { where } = buildSuccessReceiptTxCtx(f);
  const whereList: Prisma.Sql[] = [where];
  if (f.month) whereList.push(Prisma.sql`DATE_FORMAT(r.paidAt, '%Y-%m') = ${f.month}`);
  const finalWhere = Prisma.join(whereList, ' AND ');
  const page = Math.max(1, Number(f.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Number(f.pageSize ?? 50)));
  const skip = (page - 1) * pageSize;
  const rowsSql = Prisma.sql`
    SELECT
      r.paidAt                                           AS paymentDt,
      CONCAT(u.firstName, ' ', IF(u.middleName IS NULL OR u.middleName='', '', CONCAT(u.middleName, ' ')), u.lastName) AS student,
      u.matricNumber                                     AS matric,
      u.college                                          AS college,
      u.department                                       AS dept,
      u.program                                          AS prog,
      u.level                                            AS level,
      i.session                                          AS session,
      t.reference                                        AS paymentRef,
      CASE WHEN t.gateway='PAYSTACK' THEN t.paystackReference ELSE t.alatpayReference END AS gatewayRef,
      fe.name                                            AS bill,
      r.paidAmount                                       AS amount,
      r.convenienceFee                                   AS convFee,
      r.serviceCharge                                    AS svcFee,
      r.gatewayFee                                       AS gwFee,
      r.totalAmount                                      AS totalPaid,
      t.gateway                                          AS provider,
      t.status                                           AS status,
      r.receiptNumber                                    AS receiptNo
    FROM transactions t
      INNER JOIN receipts r ON r.transactionId = t.id
      INNER JOIN users u    ON u.id = t.userId
      LEFT  JOIN invoices i ON i.id = t.invoiceId
      LEFT  JOIN fees fe    ON fe.id = i.feeId
    WHERE ${finalWhere}
    ORDER BY r.paidAt DESC
    LIMIT ${pageSize} OFFSET ${skip}
  `;
  const countSql = Prisma.sql`SELECT COUNT(DISTINCT t.id) AS cnt
    FROM transactions t INNER JOIN receipts r ON r.transactionId = t.id INNER JOIN users u ON u.id = t.userId
    LEFT JOIN invoices i ON i.id = t.invoiceId LEFT JOIN fees fe ON fe.id = i.feeId WHERE ${finalWhere}`;
  const [rowsRaw, cntRaw] = await Promise.all([
    prisma.$queryRaw<any[]>(rowsSql),
    prisma.$queryRaw<[{ cnt: string|number }][]>(countSql),
  ]);
  const rows = (Array.isArray(rowsRaw) ? rowsRaw : []).map((r: any) => ({
    paymentDt: r.paymentDt ? new Date(r.paymentDt).toISOString() : null,
    student: String(r.student ?? ''),
    matric: String(r.matric ?? ''),
    college: String(r.college ?? ''),
    dept: String(r.dept ?? ''),
    prog: String(r.prog ?? ''),
    level: r.level ?? null,
    session: String(r.session ?? ''),
    paymentRef: String(r.paymentRef ?? ''),
    gatewayRef: r.gatewayRef ? String(r.gatewayRef) : '',
    bill: String(r.bill ?? ''),
    amount: d(r.amount),
    convFee: d(r.convFee),
    svcFee: d(r.svcFee),
    gwFee: d(r.gwFee),
    totalPaid: d(r.totalPaid),
    provider: String(r.provider ?? ''),
    status: String(r.status ?? ''),
    receiptNo: String(r.receiptNo ?? ''),
  }));
  const total = Number(Array.isArray(cntRaw) && cntRaw.length > 0 ? (cntRaw as any)[0]?.cnt ?? 0 : 0);
  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

// ---------------------------------------------------------------------------
// R4 — Revenue by Bill
// Expected Amount = SUM(active invoice.amountDue) for assigned bill/fee.
// Returns: expectedAmount, collectionPercent (per spec naming).
// ---------------------------------------------------------------------------
export async function revenueByBill(f: ReportFilterCtx) {
  const { where } = buildSuccessReceiptTxCtx(f);
  const resolvedCategoryId = f.billCategoryId ?? f.feeCategoryId;
  const resolvedBillId = f.billId ?? f.feeId;
  const resolvedLevel = f.levelValue ?? f.level;
  const sql = Prisma.sql`
    SELECT
      fe.id                                                                AS billId,
      fe.name                                                              AS revenueItem,
      fe.feeCode                                                           AS feeCode,
      fc.name                                                              AS categoryName,
      i.session                                                            AS session,
      COALESCE((
        SELECT SUM(iv.amountDue) FROM invoices iv
        WHERE iv.feeId = fe.id
          AND (${f.dateFrom ? Prisma.sql`iv.createdAt >= ${f.dateFrom}` : Prisma.sql`1=1`})
          AND (${f.dateTo   ? Prisma.sql`iv.createdAt <= ${f.dateTo}`   : Prisma.sql`1=1`})
          AND (${f.session  ? Prisma.sql`iv.session = ${f.session}`     : Prisma.sql`1=1`})
          AND (${f.semester ? Prisma.sql`iv.semester = ${f.semester}`   : Prisma.sql`1=1`})
      ),0) AS expectedAmt,
      COUNT(DISTINCT t.userId)                                            AS numPayers,
      COUNT(DISTINCT t.id)                                                AS numTxs,
      COALESCE(SUM(r.paidAmount),0)                                       AS collected
    FROM fees fe
      LEFT JOIN invoices i   ON i.feeId = fe.id
      LEFT JOIN transactions t ON t.invoiceId = i.id
      LEFT JOIN receipts r   ON r.transactionId = t.id
      LEFT JOIN users u      ON u.id = t.userId
      LEFT JOIN fee_categories fc ON fc.id = fe.categoryId
    WHERE
      fe.isActive = 1
      AND (${resolvedCategoryId ? Prisma.sql`fe.categoryId = ${resolvedCategoryId}` : Prisma.sql`1=1`})
      AND (${resolvedBillId ? Prisma.sql`fe.id = ${resolvedBillId}` : Prisma.sql`1=1`})
      AND (${resolvedLevel ? Prisma.sql`fe.level = ${resolvedLevel}` : Prisma.sql`1=1`})
      AND (
        (${Prisma.join([
          Prisma.sql`t.status = 'SUCCESS'`,
          Prisma.sql`r.isVoided = 0`,
          where,
        ], ' AND ')})
        OR t.id IS NULL
      )
    GROUP BY fe.id, fe.name, fe.feeCode, fc.name, i.session
    ORDER BY collected DESC
  `;
  const rows = await prisma.$queryRaw<any[]>(sql);
  return (Array.isArray(rows) ? rows : []).map((r: any) => {
    const expected = d(r.expectedAmt);
    const collected = d(r.collected);
    const outstanding = d(Math.max(0, expected - collected));
    const collectionPct = expected > 0 ? Number(((collected / expected) * 100).toFixed(2)) : 0;
    return {
      billId: Number(r.billId),
      revenueItem: String(r.revenueItem ?? ''),
      feeCode: String(r.feeCode ?? ''),
      categoryName: String(r.categoryName ?? ''),
      session: r.session ? String(r.session) : '',
      numPayers: Number(r.numPayers ?? 0),
      expectedAmt: expected,
      expectedAmount: expected,
      collected,
      outstanding,
      collectionPct,
      collectionPercent: collectionPct,
    };
  }).filter(r => r.collected > 0 || r.expectedAmt > 0);
}

// ---------------------------------------------------------------------------
// R5 — Master Payment Register (paginated drilldown + summary)
// ---------------------------------------------------------------------------
export async function paymentRegister(
  f: ReportFilterCtx & { sort?: TxnSortKey; order?: TxnOrder }
): Promise<{
  summary: { gross: number; convFee: number; svcFee: number; gwFee: number; total: number; txCount: number; uniquePayers: number; refunds: number; net: number };
  rows: any[]; total: number; page: number; pageSize: number; totalPages: number;
}> {
  const sort: TxnSortKey = TXN_ALLOWED_SORTS.has(f.sort as TxnSortKey) ? (f.sort as TxnSortKey) : 'paidAt';
  const order: TxnOrder = TXN_ALLOWED_ORDERS.has(f.order as TxnOrder) ? (f.order as TxnOrder) : 'desc';
  const sortField = TXN_SORT_TO_FIELD[sort];
  const { where } = buildSuccessReceiptTxCtx(f);
  const page = Math.max(1, Number(f.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Number(f.pageSize ?? 50)));
  const skip = (page - 1) * pageSize;

  // Search filter (R5 spec: matric / studentName / receiptNo / txRef / gatewayRef)
  let searchWhere = where;
  if (f.q && String(f.q).trim().length > 0) {
    const q = `%${String(f.q).trim()}%`;
    searchWhere = Prisma.join([
      where,
      Prisma.sql`(
        u.matricNumber LIKE ${q} OR
        CONCAT(u.firstName, ' ', u.lastName) LIKE ${q} OR
        r.receiptNumber LIKE ${q} OR
        t.reference LIKE ${q} OR
        t.paystackReference LIKE ${q} OR
        t.alatpayReference LIKE ${q}
      )`,
    ], ' AND ');
  }

  const summarySql = Prisma.sql`
    SELECT
      COUNT(DISTINCT t.id)                        AS txCount,
      COUNT(DISTINCT t.userId)                    AS uniquePayers,
      COALESCE(SUM(r.paidAmount),0)               AS gross,
      COALESCE(SUM(r.convenienceFee),0)           AS convFee,
      COALESCE(SUM(r.serviceCharge),0)            AS svcFee,
      COALESCE(SUM(r.gatewayFee),0)               AS gwFee,
      COALESCE(SUM(r.totalAmount),0)              AS total
    FROM transactions t
      INNER JOIN receipts r ON r.transactionId = t.id
      INNER JOIN users u    ON u.id = t.userId
      LEFT  JOIN invoices i ON i.id = t.invoiceId
      LEFT  JOIN fees fe    ON fe.id = i.feeId
    WHERE ${searchWhere}
  `;
  // Refunds sum for same filter range (COMPLETED only)
  const refundWhere: Prisma.Sql[] = [Prisma.sql`rf.status = 'PAID'`];
  if (f.dateFrom) refundWhere.push(Prisma.sql`rf.updatedAt >= ${f.dateFrom}`);
  if (f.dateTo)   refundWhere.push(Prisma.sql`rf.updatedAt <= ${f.dateTo}`);
  const refundSql = Prisma.sql`SELECT COALESCE(SUM(rf.requestedAmount),0) AS amount FROM refunds rf WHERE ${Prisma.join(refundWhere, ' AND ')}`;

  const rowsSql = Prisma.sql`
    SELECT
      t.id AS txId, t.reference, t.gateway AS provider, t.status, t.type,
      t.paystackReference, t.alatpayReference, t.createdAt,
      r.receiptNumber, r.paidAt, r.paidAmount AS baseAmount, r.convenienceFee, r.serviceCharge, r.gatewayFee, r.totalAmount, r.isVoided,
      u.id AS userId, u.firstName, u.lastName, u.middleName, u.matricNumber, u.email, u.college, u.department, u.program, u.level,
      i.id AS invoiceId, i.invoiceNumber, i.session, i.semester, i.status AS invoiceStatus,
      fe.id AS feeId, fe.name AS feeName, fe.feeCode,
      fc.name AS categoryName
    FROM transactions t
      INNER JOIN receipts r ON r.transactionId = t.id
      INNER JOIN users u    ON u.id = t.userId
      LEFT  JOIN invoices i ON i.id = t.invoiceId
      LEFT  JOIN fees fe    ON fe.id = i.feeId
      LEFT  JOIN fee_categories fc ON fc.id = fe.categoryId
    WHERE ${searchWhere}
    ORDER BY ${Prisma.raw(sortField)} ${Prisma.raw(order.toUpperCase())}
    LIMIT ${pageSize} OFFSET ${skip}
  `;
  const countSql = Prisma.sql`SELECT COUNT(DISTINCT t.id) AS cnt
    FROM transactions t INNER JOIN receipts r ON r.transactionId = t.id INNER JOIN users u ON u.id = t.userId
    LEFT JOIN invoices i ON i.id = t.invoiceId LEFT JOIN fees fe ON fe.id = i.feeId WHERE ${searchWhere}`;

  const [sRaw, rRaw, cRaw, rfRaw] = await Promise.all([
    prisma.$queryRaw<Array<{txCount:any;uniquePayers:any;gross:any;convFee:any;svcFee:any;gwFee:any;total:any}>>(summarySql),
    prisma.$queryRaw<any[]>(rowsSql),
    prisma.$queryRaw<[{cnt:any}][]>(countSql),
    prisma.$queryRaw<[{amount:any}][]>(refundSql),
  ]);
  const s0 = Array.isArray(sRaw) && sRaw.length > 0 ? sRaw[0] : {} as any;
  const refunds = d(Array.isArray(rfRaw) && rfRaw.length > 0 ? (rfRaw as any)[0]?.amount : 0);
  const gross = d(s0.gross);
  const rows = (Array.isArray(rRaw) ? rRaw : []).map((r: any) => ({
    txId: Number(r.txId),
    reference: String(r.reference ?? ''),
    provider: String(r.provider ?? ''),
    status: String(r.status ?? ''),
    type: String(r.type ?? ''),
    paystackReference: r.paystackReference ?? null,
    alatpayReference: r.alatpayReference ?? null,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    receiptNumber: String(r.receiptNumber ?? ''),
    paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
    baseAmount: d(r.baseAmount),
    convenienceFee: d(r.convenienceFee),
    serviceCharge: d(r.serviceCharge),
    gatewayFee: d(r.gatewayFee),
    totalAmount: d(r.totalAmount),
    isVoided: !!r.isVoided,
    student: {
      id: Number(r.userId),
      name: [r.firstName, r.middleName, r.lastName].filter(Boolean).join(' '),
      firstName: r.firstName, lastName: r.lastName, middleName: r.middleName ?? null,
      matricNumber: r.matricNumber ?? null,
      email: r.email ?? null,
      college: r.college ?? null, department: r.department ?? null, program: r.program ?? null, level: r.level ?? null,
    },
    invoice: r.invoiceId ? {
      id: Number(r.invoiceId),
      invoiceNumber: r.invoiceNumber ?? '',
      session: r.session ?? '',
      semester: r.semester ?? null,
      status: r.invoiceStatus ?? '',
    } : null,
    fee: r.feeId ? {
      id: Number(r.feeId), name: r.feeName ?? '', feeCode: r.feeCode ?? '', categoryName: r.categoryName ?? '',
    } : null,
  }));
  const total = Number(Array.isArray(cRaw) && cRaw.length > 0 ? (cRaw as any)[0]?.cnt ?? 0 : 0);
  return {
    summary: {
      gross, convFee: d(s0.convFee), svcFee: d(s0.svcFee), gwFee: d(s0.gwFee),
      total: d(s0.total),
      txCount: Number(s0.txCount ?? 0),
      uniquePayers: Number(s0.uniquePayers ?? 0),
      refunds,
      net: d(gross - refunds),
    },
    rows, total, page, pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---------------------------------------------------------------------------
// R6 — Individual Student Statement (by matric or studentId)
// ---------------------------------------------------------------------------
export async function studentStatement(f: ReportFilterCtx & { matricNumber?: string }) {
  // Resolve student
  const studentWhere: Prisma.Sql[] = [Prisma.sql`u.role='STUDENT'`];
  if (f.studentId) studentWhere.push(Prisma.sql`u.id = ${f.studentId}`);
  else if (f.matricNumber) studentWhere.push(Prisma.sql`u.matricNumber = ${f.matricNumber}`);
  else if (f.studentMatric) studentWhere.push(Prisma.sql`u.matricNumber = ${f.studentMatric}`);
  else throw new Error('studentId or matricNumber is required');

  const stuSql = Prisma.sql`
    SELECT u.id, u.firstName, u.lastName, u.middleName, u.matricNumber, u.email,
           u.college, u.department, u.program, u.level, u.accountStatus,
           u.studentType, u.academicSession, u.jambNumber, u.admissionNumber
    FROM users u WHERE ${Prisma.join(studentWhere, ' AND ')} LIMIT 1
  `;
  const stuRows = await prisma.$queryRaw<any[]>(stuSql);
  if (!Array.isArray(stuRows) || stuRows.length === 0) return { student: null as any, financialSummary: null as any, ledger: [] as any[] };
  const student = {
    id: Number(stuRows[0].id),
    name: [stuRows[0].firstName, stuRows[0].middleName, stuRows[0].lastName].filter(Boolean).join(' '),
    firstName: stuRows[0].firstName,
    lastName: stuRows[0].lastName,
    middleName: stuRows[0].middleName ?? null,
    matricNumber: stuRows[0].matricNumber ?? null,
    email: stuRows[0].email ?? null,
    college: stuRows[0].college ?? null,
    department: stuRows[0].department ?? null,
    program: stuRows[0].program ?? null,
    level: stuRows[0].level ?? null,
    accountStatus: stuRows[0].accountStatus ?? null,
    studentType: stuRows[0].studentType ?? null,
    academicSession: stuRows[0].academicSession ?? null,
    jambNumber: stuRows[0].jambNumber ?? null,
    admissionNumber: stuRows[0].admissionNumber ?? null,
  };
  const sid = student.id;

  // Financial summary: billsAssigned, billed, paid, wallet, outstanding, refunds, totalCharges
  const sumSql = Prisma.sql`
    SELECT
      (SELECT COUNT(*) FROM invoices WHERE studentId=${sid})                                 AS billsAssigned,
      COALESCE((SELECT SUM(amountDue)  FROM invoices WHERE studentId=${sid}),0)               AS billed,
      COALESCE((SELECT SUM(amountPaid) FROM invoices WHERE studentId=${sid}),0)               AS paidInvoices,
      COALESCE((
        SELECT SUM(r.paidAmount) FROM receipts r
          INNER JOIN transactions t ON t.id = r.transactionId
        WHERE r.studentId=${sid} AND r.isVoided=0 AND t.status='SUCCESS'
      ),0)                                                                                     AS paid,
      COALESCE((SELECT SUM(requestedAmount) FROM refunds rf
        INNER JOIN transactions t ON t.id = rf.originalTransactionId
        WHERE t.userId=${sid} AND rf.status='PAID'),0)                                        AS refunds,
      COALESCE((
        SELECT SUM(r.convenienceFee + r.serviceCharge) FROM receipts r
          INNER JOIN transactions t ON t.id = r.transactionId
        WHERE r.studentId=${sid} AND r.isVoided=0 AND t.status='SUCCESS'
      ),0)                                                                                     AS totalCharges
  `;
  const sRows = await prisma.$queryRaw<any[]>(sumSql);
  const s0 = Array.isArray(sRows) && sRows.length > 0 ? sRows[0] : {} as any;
  const billed = d(s0.billed);
  const paid = d(s0.paid);
  const refunds = d(s0.refunds);
  const financialSummary = {
    billsAssigned: Number(s0.billsAssigned ?? 0),
    billed,
    paid,
    wallet: 0, // wallet model not in v1 schema
    outstanding: d(Math.max(0, billed - paid)),
    refunds,
    totalCharges: d(s0.totalCharges),
  };

  // Ledger rows chronological: bills + payments + refunds as double-entry-style chronological rows
  // date | desc | bill | debit | credit | balance | ref | receipt
  const ledgerSql = Prisma.sql`
    (SELECT
      i.createdAt                                             AS sortDate,
      'INVOICE'                                               AS kind,
      CONCAT('Bill issued: ', fe.name)                        AS description,
      fe.name                                                 AS bill,
      i.amountDue                                             AS debit,
      0                                                       AS credit,
      CONCAT('INV-', i.invoiceNumber)                         AS ref,
      NULL                                                    AS receipt
     FROM invoices i LEFT JOIN fees fe ON fe.id = i.feeId
     WHERE i.studentId = ${sid})
    UNION ALL
    (SELECT
      r.paidAt                                                AS sortDate,
      'PAYMENT'                                               AS kind,
      CONCAT('Payment via ', t.gateway)                       AS description,
      fe.name                                                 AS bill,
      0                                                       AS debit,
      r.paidAmount                                            AS credit,
      t.reference                                             AS ref,
      r.receiptNumber                                         AS receipt
     FROM receipts r
       INNER JOIN transactions t ON t.id = r.transactionId
       LEFT JOIN invoices i ON i.id = r.invoiceId
       LEFT JOIN fees fe ON fe.id = i.feeId
     WHERE r.studentId=${sid} AND r.isVoided=0 AND t.status='SUCCESS')
    UNION ALL
    (SELECT
      rf.updatedAt                                           AS sortDate,
      'REFUND'                                               AS kind,
      CONCAT('Refund: ', LEFT(rf.reason,80))                 AS description,
      NULL                                                   AS bill,
      rf.requestedAmount                                     AS debit,
      0                                                      AS credit,
      rf.refundNumber                                        AS ref,
      NULL                                                   AS receipt
     FROM refunds rf INNER JOIN transactions t ON t.id = rf.originalTransactionId
     WHERE t.userId=${sid} AND rf.status='PAID')
    ORDER BY sortDate ASC
  `;
  const rawLedger = await prisma.$queryRaw<any[]>(ledgerSql);
  let running = 0;
  const ledger = (Array.isArray(rawLedger) ? rawLedger : []).map((r: any) => {
    const debit = d(r.debit);
    const credit = d(r.credit);
    running = d(running + debit - credit);
    return {
      date: r.sortDate ? new Date(r.sortDate).toISOString() : null,
      kind: String(r.kind),
      description: String(r.description ?? ''),
      bill: r.bill ? String(r.bill) : null,
      debit,
      credit,
      balance: running,
      ref: r.ref ? String(r.ref) : null,
      receipt: r.receipt ? String(r.receipt) : null,
    };
  });
  return { student, financialSummary, ledger };
}

// ---------------------------------------------------------------------------
// R7 — Bill Collection Performance (11+ columns per spec)
// Columns: BillId, Bill name, Category, Session, Semester, Students Assigned,
//          Expected Revenue, Students Paid in Full, Students Partially Paid,
//          Students Unpaid, Amount Collected, Outstanding Amount, Collection %
// ---------------------------------------------------------------------------
export async function billCollectionPerformance(f: ReportFilterCtx) {
  const resolvedCategoryId = f.billCategoryId ?? f.feeCategoryId;
  const resolvedBillId = f.billId ?? f.feeId;
  const resolvedLevel = f.levelValue ?? f.level;
  const sql = Prisma.sql`
    SELECT
      fe.id                                                   AS billId,
      fe.name                                                 AS billName,
      fe.feeCode,
      fc.name                                                 AS category,
      i.session,
      i.semester,
      COUNT(DISTINCT i.id)                                    AS assigned,
      COALESCE(SUM(i.amountDue),0)                            AS expected,
      COUNT(DISTINCT CASE WHEN i.status='PAID' THEN i.id END)          AS fullyPaidCount,
      COUNT(DISTINCT CASE WHEN i.status='PARTIALLY_PAID' THEN i.id END) AS partiallyPaidCount,
      COUNT(DISTINCT CASE WHEN i.status='UNPAID' THEN i.id END)        AS unpaidCount,
      COALESCE(SUM(i.amountPaid),0)                           AS collected,
      COALESCE(SUM(i.amountDue - i.amountPaid),0)             AS outstanding
    FROM fees fe
      LEFT JOIN invoices i ON i.feeId = fe.id
      LEFT JOIN users u      ON u.id = i.studentId
      LEFT JOIN fee_categories fc ON fc.id = fe.categoryId
    WHERE fe.isActive = 1
      AND (${f.session ? Prisma.sql`i.session = ${f.session}` : Prisma.sql`1=1`})
      AND (${f.semester ? Prisma.sql`i.semester = ${f.semester}` : Prisma.sql`1=1`})
      AND (${f.dateFrom ? Prisma.sql`i.createdAt >= ${f.dateFrom}` : Prisma.sql`1=1`})
      AND (${f.dateTo   ? Prisma.sql`i.createdAt <= ${f.dateTo}`   : Prisma.sql`1=1`})
      AND (${resolvedCategoryId ? Prisma.sql`fe.categoryId = ${resolvedCategoryId}` : Prisma.sql`1=1`})
      AND (${resolvedBillId ? Prisma.sql`fe.id = ${resolvedBillId}` : Prisma.sql`1=1`})
      AND (${resolvedLevel ? Prisma.sql`fe.level = ${resolvedLevel}` : Prisma.sql`1=1`})
      AND (${f.collegeId ? Prisma.sql`u.facultyId = ${f.collegeId}` : Prisma.sql`1=1`})
      AND (${f.departmentId ? Prisma.sql`u.departmentId = ${f.departmentId}` : Prisma.sql`1=1`})
      AND (${f.programmeId ? Prisma.sql`u.programmeId = ${f.programmeId}` : Prisma.sql`1=1`})
      AND (${f.studentId ? Prisma.sql`i.studentId = ${f.studentId}` : Prisma.sql`1=1`})
    GROUP BY fe.id, fe.name, fe.feeCode, fc.name, i.session, i.semester
    HAVING assigned > 0
    ORDER BY expected DESC
  `;
  const rows = await prisma.$queryRaw<any[]>(sql);
  return (Array.isArray(rows) ? rows : []).map((r: any) => {
    const expected = d(r.expected);
    const collected = d(r.collected);
    const outstanding = d(r.outstanding);
    const collectionPct = expected > 0 ? Number(((collected / expected) * 100).toFixed(2)) : 0;
    return {
      billId: Number(r.billId),
      billName: String(r.billName ?? ''),
      feeCode: String(r.feeCode ?? ''),
      category: String(r.category ?? ''),
      session: r.session ?? '',
      semester: r.semester ?? '',
      assigned: Number(r.assigned ?? 0),
      assignedStudents: Number(r.assigned ?? 0),
      expected,
      expectedRevenue: expected,
      fullyPaidCount: Number(r.fullyPaidCount ?? 0),
      studentsPaidFull: Number(r.fullyPaidCount ?? 0),
      partiallyPaidCount: Number(r.partiallyPaidCount ?? 0),
      studentsPaidPartial: Number(r.partiallyPaidCount ?? 0),
      unpaidCount: Number(r.unpaidCount ?? 0),
      studentsUnpaid: Number(r.unpaidCount ?? 0),
      collected,
      amountCollected: collected,
      outstanding,
      outstandingAmount: outstanding,
      collectionPct,
      collectionPercent: collectionPct,
    };
  });
}

// ---------------------------------------------------------------------------
// R8 — Outstanding / Debtors (tabs: All / Partial / Never paid)
// ---------------------------------------------------------------------------
export async function outstandingDebtors(f: ReportFilterCtx & {
  tab?: 'ALL' | 'PARTIAL' | 'NEVER'; minOutstanding?: number; maxOutstanding?: number;
}) {
  const tab = f.tab ?? 'ALL';
  const havingConds: Prisma.Sql[] = [Prisma.sql`outstanding > 0`];
  if (tab === 'PARTIAL') havingConds.push(Prisma.sql`paid > 0 AND paid < expected`);
  else if (tab === 'NEVER') havingConds.push(Prisma.sql`paid = 0`);
  if (f.minOutstanding) havingConds.push(Prisma.sql`outstanding >= ${f.minOutstanding}`);
  if (f.maxOutstanding) havingConds.push(Prisma.sql`outstanding <= ${f.maxOutstanding}`);
  const page = Math.max(1, Number(f.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Number(f.pageSize ?? 50)));
  const skip = (page - 1) * pageSize;

  const where: Prisma.Sql[] = [];
  if (f.session) where.push(Prisma.sql`i.session = ${f.session}`);
  if (f.billId) where.push(Prisma.sql`i.feeId = ${f.billId}`);
  if (f.billCategoryId) where.push(Prisma.sql`fe.categoryId = ${f.billCategoryId}`);
  if (f.levelValue) where.push(Prisma.sql`u.level = ${f.levelValue}`);
  if (f.collegeId) where.push(Prisma.sql`u.facultyId = ${f.collegeId}`);
  if (f.departmentId) where.push(Prisma.sql`u.departmentId = ${f.departmentId}`);
  if (f.programmeId) where.push(Prisma.sql`u.programmeId = ${f.programmeId}`);
  if (f.studentId) where.push(Prisma.sql`i.studentId = ${f.studentId}`);
  if (f.q) {
    const q = `%${String(f.q).trim()}%`;
    where.push(Prisma.sql`(u.matricNumber LIKE ${q} OR CONCAT(u.firstName,' ',u.lastName) LIKE ${q})`);
  }
  const whereSql = where.length > 0 ? Prisma.join(where, ' AND ') : Prisma.sql`1=1`;

  const rowsSql = Prisma.sql`
    SELECT
      u.id                                                           AS studentId,
      u.matricNumber,
      CONCAT(u.firstName, ' ', IF(u.middleName IS NULL OR u.middleName='', '', CONCAT(u.middleName, ' ')), u.lastName) AS studentName,
      u.college, u.department, u.program, u.level,
      COUNT(DISTINCT i.id)                                           AS billCount,
      fe.id                                                          AS billId,
      fe.name                                                        AS billName,
      i.session,
      COALESCE(SUM(i.amountDue),0)                                   AS expected,
      COALESCE(SUM(i.amountPaid),0)                                  AS paid,
      COALESCE(SUM(i.amountDue - i.amountPaid),0)                    AS outstanding,
      i.status                                                       AS invoiceStatus,
      i.dueDate
    FROM invoices i
      INNER JOIN users u ON u.id = i.studentId
      LEFT  JOIN fees fe ON fe.id = i.feeId
    WHERE ${whereSql}
    GROUP BY u.id, fe.id, i.session, i.status, i.dueDate
    HAVING ${Prisma.join(havingConds, ' AND ')}
    ORDER BY outstanding DESC
    LIMIT ${pageSize} OFFSET ${skip}
  `;
  const countSql = Prisma.sql`SELECT COUNT(*) AS cnt FROM (
      SELECT u.id, fe.id, i.session, i.status FROM invoices i INNER JOIN users u ON u.id=i.studentId LEFT JOIN fees fe ON fe.id=i.feeId
      WHERE ${whereSql}
      GROUP BY u.id, fe.id, i.session, i.status
      HAVING ${Prisma.join(havingConds, ' AND ')}
    ) X`;
  const summarySql = Prisma.sql`SELECT
      COUNT(*) AS debtorCount,
      COALESCE(SUM(expected),0) AS totalExpected,
      COALESCE(SUM(paid),0) AS totalPaid,
      COALESCE(SUM(outstanding),0) AS totalOutstanding
    FROM (
      SELECT u.id,
        SUM(i.amountDue) AS expected,
        SUM(i.amountPaid) AS paid,
        SUM(i.amountDue - i.amountPaid) AS outstanding
      FROM invoices i INNER JOIN users u ON u.id=i.studentId LEFT JOIN fees fe ON fe.id=i.feeId
      WHERE ${whereSql}
      GROUP BY u.id HAVING ${Prisma.join(havingConds, ' AND ')}
    ) D`;

  const [rowsRaw, cntRaw, sumRaw] = await Promise.all([
    prisma.$queryRaw<any[]>(rowsSql),
    prisma.$queryRaw<[{cnt:any}][]>(countSql),
    prisma.$queryRaw<Array<{debtorCount:any;totalExpected:any;totalPaid:any;totalOutstanding:any}>>(summarySql),
  ]);
  const rows = (Array.isArray(rowsRaw) ? rowsRaw : []).map((r: any) => ({
    studentId: Number(r.studentId),
    matricNumber: r.matricNumber ?? '',
    studentName: String(r.studentName ?? ''),
    college: r.college ?? '', department: r.department ?? '', program: r.program ?? '', level: r.level ?? null,
    billCount: Number(r.billCount ?? 0),
    billId: r.billId ? Number(r.billId) : null,
    billName: r.billName ?? '',
    session: r.session ?? '',
    expected: d(r.expected),
    paid: d(r.paid),
    outstanding: d(r.outstanding),
    invoiceStatus: r.invoiceStatus ?? '',
    dueDate: r.dueDate ? new Date(r.dueDate).toISOString() : null,
  }));
  const total = Number(Array.isArray(cntRaw) && cntRaw.length > 0 ? (cntRaw as any)[0]?.cnt ?? 0 : 0);
  const s0 = Array.isArray(sumRaw) && sumRaw.length > 0 ? sumRaw[0] : {} as any;
  return {
    rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)),
    summary: {
      debtorCount: Number(s0.debtorCount ?? 0),
      totalExpected: d(s0.totalExpected),
      totalPaid: d(s0.totalPaid),
      totalOutstanding: d(s0.totalOutstanding),
    },
  };
}

// ---------------------------------------------------------------------------
// R9 — Hierarchical College→Dept→Programme Revenue rollup
// ---------------------------------------------------------------------------
export async function hierarchicalRevenue(f: ReportFilterCtx & { level?: 'college' | 'department' | 'programme' }) {
  const { where } = buildSuccessReceiptTxCtx(f);
  const rollupLvl = f.level ?? 'college';
  let groupBy: Prisma.Sql;
  let select: Prisma.Sql;
  if (rollupLvl === 'college') {
    select = Prisma.sql`fac.id AS collegeId, fac.name AS collegeName, NULL AS deptId, NULL AS deptName, NULL AS progId, NULL AS progName`;
    groupBy = Prisma.sql`fac.id, fac.name`;
  } else if (rollupLvl === 'department') {
    select = Prisma.sql`fac.id AS collegeId, fac.name AS collegeName, d.id AS deptId, d.name AS deptName, NULL AS progId, NULL AS progName`;
    groupBy = Prisma.sql`fac.id, fac.name, d.id, d.name`;
  } else {
    select = Prisma.sql`fac.id AS collegeId, fac.name AS collegeName, d.id AS deptId, d.name AS deptName, p.id AS progId, p.name AS progName`;
    groupBy = Prisma.sql`fac.id, fac.name, d.id, d.name, p.id, p.name`;
  }
  const joinClauses = rollupLvl === 'college' ? Prisma.sql`
      LEFT JOIN Faculty fac   ON fac.id = u.facultyId`
    : rollupLvl === 'department' ? Prisma.sql`
      LEFT JOIN Faculty fac   ON fac.id = u.facultyId
      LEFT JOIN Department d  ON d.id  = u.departmentId`
    : Prisma.sql`
      LEFT JOIN Faculty fac   ON fac.id = u.facultyId
      LEFT JOIN Department d  ON d.id  = u.departmentId
      LEFT JOIN Programme p   ON p.id  = u.programmeId`;
  const sql = Prisma.sql`
    SELECT ${select},
      COUNT(DISTINCT t.id)                    AS txCount,
      COUNT(DISTINCT t.userId)                AS uniquePayers,
      COALESCE(SUM(r.paidAmount),0)           AS collected,
      COALESCE(SUM(r.convenienceFee),0)       AS convenienceFee,
      COALESCE(SUM(r.serviceCharge),0)        AS serviceCharge,
      COALESCE(SUM(r.gatewayFee),0)           AS gatewayFee
    FROM transactions t
      INNER JOIN receipts r ON r.transactionId = t.id
      INNER JOIN users u    ON u.id = t.userId
      ${joinClauses}
      LEFT JOIN invoices i  ON i.id = t.invoiceId
      LEFT JOIN fees fe     ON fe.id = i.feeId
    WHERE ${where}
    GROUP BY ${groupBy}
    ORDER BY collected DESC
  `;
  const rows = await prisma.$queryRaw<any[]>(sql);
  return (Array.isArray(rows) ? rows : []).map((r: any) => ({
    collegeId: r.collegeId ? Number(r.collegeId) : null,
    collegeName: r.collegeName ?? 'Uncategorised College',
    deptId: r.deptId ? Number(r.deptId) : null,
    deptName: r.deptName ?? null,
    progId: r.progId ? Number(r.progId) : null,
    progName: r.progName ?? null,
    txCount: Number(r.txCount ?? 0),
    uniquePayers: Number(r.uniquePayers ?? 0),
    collected: d(r.collected),
    convenienceFee: d(r.convenienceFee),
    serviceCharge: d(r.serviceCharge),
    gatewayFee: d(r.gatewayFee),
  }));
}

// ---------------------------------------------------------------------------
// R10 — Payment Gateway Report
// ---------------------------------------------------------------------------
export async function paymentGatewayReport(f: ReportFilterCtx) {
  const { where } = buildSuccessReceiptTxCtx(f);
  const sql = Prisma.sql`
    SELECT
      t.gateway                                              AS provider,
      COUNT(DISTINCT CASE WHEN t.status='SUCCESS' THEN t.id END)    AS successCount,
      COUNT(DISTINCT CASE WHEN t.status<>'SUCCESS' AND t.status IN ('FAILED','REVERSED') THEN t.id END) AS failCount,
      COUNT(DISTINCT CASE WHEN t.status='PENDING' THEN t.id END)   AS pendingCount,
      COALESCE(SUM(CASE WHEN t.status='SUCCESS' THEN r.paidAmount ELSE 0 END),0)  AS gross,
      COALESCE(SUM(r.gatewayFee),0)                               AS gwFees,
      COALESCE((SELECT SUM(rf.requestedAmount) FROM refunds rf
        INNER JOIN transactions t2 ON t2.id = rf.originalTransactionId
        WHERE t2.gateway = t.gateway AND rf.status='PAID'
          AND (${f.dateFrom ? Prisma.sql`rf.updatedAt >= ${f.dateFrom}` : Prisma.sql`1=1`})
          AND (${f.dateTo   ? Prisma.sql`rf.updatedAt <= ${f.dateTo}`   : Prisma.sql`1=1`})
      ),0)                                                        AS refunds,
      COALESCE(SUM(CASE WHEN t.status='SUCCESS' THEN r.paidAmount ELSE 0 END) - r.gatewayFee, 0) AS expectedSettlement,
      COUNT(DISTINCT CASE WHEN s.status IN ('MATCHED','SETTLED','PARTIALLY_MATCHED') THEN t.id END) AS reconciled,
      COALESCE(
        SUM(CASE WHEN t.status='SUCCESS' THEN r.paidAmount ELSE 0 END) - r.gatewayFee, 0
      ) - COALESCE(SUM(s.actualSettlement),0)                     AS variance
    FROM transactions t
      INNER JOIN receipts r ON r.transactionId = t.id
      LEFT JOIN settlements s ON s.transactionId = t.id
      INNER JOIN users u    ON u.id = t.userId
      LEFT JOIN invoices i  ON i.id = t.invoiceId
      LEFT JOIN fees fe     ON fe.id = i.feeId
    WHERE ${Prisma.join([where], ' AND ')}
    GROUP BY t.gateway
    ORDER BY gross DESC
  `;
  const rows = await prisma.$queryRaw<any[]>(sql);
  return (Array.isArray(rows) ? rows : []).map((r: any) => ({
    provider: String(r.provider ?? ''),
    successCount: Number(r.successCount ?? 0),
    failCount: Number(r.failCount ?? 0),
    pendingCount: Number(r.pendingCount ?? 0),
    gross: d(r.gross),
    gwFees: d(r.gwFees),
    refunds: d(r.refunds),
    expectedSettlement: d(r.expectedSettlement),
    reconciled: Number(r.reconciled ?? 0),
    variance: d(r.variance),
  }));
}

// ---------------------------------------------------------------------------
// R11 — Settlement Report
// Enforces SUCCESS + nonvoid receipt context, all 14 baseFilter dimensions.
// ---------------------------------------------------------------------------
export async function settlementReport(f: ReportFilterCtx & { sort?: string; order?: 'asc'|'desc' }) {
  const page = Math.max(1, Number(f.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Number(f.pageSize ?? 50)));
  const skip = (page - 1) * pageSize;
  const { where: baseCtx } = buildSuccessReceiptTxCtx(f);
  const where: Prisma.Sql[] = [baseCtx];
  if (f.reconciliationStatus) where.push(Prisma.sql`COALESCE(s.status, 'PENDING_SETTLEMENT') = ${f.reconciliationStatus}`);
  if (f.dateFrom) where.push(Prisma.sql`COALESCE(s.paymentDate, r.paidAt) >= ${f.dateFrom}`);
  if (f.dateTo)   where.push(Prisma.sql`COALESCE(s.paymentDate, r.paidAt) <= ${f.dateTo}`);
  const whereSql = Prisma.join(where, ' AND ');
  const allowedSorts: ReadonlySet<string> = new Set(['paymentDate','settlementDate','provider','status','paymentAmount','expectedSettlement','actualSettlement','variance']);
  const sortRaw = allowedSorts.has(f.sort ?? '') ? f.sort! : 'paymentDate';
  const orderRaw = f.order === 'asc' ? 'ASC' : 'DESC';
  const sortMap: Record<string,string> = {
    paymentDate: 's.paymentDate', settlementDate: 's.settlementDate',
    provider: 't.gateway', status: 'COALESCE(s.status, \'PENDING_SETTLEMENT\')',
    paymentAmount: 'COALESCE(s.paymentAmount, r.paidAmount)',
    expectedSettlement: 'COALESCE(s.expectedSettlement, r.paidAmount - r.gatewayFee)',
    actualSettlement: 's.actualSettlement',
    variance: 'variance',
  };
  const rowsSql = Prisma.sql`
    SELECT
      t.reference                                              AS txRef,
      t.gateway                                                AS provider,
      COALESCE(s.paymentDate, r.paidAt)                        AS paymentDt,
      COALESCE(s.paymentAmount, r.paidAmount)                  AS paymentAmt,
      COALESCE(s.gatewayFee, r.gatewayFee)                     AS gwFee,
      COALESCE(s.expectedSettlement, r.paidAmount - r.gatewayFee) AS expectedSettlement,
      s.settlementDate                                         AS settlementDt,
      s.settlementRef                                          AS settlementRef,
      s.bankStatementRef                                       AS bankStatementRef,
      s.actualSettlement                                       AS actualSettlement,
      COALESCE(s.actualSettlement, 0)
        - COALESCE(s.expectedSettlement, r.paidAmount - r.gatewayFee) AS variance,
      COALESCE(s.status, 'PENDING_SETTLEMENT')                 AS reconciliationStatus,
      s.notes,
      CONCAT(u.firstName,' ',u.lastName)                       AS studentName,
      u.matricNumber,
      r.receiptNumber
    FROM transactions t
      INNER JOIN receipts r ON r.transactionId = t.id
      INNER JOIN users u    ON u.id = t.userId
      LEFT  JOIN invoices i ON i.id = t.invoiceId
      LEFT  JOIN fees fe    ON fe.id = i.feeId
      LEFT  JOIN settlements s ON s.transactionId = t.id
    WHERE ${whereSql}
    ORDER BY ${Prisma.raw(sortMap[sortRaw])} ${Prisma.raw(orderRaw)}
    LIMIT ${pageSize} OFFSET ${skip}
  `;
  const countSql = Prisma.sql`SELECT COUNT(DISTINCT t.id) AS cnt
    FROM transactions t INNER JOIN receipts r ON r.transactionId = t.id
      INNER JOIN users u ON u.id = t.userId LEFT JOIN settlements s ON s.transactionId = t.id
      LEFT JOIN invoices i ON i.id = t.invoiceId LEFT JOIN fees fe ON fe.id = i.feeId
    WHERE ${whereSql}`;
  const [rowsRaw, cntRaw] = await Promise.all([
    prisma.$queryRaw<any[]>(rowsSql),
    prisma.$queryRaw<[{cnt:any}][]>(countSql),
  ]);
  const rows = (Array.isArray(rowsRaw) ? rowsRaw : []).map((r: any) => ({
    txRef: String(r.txRef ?? ''),
    provider: String(r.provider ?? ''),
    paymentDt: r.paymentDt ? new Date(r.paymentDt).toISOString() : null,
    paymentAmt: d(r.paymentAmt),
    gwFee: d(r.gwFee),
    expectedSettlement: d(r.expectedSettlement),
    settlementDt: r.settlementDt ? new Date(r.settlementDt).toISOString() : null,
    settlementRef: r.settlementRef ?? null,
    bankStatementRef: r.bankStatementRef ?? null,
    actualSettlement: r.actualSettlement != null ? d(r.actualSettlement) : null,
    variance: d(r.variance),
    reconciliationStatus: String(r.reconciliationStatus ?? ''),
    notes: r.notes ?? null,
    studentName: String(r.studentName ?? ''),
    matricNumber: r.matricNumber ?? null,
    receiptNumber: r.receiptNumber ?? null,
  }));
  const total = Number(Array.isArray(cntRaw) && cntRaw.length > 0 ? (cntRaw as any)[0]?.cnt ?? 0 : 0);
  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

// ---------------------------------------------------------------------------
// R12 — Reconciliation Exceptions (ALL 11 categories)
// ---------------------------------------------------------------------------
export type ExceptionKind =
  | 'SUCCESS_NO_RECEIPT'
  | 'RECEIPT_NO_PAYMENT'
  | 'DUPLICATE_PAYMENT_REF'
  | 'DUPLICATE_RECEIPT'
  | 'PROVIDER_MISSING_LOCALLY'
  | 'LOCAL_MISSING_AT_PROVIDER'
  | 'SETTLEMENT_MISMATCH'
  | 'UNEXPECTED_GATEWAY_CHARGE'
  | 'REFUND_UNRECONCILED'
  | 'AWAITING_SETTLEMENT'
  | 'GL_IMBALANCE'
  | 'CANCELLED_INVOICE_LATE_SUCCESS';

export async function reconciliationExceptions(f: ReportFilterCtx & { kind?: ExceptionKind }) {
  const dateFrom = f.dateFrom;
  const dateTo = f.dateTo;

  // (a) successful-tx-without-receipt
  const a = Prisma.sql`
    SELECT t.id, t.reference, t.createdAt, t.status, t.userId, t.gateway, t.amount,
           CONCAT(u.firstName,' ',u.lastName) AS studentName, u.matricNumber
    FROM transactions t INNER JOIN users u ON u.id = t.userId
    WHERE t.status='SUCCESS'
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transactionId = t.id)
      AND (${dateFrom ? Prisma.sql`t.createdAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`t.createdAt <= ${dateTo}`   : Prisma.sql`1=1`})
    LIMIT 500
  `;
  // (b) receipt-without-payment (nonvoid receipt + transaction FAILED/PENDING/etc — not SUCCESS)
  const b = Prisma.sql`
    SELECT r.id, r.receiptNumber, r.paidAt, r.paidAmount, r.studentId, r.transactionId,
           CONCAT(u.firstName,' ',u.lastName) AS studentName, u.matricNumber,
           t.status AS txStatus
    FROM receipts r INNER JOIN users u ON u.id = r.studentId
      LEFT JOIN transactions t ON t.id = r.transactionId
    WHERE r.isVoided=0 AND (t.status IS NULL OR t.status <> 'SUCCESS')
      AND (${dateFrom ? Prisma.sql`r.paidAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`r.paidAt <= ${dateTo}`   : Prisma.sql`1=1`})
    LIMIT 500
  `;
  // (c) duplicate-payment-reference
  const c = Prisma.sql`
    SELECT reference, COUNT(*) AS c FROM transactions
    WHERE reference IS NOT NULL
      AND (${dateFrom ? Prisma.sql`createdAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`createdAt <= ${dateTo}`   : Prisma.sql`1=1`})
    GROUP BY reference HAVING COUNT(*) > 1 LIMIT 500
  `;
  // (d) duplicate-receipt
  const dSql = Prisma.sql`
    SELECT receiptNumber, COUNT(*) AS c FROM receipts
    WHERE receiptNumber IS NOT NULL AND isVoided=0
      AND (${dateFrom ? Prisma.sql`paidAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`paidAt <= ${dateTo}`   : Prisma.sql`1=1`})
    GROUP BY receiptNumber HAVING COUNT(*) > 1 LIMIT 500
  `;
  // (e) provider-missing-locally: webhook events where no local tx has the paystack/alatpay reference
  const e = Prisma.sql`
    SELECT w.id, w.eventType, w.transactionReference, w.createdAt, w.isProcessed, w.payload
    FROM webhook_events w
    WHERE (
      NOT EXISTS (SELECT 1 FROM transactions t WHERE t.reference = w.transactionReference)
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.paystackReference = w.transactionReference)
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.alatpayReference = w.transactionReference)
    )
      AND (${dateFrom ? Prisma.sql`w.createdAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`w.createdAt <= ${dateTo}`   : Prisma.sql`1=1`})
    LIMIT 500
  `;
  // (f) local-missing-at-provider (local SUCCESS tx not matched at provider — proxied via settlements.status IS NULL + >7 days old)
  const fSql = Prisma.sql`
    SELECT t.id, t.reference, t.paystackReference, t.alatpayReference, t.gateway, t.amount, t.createdAt,
           CONCAT(u.firstName,' ',u.lastName) AS studentName, u.matricNumber
    FROM transactions t INNER JOIN users u ON u.id = t.userId
    WHERE t.status='SUCCESS'
      AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.transactionId = t.id AND s.status NOT IN ('UNMATCHED','UNDER_REVIEW'))
      AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transactionId=t.id AND r.isVoided=0) = FALSE
      AND DATEDIFF(CURDATE(), DATE(t.createdAt)) > 7
      AND (${dateFrom ? Prisma.sql`t.createdAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`t.createdAt <= ${dateTo}`   : Prisma.sql`1=1`})
    LIMIT 500
  `;
  // (g) settlement-amount-mismatch
  const g = Prisma.sql`
    SELECT s.id, s.settlementRef, s.transactionId, t.reference, t.gateway,
           s.expectedSettlement, s.actualSettlement, s.variance, s.status, s.settlementDate
    FROM settlements s INNER JOIN transactions t ON t.id = s.transactionId
    WHERE s.status='VARIANCE' AND ABS(COALESCE(s.variance,0)) > 0.02
      AND (${dateFrom ? Prisma.sql`s.createdAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`s.createdAt <= ${dateTo}`   : Prisma.sql`1=1`})
    LIMIT 500
  `;
  // (h) unexpected-gateway-charge: receipt.gatewayFee deviates from schema provider default percentage
  //    Paystack: 1.5% + 100 capped at 2000; ALAT: 1.0% — proxy via (receipt.gatewayFee / paidAmount) ratio outside [0.005, 0.025] for paidAmt>100
  const h = Prisma.sql`
    SELECT r.id, r.receiptNumber, r.paidAmount, r.gatewayFee, r.totalAmount, r.paidAt, t.gateway,
           t.reference, r.studentId, u.matricNumber,
           CONCAT(u.firstName,' ',u.lastName) AS studentName
    FROM receipts r INNER JOIN transactions t ON t.id = r.transactionId
      INNER JOIN users u ON u.id = r.studentId
    WHERE r.isVoided=0 AND r.paidAmount > 100
      AND (r.gatewayFee / r.paidAmount) NOT BETWEEN 0.005 AND 0.025
      AND (${dateFrom ? Prisma.sql`r.paidAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`r.paidAt <= ${dateTo}`   : Prisma.sql`1=1`})
    LIMIT 500
  `;
  // (i) refund-unreconciled
  const i = Prisma.sql`
    SELECT rf.id, rf.refundNumber, rf.requestedAmount, rf.status, rf.createdAt, rf.updatedAt, rf.reason,
           rf.originalTransactionId, t.reference,
           CONCAT(u.firstName,' ',u.lastName) AS studentName, u.matricNumber
    FROM refunds rf INNER JOIN transactions t ON t.id = rf.originalTransactionId
      INNER JOIN users u ON u.id = t.userId
    WHERE rf.status IN ('APPROVED','REQUESTED','PAID')
      AND NOT EXISTS (SELECT 1 FROM GeneralLedger gl
          WHERE gl.entryType='REFUND_ISSUED' AND gl.transactionId = t.id)
      AND (${dateFrom ? Prisma.sql`rf.createdAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`rf.createdAt <= ${dateTo}`   : Prisma.sql`1=1`})
    LIMIT 500
  `;
  // (j) payment-awaiting-settlement
  const j = Prisma.sql`
    SELECT t.id, t.reference, t.gateway, t.amount, t.createdAt,
           COALESCE(s.status, 'PENDING_SETTLEMENT') AS settlementStatus,
           CONCAT(u.firstName,' ',u.lastName) AS studentName, u.matricNumber
    FROM transactions t INNER JOIN users u ON u.id = t.userId
      INNER JOIN receipts r ON r.transactionId = t.id
      LEFT JOIN settlements s ON s.transactionId = t.id
    WHERE t.status='SUCCESS' AND r.isVoided=0
      AND COALESCE(s.status, 'PENDING_SETTLEMENT') IN ('PENDING_SETTLEMENT','UNDER_REVIEW')
      AND (${dateFrom ? Prisma.sql`t.createdAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`t.createdAt <= ${dateTo}`   : Prisma.sql`1=1`})
    LIMIT 500
  `;
  // (k) general-ledger-imbalance: per transactionId, sum(debits) - sum(credits) != 0
  const k = Prisma.sql`
    SELECT transactionId,
           SUM(CASE WHEN account LIKE '%EXPENSE%' OR account LIKE '%RECEIVABLE%' THEN amount ELSE 0 END)
           - SUM(CASE WHEN account LIKE '%INCOME%' OR account LIKE '%REVENUE%' OR account LIKE '%PAYABLE%' THEN amount ELSE 0 END)
             AS imbalance,
           COUNT(*) AS entryCount
    FROM GeneralLedger
    WHERE transactionId IS NOT NULL
      AND (${dateFrom ? Prisma.sql`transactionDate >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`transactionDate <= ${dateTo}`   : Prisma.sql`1=1`})
    GROUP BY transactionId
    HAVING ABS(imbalance) > 0.02
    LIMIT 500
  `;
  // (l) CANCELLED_INVOICE_LATE_SUCCESS — audit log entries where provider
  //     reported SUCCESS against administratively CANCELLED invoice. Pulled from
  //     AuditLog.action = PAYMENT_SUCCESS_ON_CANCELLED_INVOICE so Bursary has
  //     an auditable record-of-record for each routing-to-reconciliation case.
  //     Transaction id, invoice id/number, providerRef, paidAt, paidNaira
  //     preserved in oldValue/newValue/details JSON fields.
  const l = Prisma.sql`
    SELECT a.id AS auditId, a.createdAt, a.action,
           CAST(JSON_UNQUOTE(JSON_EXTRACT(a.details, '\$.transactionId')) AS UNSIGNED) AS transactionId,
           CAST(JSON_UNQUOTE(JSON_EXTRACT(a.details, '\$.invoiceId'))     AS UNSIGNED) AS invoiceId,
           JSON_UNQUOTE(JSON_EXTRACT(a.details, '\$.invoiceNumber'))                AS invoiceNumber,
           JSON_UNQUOTE(JSON_EXTRACT(a.details, '\$.reference'))                    AS paymentReference,
           JSON_UNQUOTE(JSON_EXTRACT(a.details, '\$.providerRef'))                  AS providerRef,
           JSON_UNQUOTE(JSON_EXTRACT(a.details, '\$.paidAt'))                       AS paidAt,
           CAST(JSON_UNQUOTE(JSON_EXTRACT(a.details, '\$.paidNaira')) AS DECIMAL(20,2)) AS paidNaira,
           JSON_UNQUOTE(JSON_EXTRACT(a.details, '\$.note'))                         AS note
    FROM AuditLog a
    WHERE a.action='PAYMENT_SUCCESS_ON_CANCELLED_INVOICE'
      AND (${dateFrom ? Prisma.sql`a.createdAt >= ${dateFrom}` : Prisma.sql`1=1`})
      AND (${dateTo   ? Prisma.sql`a.createdAt <= ${dateTo}`   : Prisma.sql`1=1`})
    ORDER BY a.createdAt DESC
    LIMIT 500
  `;

  type QRes = any[];
  const [aR, bR, cR, dR, eR, fR, gR, hR, iR, jR, kR, lR] = (await Promise.all([
    prisma.$queryRaw<QRes>(a), prisma.$queryRaw<QRes>(b), prisma.$queryRaw<QRes>(c),
    prisma.$queryRaw<QRes>(dSql), prisma.$queryRaw<QRes>(e), prisma.$queryRaw<QRes>(fSql),
    prisma.$queryRaw<QRes>(g), prisma.$queryRaw<QRes>(h), prisma.$queryRaw<QRes>(i),
    prisma.$queryRaw<QRes>(j), prisma.$queryRaw<QRes>(k), prisma.$queryRaw<QRes>(l),
  ])) as [any[],any[],any[],any[],any[],any[],any[],any[],any[],any[],any[],any[]];

  const allCats: Array<{kind: ExceptionKind; label: string; description: string; rows: any[]}> = [
    { kind: 'SUCCESS_NO_RECEIPT',        label: 'Successful tx without receipt',    description: 'Transaction marked SUCCESS but no Receipt row created', rows: Array.isArray(aR) ? aR : [] },
    { kind: 'RECEIPT_NO_PAYMENT',        label: 'Receipt without matching payment', description: 'Receipt exists but underlying tx is not SUCCESS/absent', rows: Array.isArray(bR) ? bR : [] },
    { kind: 'DUPLICATE_PAYMENT_REF',     label: 'Duplicate payment reference',     description: 'Duplicate transaction.reference values', rows: Array.isArray(cR) ? cR : [] },
    { kind: 'DUPLICATE_RECEIPT',         label: 'Duplicate receipt number',        description: 'Duplicate receipt.receiptNumber (non-voided)', rows: Array.isArray(dR) ? dR : [] },
    { kind: 'PROVIDER_MISSING_LOCALLY',  label: 'Provider event missing locally',  description: 'Webhook event reference has no matching transaction', rows: Array.isArray(eR) ? eR : [] },
    { kind: 'LOCAL_MISSING_AT_PROVIDER', label: 'Local payment missing at provider', description: 'Local SUCCESS >7 days old with no settlement matched', rows: Array.isArray(fR) ? fR : [] },
    { kind: 'SETTLEMENT_MISMATCH',       label: 'Settlement amount mismatch',      description: 'Variance > NGN 0.02 between expected and actual settlement', rows: Array.isArray(gR) ? gR : [] },
    { kind: 'UNEXPECTED_GATEWAY_CHARGE', label: 'Unexpected gateway charge',       description: 'Gateway fee ratio outside 0.5%-2.5% band (fee>100 NGN)', rows: Array.isArray(hR) ? hR : [] },
    { kind: 'REFUND_UNRECONCILED',       label: 'Refund unreconciled in GL',       description: 'Approved/paid refund without REFUND_ISSUED GL entry', rows: Array.isArray(iR) ? iR : [] },
    { kind: 'AWAITING_SETTLEMENT',       label: 'Payments awaiting settlement',    description: 'SUCCESS tx not yet settled/matched by provider', rows: Array.isArray(jR) ? jR : [] },
    { kind: 'GL_IMBALANCE',              label: 'General Ledger imbalance',        description: 'Per-tx GL entries debit/credit net > 0.02 NGN', rows: Array.isArray(kR) ? kR : [] },
    { kind: 'CANCELLED_INVOICE_LATE_SUCCESS', label: 'Late SUCCESS on CANCELLED invoice', description: 'Provider reported SUCCESS after invoice was administratively cancelled; routed to reconciliation for review', rows: Array.isArray(lR) ? lR : [] },
  ];
  const filtered = f.kind ? allCats.filter(c => c.kind === f.kind) : allCats;
  const totalCount = filtered.reduce((s, c) => s + Number(c.rows.length ?? 0), 0);
  return { totalCount, categories: allCats.map(c => ({
    kind: c.kind, label: c.label, description: c.description,
    count: Number(c.rows.length ?? 0),
    rows: (f.kind === undefined || f.kind === c.kind) ? c.rows : [],
  })) };
}

// ---------------------------------------------------------------------------
// R13 — Refund Report
// ---------------------------------------------------------------------------
export async function refundReport(f: ReportFilterCtx) {
  const resolvedCategoryId = f.billCategoryId ?? f.feeCategoryId;
  const resolvedBillId = f.billId ?? f.feeId;
  const resolvedLevel = f.levelValue ?? f.level;
  const where: Prisma.Sql[] = [];
  if (f.dateFrom) where.push(Prisma.sql`rf.createdAt >= ${f.dateFrom}`);
  if (f.dateTo)   where.push(Prisma.sql`rf.createdAt <= ${f.dateTo}`);
  if (f.provider) where.push(Prisma.sql`t.gateway = ${f.provider}`);
  if (f.paymentStatus) where.push(Prisma.sql`rf.status = ${f.paymentStatus}`);
  if (f.studentId) where.push(Prisma.sql`u.id = ${f.studentId}`);
  if (f.studentMatric) where.push(Prisma.sql`u.matricNumber = ${f.studentMatric}`);
  if (f.session) where.push(Prisma.sql`i.session = ${f.session}`);
  if (f.semester) where.push(Prisma.sql`i.semester = ${f.semester}`);
  if (resolvedLevel) where.push(Prisma.sql`fe.level = ${resolvedLevel}`);
  if (resolvedCategoryId) where.push(Prisma.sql`fe.categoryId = ${resolvedCategoryId}`);
  if (resolvedBillId) where.push(Prisma.sql`i.feeId = ${resolvedBillId}`);
  if (f.collegeId) where.push(Prisma.sql`u.facultyId = ${f.collegeId}`);
  if (f.departmentId) where.push(Prisma.sql`u.departmentId = ${f.departmentId}`);
  if (f.programmeId) where.push(Prisma.sql`u.programmeId = ${f.programmeId}`);
  if (f.q) {
    const q = `%${String(f.q).trim()}%`;
    where.push(Prisma.sql`(u.matricNumber LIKE ${q} OR CONCAT(u.firstName,' ',u.lastName) LIKE ${q} OR rf.refundNumber LIKE ${q} OR t.reference LIKE ${q})`);
  }
  const whereSql = where.length > 0 ? Prisma.join(where, ' AND ') : Prisma.sql`1=1`;
  const sql = Prisma.sql`
    SELECT
      rf.id, rf.refundNumber, rf.createdAt AS refundDate, rf.requestedAmount AS refundAmt,
      rf.status, rf.reason, rf.paidAt, rf.approvedById, rf.paystackRefundReference, rf.notes,
      CONCAT(ru.firstName,' ',ru.lastName) AS requestedBy,
      CONCAT(au.firstName,' ',au.lastName) AS approvedBy,
      t.id AS originalTxId, t.reference AS origTx, t.amount AS origAmt, t.gateway AS provider,
      u.id AS studentId, CONCAT(u.firstName,' ',u.lastName) AS student, u.matricNumber,
      i.session, i.semester, fe.name AS billName, fc.name AS categoryName
    FROM refunds rf
      LEFT JOIN users ru ON ru.id = rf.requestedById
      LEFT JOIN users au ON au.id = rf.approvedById
      INNER JOIN transactions t ON t.id = rf.originalTransactionId
      INNER JOIN users u ON u.id = t.userId
      LEFT JOIN invoices i ON i.id = t.invoiceId
      LEFT JOIN fees fe ON fe.id = i.feeId
      LEFT JOIN fee_categories fc ON fc.id = fe.categoryId
    WHERE ${whereSql}
    ORDER BY rf.createdAt DESC
  `;
  const rows = await prisma.$queryRaw<any[]>(sql);
  const data = (Array.isArray(rows) ? rows : []).map((r: any) => ({
    id: Number(r.id),
    refundNumber: String(r.refundNumber ?? ''),
    refundDate: r.refundDate ? new Date(r.refundDate).toISOString() : null,
    student: String(r.student ?? ''),
    matricNumber: r.matricNumber ?? '',
    origTx: String(r.origTx ?? ''),
    origAmt: d(r.origAmt),
    refundAmt: d(r.refundAmt),
    reason: String(r.reason ?? ''),
    requestedBy: String(r.requestedBy ?? ''),
    approvedBy: r.approvedBy ? String(r.approvedBy) : null,
    provider: String(r.provider ?? ''),
    refundRef: r.paystackRefundReference ?? null,
    status: String(r.status ?? ''),
    paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
    session: r.session ?? '',
    semester: r.semester ?? '',
    billName: r.billName ?? '',
    categoryName: r.categoryName ?? '',
  }));
  // Summary buckets
  const today = new Date(); today.setHours(0,0,0,0);
  const todayEnd = new Date(today); todayEnd.setHours(23,59,59,999);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const summary = {
    todayCount: data.filter(r => new Date(r.refundDate!) >= today && new Date(r.refundDate!) <= todayEnd).length,
    monthCount: data.filter(r => new Date(r.refundDate!) >= monthStart).length,
    pendingCount: data.filter(r => r.status === 'REQUESTED' || r.status === 'APPROVED').length,
    completeCount: data.filter(r => r.status === 'PAID').length,
    failedCount: data.filter(r => r.status === 'FAILED' || r.status === 'REJECTED').length,
    totalRefunded: data.filter(r => r.status === 'PAID').reduce((s, r) => s + r.refundAmt, 0),
  };
  return { rows: data, summary };
}

// ---------------------------------------------------------------------------
// R14 — Charges & Fee Income
// netRevenue = basePayment + convenienceFee + serviceCharge − gatewayFee
// (per spec: base + 3 distinct charges, never mix gross-refunds into netRevenue)
// totalCharged = basePayment + convFee + svcCharge + gwFee (sum of 4)
// ---------------------------------------------------------------------------
export async function chargesAndFeeIncome(f: ReportFilterCtx) {
  const { where } = buildSuccessReceiptTxCtx(f);
  const sql = Prisma.sql`
    SELECT
      DATE_FORMAT(r.paidAt, '%Y-%m')                     AS period,
      MIN(DATE(r.paidAt))                                AS periodStart,
      COALESCE(SUM(r.paidAmount),0)                      AS basePayment,
      COALESCE(SUM(r.convenienceFee),0)                  AS convFee,
      COALESCE(SUM(r.serviceCharge),0)                   AS svcCharge,
      COALESCE(SUM(r.gatewayFee),0)                      AS gwFee,
      COALESCE(SUM(r.paidAmount + r.convenienceFee + r.serviceCharge + r.gatewayFee),0) AS totalCharged,
      COALESCE(SUM(r.paidAmount + r.convenienceFee + r.serviceCharge - r.gatewayFee),0) AS netRevenue,
      COUNT(DISTINCT t.id)                               AS txCount
    FROM transactions t
      INNER JOIN receipts r ON r.transactionId = t.id
      INNER JOIN users u    ON u.id = t.userId
      LEFT JOIN invoices i ON i.id = t.invoiceId
    WHERE ${where}
    GROUP BY DATE_FORMAT(r.paidAt, '%Y-%m')
    ORDER BY period DESC
  `;
  const rows = await prisma.$queryRaw<any[]>(sql);
  return (Array.isArray(rows) ? rows : []).map((r: any) => {
    const basePayment = d(r.basePayment);
    const convFee = d(r.convFee);
    const svcCharge = d(r.svcCharge);
    const gwFee = d(r.gwFee);
    return {
      period: String(r.period ?? ''),
      periodStart: dateOnly(r.periodStart),
      basePayment,
      convFee,
      svcCharge,
      gwFee,
      totalCharged: d(r.totalCharged),
      netRevenue: d(r.netRevenue),
      netRevenueRecomputed: d(basePayment + convFee + svcCharge - gwFee),
      txCount: Number(r.txCount ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// R15 — General Ledger
// Uses GeneralLedger table only (never computed from frontend).
// Returns totalsByEntryType object with all 6 GeneralLedgerEntryType sums.
// ---------------------------------------------------------------------------
export async function generalLedger(f: ReportFilterCtx & { entryType?: GeneralLedgerEntryType; sort?: string; order?: 'asc'|'desc' }) {
  const page = Math.max(1, Number(f.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Number(f.pageSize ?? 50)));
  const skip = (page - 1) * pageSize;
  const resolvedCategoryId = f.billCategoryId ?? f.feeCategoryId;
  const resolvedBillId = f.billId ?? f.feeId;
  const resolvedLevel = f.levelValue ?? f.level;
  const where: Prisma.Sql[] = [];
  if (f.dateFrom) where.push(Prisma.sql`gl.transactionDate >= ${f.dateFrom}`);
  if (f.dateTo)   where.push(Prisma.sql`gl.transactionDate <= ${f.dateTo}`);
  if (f.entryType) where.push(Prisma.sql`gl.entryType = ${f.entryType}`);
  if (f.studentId) where.push(Prisma.sql`gl.userId = ${f.studentId}`);
  if (f.provider) where.push(Prisma.sql`t.gateway = ${f.provider}`);
  if (f.session) where.push(Prisma.sql`i.session = ${f.session}`);
  if (f.semester) where.push(Prisma.sql`i.semester = ${f.semester}`);
  if (resolvedCategoryId) where.push(Prisma.sql`fe.categoryId = ${resolvedCategoryId}`);
  if (resolvedBillId) where.push(Prisma.sql`i.feeId = ${resolvedBillId}`);
  if (resolvedLevel) where.push(Prisma.sql`fe.level = ${resolvedLevel}`);
  if (f.collegeId) where.push(Prisma.sql`u.facultyId = ${f.collegeId}`);
  if (f.departmentId) where.push(Prisma.sql`u.departmentId = ${f.departmentId}`);
  if (f.programmeId) where.push(Prisma.sql`u.programmeId = ${f.programmeId}`);
  if (f.q) {
    const q = `%${String(f.q).trim()}%`;
    where.push(Prisma.sql`(gl.account LIKE ${q} OR gl.description LIKE ${q} OR COALESCE(gl.transactionId,'') LIKE ${q} OR COALESCE(gl.receiptId,'') LIKE ${q})`);
  }
  const whereSql = where.length > 0 ? Prisma.join(where, ' AND ') : Prisma.sql`1=1`;
  type GlSort = 'transactionDate' | 'entryType' | 'account' | 'amount' | 'transactionId';
  const GL_SORTS: ReadonlySet<GlSort> = new Set(['transactionDate','entryType','account','amount','transactionId']);
  const GL_SORT_MAP: Record<GlSort, string> = {
    transactionDate: 'gl.transactionDate', entryType: 'gl.entryType', account: 'gl.account',
    amount: 'gl.amount', transactionId: 'gl.transactionId',
  };
  const sort = GL_SORTS.has(f.sort as GlSort) ? (f.sort as GlSort) : 'transactionDate';
  const order = f.order === 'asc' ? 'ASC' : 'DESC';
  const rowsSql = Prisma.sql`
    SELECT
      gl.id, gl.transactionDate, gl.entryType, gl.description, gl.amount, gl.currency,
      gl.account, gl.counterpartyAccount,
      gl.transactionId, gl.receiptId, gl.userId, gl.invoiceId, gl.meta, gl.createdAt,
      t.reference                                             AS txReference,
      t.gateway                                               AS provider,
      r.receiptNumber,
      CONCAT(u.firstName,' ',u.lastName)                       AS counterparty,
      i.session                                               AS session,
      i.semester                                              AS semester
    FROM GeneralLedger gl
      LEFT JOIN transactions t ON t.id = gl.transactionId
      LEFT JOIN receipts r     ON r.id = gl.receiptId
      LEFT JOIN users u        ON u.id = gl.userId
      LEFT JOIN invoices i     ON i.id = gl.invoiceId
      LEFT JOIN fees fe        ON fe.id = i.feeId
    WHERE ${whereSql}
    ORDER BY ${Prisma.raw(GL_SORT_MAP[sort])} ${Prisma.raw(order)}
    LIMIT ${pageSize} OFFSET ${skip}
  `;
  const countSql = Prisma.sql`SELECT COUNT(*) AS cnt FROM GeneralLedger gl
      LEFT JOIN transactions t ON t.id = gl.transactionId
      LEFT JOIN users u ON u.id = gl.userId
      LEFT JOIN invoices i ON i.id = gl.invoiceId
      LEFT JOIN fees fe ON fe.id = i.feeId
    WHERE ${whereSql}`;
  const [rowsRaw, cntRaw] = await Promise.all([
    prisma.$queryRaw<any[]>(rowsSql),
    prisma.$queryRaw<[{cnt:any}][]>(countSql),
  ]);
  const rows = (Array.isArray(rowsRaw) ? rowsRaw : []).map((r: any) => ({
    id: Number(r.id),
    transactionDate: r.transactionDate ? new Date(r.transactionDate).toISOString() : null,
    entryType: String(r.entryType ?? ''),
    description: r.description ?? null,
    amount: d(r.amount),
    currency: String(r.currency ?? 'NGN'),
    account: String(r.account ?? ''),
    counterpartyAccount: r.counterpartyAccount ?? null,
    transactionId: r.transactionId ? Number(r.transactionId) : null,
    txReference: r.txReference ?? null,
    receiptId: r.receiptId ? Number(r.receiptId) : null,
    receiptNumber: r.receiptNumber ?? null,
    userId: r.userId ? Number(r.userId) : null,
    counterparty: r.counterparty ?? null,
    invoiceId: r.invoiceId ? Number(r.invoiceId) : null,
    session: r.session ?? '',
    semester: r.semester ?? '',
    provider: r.provider ?? '',
  }));
  const total = Number(Array.isArray(cntRaw) && cntRaw.length > 0 ? (cntRaw as any)[0]?.cnt ?? 0 : 0);
  // Summary totals per entryType — ensure all 6 enums always present even if 0
  const sumSql = Prisma.sql`SELECT entryType, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
    FROM GeneralLedger gl
      LEFT JOIN transactions t ON t.id = gl.transactionId
      LEFT JOIN users u ON u.id = gl.userId
      LEFT JOIN invoices i ON i.id = gl.invoiceId
      LEFT JOIN fees fe ON fe.id = i.feeId
    WHERE ${whereSql} GROUP BY entryType`;
  const sumRows = await prisma.$queryRaw<any[]>(sumSql);
  const totalsByEntry: Record<string, { total: number; count: number }> = {};
  const sixEnums: string[] = ['PAYMENT_SUCCESS','REFUND_ISSUED','CONVENIENCE_FEE_INCOME','SERVICE_CHARGE_INCOME','GATEWAY_FEE_EXPENSE','WALLET_CREDIT'];
  for (const k of sixEnums) totalsByEntry[k] = { total: 0, count: 0 };
  for (const s of Array.isArray(sumRows) ? sumRows : []) {
    totalsByEntry[String(s.entryType)] = { total: d(s.total), count: Number(s.cnt ?? 0) };
  }
  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), totalsByEntry };
}

// ---------------------------------------------------------------------------
// R16 — Receipt Register
// Includes voided + exception flags per spec; applies all 14 filter dims.
// ---------------------------------------------------------------------------
export async function receiptRegister(f: ReportFilterCtx & { sort?: string; order?: 'asc'|'desc' }) {
  const page = Math.max(1, Number(f.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Number(f.pageSize ?? 50)));
  const skip = (page - 1) * pageSize;
  const resolvedCategoryId = f.billCategoryId ?? f.feeCategoryId;
  const resolvedBillId = f.billId ?? f.feeId;
  const resolvedLevel = f.levelValue ?? f.level;
  const where: Prisma.Sql[] = [];
  if (f.dateFrom) where.push(Prisma.sql`r.paidAt >= ${f.dateFrom}`);
  if (f.dateTo)   where.push(Prisma.sql`r.paidAt <= ${f.dateTo}`);
  if (f.studentId) where.push(Prisma.sql`r.studentId = ${f.studentId}`);
  if (f.studentMatric) where.push(Prisma.sql`u.matricNumber = ${f.studentMatric}`);
  if (resolvedBillId) where.push(Prisma.sql`i.feeId = ${resolvedBillId}`);
  if (resolvedCategoryId) where.push(Prisma.sql`fe.categoryId = ${resolvedCategoryId}`);
  if (f.provider) where.push(Prisma.sql`t.gateway = ${f.provider}`);
  if (f.session) where.push(Prisma.sql`i.session = ${f.session}`);
  if (f.semester) where.push(Prisma.sql`i.semester = ${f.semester}`);
  if (resolvedLevel) where.push(Prisma.sql`fe.level = ${resolvedLevel}`);
  if (f.collegeId) where.push(Prisma.sql`u.facultyId = ${f.collegeId}`);
  if (f.departmentId) where.push(Prisma.sql`u.departmentId = ${f.departmentId}`);
  if (f.programmeId) where.push(Prisma.sql`u.programmeId = ${f.programmeId}`);
  if (f.paymentStatus) where.push(Prisma.sql`t.status = ${f.paymentStatus}`);
  if (f.q) {
    const q = `%${String(f.q).trim()}%`;
    where.push(Prisma.sql`(r.receiptNumber LIKE ${q} OR u.matricNumber LIKE ${q} OR CONCAT(u.firstName,' ',u.lastName) LIKE ${q} OR t.reference LIKE ${q})`);
  }
  const whereSql = where.length > 0 ? Prisma.join(where, ' AND ') : Prisma.sql`1=1`;
  const allowed: ReadonlySet<string> = new Set(['paidAt','paidAmount','receiptNumber','studentName','provider']);
  const sortRaw = allowed.has(f.sort ?? '') ? f.sort! : 'paidAt';
  const orderRaw = f.order === 'asc' ? 'ASC' : 'DESC';
  const sortMap: Record<string,string> = {
    paidAt: 'r.paidAt', paidAmount: 'r.paidAmount', receiptNumber: 'r.receiptNumber',
    studentName: 'u.lastName', provider: 't.gateway',
  };
  const rowsSql = Prisma.sql`
    SELECT
      r.id, r.receiptNumber, r.paidAt, r.paidAmount, r.convenienceFee, r.serviceCharge, r.gatewayFee, r.totalAmount,
      r.isVoided, r.voidedAt,
      t.reference AS txRef, t.gateway AS provider, t.paystackChannel AS channel, t.status AS txStatus,
      CONCAT(u.firstName,' ',u.lastName) AS student, u.matricNumber,
      fe.name AS bill, fe.feeCode, i.invoiceNumber, i.session, i.semester,
      -- R16 flag columns
      CASE WHEN r.isVoided=1 THEN 1 ELSE 0 END AS voidedFlag,
      CASE WHEN EXISTS (SELECT 1 FROM receipts r2 WHERE r2.receiptNumber = r.receiptNumber AND r2.id <> r.id AND r2.isVoided=0) THEN 1 ELSE 0 END AS duplicateFlag,
      -- R12 exception cross-link
      CASE WHEN t.status<>'SUCCESS' AND r.isVoided=0 THEN 1 ELSE 0 END AS exceptionReceiptNoPayment
    FROM receipts r
      INNER JOIN users u ON u.id = r.studentId
      INNER JOIN transactions t ON t.id = r.transactionId
      LEFT JOIN invoices i ON i.id = r.invoiceId
      LEFT JOIN fees fe ON fe.id = i.feeId
    WHERE ${whereSql}
    ORDER BY ${Prisma.raw(sortMap[sortRaw])} ${Prisma.raw(orderRaw)}
    LIMIT ${pageSize} OFFSET ${skip}
  `;
  const countSql = Prisma.sql`SELECT COUNT(DISTINCT r.id) AS cnt
    FROM receipts r INNER JOIN users u ON u.id=r.studentId INNER JOIN transactions t ON t.id=r.transactionId
      LEFT JOIN invoices i ON i.id=r.invoiceId LEFT JOIN fees fe ON fe.id=i.feeId
    WHERE ${whereSql}`;
  const [rowsRaw, cntRaw] = await Promise.all([
    prisma.$queryRaw<any[]>(rowsSql),
    prisma.$queryRaw<[{cnt:any}][]>(countSql),
  ]);
  const rows = (Array.isArray(rowsRaw) ? rowsRaw : []).map((r: any) => ({
    id: Number(r.id),
    receiptNumber: String(r.receiptNumber ?? ''),
    paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
    student: String(r.student ?? ''),
    matricNumber: r.matricNumber ?? '',
    bill: r.bill ?? '',
    feeCode: r.feeCode ?? '',
    invoiceNumber: r.invoiceNumber ?? '',
    base: d(r.paidAmount),
    convenienceFee: d(r.convenienceFee),
    serviceCharge: d(r.serviceCharge),
    gatewayFee: d(r.gatewayFee),
    total: d(r.totalAmount),
    txRef: r.txRef ?? '',
    provider: r.provider ?? '',
    channel: r.channel ?? null,
    voided: !!r.voidedFlag,
    reissued: !!r.duplicateFlag,
    duplicate: !!r.duplicateFlag,
    exceptionReceiptNoPayment: !!r.exceptionReceiptNoPayment,
  }));
  const total = Number(Array.isArray(cntRaw) && cntRaw.length > 0 ? (cntRaw as any)[0]?.cnt ?? 0 : 0);
  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

// ---------------------------------------------------------------------------
// R17 — Transaction Status breakdown (includes non-SUCCESS explicitly)
// ---------------------------------------------------------------------------
export async function transactionStatusMix(f: ReportFilterCtx) {
  const where: Prisma.Sql[] = [];
  if (f.dateFrom) where.push(Prisma.sql`t.createdAt >= ${f.dateFrom}`);
  if (f.dateTo)   where.push(Prisma.sql`t.createdAt <= ${f.dateTo}`);
  if (f.provider) where.push(Prisma.sql`t.gateway = ${f.provider}`);
  const whereSql = where.length > 0 ? Prisma.join(where, ' AND ') : Prisma.sql`1=1`;
  const sql = Prisma.sql`
    SELECT t.status, COUNT(*) AS cnt, COALESCE(SUM(t.amount),0) AS amount
    FROM transactions t
    WHERE ${whereSql}
    GROUP BY t.status
    ORDER BY cnt DESC
  `;
  const rows = await prisma.$queryRaw<any[]>(sql);
  // Per spec: R17 explicitly reports all statuses. But revenue calc excludes PENDING/FAILED/CANCELLED.
  // This report shows the mix, not included in net revenue.
  // Map statuses → canonical R17 buckets: SUCCESSFUL | PENDING | FAILED | CANCELLED | REFUNDED | PARTIALLY_REFUNDED
  const canonicalMap: Record<string, string> = {
    SUCCESS: 'SUCCESSFUL', PROCESSING: 'PENDING', PENDING: 'PENDING',
    FAILED: 'FAILED', UNDERPAID: 'FAILED', OVERPAID: 'SUCCESSFUL',
    REVERSED: 'CANCELLED',
  };
  const merged: Record<string, {count: number; amount: number}> = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = canonicalMap[String(r.status)] ?? String(r.status);
    if (!merged[key]) merged[key] = { count: 0, amount: 0 };
    merged[key].count += Number(r.cnt ?? 0);
    merged[key].amount += d(r.amount);
  }
  // Ensure canonical 6 keys always present
  const canonicalKeys = ['SUCCESSFUL','PENDING','FAILED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED'];
  for (const k of canonicalKeys) if (!merged[k]) merged[k] = { count: 0, amount: 0 };
  // Refunds from refund table: PAID = REFUNDED, APPROVED/REQUESTED not yet paid = PARTIALLY_REFUNDED
  const refSql = Prisma.sql`
    SELECT status, COUNT(*) AS cnt, COALESCE(SUM(requestedAmount),0) AS amount FROM refunds
    WHERE (${f.dateFrom ? Prisma.sql`createdAt >= ${f.dateFrom}` : Prisma.sql`1=1`})
      AND (${f.dateTo   ? Prisma.sql`createdAt <= ${f.dateTo}`   : Prisma.sql`1=1`})
    GROUP BY status
  `;
  const refRows = await prisma.$queryRaw<any[]>(refSql);
  for (const r of Array.isArray(refRows) ? refRows : []) {
    const s = String(r.status);
    if (s === 'PAID')      { merged['REFUNDED'].count += Number(r.cnt ?? 0); merged['REFUNDED'].amount += d(r.amount); }
    else if (s !== 'REJECTED' && s !== 'FAILED') {
      merged['PARTIALLY_REFUNDED'].count += Number(r.cnt ?? 0);
      merged['PARTIALLY_REFUNDED'].amount += d(r.amount);
    }
  }
  const out: Array<{status: string; count: number; amount: number; includedInRevenue: boolean}> = [];
  for (const k of canonicalKeys) {
    const m = merged[k];
    out.push({
      status: k,
      count: m.count,
      amount: d(m.amount),
      includedInRevenue: k === 'SUCCESSFUL',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// R18 — Comparative Reports (fair-periods only, never whole-last-period)
// D: Today vs Yesterday (1-day buckets)
// M: MTD (1..today) vs Last Month same-day-window (NOT whole previous month)
// S: Session-to-date vs Previous Session same start-duration
// Also honours all baseFilter dims (provider, session, college, student, etc.)
// ---------------------------------------------------------------------------
export async function comparativeReports(range: 'D' | 'M' | 'S', f: ReportFilterCtx) {
  const now = new Date();
  let aFrom: Date, aTo: Date, bFrom: Date, bTo: Date, labelA: string, labelB: string;
  if (range === 'D') {
    aFrom = new Date(now); aFrom.setHours(0,0,0,0); aTo = new Date(aFrom); aTo.setHours(23,59,59,999);
    bFrom = new Date(aFrom); bFrom.setDate(bFrom.getDate() - 1); bTo = new Date(bFrom); bTo.setHours(23,59,59,999);
    labelA = 'Today'; labelB = 'Yesterday';
  } else if (range === 'M') {
    const today = now.getDate();
    aFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    aTo   = new Date(now.getFullYear(), now.getMonth(), today, 23, 59, 59, 999);
    bFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthDayCount = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const safeLastMonthDay = Math.min(today, lastMonthDayCount);
    bTo   = new Date(now.getFullYear(), now.getMonth() - 1, safeLastMonthDay, 23,59,59,999);
    labelA = `This Month (${today} equiv days)`;
    labelB = `Last Month (${safeLastMonthDay} equiv days)`;
  } else {
    // Session: session-start → now relative day offset (fair comparison, never whole session)
    const session = f.session ?? (await prisma.academicSession.findFirst({ where: { isActive: true } }))?.name;
    const activeSesh = await prisma.academicSession.findFirst({
      where: session ? { name: session } : { isActive: true },
    });
    const aSeshStart = activeSesh?.startDate ?? new Date();
    const daysIntoSession = Math.max(1, Math.floor((now.getTime() - aSeshStart.getTime()) / (1000*60*60*24)) + 1);
    const prevYear = activeSesh?.name ? String(activeSesh.name).replace(/\d{4}/, y => String(Number(y) - 1)) : '';
    const prevSesh = prevYear ? await prisma.academicSession.findFirst({ where: { name: prevYear } }) : null;
    const bSeshStart = prevSesh?.startDate ?? new Date(aSeshStart);
    if (!prevSesh) bSeshStart.setFullYear(bSeshStart.getFullYear() - 1);
    aFrom = aSeshStart;
    aTo = new Date(aSeshStart); aTo.setDate(aTo.getDate() + daysIntoSession - 1);
    if (aTo > now) aTo = new Date(now);
    bFrom = bSeshStart;
    bTo = new Date(bSeshStart); bTo.setDate(bTo.getDate() + daysIntoSession - 1);
    labelA = activeSesh?.name ?? 'This Session';
    labelB = prevSesh?.name ?? 'Previous Session';
  }

  const resolvedCategoryId = f.billCategoryId ?? f.feeCategoryId;
  const resolvedBillId = f.billId ?? f.feeId;
  const resolvedLevel = f.levelValue ?? f.level;

  const run = async (from: Date, to: Date) => {
    const conds: Prisma.Sql[] = [
      Prisma.sql`t.status='SUCCESS'`,
      Prisma.sql`r.isVoided=0`,
      Prisma.sql`r.paidAt >= ${from}`,
      Prisma.sql`r.paidAt <= ${to}`,
    ];
    if (f.provider) conds.push(Prisma.sql`t.gateway = ${f.provider}`);
    if (f.studentId) conds.push(Prisma.sql`t.userId = ${f.studentId}`);
    if (f.collegeId) conds.push(Prisma.sql`u.facultyId = ${f.collegeId}`);
    if (f.departmentId) conds.push(Prisma.sql`u.departmentId = ${f.departmentId}`);
    if (f.programmeId) conds.push(Prisma.sql`u.programmeId = ${f.programmeId}`);
    if (f.session) conds.push(Prisma.sql`i.session = ${f.session}`);
    if (f.semester) conds.push(Prisma.sql`i.semester = ${f.semester}`);
    if (resolvedLevel) conds.push(Prisma.sql`fe.level = ${resolvedLevel}`);
    if (resolvedCategoryId) conds.push(Prisma.sql`fe.categoryId = ${resolvedCategoryId}`);
    if (resolvedBillId) conds.push(Prisma.sql`i.feeId = ${resolvedBillId}`);
    const w = Prisma.join(conds, ' AND ');
    const s = await prisma.$queryRaw<Array<{txCount:any;uniquePayers:any;gross:any;refunds:any;net:any}>>(Prisma.sql`
      SELECT COUNT(DISTINCT t.id) AS txCount, COUNT(DISTINCT t.userId) AS uniquePayers,
             COALESCE(SUM(r.paidAmount),0) AS gross,
             COALESCE((SELECT SUM(requestedAmount) FROM refunds WHERE status='PAID' AND updatedAt>=${from} AND updatedAt<=${to}),0) AS refunds,
             COALESCE(SUM(r.paidAmount),0)
             - COALESCE((SELECT SUM(requestedAmount) FROM refunds WHERE status='PAID' AND updatedAt>=${from} AND updatedAt<=${to}),0) AS net
      FROM transactions t
        INNER JOIN receipts r ON r.transactionId=t.id
        INNER JOIN users u     ON u.id = t.userId
        LEFT  JOIN invoices i  ON i.id = t.invoiceId
        LEFT  JOIN fees fe     ON fe.id = i.feeId
      WHERE ${w}
    `);
    const s0 = Array.isArray(s) && s.length > 0 ? s[0] : {} as any;
    return { txCount: Number(s0.txCount ?? 0), uniquePayers: Number(s0.uniquePayers ?? 0), gross: d(s0.gross), refunds: d(s0.refunds), net: d(s0.net) };
  };

  const [a, b] = await Promise.all([run(aFrom, aTo), run(bFrom, bTo)]);
  return {
    rangeA: { label: labelA, from: aFrom.toISOString(), to: aTo.toISOString(), data: a },
    rangeB: { label: labelB, from: bFrom.toISOString(), to: bTo.toISOString(), data: b },
    delta: {
      net: d(a.net - b.net),
      netPct: b.net > 0 ? Number((((a.net - b.net) / b.net) * 100).toFixed(2)) : a.net > 0 ? 100 : 0,
      txCount: a.txCount - b.txCount,
      gross: d(a.gross - b.gross),
    },
  };
}

// ---------------------------------------------------------------------------
// R21 — Audit: record every report export into ReportExport model
// ---------------------------------------------------------------------------
export async function recordReportExport(params: {
  reportUuid: string;
  reportType: any;
  reportName?: string;
  format: 'XLSX' | 'PDF' | 'CSV' | 'JSON';
  generatedById: number;
  dateRangeStart?: Date | null;
  dateRangeEnd?: Date | null;
  filters?: any;
  rowCount: number;
  fileSizeBytes?: bigint | number;
  fileChecksum?: string;
  storagePath?: string;
  downloadUrl?: string;
  errorMessage?: string;
  jobId?: string;
  scheduledReportId?: number;
  expiresAt?: Date;
  status?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
}) {
  try {
    return await prismaAny.reportExport.create({
      data: {
        reportUuid: params.reportUuid,
        reportType: params.reportType,
        reportName: params.reportName ?? null,
        format: params.format,
        status: params.status ?? 'COMPLETED',
        generatedById: params.generatedById,
        dateRangeStart: params.dateRangeStart ?? null,
        dateRangeEnd: params.dateRangeEnd ?? null,
        filters: (params.filters != null ? params.filters : Prisma.JsonNull) as any,
        rowCount: params.rowCount ?? 0,
        fileSizeBytes: params.fileSizeBytes != null ? BigInt(params.fileSizeBytes as any) : null,
        fileChecksum: params.fileChecksum ?? null,
        storagePath: params.storagePath ?? null,
        downloadUrl: params.downloadUrl ?? null,
        errorMessage: params.errorMessage ?? null,
        jobId: params.jobId ?? null,
        scheduledReportId: params.scheduledReportId ?? undefined,
        expiresAt: params.expiresAt ?? null,
      },
    });
  } catch (err: any) {
    // Swallow audit-write failure so export still succeeds — log warn only.
    console.warn('[reportExport] audit record write failed:', String(err?.message ?? err).slice(0, 200));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper for MAX_EXPORT_ROWS hard cap (R19 Export Centre / spec: 250k)
// ---------------------------------------------------------------------------
export const MAX_EXPORT_ROWS = 250_000;
