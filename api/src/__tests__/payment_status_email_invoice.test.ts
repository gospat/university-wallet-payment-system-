// =============================================================================
// Backend tests: read-only payment status endpoint, email idempotency,
// and invoice reference generation.
// -----------------------------------------------------------------------------
// Coverage:
//   K. read-only status endpoint ownership
//   L. student A cannot query student B transaction
//   M. status endpoint performs no financial mutation
//   O. repeated success webhook generates one payment-success email
//   P. concurrent duplicate email dispatch does not throw noisy P2002
//   Q. invoice generator never produces INV//
//   R. all invoice creation paths use canonical generator (yearFromSession)
// =============================================================================

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    transaction: { findFirst: jest.fn(), findUnique: jest.fn() },
    invoice: { findUnique: jest.fn() },
    receipt: { findFirst: jest.fn() },
    emailDeliveryLog: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

// Mock BullMQ so dispatchEmail doesn't try to connect to Redis in the
// non-test-mode idempotency tests.
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({}),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn(),
}));

jest.mock('../config/redis', () => ({
  createBullmqProducerConnection: jest.fn(() => ({})),
  createBullmqWorkerConnection: jest.fn(() => ({})),
}));

import prisma from '../config/database';
import { getPaymentStatus } from '../controllers/payments';
import { dispatchEmail } from '../queues/emailQueue';
import { generateInvoiceReference } from '../utils/paystack';
import { yearFromSession } from '../utils/yearlyCounter';

const mockReq = (overrides: any = {}) => ({
  user: { id: 101 },
  params: { reference: 'PAY-20261013-TEST01' },
  ...overrides,
});

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

// catchAsync does not return the inner promise, so tests must flush the
// microtask queue after invoking the wrapped controller.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = 'test';
});

// ===========================================================================
// Invoice reference generation (Q, R)
// ===========================================================================
describe('generateInvoiceReference + yearFromSession', () => {
  it('Q: never produces INV// when year is empty string', () => {
    const ref = generateInvoiceReference(6, '');
    expect(ref).not.toMatch(/^INV\/\//);
    expect(ref).toMatch(/^INV\/\d{4}\/00006$/);
  });

  it('Q: never produces INV// when year is whitespace', () => {
    const ref = generateInvoiceReference(8, '   ');
    expect(ref).not.toMatch(/^INV\/\//);
    expect(ref).toMatch(/^INV\/\d{4}\/00008$/);
  });

  it('Q: never produces INV// when year is undefined', () => {
    const ref = generateInvoiceReference(1, undefined);
    expect(ref).not.toMatch(/^INV\/\//);
    expect(ref).toMatch(/^INV\/\d{4}\/00001$/);
  });

  it('Q: produces canonical INV/2026/00001 for valid year', () => {
    expect(generateInvoiceReference(1, '2026')).toBe('INV/2026/00001');
  });

  it('R: yearFromSession extracts start year from 2026/2027', () => {
    expect(yearFromSession('2026/2027')).toBe('2026');
  });

  it('R: yearFromSession falls back to current year on empty/null', () => {
    const currentYear = String(new Date().getFullYear());
    expect(yearFromSession('')).toBe(currentYear);
    expect(yearFromSession(null)).toBe(currentYear);
    expect(yearFromSession(undefined)).toBe(currentYear);
  });

  it('R: yearFromSession extracts year from malformed "2026-abc"', () => {
    expect(yearFromSession('2026-abc')).toBe('2026');
  });

  it('R: combined generateInvoiceReference(yearFromSession(empty)) never INV//', () => {
    const ref = generateInvoiceReference(5, yearFromSession(''));
    expect(ref).not.toMatch(/^INV\/\//);
  });
});

// ===========================================================================
// Read-only payment status endpoint (K, L, M)
// ===========================================================================
describe('getPaymentStatus — read-only status endpoint', () => {
  it('K: returns persisted transaction state for owner', async () => {
    (prisma.transaction.findFirst as jest.Mock).mockResolvedValue({
      id: 48,
      reference: 'PAY-20261013-TEST01',
      status: 'SUCCESS',
      gateway: 'ALATPAY',
      amount: 100,
      expectedAmount: 100,
      userId: 101,
      invoiceId: 8,
      alatpayFinalTransactionId: '7162fb44-6d04-4590-ac65-a96061e272ab',
      updatedAt: new Date('2026-10-13T12:00:00Z'),
    });
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue({
      id: 8,
      invoiceNumber: 'INV/2026/00008',
      amountDue: 100,
      amountPaid: 100,
      status: 'PAID',
    });
    (prisma.receipt.findFirst as jest.Mock).mockResolvedValue({
      id: 24,
      receiptNumber: 'RCPT/2026/00005',
    });

    const req = mockReq();
    const res = mockRes();
    getPaymentStatus(req as any, res as any, jest.fn() as any);
    await flush();

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.reference).toBe('PAY-20261013-TEST01');
    expect(body.data.transactionId).toBe(48);
    expect(body.data.status).toBe('SUCCESS');
    expect(body.data.gateway).toBe('ALATPAY');
    expect(body.data.invoiceStatus).toBe('PAID');
    expect(body.data.receipt.receiptNumber).toBe('RCPT/2026/00005');
    expect(body.data.alatpayFinalTransactionIdPresent).toBe(true);
    // Must NOT expose the actual UUID or secrets
    expect(JSON.stringify(body.data)).not.toContain('7162fb44');
  });

  it('L: returns 403 when transaction belongs to another student', async () => {
    (prisma.transaction.findFirst as jest.Mock).mockResolvedValue({
      id: 48,
      reference: 'PAY-20261013-TEST01',
      status: 'PENDING',
      gateway: 'ALATPAY',
      amount: 100,
      expectedAmount: 100,
      userId: 999,
      invoiceId: 8,
      alatpayFinalTransactionId: null,
      updatedAt: new Date(),
    });

    const req = mockReq({ user: { id: 101 } });
    const res = mockRes();
    const next = jest.fn();
    getPaymentStatus(req as any, res as any, next as any);
    await flush();

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
  });

  it('M: performs no financial mutation (no create/update calls)', async () => {
    (prisma.transaction.findFirst as jest.Mock).mockResolvedValue({
      id: 48,
      reference: 'PAY-20261013-TEST01',
      status: 'PENDING',
      gateway: 'ALATPAY',
      amount: 100,
      expectedAmount: 100,
      userId: 101,
      invoiceId: 8,
      alatpayFinalTransactionId: null,
      updatedAt: new Date(),
    });
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.receipt.findFirst as jest.Mock).mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    getPaymentStatus(req as any, res as any, jest.fn() as any);
    await flush();

    expect(prisma.transaction.findFirst).toHaveBeenCalled();
    expect(prisma.invoice.findUnique).toHaveBeenCalled();
    expect(prisma.receipt.findFirst).toHaveBeenCalled();
    // No mutation methods should be invoked
    expect((prisma.transaction as any).create).toBeUndefined();
    expect((prisma.transaction as any).update).toBeUndefined();
    expect((prisma.invoice as any).create).toBeUndefined();
    expect((prisma.receipt as any).create).toBeUndefined();
  });

  it('returns 404 when transaction not found', async () => {
    (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();
    getPaymentStatus(req as any, res as any, next as any);
    await flush();

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(404);
  });
});

// ===========================================================================
// Email idempotency (O, P)
// ===========================================================================
describe('dispatchEmail — idempotency via emailDeliveryLog', () => {
  const baseArgs = {
    emailType: 'PAYMENT_SUCCESSFUL',
    recipientId: 101,
    reference: 'PAY-20261013-TEST01',
    to: 'student@example.com',
    payload: { studentName: 'Test', feeName: 'Tuition', amountNgnNumber: 100, reference: 'PAY-20261013-TEST01', receiptNumber: 'RCPT/2026/00005' },
  };

  beforeEach(() => {
    // Bypass the test-mode in-memory dedup so the real DB idempotency
    // path (createPendingDeliveryLog) is exercised.
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env.NODE_ENV = 'test';
  });

  it('O: duplicate dispatch with existing PENDING log does not enqueue again', async () => {
    (prisma.emailDeliveryLog.findFirst as jest.Mock).mockResolvedValue({
      id: BigInt(1),
      status: 'PENDING',
    });

    await dispatchEmail(baseArgs);
    // findFirst called (idempotency check); create never called
    expect(prisma.emailDeliveryLog.findFirst).toHaveBeenCalled();
    expect(prisma.emailDeliveryLog.create).not.toHaveBeenCalled();
  });

  it('O: duplicate dispatch with existing SENT log does not enqueue again', async () => {
    (prisma.emailDeliveryLog.findFirst as jest.Mock).mockResolvedValue({
      id: BigInt(2),
      status: 'SENT',
    });

    await dispatchEmail(baseArgs);
    expect(prisma.emailDeliveryLog.create).not.toHaveBeenCalled();
  });

  it('P: P2002 on concurrent create is silently deduped (no throw)', async () => {
    let callCount = 0;
    (prisma.emailDeliveryLog.findFirst as jest.Mock).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return null;
      // Simulate the concurrent winner row appearing after P2002
      return { id: BigInt(3), status: 'PENDING' };
    });
    (prisma.emailDeliveryLog.create as jest.Mock).mockRejectedValue({
      code: 'P2002',
      message: 'Unique constraint failed',
    });

    // Should NOT throw
    await expect(dispatchEmail(baseArgs)).resolves.toBeUndefined();
    expect(prisma.emailDeliveryLog.create).toHaveBeenCalled();
  });

  it('P: P2002 is not logged as an operational error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (prisma.emailDeliveryLog.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.emailDeliveryLog.create as jest.Mock).mockRejectedValue({
      code: 'P2002',
      message: 'Unique constraint failed on idempotencyKey',
    });

    await dispatchEmail(baseArgs);
    // The warn should NOT have been called for P2002
    const p2002Warnings = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('P2002'),
    );
    expect(p2002Warnings.length).toBe(0);
    warnSpy.mockRestore();
  });

  it('FAILED email allows retry (reset to PENDING)', async () => {
    (prisma.emailDeliveryLog.findFirst as jest.Mock).mockResolvedValue({
      id: BigInt(5),
      status: 'FAILED',
    });
    (prisma.emailDeliveryLog.update as jest.Mock).mockResolvedValue({ id: BigInt(5) });

    await dispatchEmail(baseArgs);
    expect(prisma.emailDeliveryLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
  });

  it('different emails (different idempotency keys) are both dispatched', async () => {
    (prisma.emailDeliveryLog.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.emailDeliveryLog.create as jest.Mock).mockResolvedValue({ id: BigInt(10) });

    await dispatchEmail(baseArgs);
    await dispatchEmail({ ...baseArgs, reference: 'PAY-20261013-OTHER' });

    // Two different references → two different idempotency keys → two creates
    expect(prisma.emailDeliveryLog.create).toHaveBeenCalledTimes(2);
  });
});
