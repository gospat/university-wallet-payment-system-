// =============================================================================
// BURSARY REPORTS FOUNDATION — regression tests (Task E).
//
// Proves the reporting foundation is financially reliable:
//   • A/B/C  Lagos business-date semantics (inclusive lower / exclusive upper)
//   • D      SUCCESS collections use Receipt.paidAt, not Transaction.createdAt
//   • E/F/G  R10 counts FAILED/PENDING attempts independent of the receipt join
//   • H/I/J  canonical backend ⇄ UI ⇄ export column contracts agree
//   • K      Settlement actualSettlement=null => variance=null (no fake variance)
//   • L      Payment Register renders the documented field set
//   • M      Revenue-by-Bill totals do not multiply because of joins
//   • N/O    Provider filters return only that provider's financial collections
//   • P      Screen and export totals agree for the same filters
//   • Q/R/S  Task F — refund scoping (monthly range, comparative boundary,
//            payment-register provider/student scope)
//   • T-*    Task F — R10 settlement evidence fails closed (NONE/PARTIAL/FULL)
//   • U      Task F — R10 gateway refunds honour the report filter scope
//
// Pure-function tests always run. DB-backed tests execute against the
// development/test DB and are reported as SKIPPED (never silently passed) when
// no database is reachable.
// All fixtures use a synthetic year (2001) so they never collide with real data.
// =============================================================================

import { execFileSync } from 'child_process';
import prisma from '../config/database';
import { Role, TransactionType, TransactionStatus, PaymentGateway, Prisma } from '@prisma/client';
import {
  reportDateRange,
  lagosDayOf,
  lagosDayBounds,
  buildReconciliationStatusFilter,
  dashboardSummaryCards,
  dailyCollections,
  monthlyCollections,
  comparativeReports,
  paymentGatewayReport,
  settlementReport,
  revenueByBill,
  paymentRegister,
  type ReportFilterCtx,
} from '../services/reports/aggregates';
import { EXPORT_COLUMN_CATALOG } from '../services/reportExport/catalog';
import { fetchReportDataForExport } from '../services/reportExport';

// ---------------------------------------------------------------------------
// DB availability probe — resolved SYNCHRONOUSLY at collection time so the
// DB-backed specs can be registered with `it.skip` when no database is
// reachable. A test that early-returns inside its body is recorded by Jest as
// PASSED, which would falsely imply its assertions executed. Skipping at
// registration makes Jest report them as SKIPPED instead.
// ---------------------------------------------------------------------------
function probeDbSync(): boolean {
  if (!process.env.DATABASE_URL) return false;
  const script =
    "const {PrismaClient}=require('@prisma/client');" +
    "const p=new PrismaClient();" +
    "p.$queryRawUnsafe('SELECT 1').then(()=>p.$disconnect())" +
    ".then(()=>process.exit(0)).catch(()=>process.exit(1));";
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: 'ignore', env: process.env, timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}
const DB_AVAILABLE = probeDbSync();
// DB-backed specs: executed when a database is reachable, otherwise reported
// explicitly as SKIPPED (never silently returned as passed).
const dbIt: jest.It = DB_AVAILABLE ? it : it.skip;

// ---------------------------------------------------------------------------
// A/B/C — Lagos business-date semantics (pure).
// ---------------------------------------------------------------------------
describe('Reports — Lagos business-date semantics (pure)', () => {
  it('A. a single Lagos day is the whole selected business day (half-open)', () => {
    // Bursary selects 15 October 2026 (date-only → UTC midnight).
    const { fromInclusive, toExclusive } = reportDateRange({
      dateFrom: new Date('2026-10-15T00:00:00.000Z'),
      dateTo: new Date('2026-10-15T00:00:00.000Z'),
    });
    expect(fromInclusive!.toISOString()).toBe('2026-10-14T23:00:00.000Z');
    expect(toExclusive!.toISOString()).toBe('2026-10-15T23:00:00.000Z');
    // Lower INCLUSIVE, upper EXCLUSIVE.
    expect(fromInclusive!.getTime()).toBeLessThan(toExclusive!.getTime());
  });

  it('B. a multi-day range includes the entire final selected Lagos day', () => {
    const { fromInclusive, toExclusive } = reportDateRange({
      dateFrom: new Date('2026-10-13T00:00:00.000Z'),
      dateTo: new Date('2026-10-15T00:00:00.000Z'),
    });
    // 13 Oct 00:00 Lagos → 16 Oct 00:00 Lagos (exclusive).
    expect(fromInclusive!.toISOString()).toBe('2026-10-12T23:00:00.000Z');
    expect(toExclusive!.toISOString()).toBe('2026-10-15T23:00:00.000Z');
    // A Lagos instant late on 15 Oct (e.g. 22:30 Lagos = 21:30Z) is INSIDE.
    const lateOnLastDay = new Date('2026-10-15T21:30:00.000Z');
    expect(lateOnLastDay.getTime()).toBeGreaterThanOrEqual(fromInclusive!.getTime());
    expect(lateOnLastDay.getTime()).toBeLessThan(toExclusive!.getTime());
  });

  it('C. an instant exactly at toExclusive is excluded', () => {
    const { toExclusive } = reportDateRange({
      dateFrom: new Date('2026-10-15T00:00:00.000Z'),
      dateTo: new Date('2026-10-15T00:00:00.000Z'),
    });
    // 16 Oct 00:00 Lagos == toExclusive. `< toExclusive` must be false.
    const atBoundary = new Date('2026-10-15T23:00:00.000Z');
    expect(atBoundary.getTime()).toBe(toExclusive!.getTime());
    expect(atBoundary.getTime() < toExclusive!.getTime()).toBe(false);
  });

  it('one-sided ranges: from-only keeps the inclusive lower bound, to-only the exclusive upper', () => {
    const fromOnly = reportDateRange({ dateFrom: new Date('2026-10-15T00:00:00.000Z') });
    expect(fromOnly.fromInclusive!.toISOString()).toBe('2026-10-14T23:00:00.000Z');
    expect(fromOnly.toExclusive).toBeUndefined();

    const toOnly = reportDateRange({ dateTo: new Date('2026-10-15T00:00:00.000Z') });
    expect(toOnly.toExclusive!.toISOString()).toBe('2026-10-15T23:00:00.000Z');
    expect(toOnly.fromInclusive).toBeUndefined();

    expect(reportDateRange({})).toEqual({});
  });

  it('lagosDayOf/lagosDayBounds bucket a UTC instant into the correct Lagos calendar day', () => {
    // 23:30Z on 14 Oct is already 00:30 Lagos on 15 Oct.
    const lagosDay = lagosDayOf(new Date('2026-10-14T23:30:00.000Z'));
    expect(lagosDay.toISOString()).toBe('2026-10-15T00:00:00.000Z');

    const { fromInclusive, toExclusive } = lagosDayBounds(lagosDay, lagosDayOf(new Date('2026-10-15T23:30:00.000Z')));
    expect(fromInclusive.toISOString()).toBe('2026-10-14T23:00:00.000Z');
    expect(toExclusive.toISOString()).toBe('2026-10-16T23:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// buildReconciliationStatusFilter — single value AND array (frontend facets).
// ---------------------------------------------------------------------------
describe('Reports — reconciliationStatus filter accepts a single enum OR an array', () => {
  it('returns null when unset/empty', () => {
    expect(buildReconciliationStatusFilter({})).toBeNull();
    expect(buildReconciliationStatusFilter({ reconciliationStatus: [] })).toBeNull();
  });

  it('binds a single value as a parameter (no injection surface)', () => {
    const frag = buildReconciliationStatusFilter({ reconciliationStatus: 'MATCHED' }) as Prisma.Sql;
    const sql = (frag as any).sql as string;
    const values = (frag as any).values as any[];
    expect(sql).toContain('COALESCE(s.status');
    expect(sql).toContain('IN (');
    expect(sql).not.toContain('MATCHED'); // literal must NOT be inlined
    expect(values).toContain('MATCHED');
  });

  it('binds every element of an array (RECONCILED / UNRECONCILED facets)', () => {
    const frag = buildReconciliationStatusFilter({
      reconciliationStatus: ['MATCHED', 'SETTLED', 'PARTIALLY_MATCHED'],
    }) as Prisma.Sql;
    const values = (frag as any).values as any[];
    expect(values).toEqual(expect.arrayContaining(['MATCHED', 'SETTLED', 'PARTIALLY_MATCHED']));
    expect(values.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// H/I/J/L — canonical contract agreement: UI column keys ⇄ export catalog.
// These lists mirror GenericReport.tsx COLS + reportsApi.ts so that any drift
// in the export catalog is caught immediately.
// ---------------------------------------------------------------------------
describe('Reports — backend/UI/export column contracts agree', () => {
  const UI_COLUMNS: Record<string, string[]> = {
    daily: ['date', 'txCount', 'studentCount', 'bellsCollection', 'convenienceFee', 'serviceCharge', 'gatewayFee', 'totalCharged', 'refunds', 'netBellsCollection'],
    monthly: ['month', 'txCount', 'uniquePayers', 'bellsCollection', 'charges', 'totalCharged', 'refunds', 'netBellsCollection'],
    hierarchical: ['collegeName', 'deptName', 'progName', 'txCount', 'uniquePayers', 'collected', 'convenienceFee', 'serviceCharge', 'gatewayFee'],
    gateway: ['provider', 'successCount', 'failCount', 'pendingCount', 'gross', 'gatewayFees', 'expectedSettlement', 'fullySettledCount', 'partialSettlementCount', 'settlementEvidenceCount', 'settlementCoverage', 'actualSettlement', 'settlementVariance'],
    settlement: ['transactionReference', 'provider', 'paymentDate', 'paymentAmount', 'gatewayFee', 'expectedSettlement', 'settlementDate', 'settlementRef', 'actualSettlement', 'variance'],
    payment_register: ['createdAt', 'studentName', 'matricNumber', 'provider', 'billName', 'baseAmount', 'convenienceFee', 'gatewayFee', 'totalAmount', 'status', 'receiptNumber'],
  };

  for (const [reportKey, keys] of Object.entries(UI_COLUMNS)) {
    it(`${reportKey}: every on-screen column exists in the export catalog`, () => {
      const catalogKeys = new Set(EXPORT_COLUMN_CATALOG[reportKey as keyof typeof EXPORT_COLUMN_CATALOG].map((c) => c.key));
      for (const k of keys) expect(catalogKeys.has(k)).toBe(true);
    });
  }

  it('H. Daily Collections uses a single canonical date field name ("date", never "day")', () => {
    const keys = EXPORT_COLUMN_CATALOG.daily.map((c) => c.key);
    expect(keys).toContain('date');
    expect(keys).not.toContain('day');
  });

  it('I. Gateway report uses "gatewayFees" (not the legacy "gwFees")', () => {
    const keys = EXPORT_COLUMN_CATALOG.gateway.map((c) => c.key);
    expect(keys).toContain('gatewayFees');
    expect(keys).not.toContain('gwFees');
  });

  it('J. Settlement report exposes the canonical descriptive field names', () => {
    const keys = EXPORT_COLUMN_CATALOG.settlement.map((c) => c.key);
    for (const k of ['transactionReference', 'paymentDate', 'paymentAmount', 'gatewayFee', 'expectedSettlement', 'settlementDate', 'actualSettlement', 'variance', 'reconciliationStatus']) {
      expect(keys).toContain(k);
    }
    for (const legacy of ['txRef', 'paymentDt', 'paymentAmt', 'gwFee', 'settlementDt']) {
      expect(keys).not.toContain(legacy);
    }
  });
});

// ---------------------------------------------------------------------------
// DB-backed financial semantics.
// ---------------------------------------------------------------------------
describe('Reports — DB-backed financial semantics', () => {
  let studentId: number | null = null;

  const txIds: number[] = [];
  const receiptIds: number[] = [];
  const invoiceIds: number[] = [];
  const feeIds: number[] = [];
  const refundIds: number[] = [];
  const settlementIds: number[] = [];
  const extraUserIds: number[] = [];

  // Synthetic days (year 2001) — effectively impossible to collide with real data.
  const DAY_SUCCESS = '2001-02-03';
  const DAY_BOUNDARY_OUT = '2001-02-05';
  const DAY_ATTEMPTS = '2001-02-07';
  const DAY_SETTLEMENT = '2001-02-09';
  const DAY_REVENUE = '2001-02-11';
  const DAY_REGISTER = '2001-02-13';
  const DAY_GW_NONE = '2001-02-15';
  const DAY_GW_FULL = '2001-02-17';
  const DAY_GW_PARTIAL = '2001-02-19';
  const DAY_GW_SCOPE = '2001-02-21';

  function dayCtx(day: string): ReportFilterCtx {
    return { dateFrom: new Date(`${day}T00:00:00.000Z`), dateTo: new Date(`${day}T00:00:00.000Z`) };
  }

  beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    // A DEDICATED synthetic student, so these specs never share scope with real
    // students (critical for the comparative/register refund isolation specs).
    const s = await prisma.user.create({
      data: {
        email: `report-foundation-${Date.now()}@university.edu.ng`,
        password: '$2b$10$testpasswordhash',
        firstName: 'Report',
        lastName: 'Foundation',
        role: Role.STUDENT,
        matricNumber: `RF-${Date.now()}`,
      },
      select: { id: true },
    });
    studentId = s.id;
  });

  afterEach(async () => {
    if (refundIds.length) { await prisma.refund.deleteMany({ where: { id: { in: refundIds } } }); refundIds.length = 0; }
    if (settlementIds.length) { await prisma.settlement.deleteMany({ where: { id: { in: settlementIds } } }); settlementIds.length = 0; }
    if (receiptIds.length) { await prisma.receipt.deleteMany({ where: { id: { in: receiptIds } } }); receiptIds.length = 0; }
    if (txIds.length) { await prisma.transaction.deleteMany({ where: { id: { in: txIds } } }); txIds.length = 0; }
    if (invoiceIds.length) { await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } }); invoiceIds.length = 0; }
    if (feeIds.length) { await prisma.fee.deleteMany({ where: { id: { in: feeIds } } }); feeIds.length = 0; }
    if (extraUserIds.length) { await prisma.user.deleteMany({ where: { id: { in: extraUserIds } } }); extraUserIds.length = 0; }
  });

  afterAll(async () => {
    if (!DB_AVAILABLE || !studentId) return;
    // Leftovers are already cleared per-test; delete the dedicated student.
    await prisma.receipt.deleteMany({ where: { studentId } });
    await prisma.refund.deleteMany({ where: { requestedById: studentId } });
    await prisma.settlement.deleteMany({ where: { transaction: { userId: studentId } } });
    await prisma.transaction.deleteMany({ where: { userId: studentId } });
    await prisma.invoice.deleteMany({ where: { studentId } });
    await prisma.user.delete({ where: { id: studentId } });
  });

  let seq = 0;
  async function makeSuccessTx(opts: {
    gateway: PaymentGateway;
    amount: number;
    paidAt: Date;
    createdAt?: Date;
    convenienceFee?: number;
    serviceCharge?: number;
    gatewayFee?: number;
    feeId?: number;
    invoiceId?: number;
    userId?: number;
  }) {
    seq += 1;
    const ref = `RPT-FND-${Date.now()}-${seq}`;
    const owner = opts.userId ?? studentId!;
    const tx = await prisma.transaction.create({
      data: {
        reference: ref,
        userId: owner,
        gateway: opts.gateway,
        amount: opts.amount,
        type: TransactionType.FEE_PAYMENT,
        status: TransactionStatus.SUCCESS,
        createdAt: opts.createdAt ?? opts.paidAt,
        invoiceId: opts.invoiceId ?? null,
      },
    });
    txIds.push(tx.id);
    const receipt = await prisma.receipt.create({
      data: {
        receiptNumber: `RCPT-${ref}`,
        verificationToken: `vt-${ref}`,
        transactionId: tx.id,
        studentId: owner,
        invoiceId: opts.invoiceId ?? null,
        paidAmount: opts.amount,
        convenienceFee: opts.convenienceFee ?? 0,
        serviceCharge: opts.serviceCharge ?? 0,
        gatewayFee: opts.gatewayFee ?? 0,
        totalAmount: opts.amount + (opts.convenienceFee ?? 0) + (opts.serviceCharge ?? 0) + (opts.gatewayFee ?? 0),
        paidAt: opts.paidAt,
        isVoided: false,
      },
    });
    receiptIds.push(receipt.id);
    return { tx, receipt };
  }

  async function makeAttemptTx(opts: {
    gateway: PaymentGateway;
    amount: number;
    createdAt: Date;
    status: TransactionStatus;
  }) {
    seq += 1;
    const ref = `RPT-ATT-${Date.now()}-${seq}`;
    const tx = await prisma.transaction.create({
      data: {
        reference: ref,
        userId: studentId!,
        gateway: opts.gateway,
        amount: opts.amount,
        type: TransactionType.FEE_PAYMENT,
        status: opts.status,
        createdAt: opts.createdAt,
      },
    });
    txIds.push(tx.id);
    return tx;
  }

  // Create an extra synthetic student (isolated from the dedicated one) for
  // cross-student scope isolation tests. Cleaned up in afterEach.
  async function makeStudent() {
    seq += 1;
    const s = await prisma.user.create({
      data: {
        email: `report-extra-${Date.now()}-${seq}@university.edu.ng`,
        password: '$2b$10$testpasswordhash',
        firstName: 'Extra',
        lastName: `Student${seq}`,
        role: Role.STUDENT,
        matricNumber: `RFX-${Date.now()}-${seq}`,
      },
      select: { id: true },
    });
    extraUserIds.push(s.id);
    return s.id;
  }

  // A PAID refund against an original transaction, with its COMPLETION date
  // pinned deterministically. Refund.updatedAt is @updatedAt (Prisma-managed),
  // so it must be set via raw SQL to model "refund completed at <date>".
  async function makePaidRefund(originalTransactionId: number, amount: number, completedAt: Date, requestedById?: number) {
    seq += 1;
    const refund = await prisma.refund.create({
      data: {
        refundNumber: `RFD-RPT-${Date.now()}-${seq}`,
        originalTransactionId,
        requestedAmount: amount,
        reason: 'reports-foundation test refund',
        status: 'PAID',
        requestedById: requestedById ?? studentId!,
        paidAt: completedAt,
      },
    });
    refundIds.push(refund.id);
    await prisma.$executeRaw`UPDATE refunds SET updatedAt = ${completedAt} WHERE id = ${refund.id}`;
    return refund;
  }

  // An authoritative Settlement record for a successful transaction.
  async function makeSettlement(
    transactionId: number,
    gateway: PaymentGateway,
    paymentAmount: number,
    actualSettlement: number | null,
    status: 'PENDING_SETTLEMENT' | 'SETTLED' | 'MATCHED' | 'PARTIALLY_MATCHED' = 'SETTLED',
    // Settlement.paymentDate drives settlementReport's date filter
    // (COALESCE(s.paymentDate, r.paidAt)). Tests that scope settlementReport to a
    // synthetic day must pin it inside that day, else the row is out of range.
    paymentDate?: Date,
  ) {
    seq += 1;
    const s = await prisma.settlement.create({
      data: {
        settlementRef: `SET-RPT-${Date.now()}-${seq}`,
        transactionId,
        gateway,
        paymentAmount,
        gatewayFee: 0,
        expectedSettlement: paymentAmount,
        actualSettlement,
        paymentDate: paymentDate ?? new Date(),
        status,
      },
    });
    settlementIds.push(s.id);
    return s;
  }

  dbIt('D. SUCCESS collection is dated by Receipt.paidAt, not Transaction.createdAt', async () => {
    // created long before the Lagos day; receipt.paidAt inside the day.
    await makeSuccessTx({
      gateway: PaymentGateway.PAYSTACK,
      amount: 100,
      createdAt: new Date('2001-01-01T00:00:00.000Z'),
      paidAt: new Date(`${DAY_SUCCESS}T12:00:00.000Z`),
    });

    const rows = await dailyCollections(dayCtx(DAY_SUCCESS));
    const dayRow = rows.find((r: any) => r.date === DAY_SUCCESS)!;
    expect(dayRow).toBeTruthy();
    // The 100 collected must be attributed to the paidAt day (only our fixture
    // exists on this synthetic day), proving paidAt — not createdAt — is used.
    expect(Number(dayRow.gross)).toBe(100);
  });

  dbIt('C(DB). A receipt paid exactly at toExclusive is EXCLUDED from the selected day', async () => {
    const ctx = dayCtx(DAY_BOUNDARY_OUT);
    const { toExclusive } = reportDateRange(ctx);
    await makeSuccessTx({
      gateway: PaymentGateway.PAYSTACK,
      amount: 777,
      paidAt: toExclusive!, // == 16 Oct-style boundary, exclusive
    });
    const rows = await dailyCollections(ctx);
    const total = rows.reduce((s: number, r: any) => s + Number(r.gross ?? 0), 0);
    expect(total).toBe(0); // the boundary payment must not be counted
  });

  dbIt('E/F. R10 counts FAILED/PENDING attempts even when a SUCCESS receipt exists in range', async () => {
    const ctx = dayCtx(DAY_ATTEMPTS);
    await makeSuccessTx({
      gateway: PaymentGateway.PAYSTACK,
      amount: 100,
      paidAt: new Date(`${DAY_ATTEMPTS}T10:00:00.000Z`),
    });
    await makeAttemptTx({ gateway: PaymentGateway.PAYSTACK, amount: 50, status: TransactionStatus.FAILED, createdAt: new Date(`${DAY_ATTEMPTS}T11:00:00.000Z`) });
    await makeAttemptTx({ gateway: PaymentGateway.PAYSTACK, amount: 50, status: TransactionStatus.PENDING, createdAt: new Date(`${DAY_ATTEMPTS}T12:00:00.000Z`) });

    const rows = await paymentGatewayReport(ctx);
    const ps = rows.find((r: any) => r.provider === 'PAYSTACK')!;
    expect(ps).toBeTruthy();
    expect(ps.successCount).toBeGreaterThanOrEqual(1);
    // Would be 0 if the successful-receipt join filtered attempts out.
    expect(ps.failCount).toBeGreaterThanOrEqual(1);
    expect(ps.pendingCount).toBeGreaterThanOrEqual(1);
    expect(ps.gatewayFees).toBeGreaterThanOrEqual(0);
    // Expected settlement is (success amount − summed gateway fees), never a bare subtraction of one row.
    expect(ps.expectedSettlement).toBeCloseTo(ps.gross - ps.gatewayFees, 2);
  });

  dbIt('G/N/O. Provider filtering isolates each gateway and returns only its financial collections', async () => {
    const ctx = dayCtx(DAY_SUCCESS);
    await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 100, paidAt: new Date(`${DAY_SUCCESS}T09:00:00.000Z`) });
    await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 200, paidAt: new Date(`${DAY_SUCCESS}T09:30:00.000Z`) });

    const psRows = await dailyCollections({ ...ctx, provider: PaymentGateway.PAYSTACK });
    for (const r of psRows) {
      // Only the Paystack fixture existed on this synthetic day, so exactly 100.
      expect(Number(r.gross)).toBe(100);
    }
    const alatRows = await dailyCollections({ ...ctx, provider: PaymentGateway.ALATPAY });
    for (const r of alatRows) {
      expect(Number(r.gross)).toBe(200);
    }
  });

  dbIt('K. Settlement with no Settlement row yields actualSettlement=null, variance=null (no fake variance)', async () => {
    const ctx = dayCtx(DAY_SETTLEMENT);
    const ref = await makeSuccessTx({
      gateway: PaymentGateway.PAYSTACK,
      amount: 100,
      paidAt: new Date(`${DAY_SETTLEMENT}T14:00:00.000Z`),
    });
    const result = await settlementReport({ ...ctx });
    const row = result.rows.find((r: any) => r.transactionReference === ref.tx.reference)!;
    expect(row).toBeTruthy();
    expect(row.actualSettlement).toBeNull();
    expect(row.variance).toBeNull();          // NOT 0 − expectedSettlement
    expect(row.settlementDate).toBeNull();
    expect(row.settlementRef).toBeNull();
    expect(row.reconciliationStatus).toBe('PENDING_SETTLEMENT');
  });

  dbIt('M. Revenue-by-Bill collected total does not multiply because of invoice/payment joins', async () => {
    // Derive the required Fee FK fields from an existing fee so this fixture is
    // valid against the real schema (Fee requires categoryId/academicSession/createdById).
    const sample = await prisma.fee.findFirst({ select: { categoryId: true, createdById: true, academicSession: true } });
    // Fail LOUDLY (never a silent pass) if the seeded environment is missing fees.
    if (!sample) throw new Error('DB-backed test requires at least one seeded fee row');

    const suffix = `${Date.now()}`;
    const fee = await prisma.fee.create({
      data: {
        name: `RPT Fee ${suffix}`,
        feeCode: `RPT-${suffix}`,
        categoryId: sample.categoryId,
        createdById: sample.createdById,
        amount: 100,
        academicSession: sample.academicSession,
        level: 1,
        isActive: true,
      } as any,
    });
    feeIds.push(fee.id);

    const revenueDay = new Date(`${DAY_REVENUE}T12:00:00.000Z`);
    // Two invoices for the same fee (expected 200 total), but only ONE is paid.
    const inv1 = await prisma.invoice.create({ data: { invoiceNumber: `RPT-INV-${suffix}-1`, studentId: studentId!, feeId: fee.id, amountDue: 100, amountPaid: 100, status: 'PAID', session: '2001/2002', createdAt: revenueDay } as any });
    const inv2 = await prisma.invoice.create({ data: { invoiceNumber: `RPT-INV-${suffix}-2`, studentId: studentId!, feeId: fee.id, amountDue: 100, amountPaid: 0, status: 'UNPAID', session: '2001/2002', createdAt: revenueDay } as any });
    invoiceIds.push(inv1.id, inv2.id);

    await makeSuccessTx({
      gateway: PaymentGateway.PAYSTACK,
      amount: 100,
      paidAt: revenueDay,
      feeId: fee.id,
      invoiceId: inv1.id,
    });

    const rows = await revenueByBill({ ...dayCtx(DAY_REVENUE), feeId: fee.id });
    const row = rows.find((r: any) => r.billId === fee.id)!;
    expect(row).toBeTruthy();
    // Collected counted once (100), not once per joined invoice.
    expect(row.collected).toBe(100);
    // Expected revenue is the sum of the fee's invoices (each counted once).
    expect(row.expectedAmount).toBe(200);
  });

  dbIt('L. Payment Register exposes the documented field set for each successful payment', async () => {
    const ctx = dayCtx(DAY_SUCCESS);
    await makeSuccessTx({
      gateway: PaymentGateway.PAYSTACK,
      amount: 100,
      convenienceFee: 2,
      serviceCharge: 3,
      gatewayFee: 1.5,
      paidAt: new Date(`${DAY_SUCCESS}T15:00:00.000Z`),
    });
    const reg = await paymentRegister({ ...ctx, page: 1, pageSize: 50 } as any);
    expect(reg.rows.length).toBeGreaterThanOrEqual(1);
    const row = reg.rows[0];
    for (const k of ['transactionId', 'createdAt', 'paidAt', 'studentName', 'matricNumber', 'college', 'department', 'programme', 'level', 'session', 'billName', 'baseAmount', 'convenienceFee', 'serviceCharge', 'gatewayFee', 'totalAmount', 'provider', 'status', 'transactionReference', 'gatewayReference', 'receiptNumber']) {
      expect(Object.prototype.hasOwnProperty.call(row, k)).toBe(true);
    }
  });

  dbIt('P. Screen and export produce identical Daily Collections rows for the same filters', async () => {
    const ctx = dayCtx(DAY_SUCCESS);
    await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 100, paidAt: new Date(`${DAY_SUCCESS}T08:00:00.000Z`) });

    const screen = await dailyCollections(ctx);
    const exported = await fetchReportDataForExport('DAILY_COLLECTIONS', ctx);
    expect(exported.rows).toEqual(screen);
    expect(exported.columnsKey).toBe('daily');
  });

  dbIt('P2. Screen and export produce identical Gateway report rows for the same filters', async () => {
    const ctx = dayCtx(DAY_ATTEMPTS);
    await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 100, paidAt: new Date(`${DAY_ATTEMPTS}T08:00:00.000Z`) });
    await makeAttemptTx({ gateway: PaymentGateway.ALATPAY, amount: 40, status: TransactionStatus.FAILED, createdAt: new Date(`${DAY_ATTEMPTS}T09:00:00.000Z`) });

    const screen = await paymentGatewayReport(ctx);
    const exported = await fetchReportDataForExport('PAYMENT_GATEWAY', ctx);
    expect(exported.rows).toEqual(screen);
    expect(exported.columnsKey).toBe('gateway');
  });

  // =========================================================================
  // Task F follow-up regressions.
  // =========================================================================

  dbIt('Q. Monthly refunds are limited to the selected Lagos date range (same-month refund outside range excluded)', async () => {
    const day = '2001-04-15';
    const ctx = dayCtx(day);
    const { tx } = await makeSuccessTx({
      gateway: PaymentGateway.ALATPAY,
      amount: 100,
      paidAt: new Date(`${day}T10:00:00.000Z`),
    });
    // Refund completed INSIDE the selected Lagos day (15 Apr).
    await makePaidRefund(tx.id, 10, new Date(`${day}T12:00:00.000Z`));
    // Refund completed LATER in the SAME calendar month but OUTSIDE the range.
    await makePaidRefund(tx.id, 50, new Date('2001-04-25T12:00:00.000Z'));

    const rows = await monthlyCollections(ctx);
    const april = rows.find((r: any) => r.month === '2001-04')!;
    expect(april).toBeTruthy();
    expect(april.gross).toBe(100);
    // Only the in-range refund (10) counts — the 50 from 25 Apr must be excluded
    // even though it falls in the same calendar month.
    expect(april.refunds).toBe(10);
  });

  dbIt('R. Comparative refunds: a refund exactly at toExclusive is excluded from the bucket (no double count)', async () => {
    // Derive today's Lagos bucket with the SAME helpers the implementation uses.
    const todayLagos = lagosDayOf(new Date());
    const { fromInclusive: aFrom, toExclusive: aTo } = lagosDayBounds(todayLagos, todayLagos);
    const insidePaidAt = new Date(aFrom.getTime() + 3 * 3600 * 1000);
    const { tx } = await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 100, paidAt: insidePaidAt });
    // In-bucket refund.
    await makePaidRefund(tx.id, 10, new Date(aFrom.getTime() + 4 * 3600 * 1000));
    // Refund EXACTLY at the exclusive upper bound (start of the NEXT Lagos day).
    await makePaidRefund(tx.id, 50, aTo);

    const cmp = await comparativeReports('D', { studentId: studentId! });
    // The boundary refund belongs to the FOLLOWING period only, never this one.
    expect(cmp.rangeA.data.refunds).toBe(10);
    // Yesterday's bucket's upper bound is today's lower bound, so the boundary
    // instant is not in it either — it is not double-counted anywhere.
    expect(cmp.rangeB.data.refunds).toBe(0);
  });

  dbIt('S. Payment Register refund summary respects provider & student scope (no cross-scope subtraction)', async () => {
    const studentB = await makeStudent();
    const day = DAY_REGISTER;
    const { tx: txAAlat } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 1000, paidAt: new Date(`${day}T10:00:00.000Z`) });
    const { tx: txAPs }   = await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 500, paidAt: new Date(`${day}T11:00:00.000Z`) });
    const { tx: txBAlat } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 300, paidAt: new Date(`${day}T12:00:00.000Z`), userId: studentB });

    await makePaidRefund(txAAlat.id, 100, new Date(`${day}T13:00:00.000Z`));
    await makePaidRefund(txAPs.id,   200, new Date(`${day}T13:30:00.000Z`));
    await makePaidRefund(txBAlat.id,  50, new Date(`${day}T14:00:00.000Z`), studentB);

    const base = dayCtx(day);
    // ALATPay register must NOT subtract the Paystack refund (200).
    const alat = await paymentRegister({ ...base, provider: PaymentGateway.ALATPAY, page: 1, pageSize: 50 });
    expect(alat.summary.refunds).toBe(150); // 100 (A) + 50 (B); Paystack 200 excluded
    // Paystack register must NOT subtract the ALATPay refunds (100 + 50).
    const ps = await paymentRegister({ ...base, provider: PaymentGateway.PAYSTACK, page: 1, pageSize: 50 });
    expect(ps.summary.refunds).toBe(200);
    // Student A register must NOT subtract student B's refund (50).
    const stuA = await paymentRegister({ ...base, studentId: studentId!, page: 1, pageSize: 50 });
    expect(stuA.summary.refunds).toBe(300); // 100 + 200
    const stuB = await paymentRegister({ ...base, studentId: studentB, page: 1, pageSize: 50 });
    expect(stuB.summary.refunds).toBe(50);
    // Combined scope: ALATPay + student A.
    const alatA = await paymentRegister({ ...base, provider: PaymentGateway.ALATPAY, studentId: studentId!, page: 1, pageSize: 50 });
    expect(alatA.summary.refunds).toBe(100);
  });

  dbIt('T-A. R10 with NO settlement evidence: actualSettlement=null, settlementVariance=null, coverage NONE', async () => {
    const ctx = dayCtx(DAY_GW_NONE);
    await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 100, paidAt: new Date(`${DAY_GW_NONE}T10:00:00.000Z`) });

    const rows = await paymentGatewayReport(ctx);
    const alat = rows.find((r: any) => r.provider === 'ALATPAY')!;
    expect(alat).toBeTruthy();
    expect(alat.expectedSettlement).toBeCloseTo(100, 2);
    expect(alat.settlementCoverage).toBe('NONE');
    // Unknown settlement must NEVER be reported as ₦0 received.
    expect(alat.actualSettlement).toBeNull();
    expect(alat.settlementVariance).toBeNull();
  });

  dbIt('T-B. R10 with FULL settlement evidence: actual total and variance are computed', async () => {
    const ctx = dayCtx(DAY_GW_FULL);
    const { tx: txA } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 100, paidAt: new Date(`${DAY_GW_FULL}T10:00:00.000Z`) });
    await makeSettlement(txA.id, PaymentGateway.ALATPAY, 100, 100, 'SETTLED');
    const { tx: txP } = await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 200, paidAt: new Date(`${DAY_GW_FULL}T11:00:00.000Z`) });
    await makeSettlement(txP.id, PaymentGateway.PAYSTACK, 200, 190, 'MATCHED');

    const rows = await paymentGatewayReport(ctx);
    const alat = rows.find((r: any) => r.provider === 'ALATPAY')!;
    const ps = rows.find((r: any) => r.provider === 'PAYSTACK')!;
    expect(alat.settlementCoverage).toBe('FULL');
    expect(alat.actualSettlement).toBe(100);
    expect(alat.settlementVariance).toBe(0);
    expect(ps.settlementCoverage).toBe('FULL');
    expect(ps.actualSettlement).toBe(190);
    // CANONICAL sign: variance = ACTUAL − EXPECTED = 190 − 200 = −10 (shortfall).
    expect(ps.settlementVariance).toBe(-10);
  });

  dbIt('T-C. R10 with PARTIAL settlement evidence: coverage PARTIAL and no misleading full-period variance', async () => {
    const ctx = dayCtx(DAY_GW_PARTIAL);
    const { tx: settled } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 200, paidAt: new Date(`${DAY_GW_PARTIAL}T10:00:00.000Z`) });
    await makeSettlement(settled.id, PaymentGateway.ALATPAY, 200, 195, 'SETTLED');
    // A second successful payment with NO settlement evidence.
    await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 100, paidAt: new Date(`${DAY_GW_PARTIAL}T11:00:00.000Z`) });

    const rows = await paymentGatewayReport(ctx);
    const alat = rows.find((r: any) => r.provider === 'ALATPAY')!;
    expect(alat.successCount).toBe(2);
    expect(alat.settlementEvidenceCount).toBe(1);
    expect(alat.settlementCoverage).toBe('PARTIAL');
    expect(alat.actualSettlement).toBe(195);    // only the available evidence
    // Must NOT compare the FULL expected amount against partial actual evidence.
    expect(alat.settlementVariance).toBeNull();
  });

  dbIt('U. R10 gateway refund summary is scoped to the report filters (no cross-scope refund subtraction)', async () => {
    const studentB = await makeStudent();
    const day = DAY_GW_SCOPE;
    // Student A: ALATPAY success + refund (100) and PAYSTACK success + refund (40).
    const { tx: txAAlat } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 1000, paidAt: new Date(`${day}T10:00:00.000Z`) });
    const { tx: txAPs }   = await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 500, paidAt: new Date(`${day}T11:00:00.000Z`) });
    // Student B: ALATPAY refund (60) — must never be subtracted from A's rows.
    const { tx: txBAlat } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 300, paidAt: new Date(`${day}T12:00:00.000Z`), userId: studentB });
    await makePaidRefund(txAAlat.id, 100, new Date(`${day}T13:00:00.000Z`));
    await makePaidRefund(txAPs.id,    40, new Date(`${day}T13:30:00.000Z`));
    await makePaidRefund(txBAlat.id,  60, new Date(`${day}T14:00:00.000Z`), studentB);

    const base = dayCtx(day);
    // Whole scope: ALATPAY = 100 (A) + 60 (B); PAYSTACK = 40 (A).
    const all = await paymentGatewayReport(base);
    expect(all.find((r: any) => r.provider === 'ALATPAY')!.refunds).toBe(160);
    expect(all.find((r: any) => r.provider === 'PAYSTACK')!.refunds).toBe(40);
    // Student A only: the ALATPAY row must exclude student B's 60.
    const stuA = await paymentGatewayReport({ ...base, studentId: studentId! });
    expect(stuA.find((r: any) => r.provider === 'ALATPAY')!.refunds).toBe(100);
    expect(stuA.find((r: any) => r.provider === 'PAYSTACK')!.refunds).toBe(40);
    // Provider filter: the PAYSTACK row must never subtract the ALATPAY refunds.
    const ps = await paymentGatewayReport({ ...base, provider: PaymentGateway.PAYSTACK });
    expect(ps.find((r: any) => r.provider === 'PAYSTACK')!.refunds).toBe(40);
  });

  // =========================================================================
  // Task G follow-up regressions — FINAL REPORTS FOUNDATION CORRECTION.
  // =========================================================================

  dbIt('V. R1 dashboard summary resolves every documented detail filter (no missing SQL alias) and respects scope', async () => {
    const day = '2001-06-01';
    await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 100, paidAt: new Date(`${day}T10:00:00.000Z`) });
    const base = dayCtx(day);

    // Derive valid FK ids from the seeded environment (fail loudly if absent).
    const sampleFee = await prisma.fee.findFirst({ select: { id: true, categoryId: true, level: true } });
    if (!sampleFee) throw new Error('DB-backed test requires at least one seeded fee row');
    const stu = await prisma.user.findUnique({ where: { id: studentId! }, select: { matricNumber: true } });

    // Every alias the shared filter may reference must be joined by the R1
    // settlement query. Before the fix, u.matricNumber / i.feeId / fe.categoryId
    // etc. raised "Unknown column" on filtered dashboard requests.
    const filters: Array<ReportFilterCtx> = [
      { ...base, provider: PaymentGateway.PAYSTACK },
      { ...base, studentId: studentId! },
      { ...base, studentMatric: stu!.matricNumber! },
      { ...base, feeId: sampleFee.id },
      { ...base, feeCategoryId: sampleFee.categoryId },
      { ...base, session: '2001/2002' },
      { ...base, semester: 'FIRST' },
      { ...base, collegeId: 999999 },
      { ...base, departmentId: 999999 },
      { ...base, programmeId: 999999 },
      { ...base, level: sampleFee.level ?? 1 },
    ];
    for (const f of filters) {
      const cards = await dashboardSummaryCards(f);
      expect(cards).toBeTruthy();
      expect(typeof cards.bellsCollection).toBe('number');
      expect(typeof cards.totalCharged).toBe('number');
      expect(typeof cards.netBellsCollection).toBe('number');
    }
    // Unfiltered scope must include the fixture.
    const all = await dashboardSummaryCards(base);
    expect(all.bellsCollection).toBe(100);
  });

  dbIt('W. R1 partial settlement never presents the full Receipt.paidAmount as settled', async () => {
    const day = '2001-06-03';
    const { tx } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 100000, paidAt: new Date(`${day}T10:00:00.000Z`) });
    await makeSettlement(tx.id, PaymentGateway.ALATPAY, 100000, 60000, 'PARTIALLY_MATCHED');

    const cards = await dashboardSummaryCards(dayCtx(day));
    // Authoritative settled money is the ACTUAL 60,000 — never the 100,000 payment.
    expect(cards.settlementEvidenceAmount).toBe(60000);
    expect(cards.settlementEvidenceAmount).not.toBe(100000);
    expect(cards.fullySettledCount).toBe(0);
    expect(cards.partialSettlementCount).toBe(1);
  });

  dbIt('X. R1 settlement rows with NULL actualSettlement leave the settled amount UNKNOWN (null, not 0)', async () => {
    const day = '2001-06-05';
    const { tx } = await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 5000, paidAt: new Date(`${day}T10:00:00.000Z`) });
    await makeSettlement(tx.id, PaymentGateway.PAYSTACK, 5000, null, 'PENDING_SETTLEMENT');

    const cards = await dashboardSummaryCards(dayCtx(day));
    expect(cards.settlementEvidenceAmount).toBeNull();
    expect(cards.settlementEvidenceCount).toBe(0);
    expect(cards.pendingSettlementCount).toBe(1);
    expect(cards.pendingSettlementAmount).toBe(5000);
  });

  dbIt('Y. R1 partial settlement money uses only the authoritative actual amount (mixed evidence)', async () => {
    const day = '2001-06-07';
    const { tx: a } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 100000, paidAt: new Date(`${day}T10:00:00.000Z`) });
    await makeSettlement(a.id, PaymentGateway.ALATPAY, 100000, 60000, 'PARTIALLY_MATCHED');
    // A second successful payment with NO settlement evidence at all.
    await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 40000, paidAt: new Date(`${day}T11:00:00.000Z`) });

    const cards = await dashboardSummaryCards(dayCtx(day));
    expect(cards.settlementEvidenceAmount).toBe(60000);
    expect(cards.settlementEvidenceCount).toBe(1);
    expect(cards.partialSettlementCount).toBe(1);
    // The unevidenced payment remains PENDING — never counted as settled.
    expect(cards.pendingSettlementCount).toBe(1);
  });

  dbIt('Z. R10 and R11 use the SAME canonical variance sign (ACTUAL − EXPECTED); shortfall is negative', async () => {
    const day = '2001-06-09';
    const { tx } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 100, gatewayFee: 0, paidAt: new Date(`${day}T10:00:00.000Z`) });
    await makeSettlement(tx.id, PaymentGateway.ALATPAY, 100, 90, 'MATCHED', new Date(`${day}T10:00:00.000Z`));

    const gw = (await paymentGatewayReport(dayCtx(day))).find((r: any) => r.provider === 'ALATPAY')!;
    expect(gw.expectedSettlement).toBe(100);
    expect(gw.actualSettlement).toBe(90);
    expect(gw.settlementVariance).toBe(-10); // ACTUAL − EXPECTED

    const st = await settlementReport(dayCtx(day));
    const row = st.rows.find((r: any) => r.transactionReference === tx.reference)!;
    expect(row.expectedSettlement).toBe(100);
    expect(row.actualSettlement).toBe(90);
    expect(row.variance).toBe(-10); // SAME sign as R10
    expect(row.variance).toBe(gw.settlementVariance);
  });

  dbIt('AA. Excess settlement produces a POSITIVE variance under the canonical sign', async () => {
    const day = '2001-06-11';
    const { tx } = await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 100, gatewayFee: 0, paidAt: new Date(`${day}T10:00:00.000Z`) });
    await makeSettlement(tx.id, PaymentGateway.PAYSTACK, 100, 110, 'MATCHED', new Date(`${day}T10:00:00.000Z`));

    const gw = (await paymentGatewayReport(dayCtx(day))).find((r: any) => r.provider === 'PAYSTACK')!;
    expect(gw.settlementVariance).toBe(10); // ACTUAL − EXPECTED = +10

    const st = await settlementReport(dayCtx(day));
    const row = st.rows.find((r: any) => r.transactionReference === tx.reference)!;
    expect(row.variance).toBe(10);
  });

  dbIt('AB. NONE settlement coverage fails closed (R10 variance null, R11 variance null, R1 evidence amount null)', async () => {
    const day = '2001-06-13';
    const { tx } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 100, paidAt: new Date(`${day}T10:00:00.000Z`) });
    // No Settlement row at all.

    const gw = (await paymentGatewayReport(dayCtx(day))).find((r: any) => r.provider === 'ALATPAY')!;
    expect(gw.settlementCoverage).toBe('NONE');
    expect(gw.actualSettlement).toBeNull();
    expect(gw.settlementVariance).toBeNull();

    const st = await settlementReport(dayCtx(day));
    const row = st.rows.find((r: any) => r.transactionReference === tx.reference)!;
    expect(row.actualSettlement).toBeNull();
    expect(row.variance).toBeNull();

    const cards = await dashboardSummaryCards(dayCtx(day));
    expect(cards.settlementEvidenceAmount).toBeNull();
  });

  dbIt('AC. PARTIAL settlement coverage: complete-period R10 variance is null (never full-expected vs partial-actual)', async () => {
    const day = '2001-06-15';
    const { tx: settled } = await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 100, paidAt: new Date(`${day}T10:00:00.000Z`) });
    await makeSettlement(settled.id, PaymentGateway.PAYSTACK, 100, 95, 'MATCHED');
    await makeSuccessTx({ gateway: PaymentGateway.PAYSTACK, amount: 50, paidAt: new Date(`${day}T11:00:00.000Z`) });

    const gw = (await paymentGatewayReport(dayCtx(day))).find((r: any) => r.provider === 'PAYSTACK')!;
    expect(gw.successCount).toBe(2);
    expect(gw.settlementEvidenceCount).toBe(1);
    expect(gw.settlementCoverage).toBe('PARTIAL');
    expect(gw.settlementVariance).toBeNull();
  });

  dbIt('AD. Canonical collection formulas agree across R1, Daily, Monthly and export', async () => {
    const day = '2001-06-17';
    // Bells 100, Conv 10, Svc 5, GW 2, Refund 20 → Total Charged 117, Net Bells 80.
    const { tx } = await makeSuccessTx({
      gateway: PaymentGateway.ALATPAY,
      amount: 100,
      convenienceFee: 10,
      serviceCharge: 5,
      gatewayFee: 2,
      paidAt: new Date(`${day}T10:00:00.000Z`),
    });
    await makePaidRefund(tx.id, 20, new Date(`${day}T11:00:00.000Z`));

    const cards = await dashboardSummaryCards(dayCtx(day));
    expect(cards.bellsCollection).toBe(100);
    expect(cards.convenienceFee).toBe(10);
    expect(cards.serviceCharge).toBe(5);
    expect(cards.gatewayFees).toBe(2);
    expect(cards.totalCharged).toBe(117);
    expect(cards.refunds).toBe(20);
    expect(cards.netBellsCollection).toBe(80);
    // The backward-compatible alias must be the canonical net, never charge-adjusted.
    expect(cards.netCollection).toBe(80);

    const daily = (await dailyCollections(dayCtx(day))).find((r: any) => r.date === day)!;
    expect(daily.bellsCollection).toBe(100);
    expect(daily.totalCharged).toBe(117);
    expect(daily.refunds).toBe(20);
    expect(daily.netBellsCollection).toBe(80);
    expect(daily.gross).toBe(100); // alias
    expect(daily.net).toBe(80);    // alias

    const monthly = (await monthlyCollections(dayCtx(day))).find((r: any) => r.month === day.slice(0, 7))!;
    expect(monthly.bellsCollection).toBe(100);
    expect(monthly.totalCharged).toBe(117);
    expect(monthly.refunds).toBe(20);
    expect(monthly.netBellsCollection).toBe(80);

    const exported = await fetchReportDataForExport('DAILY_COLLECTIONS', dayCtx(day));
    const edRow = (exported.rows as any[]).find((r: any) => r.date === day)!;
    expect(edRow.bellsCollection).toBe(100);
    expect(edRow.totalCharged).toBe(117);
    expect(edRow.netBellsCollection).toBe(80);
  });

  dbIt('AE. R10 counts a PARTIALLY_MATCHED transaction separately from fully settled transactions', async () => {
    const day = '2001-06-19';
    const { tx: full } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 100, paidAt: new Date(`${day}T10:00:00.000Z`) });
    await makeSettlement(full.id, PaymentGateway.ALATPAY, 100, 100, 'SETTLED');
    const { tx: part } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 200, paidAt: new Date(`${day}T11:00:00.000Z`) });
    await makeSettlement(part.id, PaymentGateway.ALATPAY, 200, 120, 'PARTIALLY_MATCHED');
    const { tx: pend } = await makeSuccessTx({ gateway: PaymentGateway.ALATPAY, amount: 50, paidAt: new Date(`${day}T12:00:00.000Z`) });
    await makeSettlement(pend.id, PaymentGateway.ALATPAY, 50, null, 'PENDING_SETTLEMENT');

    const gw = (await paymentGatewayReport(dayCtx(day))).find((r: any) => r.provider === 'ALATPAY')!;
    expect(gw.successCount).toBe(3);
    expect(gw.fullySettledCount).toBe(1);        // only MATCHED/SETTLED
    expect(gw.partialSettlementCount).toBe(1);   // PARTIALLY_MATCHED counted separately
    expect(gw.settlementEvidenceCount).toBe(2);  // full + partial carry actualSettlement
    // A partially settled tx must NEVER be counted as fully settled.
    expect(gw.fullySettledCount).not.toBe(gw.successCount);
  });
});
