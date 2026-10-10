import { PaymentService, _testResetInitiateLocks } from '../services/payment';
import prisma from '../config/database';
import * as PaystackModule from '../services/paystack';
import { TransactionStatus, Role, PaymentGateway } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { getContinueOption } from '../controllers/payments';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    user: { findFirst: jest.fn(), findUnique: jest.fn() },
    invoice: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    transaction: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    receipt: { create: jest.fn(), findFirst: jest.fn() },
    generalLedger: { create: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    rolePermission: { findMany: jest.fn() },
    counter: { upsert: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(async (fn: any) => {
      const prisma = (require('../config/database') as any).default;
      const txClient: any = {
        $executeRawUnsafe: jest.fn().mockResolvedValue([]),
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: {
          findFirst: (...args: any[]) => prisma.user.findFirst?.(...args),
          findUnique: (...args: any[]) => prisma.user.findUnique?.(...args),
        },
        invoice: {
          findFirst: (...args: any[]) => prisma.invoice.findFirst?.(...args),
          findUnique: (...args: any[]) => prisma.invoice.findFirst
            ? prisma.invoice.findFirst({ where: args?.[0]?.where, select: args?.[0]?.select })
            : Promise.resolve(null),
          update: (...args: any[]) => prisma.invoice.update?.(...args),
        },
        transaction: {
          findFirst: (...args: any[]) => prisma.transaction.findFirst?.(...args),
          findMany: (...args: any[]) => prisma.transaction.findMany?.(...args),
          findUnique: (...args: any[]) => prisma.transaction.findUnique?.(...args),
          count: (...args: any[]) => prisma.transaction.count?.(...args) ?? Promise.resolve(0),
          create: (...args: any[]) => prisma.transaction.create(...args),
          update: (...args: any[]) => prisma.transaction.update(...args),
          updateMany: (...args: any[]) => prisma.transaction.updateMany(...args),
        },
        receipt: {
          create: (...args: any[]) => prisma.receipt.create(...args),
          findFirst: (...args: any[]) => prisma.receipt.findFirst?.(...args),
        },
        generalLedger: {
          create: (...args: any[]) => prisma.generalLedger.create(...args),
        },
        auditLog: {
          create: (...args: any[]) => prisma.auditLog.create(...args),
        },
        wallet: {
          update: (...args: any[]) => prisma.wallet?.update?.(...args),
        },
        counter: {
          upsert: (...args: any[]) => prisma.counter?.upsert?.(...args),
          findUnique: (...args: any[]) => prisma.counter?.findUnique?.(...args),
        },
      };
      return fn(txClient);
    }),
  },
}));

jest.mock('../services/paystack', () => ({
  __esModule: true,
  PaystackService: {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    computePaymentBreakdown: jest.fn(),
  },
  computePaymentBreakdown: jest.fn(),
}));

jest.mock('../utils/alatpay', () => {
  const actual = jest.requireActual('../utils/alatpay');
  return {
    __esModule: true,
    ...actual,
  };
});

jest.mock('../services/payment/providerFactory', () => {
  const actual = jest.requireActual('@prisma/client');
  const singletonProvider = {
    initialize: jest.fn(),
    verify: jest.fn(),
    computeBreakdown: (baseAmountMajor: number) =>
      (require('../services/paystack') as any).computePaymentBreakdown(baseAmountMajor),
  };
  return {
    __esModule: true,
    getActiveGatewaySetting: jest.fn().mockResolvedValue(actual.PaymentGateway.PAYSTACK),
    setActiveGatewaySetting: jest.fn(),
    getPaymentProvider: jest.fn(() => singletonProvider),
    _singletonProvider: singletonProvider,
  };
});

jest.mock('../config/queue', () => ({
  __esModule: true,
  dispatchJob: jest.fn().mockResolvedValue({ jobId: 'test-job' }),
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    call: jest.fn(),
    status: 'ready',
    disconnect: jest.fn(),
    quit: jest.fn(),
  }));
});

function requireAll(): {
  getPaymentProvider: jest.Mock;
  providerInitialize: jest.Mock;
  providerVerify: jest.Mock;
  getActiveGatewaySetting: jest.Mock;
  PaystackInit: jest.Mock;
  PaystackVerify: jest.Mock;
  PaystackBreakdown: jest.Mock;
  ioredisConstructor: jest.Mock;
} {
  const providerFactory = require('../services/payment/providerFactory');
  const PaystackService = (require('../services/paystack') as any).PaystackService;
  const ioredisConstructor = require('ioredis') as jest.Mock;
  const provider = providerFactory.getPaymentProvider();
  return {
    getPaymentProvider: providerFactory.getPaymentProvider,
    providerInitialize: provider.initialize,
    providerVerify: provider.verify,
    getActiveGatewaySetting: providerFactory.getActiveGatewaySetting,
    PaystackInit: PaystackService.initializeTransaction,
    PaystackVerify: PaystackService.verifyTransaction,
    PaystackBreakdown: (require('../services/paystack') as any).computePaymentBreakdown,
    ioredisConstructor,
  };
}

const MOCK_STUDENT = {
  id: 1001,
  email: 'student@test.edu',
  firstName: 'Test',
  lastName: 'Student',
  matricNumber: 'TEST/001',
  role: Role.STUDENT,
};

const MOCK_INVOICE = {
  id: 501,
  invoiceNumber: 'INV-001',
  studentId: 1001,
  amountDue: 50000,
  amountPaid: 0,
  status: 'UNPAID',
  session: '2024/2025',
  semester: 'FIRST',
  feeId: 1,
  fee: { id: 1, name: 'School Fees', feeCode: 'SCH-001', categoryId: 1 },
};

const BREAKDOWN = {
  baseAmount: 50000,
  serviceCharge: 750,
  gatewayFee: 0,
  totalAmount: 50750,
  serviceChargeMode: 'percentage',
  gatewayFeeMode: 'flat',
};

const PAY_REF = 'PAY-20261010-TESTREF01';

function minutesAgo(min: number): Date {
  return new Date(Date.now() - min * 60 * 1000);
}

function resetMocks() {
  (prisma.user.findFirst as jest.Mock).mockReset();
  (prisma.user.findUnique as jest.Mock).mockReset();
  (prisma.invoice.findFirst as jest.Mock).mockReset();
  (prisma.invoice.findUnique as jest.Mock).mockReset();
  (prisma.invoice.update as jest.Mock).mockReset();
  (prisma.transaction.findFirst as jest.Mock).mockReset();
  (prisma.transaction.findMany as jest.Mock).mockReset();
  (prisma.transaction.findUnique as jest.Mock).mockReset();
  (prisma.transaction.create as jest.Mock).mockReset();
  (prisma.transaction.update as jest.Mock).mockReset();
  (prisma.transaction.updateMany as jest.Mock).mockReset();
  (prisma.transaction.count as jest.Mock).mockReset();
  (prisma.receipt.create as jest.Mock).mockReset();
  (prisma.receipt.findFirst as jest.Mock).mockReset();
  (prisma.generalLedger.create as jest.Mock).mockReset();
  if ((prisma as any).auditLog && typeof (prisma as any).auditLog.create === 'function') {
    ((prisma as any).auditLog.create as jest.Mock).mockReset();
    ((prisma as any).auditLog.create as jest.Mock).mockResolvedValue({ id: 1 });
  }
  if ((prisma as any).counter) {
    ((prisma as any).counter.upsert as jest.Mock)?.mockReset?.();
    ((prisma as any).counter.findUnique as jest.Mock)?.mockReset?.();
  }
  const m = requireAll();
  m.providerInitialize.mockReset();
  m.providerVerify.mockReset();
  m.PaystackInit.mockReset();
  m.PaystackVerify.mockReset();
  m.PaystackBreakdown.mockReset();
  m.getPaymentProvider.mockClear();
}

function setupBase(gateway: PaymentGateway = PaymentGateway.PAYSTACK) {
  resetMocks();
  _testResetInitiateLocks();
  process.env.INVOICE_OP_LOCK_DISABLE = '1';
  const m = requireAll();
  m.getActiveGatewaySetting.mockResolvedValue(gateway);
  m.PaystackBreakdown.mockReturnValue(BREAKDOWN);
  (prisma.user.findFirst as jest.Mock).mockResolvedValue(MOCK_STUDENT);
  (prisma.user.findUnique as jest.Mock).mockResolvedValue(MOCK_STUDENT);
  (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(MOCK_INVOICE);
  (prisma.invoice.findUnique as jest.Mock).mockResolvedValue(MOCK_INVOICE);
  const Decimal = (require('@prisma/client').Prisma.Decimal as any);
  (prisma.transaction.create as jest.Mock).mockResolvedValue({
    id: 42,
    reference: PAY_REF,
    status: TransactionStatus.PENDING,
    expectedAmount: new Decimal(BREAKDOWN.totalAmount),
    amount: new Decimal(0),
    metadata: {},
    gateway,
    userId: MOCK_STUDENT.id,
    invoiceId: MOCK_INVOICE.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  (prisma.transaction.count as jest.Mock).mockResolvedValue(0);
  (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.transaction.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.receipt.findFirst as jest.Mock).mockResolvedValue(null);
  const Redis = require('ioredis');
  if (Redis.mock) {
    const store = new Map<string, string>();
    Redis.mockImplementation(() => ({
      on: jest.fn(),
      call: jest.fn(async (cmd: string, ...args: any[]) => {
        if (cmd === 'SET') {
          const key = String(args[0]);
          const value = String(args[1]);
          const flags = args.slice(2).map((x: any) => String(x).toUpperCase());
          if (flags.includes('NX') && store.has(key)) return null;
          store.set(key, value);
          return 'OK';
        }
        if (cmd === 'GET') return store.has(String(args[0])) ? store.get(String(args[0])) : null;
        if (cmd === 'DEL') {
          let n = 0;
          for (const raw of args) {
            const k = String(raw);
            if (store.has(k)) { store.delete(k); n++; }
          }
          return n;
        }
        return null;
      }),
      status: 'ready',
      disconnect: jest.fn(),
      quit: jest.fn(),
    }));
  }
  return m;
}

function makeRes() {
  let jsonOut: any = null;
  let statusOut: number | null = null;
  const res: any = {
    status: jest.fn().mockImplementation((s: number) => { statusOut = s; return res; }),
    json: jest.fn().mockImplementation((body: any) => { jsonOut = body; return res; }),
  };
  return { res, getJson: () => jsonOut, getStatus: () => statusOut };
}

describe('T5 FR-5 — Check Status + Continue Payment Safety', () => {

  // -----------------------------------------------------------------------
  // TR5_1 (mandatory #19): providerVerify returns 'pending' → NO FAILED/UNDERPAID/OVERPAID status mutations
  // -----------------------------------------------------------------------
  it('TR5_1 verifyPayment provider returns pending — tx NEVER becomes FAILED, UNDERPAID, or OVERPAID; status stays PENDING.', async () => {
    const m = setupBase(PaymentGateway.ALATPAY);

    const Decimal = (require('@prisma/client').Prisma.Decimal as any);
    const pendingTxRow: any = {
      id: 42,
      reference: PAY_REF,
      status: TransactionStatus.PENDING,
      gateway: PaymentGateway.ALATPAY,
      userId: MOCK_STUDENT.id,
      invoiceId: MOCK_INVOICE.id,
      expectedAmount: new Decimal(BREAKDOWN.totalAmount),
      amount: new Decimal(0),
      paystackReference: null,
      alatpayFinalTransactionId: 'd7725744-785f-46c9-821b-2e9d5d6f7ac3',
      alatpayOrderReference: 'ord-ref-1',
      alatpayInitPaymentReference: 'init-ref-1',
      alatpaySessionId: 'sess-xyz',
      metadata: {},
      createdAt: minutesAgo(2),
      updatedAt: minutesAgo(2),
    };

    (prisma.transaction.findFirst as jest.Mock).mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.reference === PAY_REF || where.id === 42) return pendingTxRow;
      return null;
    });
    (prisma.transaction.findUnique as jest.Mock).mockImplementation(async (opts: any) => {
      const w = opts?.where ?? {};
      if (w.reference === PAY_REF || w.id === 42) return pendingTxRow;
      return null;
    });

    m.providerVerify.mockResolvedValue({
      verified: false,
      status: 'pending',
      reason: 'provider_still_processing',
      amountMajor: 0,
      providerRaw: { status: 'pending' },
    });
    m.PaystackVerify.mockResolvedValue({
      status: true,
      data: { status: 'pending', amount: 0, reference: PAY_REF },
    });

    try {
      await PaymentService.verifyPayment(PAY_REF, {
        assertStudentId: MOCK_STUDENT.id,
        req: { ip: '127.0.0.1', headers: {}, user: { id: MOCK_STUDENT.id } } as any,
        providerReference: 'd7725744-785f-46c9-821b-2e9d5d6f7ac3',
        expectedTransactionId: 42,
      });
    } catch (_e) {
      // Swallow intentionally — we only care whether any FAILED/UNDERPAID/OVERPAID writes occurred.
    }

    const forbiddenStatuses = [
      TransactionStatus.FAILED,
      TransactionStatus.UNDERPAID,
      TransactionStatus.OVERPAID,
    ];

    const forbiddenUpdates = (prisma.transaction.update as jest.Mock).mock.calls.filter((call) => {
      const s = (call?.[1]?.data?.status ?? call?.[0]?.data?.status) as any;
      return forbiddenStatuses.includes(s);
    });
    expect(forbiddenUpdates.length).toBe(0);

    const forbiddenUpdateMany = (prisma.transaction.updateMany as jest.Mock).mock.calls.filter((call) => {
      const s = (call?.[1]?.data?.status ?? call?.[0]?.data?.status) as any;
      return forbiddenStatuses.includes(s);
    });
    expect(forbiddenUpdateMany.length).toBe(0);
  }, 20000);

  it('TR5_1b verifyPayment provider returns unknown — tx NEVER becomes FAILED; status stays non-terminal.', async () => {
    const m = setupBase(PaymentGateway.ALATPAY);
    const Decimal = (require('@prisma/client').Prisma.Decimal as any);
    const pendingTxRow: any = {
      id: 43,
      reference: 'PAY-TR5-1B',
      status: TransactionStatus.PENDING,
      gateway: PaymentGateway.ALATPAY,
      userId: MOCK_STUDENT.id,
      invoiceId: MOCK_INVOICE.id,
      expectedAmount: new Decimal(BREAKDOWN.totalAmount),
      amount: new Decimal(0),
      paystackReference: null,
      alatpayFinalTransactionId: 'uuid-for-1b',
      alatpayOrderReference: 'ord-ref-1b',
      alatpayInitPaymentReference: 'init-ref-1b',
      alatpaySessionId: 'sess-1b',
      metadata: {},
      createdAt: minutesAgo(2),
      updatedAt: minutesAgo(2),
    };
    (prisma.transaction.findFirst as jest.Mock).mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.reference === 'PAY-TR5-1B' || where.id === 43) return pendingTxRow;
      return null;
    });
    (prisma.transaction.findUnique as jest.Mock).mockImplementation(async (opts: any) => {
      const w = opts?.where ?? {};
      if (w.reference === 'PAY-TR5-1B' || w.id === 43) return pendingTxRow;
      return null;
    });
    m.providerVerify.mockResolvedValue({
      verified: false,
      status: 'unknown',
      reason: 'provider_status_unknown',
      amountMajor: 0,
      providerRaw: { status: 'unknown' },
    });
    m.PaystackVerify.mockResolvedValue({
      status: true,
      data: { status: 'unknown', amount: 0, reference: 'PAY-TR5-1B' },
    });

    try {
      await PaymentService.verifyPayment('PAY-TR5-1B', {
        assertStudentId: MOCK_STUDENT.id,
        req: { ip: '127.0.0.1', headers: {}, user: { id: MOCK_STUDENT.id } } as any,
        providerReference: 'uuid-for-1b',
        expectedTransactionId: 43,
      });
    } catch (_e) {
      // Swallow intentionally — we only care whether any FAILED writes occurred.
    }

    const failedUpdates = (prisma.transaction.update as jest.Mock).mock.calls.filter((call) => {
      const s = (call?.[1]?.data?.status ?? call?.[0]?.data?.status) as any;
      return s === TransactionStatus.FAILED;
    });
    expect(failedUpdates.length).toBe(0);
    const failedUpdateMany = (prisma.transaction.updateMany as jest.Mock).mock.calls.filter((call) => {
      const s = (call?.[1]?.data?.status ?? call?.[0]?.data?.status) as any;
      return s === TransactionStatus.FAILED;
    });
    expect(failedUpdateMany.length).toBe(0);
  }, 20000);

  it('TR5_1c verifyPayment provider returns processing — tx NEVER becomes FAILED.', async () => {
    const m = setupBase(PaymentGateway.ALATPAY);
    const Decimal = (require('@prisma/client').Prisma.Decimal as any);
    const processingTxRow: any = {
      id: 44,
      reference: 'PAY-TR5-1C',
      status: TransactionStatus.PROCESSING,
      gateway: PaymentGateway.ALATPAY,
      userId: MOCK_STUDENT.id,
      invoiceId: MOCK_INVOICE.id,
      expectedAmount: new Decimal(BREAKDOWN.totalAmount),
      amount: new Decimal(0),
      paystackReference: null,
      alatpayFinalTransactionId: 'uuid-for-1c',
      alatpayOrderReference: 'ord-ref-1c',
      alatpayInitPaymentReference: 'init-ref-1c',
      alatpaySessionId: 'sess-1c',
      metadata: {},
      createdAt: minutesAgo(2),
      updatedAt: minutesAgo(2),
    };
    (prisma.transaction.findFirst as jest.Mock).mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.reference === 'PAY-TR5-1C' || where.id === 44) return processingTxRow;
      return null;
    });
    (prisma.transaction.findUnique as jest.Mock).mockImplementation(async (opts: any) => {
      const w = opts?.where ?? {};
      if (w.reference === 'PAY-TR5-1C' || w.id === 44) return processingTxRow;
      return null;
    });
    m.providerVerify.mockResolvedValue({
      verified: false,
      status: 'processing',
      reason: 'provider_still_processing',
      amountMajor: 0,
      providerRaw: { status: 'processing' },
    });
    m.PaystackVerify.mockResolvedValue({
      status: true,
      data: { status: 'processing', amount: 0, reference: 'PAY-TR5-1C' },
    });

    try {
      await PaymentService.verifyPayment('PAY-TR5-1C', {
        assertStudentId: MOCK_STUDENT.id,
        req: { ip: '127.0.0.1', headers: {}, user: { id: MOCK_STUDENT.id } } as any,
        providerReference: 'uuid-for-1c',
        expectedTransactionId: 44,
      });
    } catch (_e) {
      // Swallow intentionally.
    }

    const failedUpdates = (prisma.transaction.update as jest.Mock).mock.calls.filter((call) => {
      const s = (call?.[1]?.data?.status ?? call?.[0]?.data?.status) as any;
      return s === TransactionStatus.FAILED;
    });
    expect(failedUpdates.length).toBe(0);
  }, 20000);

  it('TR5_1d verifyPayment provider throws "Resource not found" — tx NEVER becomes FAILED.', async () => {
    const m = setupBase(PaymentGateway.ALATPAY);
    const Decimal = (require('@prisma/client').Prisma.Decimal as any);
    const pendingTxRow: any = {
      id: 45,
      reference: 'PAY-TR5-1D',
      status: TransactionStatus.PENDING,
      gateway: PaymentGateway.ALATPAY,
      userId: MOCK_STUDENT.id,
      invoiceId: MOCK_INVOICE.id,
      expectedAmount: new Decimal(BREAKDOWN.totalAmount),
      amount: new Decimal(0),
      paystackReference: null,
      alatpayFinalTransactionId: 'uuid-for-1d',
      alatpayOrderReference: 'ord-ref-1d',
      alatpayInitPaymentReference: 'init-ref-1d',
      alatpaySessionId: 'sess-1d',
      metadata: {},
      createdAt: minutesAgo(2),
      updatedAt: minutesAgo(2),
    };
    (prisma.transaction.findFirst as jest.Mock).mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.reference === 'PAY-TR5-1D' || where.id === 45) return pendingTxRow;
      return null;
    });
    (prisma.transaction.findUnique as jest.Mock).mockImplementation(async (opts: any) => {
      const w = opts?.where ?? {};
      if (w.reference === 'PAY-TR5-1D' || w.id === 45) return pendingTxRow;
      return null;
    });
    m.providerVerify.mockRejectedValueOnce(new Error('Resource not found'));
    m.PaystackVerify.mockResolvedValue({
      status: false,
      message: 'Resource not found',
    });

    try {
      await PaymentService.verifyPayment('PAY-TR5-1D', {
        assertStudentId: MOCK_STUDENT.id,
        req: { ip: '127.0.0.1', headers: {}, user: { id: MOCK_STUDENT.id } } as any,
        providerReference: 'uuid-for-1d',
        expectedTransactionId: 45,
      });
    } catch (_e) {
      // Swallow intentionally — only care that no FAILED write occurred.
    }

    const failedUpdates = (prisma.transaction.update as jest.Mock).mock.calls.filter((call) => {
      const s = (call?.[1]?.data?.status ?? call?.[0]?.data?.status) as any;
      return s === TransactionStatus.FAILED;
    });
    expect(failedUpdates.length).toBe(0);
    const failedUpdateMany = (prisma.transaction.updateMany as jest.Mock).mock.calls.filter((call) => {
      const s = (call?.[1]?.data?.status ?? call?.[0]?.data?.status) as any;
      return s === TransactionStatus.FAILED;
    });
    expect(failedUpdateMany.length).toBe(0);
  }, 20000);

  // -----------------------------------------------------------------------
  // TR5_2a (mandatory #20 part A): ALATPAY PENDING with sessionId + checkoutUrl
  //   → canResume=true resumeMode='alatpay_native'. 0 tx.create, 0 provider.initialize.
  // -----------------------------------------------------------------------
  it('TR5_2a getContinueOption ALATPAY PENDING with alatpaySessionId+CheckoutUrl → canResume=true alatpay_native; no prisma.transaction.create; no provider.initialize', async () => {
    const m = setupBase(PaymentGateway.ALATPAY);
    const Decimal = (require('@prisma/client').Prisma.Decimal as any);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue({
      id: 9001,
      userId: MOCK_STUDENT.id,
      status: TransactionStatus.PENDING,
      gateway: PaymentGateway.ALATPAY,
      reference: 'PAY-ALAT-9001',
      expectedAmount: new Decimal(50750),
      paystackReference: null,
      alatpaySessionId: 'sess-alat-abc123',
      alatpayCheckoutUrl: 'https://alatpay.example.com/checkout/sess-alat-abc123',
      alatpayOrderReference: 'ord-alat-1001',
      alatpayInitPaymentReference: 'init-alat-2001',
      metadata: { alatpay: { checkout_url: 'https://alatpay.example.com/checkout/sess-alat-abc123' } },
    });

    const mockReq: any = {
      user: { id: MOCK_STUDENT.id, role: Role.STUDENT },
      params: { transactionId: '9001' },
    };
    const { res, getJson } = makeRes();
    const next = jest.fn();

    await getContinueOption(mockReq as any, res as any, next as any);

    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
    const jsonOut = getJson();
    expect(jsonOut).not.toBeNull();
    expect(jsonOut.canResume).toBe(true);
    expect(jsonOut.resumeMode).toBe('alatpay_native');
    expect(jsonOut.reason).toBeNull();
    expect(jsonOut.payload).not.toBeNull();
    expect(jsonOut.payload.bellsReference).toBe('PAY-ALAT-9001');
    expect(jsonOut.payload.transactionStatus).toBe('PENDING');
    expect(jsonOut.payload.alatpaySessionId).toBe('sess-alat-abc123');
    expect(jsonOut.payload.alatpayOrderReference).toBe('ord-alat-1001');
    expect(jsonOut.payload.alatpayInitPaymentReference).toBe('init-alat-2001');
    expect((prisma.transaction.create as jest.Mock).mock.calls.length).toBe(0);
    expect(m.providerInitialize.mock.calls.length).toBe(0);
    expect(m.PaystackInit.mock.calls.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // TR5_2b (mandatory #20 part B): ALATPAY PENDING but NO alatpaySessionId
  //   → canResume=false; reason contains "not available for safe resume"
  // -----------------------------------------------------------------------
  it('TR5_2b getContinueOption ALATPAY PENDING missing alatpaySessionId → canResume=false; reason contains "not available for safe resume"; no prisma.transaction.create', async () => {
    const m = setupBase(PaymentGateway.ALATPAY);
    const Decimal = (require('@prisma/client').Prisma.Decimal as any);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue({
      id: 9002,
      userId: MOCK_STUDENT.id,
      status: TransactionStatus.PENDING,
      gateway: PaymentGateway.ALATPAY,
      reference: 'PAY-ALAT-9002',
      expectedAmount: new Decimal(50750),
      paystackReference: null,
      alatpaySessionId: null,
      alatpayCheckoutUrl: 'https://alatpay.example.com/checkout/some-url',
      alatpayOrderReference: 'ord-alat-1002',
      alatpayInitPaymentReference: 'init-alat-2002',
      metadata: null,
    });

    const mockReq: any = {
      user: { id: MOCK_STUDENT.id, role: Role.STUDENT },
      params: { transactionId: '9002' },
    };
    const { res, getJson } = makeRes();
    const next = jest.fn();

    await getContinueOption(mockReq as any, res as any, next as any);

    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
    const jsonOut = getJson();
    expect(jsonOut).not.toBeNull();
    expect(jsonOut.canResume).toBe(false);
    expect(jsonOut.resumeMode).toBe('none');
    expect(typeof jsonOut.reason).toBe('string');
    expect(jsonOut.reason).toContain('not available for safe resume');
    expect(jsonOut.payload).toBeNull();
    expect((prisma.transaction.create as jest.Mock).mock.calls.length).toBe(0);
    expect(m.providerInitialize.mock.calls.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // TR5_2c: ownership enforcement 403
  // -----------------------------------------------------------------------
  it('TR5_2c getContinueOption ownership — tx.userId !== req.user.id → next(AppError 403).', async () => {
    setupBase(PaymentGateway.ALATPAY);
    const Decimal = (require('@prisma/client').Prisma.Decimal as any);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue({
      id: 9003,
      userId: 9999,
      status: TransactionStatus.PENDING,
      gateway: PaymentGateway.ALATPAY,
      reference: 'PAY-ALAT-9003',
      expectedAmount: new Decimal(50750),
      paystackReference: null,
      alatpaySessionId: 'sess-123',
      alatpayCheckoutUrl: 'https://alatpay.example.com/c',
      alatpayOrderReference: null,
      alatpayInitPaymentReference: null,
      metadata: null,
    });

    const mockReq: any = {
      user: { id: MOCK_STUDENT.id, role: Role.STUDENT },
      params: { transactionId: '9003' },
    };
    const { res } = makeRes();
    const next = jest.fn();

    await getContinueOption(mockReq as any, res as any, next as any);
    await new Promise((r) => setTimeout(r, 10));

    expect(next).toHaveBeenCalledTimes(1);
    const errArg = next.mock.calls[0][0];
    expect(errArg).toBeInstanceOf(AppError);
    const code = (errArg as AppError).statusCode ?? (errArg as any).code ?? (errArg as any).status;
    expect(code).toBe(403);
  });

  // -----------------------------------------------------------------------
  // TR5_2d: terminal SUCCESS tx → canResume=false
  // -----------------------------------------------------------------------
  it('TR5_2d getContinueOption terminal SUCCESS → canResume=false "Transaction is no longer in an unresolved pending state."', async () => {
    setupBase(PaymentGateway.PAYSTACK);
    const Decimal = (require('@prisma/client').Prisma.Decimal as any);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue({
      id: 9004,
      userId: MOCK_STUDENT.id,
      status: TransactionStatus.SUCCESS,
      gateway: PaymentGateway.PAYSTACK,
      reference: 'PAY-PS-9004',
      expectedAmount: new Decimal(50750),
      paystackReference: 'ps_ref_success',
      alatpaySessionId: null,
      alatpayCheckoutUrl: null,
      alatpayOrderReference: null,
      alatpayInitPaymentReference: null,
      metadata: null,
    });

    const mockReq: any = {
      user: { id: MOCK_STUDENT.id, role: Role.STUDENT },
      params: { transactionId: '9004' },
    };
    const { res, getJson } = makeRes();
    const next = jest.fn();

    await getContinueOption(mockReq as any, res as any, next as any);

    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
    const jsonOut = getJson();
    expect(jsonOut.canResume).toBe(false);
    expect(jsonOut.resumeMode).toBe('none');
    expect(jsonOut.reason).toBe('Transaction is no longer in an unresolved pending state.');
    expect(jsonOut.payload).toBeNull();
  });

  // -----------------------------------------------------------------------
  // TR5_2e: PAYSTACK PENDING with paystackReference → paystack_redirect
  // -----------------------------------------------------------------------
  it('TR5_2e getContinueOption PAYSTACK PENDING with paystackReference → canResume=true paystack_redirect; no prisma.transaction.create', async () => {
    const m = setupBase(PaymentGateway.PAYSTACK);
    const Decimal = (require('@prisma/client').Prisma.Decimal as any);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue({
      id: 9005,
      userId: MOCK_STUDENT.id,
      status: TransactionStatus.PENDING,
      gateway: PaymentGateway.PAYSTACK,
      reference: 'PAY-PS-9005',
      expectedAmount: new Decimal(50750),
      paystackReference: 'yio8xxexampleps',
      alatpaySessionId: null,
      alatpayCheckoutUrl: null,
      alatpayOrderReference: null,
      alatpayInitPaymentReference: null,
      metadata: { paystack: { authorization_url: 'https://paystack.com/pay/abc123' } },
    });

    const mockReq: any = {
      user: { id: MOCK_STUDENT.id, role: Role.STUDENT },
      params: { transactionId: '9005' },
    };
    const { res, getJson } = makeRes();
    const next = jest.fn();

    await getContinueOption(mockReq as any, res as any, next as any);

    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
    const jsonOut = getJson();
    expect(jsonOut.canResume).toBe(true);
    expect(jsonOut.resumeMode).toBe('paystack_redirect');
    expect(jsonOut.reason).toBeNull();
    expect(jsonOut.payload.paystackReference).toBe('yio8xxexampleps');
    expect(jsonOut.payload.bellsReference).toBe('PAY-PS-9005');
    expect((prisma.transaction.create as jest.Mock).mock.calls.length).toBe(0);
    expect(m.providerInitialize.mock.calls.length).toBe(0);
  });
});
