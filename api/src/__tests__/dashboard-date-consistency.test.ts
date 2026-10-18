/**
 * BURSARY DASHBOARD — DATE-WINDOW CONSISTENCY REGRESSION SUITE
 * =============================================================================
 * Production defect this file locks down:
 *
 *   For ONE selected date range the Summary cards rendered ₦0.00 / 0
 *   transactions / empty Recent Transactions, while "Collections Over Time"
 *   and "Collections by Category" showed the real ₦700 across 6 transactions.
 *
 * Root cause: /bursary/dashboard/summary built its receipts (and other) window
 * by concatenating a time suffix onto an ALREADY-COERCED Date
 * (`new Date(dateTo + 'T23:59:59.999Z')`), which yields an Invalid Date and
 * fails the whole request. The UI swallowed the failure and rendered the
 * legitimate-looking zero figures.
 *
 * These specs therefore assert the SINGLE canonical date-window contract:
 *   • summary.totalCollected === trend.total === byCategory.grandTotal
 *   • summary.transactionsCount === trend.totalCount === Σ category.count
 *   • averageTransaction === totalCollected / successfulTransactionCount
 *   • uniquePayingStudents derives from the SAME transaction population
 *   • recentTransactions derives from the SAME population/window
 * for a NON-ZERO range that includes an END-OF-DAY (22:30 Lagos) transaction,
 * and that the half-open boundaries (lower INCLUSIVE / upper EXCLUSIVE) hold.
 *
 * The real bursary router is mounted with REAL validation middleware and a
 * deterministic in-memory Prisma double that evaluates `where.createdAt`
 * exactly like Prisma's `gte`/`lt` (and throws on an Invalid Date, mirroring
 * Prisma's validation failure). No DB, no network, no production data.
 * Nothing here mutates payments/receipts/transactions.
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Authorization is NOT the subject of this suite — the date window is. Auth is
// stubbed to admit a BURSARY staff user; `requirePermission` is a pass-through
// so each dashboard handler is exercised in isolation.
// ---------------------------------------------------------------------------
jest.mock('../middlewares/auth', () => ({
  protect: (req: any, _res: any, next: any) => {
    req.user = { id: 1, role: 'BURSARY', isSuperAdmin: false, permissions: [] };
    next();
  },
  restrictTo: () => (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireSuperAdmin: () => (_req: any, _res: any, next: any) => next(),
  isSuperAdmin: () => false,
  bumpRolePermsVersion: () => {},
}));

jest.mock('../controllers/refunds', () => ({
  bursaryListRefunds: jest.fn(),
  bursaryRequestRefund: jest.fn(),
}));
jest.mock('../services/refund', () => ({
  RefundService: { assertTransactionMutable: jest.fn() },
}));
jest.mock('../services/transactionCancellation', () => ({
  CancelTransactionBodySchema: { safeParse: (x: any) => ({ success: true, data: x }) },
  TransactionCancellationService: {},
}));
jest.mock('../controllers/payments', () => ({
  getTransactionForVerify: jest.fn(),
  lookupTransactionForVerify: jest.fn(),
  verifyPaymentByTransactionId: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Deterministic fixture population.
// ---------------------------------------------------------------------------
const CAT_A = { id: 11, name: 'Tuition', code: 'TUI' };
const CAT_B = { id: 12, name: 'Hostel', code: 'HOS' };
const FEE_A = { id: 21, name: 'Tuition Fee', category: CAT_A };
const FEE_B = { id: 22, name: 'Hostel Fee', category: CAT_B };
const INV_A = { id: 31, invoiceNumber: 'INV-A', fee: FEE_A };
const INV_B = { id: 32, invoiceNumber: 'INV-B', fee: FEE_B };
const STUDENT_A = { id: 101, firstName: 'Ada', lastName: 'Obi', matricNumber: 'STU-101' };
const STUDENT_B = { id: 102, firstName: 'Bola', lastName: 'Ade', matricNumber: 'STU-102' };

type Row = {
  id: number;
  reference: string;
  userId: number;
  amount: number;
  status: string;
  type: string;
  createdAt: Date;
  paystackChannel: string | null;
  user: typeof STUDENT_A;
  invoice: any;
};

let txSeq = 0;
function tx(opts: {
  at: string;
  amount: number;
  student: typeof STUDENT_A;
  invoice: any;
  status?: string;
  type?: string;
}): Row {
  txSeq += 1;
  return {
    id: txSeq,
    reference: `DASH-${txSeq}`,
    userId: opts.student.id,
    amount: opts.amount,
    status: opts.status ?? 'SUCCESS',
    type: opts.type ?? 'FEE_PAYMENT',
    createdAt: new Date(opts.at),
    paystackChannel: 'card',
    user: opts.student,
    invoice: opts.invoice,
  };
}

// Selected Lagos business day: 15 Oct 2026.
//   window = [2026-10-14T23:00:00Z, 2026-10-15T23:00:00Z)
const T = (hhmmss: string) => `2026-10-15T${hhmmss}.000Z`;

const ALL_TXS: Row[] = [
  // --- Cat A: ₦125 x 4 = ₦500 -------------------------------------------------
  tx({ at: T('08:00:00'), amount: 125, student: STUDENT_A, invoice: INV_A }),
  tx({ at: T('09:00:00'), amount: 125, student: STUDENT_B, invoice: INV_A }),
  tx({ at: T('10:00:00'), amount: 125, student: STUDENT_A, invoice: INV_A }),
  // END-OF-DAY: 22:30 Lagos (21:30Z) — must be INSIDE the selected Lagos day.
  tx({ at: T('21:30:00'), amount: 125, student: STUDENT_B, invoice: INV_A }),
  // --- Cat B: ₦100 x 2 = ₦200 -------------------------------------------------
  tx({ at: T('11:00:00'), amount: 100, student: STUDENT_A, invoice: INV_B }),
  tx({ at: T('12:00:00'), amount: 100, student: STUDENT_B, invoice: INV_B }),

  // --- EXCLUDED from the selected day -----------------------------------------
  // Exactly at toExclusive (16 Oct 00:00 Lagos) — upper bound is EXCLUSIVE.
  tx({ at: '2026-10-15T23:00:00.000Z', amount: 999, student: STUDENT_A, invoice: INV_A }),
  // Before the 13-Oct lower bound too (11 Oct 23:59:59 Lagos) — excluded from
  // every range this suite selects.
  tx({ at: '2026-10-11T22:59:59.000Z', amount: 999, student: STUDENT_A, invoice: INV_A }),
  // Inside the window but NOT a SUCCESS → excluded by status.
  tx({ at: T('13:00:00'), amount: 888, student: STUDENT_A, invoice: INV_A, status: 'FAILED' }),
  // Inside the window but NOT a FEE_PAYMENT → excluded by type.
  tx({ at: T('14:00:00'), amount: 777, student: STUDENT_A, invoice: INV_A, type: 'WALLET_TOPUP' }),

  // --- A previous Lagos day (for multi-day range specs) ------------------------
  tx({ at: '2026-10-14T12:00:00.000Z', amount: 50, student: STUDENT_A, invoice: INV_A }),
];

// Receipts mirror the successful in-window transactions (ONE per tx) plus a
// boundary receipt that must be excluded by the same half-open window.
const RECEIPTS = ALL_TXS.filter((t) => t.status === 'SUCCESS' && t.type === 'FEE_PAYMENT').map(
  (t) => ({ id: t.id, transactionId: t.id, studentId: t.userId, paidAt: t.createdAt, isVoided: false }),
);
RECEIPTS.push({ id: 9001, transactionId: 0, studentId: STUDENT_A.id, paidAt: new Date('2026-10-15T23:00:00.000Z'), isVoided: false });
RECEIPTS.push({ id: 9002, transactionId: 0, studentId: STUDENT_A.id, paidAt: new Date('2026-10-15T21:45:00.000Z'), isVoided: true });

// ---------------------------------------------------------------------------
// In-memory Prisma double honouring the DateTime filter the routes build.
// ---------------------------------------------------------------------------
function toTime(value: any, field: string): number {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) {
    // Mirrors Prisma rejecting an Invalid Date argument — which is exactly what
    // the old `dateTo + 'T23:59:59.999Z'` concatenation produced.
    throw new Error(`Invalid value for argument \`${field}\`: Invalid Date`);
  }
  return t;
}

function inWindow(createdAt: Date, filter: any, field: string): boolean {
  if (!filter) return true;
  const t = createdAt.getTime();
  if (filter.gte !== undefined && !(t >= toTime(filter.gte, field))) return false;
  if (filter.lt !== undefined && !(t < toTime(filter.lt, field))) return false;
  if (filter.lte !== undefined && !(t <= toTime(filter.lte, field))) return false;
  return true;
}

function matchesWhere(row: { status: string; type: string; createdAt: Date }, where: any): boolean {
  if (!where) return true;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.type !== undefined && row.type !== where.type) return false;
  if (!inWindow(row.createdAt, where.createdAt, 'createdAt')) return false;
  return true;
}

const mockPrisma: any = {
  transaction: {
    aggregate: jest.fn(async ({ where }: any) => {
      const rows = ALL_TXS.filter((t) => matchesWhere(t, where));
      return {
        _sum: { amount: rows.reduce((s, t) => s + t.amount, 0) },
        _count: { id: rows.length },
      };
    }),
    groupBy: jest.fn(async ({ where }: any) => {
      const rows = ALL_TXS.filter((t) => matchesWhere(t, where));
      const byUser = new Map<number, number>();
      for (const r of rows) byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + 1);
      return Array.from(byUser.keys()).map((userId) => ({ userId }));
    }),
    findMany: jest.fn(async (args: any) => {
      let rows = ALL_TXS.filter((t) => matchesWhere(t, args?.where));
      if (args?.orderBy?.createdAt === 'desc') {
        rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (typeof args?.take === 'number') rows = rows.slice(0, args.take);
      // Trend projection (select) vs. the full recent-transactions record.
      if (args?.select?.createdAt) return rows.map((r) => ({ createdAt: r.createdAt, amount: r.amount }));
      return rows;
    }),
  },
  user: { count: jest.fn(async () => 2) },
  fee: { count: jest.fn(async () => 2) },
  receipt: {
    count: jest.fn(async ({ where }: any) =>
      RECEIPTS.filter((r) => {
        if (where?.isVoided !== undefined && r.isVoided !== where.isVoided) return false;
        if (!inWindow(r.paidAt, where?.paidAt, 'paidAt')) return false;
        return true;
      }).length,
    ),
  },
};

jest.mock('../config/database', () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));

// Imported AFTER the mocks are declared (jest hoists jest.mock above imports).
import bursaryRouter from '../routes/bursary';
import { dashboardDateWindow } from '../services/reports/aggregates';

const app = express();
app.use(express.json());
app.use('/api/v1/bursary', bursaryRouter);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err?.statusCode || err?.status || 500).json({ status: 'error', message: err?.message });
});

const BASE = '/api/v1/bursary/dashboard';

// ---------------------------------------------------------------------------
// Pure window semantics.
// ---------------------------------------------------------------------------
describe('dashboardDateWindow — ONE canonical Lagos business-day window (pure)', () => {
  it('a selected single Lagos day is half-open: lower INCLUSIVE / upper EXCLUSIVE', () => {
    const w = dashboardDateWindow({
      dateFrom: new Date('2026-10-15T00:00:00.000Z'),
      dateTo: new Date('2026-10-15T00:00:00.000Z'),
    });
    expect(w!.gte!.toISOString()).toBe('2026-10-14T23:00:00.000Z');
    expect(w!.lt!.toISOString()).toBe('2026-10-15T23:00:00.000Z');
  });

  it('NEVER concatenates a suffix onto an already-coerced Date (no Invalid Date)', () => {
    // The old defect: `new Date(dateTo + 'T23:59:59.999Z')` with dateTo a Date.
    const w = dashboardDateWindow({ dateTo: new Date('2026-10-15T00:00:00.000Z') });
    expect(Number.isNaN(w!.lt!.getTime())).toBe(false);
    expect(w!.lt!.toISOString()).toBe('2026-10-15T23:00:00.000Z');
  });

  it('returns undefined when no bounds are supplied (no time filter at all)', () => {
    expect(dashboardDateWindow({})).toBeUndefined();
    expect(dashboardDateWindow()).toBeUndefined();
  });

  it('one-sided bounds keep only the supplied edge', () => {
    const fromOnly = dashboardDateWindow({ dateFrom: new Date('2026-10-15T00:00:00.000Z') });
    expect(fromOnly).toEqual({ gte: new Date('2026-10-14T23:00:00.000Z') });

    const toOnly = dashboardDateWindow({ dateTo: new Date('2026-10-15T00:00:00.000Z') });
    expect(toOnly).toEqual({ lt: new Date('2026-10-15T23:00:00.000Z') });
  });
});

// ---------------------------------------------------------------------------
// Endpoint consistency for the non-zero selected day.
// ---------------------------------------------------------------------------
describe('Bursary dashboard — one window across summary / trend / by-category', () => {
  const DAY_QS = { dateFrom: '2026-10-15', dateTo: '2026-10-15' };

  async function loadAll(qs: Record<string, string>) {
    const summary = await request(app).get(`${BASE}/summary`).query(qs);
    const trend = await request(app).get(`${BASE}/trend`).query({ ...qs, groupBy: 'day' });
    const byCategory = await request(app).get(`${BASE}/by-category`).query(qs);
    return { summary, trend, byCategory };
  }

  it('the summary is available (never a silent zero) and reports the real totals', async () => {
    const res = await request(app).get(`${BASE}/summary`).query(DAY_QS);
    expect(res.status).toBe(200);
    const cards = res.body.data.cards;
    expect(cards.totalCollected).toBe(700);
    expect(cards.transactionsCount).toBe(6);
    expect(cards.uniquePayingStudents).toBe(2);
    expect(cards.averageTransaction).toBeCloseTo(700 / 6, 6);
    expect(cards.receiptsIssued).toBe(6);
    expect(res.body.data.recentTransactions).toHaveLength(5);
  });

  it('includes the END-OF-DAY (22:30 Lagos) transaction and the latest one is most recent', async () => {
    const res = await request(app).get(`${BASE}/summary`).query(DAY_QS);
    const recent: any[] = res.body.data.recentTransactions;
    // 21:30Z == 22:30 Lagos on 15 Oct — inside the selected Lagos day.
    expect(recent[0].createdAt).toBe('2026-10-15T21:30:00.000Z');
    expect(recent[0].amount).toBe(125);
  });

  it('Trend and Category agree with the Summary (totalCollected === total === grandTotal)', async () => {
    const { summary, trend, byCategory } = await loadAll(DAY_QS);
    expect(summary.status).toBe(200);
    expect(trend.status).toBe(200);
    expect(byCategory.status).toBe(200);

    expect(summary.body.data.cards.totalCollected).toBe(700);
    expect(trend.body.data.total).toBe(700);
    expect(byCategory.body.data.grandTotal).toBe(700);
    expect(summary.body.data.cards.totalCollected).toBe(trend.body.data.total);
    expect(trend.body.data.total).toBe(byCategory.body.data.grandTotal);
  });

  it('transaction counts agree across all three surfaces', async () => {
    const { summary, trend, byCategory } = await loadAll(DAY_QS);
    const catCount = byCategory.body.data.rows.reduce((s: number, r: any) => s + r.count, 0);
    expect(summary.body.data.cards.transactionsCount).toBe(6);
    expect(trend.body.data.totalCount).toBe(6);
    expect(catCount).toBe(6);
    expect(summary.body.data.cards.transactionsCount).toBe(trend.body.data.totalCount);
    expect(trend.body.data.totalCount).toBe(catCount);
  });

  it('category components break down as ₦500 (4 tx) + ₦200 (2 tx)', async () => {
    const { byCategory } = await loadAll(DAY_QS);
    const rows = byCategory.body.data.rows as any[];
    const tuition = rows.find((r) => r.name === 'Tuition')!;
    const hostel = rows.find((r) => r.name === 'Hostel')!;
    expect(tuition.total).toBe(500);
    expect(tuition.count).toBe(4);
    expect(hostel.total).toBe(200);
    expect(hostel.count).toBe(2);
  });

  it('averageTransaction === totalCollected / successfulTransactionCount', async () => {
    const { summary, trend } = await loadAll(DAY_QS);
    const cards = summary.body.data.cards;
    expect(cards.averageTransaction).toBeCloseTo(cards.totalCollected / trend.body.data.totalCount, 6);
  });

  it('recent transactions derive from the SAME window (no out-of-range rows)', async () => {
    const res = await request(app).get(`${BASE}/summary`).query(DAY_QS);
    const bound = { gte: new Date('2026-10-14T23:00:00.000Z').getTime(), lt: new Date('2026-10-15T23:00:00.000Z').getTime() };
    for (const r of res.body.data.recentTransactions as any[]) {
      const t = new Date(r.createdAt).getTime();
      expect(t).toBeGreaterThanOrEqual(bound.gte);
      expect(t).toBeLessThan(bound.lt);
    }
  });

  it('the upper bound is EXCLUSIVE: a tx exactly at 16 Oct 00:00 Lagos is dropped', async () => {
    const res = await request(app).get(`${BASE}/summary`).query(DAY_QS);
    const refs = (res.body.data.recentTransactions as any[]).map((r) => r.createdAt);
    expect(refs).not.toContain('2026-10-15T23:00:00.000Z');
    // ₦999 boundary rows must never inflate the totals.
    expect(res.body.data.cards.totalCollected).toBe(700);
  });

  it('a broader range (13–15 Oct) admits the previous Lagos day consistently', async () => {
    const { summary, trend, byCategory } = await loadAll({ dateFrom: '2026-10-13', dateTo: '2026-10-15' });
    expect(summary.body.data.cards.totalCollected).toBe(750);
    expect(summary.body.data.cards.transactionsCount).toBe(7);
    expect(trend.body.data.total).toBe(750);
    expect(byCategory.body.data.grandTotal).toBe(750);
    expect(trend.body.data.totalCount).toBe(7);
    expect(
      (byCategory.body.data.rows as any[]).reduce((s, r) => s + r.count, 0),
    ).toBe(7);
  });

  it('a wide explicit range still keeps every surface on ONE population', async () => {
    // An explicit (very wide) range rather than an absent filter: the trend
    // endpoint falls back to its own look-back when no bounds are supplied,
    // which is a different contract from "same window as the summary".
    const WIDE = { dateFrom: '2026-10-01', dateTo: '2026-10-31' };
    const { summary, trend, byCategory } = await loadAll(WIDE);
    const a = summary.body.data.cards.totalCollected;
    const b = trend.body.data.total;
    const c = byCategory.body.data.grandTotal;
    expect(a).toBe(2748);
    expect(a).toBe(b);
    expect(b).toBe(c);
    const catCount = (byCategory.body.data.rows as any[]).reduce((s, r) => s + r.count, 0);
    expect(summary.body.data.cards.transactionsCount).toBe(9);
    expect(summary.body.data.cards.transactionsCount).toBe(trend.body.data.totalCount);
    expect(trend.body.data.totalCount).toBe(catCount);
  });

  it('a summary failure is a hard error, never a 200 with zero financials', async () => {
    const original = mockPrisma.transaction.aggregate;
    mockPrisma.transaction.aggregate = jest.fn(async () => {
      throw new Error('simulated summary failure');
    });
    try {
      const res = await request(app).get(`${BASE}/summary`).query(DAY_QS);
      expect(res.status).toBe(500);
      expect(res.body?.data?.cards?.totalCollected).toBeUndefined();
    } finally {
      mockPrisma.transaction.aggregate = original;
    }
  });

  it('an Invalid Date in the window is rejected by the data layer (mirrors the old defect)', async () => {
    // Directly proves the invariant the routes must uphold: handing Prisma an
    // Invalid Date fails the query instead of silently matching nothing.
    const bad = new Date('not-a-date');
    expect(Number.isNaN(bad.getTime())).toBe(true);
    expect(() => inWindow(new Date(), { gte: bad }, 'createdAt')).toThrow(/Invalid Date/);
  });
});
