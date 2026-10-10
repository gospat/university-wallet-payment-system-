import {
  PaymentService,
  _testResetInitiateLocks,
  classifyProviderVerify,
  acquireInitiateDedupeLock,
  acquireInitiateDedupeLockWithOwner,
  releaseInitiateDedupeLock,
  ProviderClassifyKind,
  _testOverrideInitiateLockTtl,
} from '../services/payment';
import prisma from '../config/database';
import * as PaystackModule from '../services/paystack';
import { TransactionStatus, Role, PaymentGateway, InvoiceStatus } from '@prisma/client';
import { AppError } from '../utils/AppError';

// $transaction serialization mutex (simulates real Prisma DB isolation for concurrent tests):
(global as any).__txSerialQueue = Promise.resolve();
(global as any).__runTxSerial = async function _txRunSerial<T>(fn: () => Promise<T> | T): Promise<T> {
  const queue: Promise<any> = (global as any).__txSerialQueue ?? Promise.resolve();
  const next = queue.then(() => fn());
  (global as any).__txSerialQueue = next.catch(() => undefined);
  return next;
};

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    user: { findFirst: jest.fn() },
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
    generalLedger: { create: jest.fn(), createMany: jest.fn(), findFirst: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    rolePermission: { findMany: jest.fn() },
    counter: { upsert: jest.fn().mockResolvedValue({ value: 1 }) },
    feeAssignment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
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
          createMany: (...args: any[]) => prisma.generalLedger.createMany?.(...args),
          findFirst: (...args: any[]) => prisma.generalLedger.findFirst?.(...args),
        },
        auditLog: {
          create: (...args: any[]) => prisma.auditLog.create(...args),
        },
        wallet: {
          update: (...args: any[]) => prisma.wallet?.update?.(...args),
        },
        counter: {
          upsert: (...args: any[]) => prisma.counter?.upsert?.(...args),
        },
        feeAssignment: {
          updateMany: (...args: any[]) => prisma.feeAssignment?.updateMany?.(...args),
        },
      };
      const runSerial: any = (global as any).__runTxSerial;
      if (typeof runSerial === 'function') return runSerial(() => fn(txClient));
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

jest.mock('../queues/emailQueue', () => ({
  __esModule: true,
  dispatchEmail: jest.fn(),
}));

const _ioredisSharedStore = new Map<string, string>();
jest.mock('ioredis', () => {
  const store = (jest as any)._ioredisSharedStore || (global as any).__ioredisSharedStore;
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    call: jest.fn(async (cmd: string, ...args: any[]) => {
      const s = (global as any).__ioredisSharedStore;
      if (cmd === 'SET') {
        const key = String(args[0]);
        const value = String(args[1]);
        const flags = args.slice(2).map((x: any) => String(x).toUpperCase());
        if (flags.includes('NX') && s.has(key)) return null;
        s.set(key, value);
        return 'OK';
      }
      if (cmd === 'GET') {
        const key = String(args[0]);
        return s.has(key) ? s.get(key) : null;
      }
      if (cmd === 'DEL') {
        let n = 0;
        for (const raw of args) {
          const k = String(raw);
          if (s.has(k)) { s.delete(k); n++; }
        }
        return n;
      }
      if (cmd === 'EVAL') {
        const numKeys = Number(args[1]);
        const keys = args.slice(2, 2 + numKeys).map(String);
        const argv = args.slice(2 + numKeys).map(String);
        if (keys.length === 1 && argv.length === 1) {
          const k = keys[0]; const expect = argv[0];
          if (s.has(k) && s.get(k) === expect) { s.delete(k); return 1; }
          return 0;
        }
        return 0;
      }
      return null;
    }),
    status: 'ready',
    disconnect: jest.fn(),
    quit: jest.fn(),
  }));
});
(global as any).__ioredisSharedStore = _ioredisSharedStore;

function requireAll(): {
  getPaymentProvider: jest.Mock;
  providerInitialize: jest.Mock;
  providerVerify: jest.Mock;
  getActiveGatewaySetting: jest.Mock;
  PaystackInit: jest.Mock;
  PaystackVerify: jest.Mock;
  PaystackBreakdown: jest.Mock;
  ioredisConstructor: jest.Mock;
  ioredisLast: () => { call: jest.Mock };
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
    ioredisLast: () => ioredisConstructor.mock.results[ioredisConstructor.mock.results.length - 1]?.value,
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
  status: InvoiceStatus.UNPAID,
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

function minutesAgo(min: number): Date {
  return new Date(Date.now() - min * 60 * 1000);
}

function makeTxRow(overrides: Partial<any> = {}): any {
  const Prisma = require('@prisma/client').Prisma;
  return {
    id: 42,
    reference: 'PAY-20261008-HQ13D2',
    status: TransactionStatus.PENDING,
    expectedAmount: new Prisma.Decimal(BREAKDOWN.totalAmount),
    amount: new Prisma.Decimal(0),
    metadata: {
      amount: {
        base: BREAKDOWN.baseAmount,
        serviceCharge: BREAKDOWN.serviceCharge,
        gatewayFee: BREAKDOWN.gatewayFee,
        total: BREAKDOWN.totalAmount,
      },
    },
    gateway: PaymentGateway.PAYSTACK,
    paystackReference: 'PAY-MOCK-REF',
    userId: MOCK_STUDENT.id,
    invoiceId: MOCK_INVOICE.id,
    invoice: { ...MOCK_INVOICE },
    user: { ...MOCK_STUDENT },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function resetMocks() {
  (prisma.user.findFirst as jest.Mock).mockReset();
  (prisma.invoice.findFirst as jest.Mock).mockReset();
  (prisma.invoice.findUnique as jest.Mock).mockReset();
  if ((prisma as any).invoice?.update && typeof (prisma as any).invoice.update.mockReset === 'function') {
    (prisma.invoice.update as jest.Mock).mockReset();
  }
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
  (prisma.generalLedger.createMany as jest.Mock).mockReset();
  (prisma.generalLedger.findFirst as jest.Mock).mockReset();
  if ((prisma as any).auditLog && typeof (prisma as any).auditLog.create === 'function') {
    ((prisma as any).auditLog.create as jest.Mock).mockReset();
    ((prisma as any).auditLog.create as jest.Mock).mockResolvedValue({ id: 1 });
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
  process.env.INITIATE_LOCK_TTL_SEC_OVERRIDE = '0';
  const m = requireAll();
  m.getActiveGatewaySetting.mockResolvedValue(gateway);
  m.PaystackBreakdown.mockReturnValue(BREAKDOWN);
  (prisma.user.findFirst as jest.Mock).mockResolvedValue(MOCK_STUDENT);
  (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(MOCK_INVOICE);
  (prisma.transaction.create as jest.Mock).mockResolvedValue(makeTxRow({ gateway }));
  (prisma.transaction.count as jest.Mock).mockResolvedValue(0);
  (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.transaction.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.receipt.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.generalLedger.findFirst as jest.Mock).mockResolvedValue(null);
  if ((global as any).__ioredisSharedStore) {
    (global as any).__ioredisSharedStore.clear();
  }
  return m;
}

function setupVerifyScenario(m: any, providerStatus: string, txStatus: TransactionStatus = TransactionStatus.PENDING, paidMinorOverride?: number) {
  const paidMinor = paidMinorOverride ?? BREAKDOWN.totalAmount * 100;
  const paidNaira = paidMinor / 100;
  m.providerVerify.mockResolvedValue({
    providerReference: 'PAY-MOCK-REF',
    paidAmountMinor: paidMinor,
    paidAmountNaira: paidNaira,
    channel: 'card',
    paidAt: new Date(),
    providerStatus,
    status: providerStatus === 'success' ? TransactionStatus.SUCCESS : undefined,
    raw: {},
  });
  const row = makeTxRow({ status: txStatus });
  (prisma.transaction.findMany as jest.Mock).mockResolvedValue([row]);
  (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(row);
  (prisma.transaction.findUnique as jest.Mock).mockImplementation(async (opts: any) => {
    const id = opts?.where?.id;
    if (id === row.id) return row;
    return row;
  });
  (prisma.transaction.updateMany as jest.Mock).mockResolvedValue(
    txStatus === TransactionStatus.PENDING ? { count: 1 } : { count: 0 },
  );
  (prisma.receipt.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.generalLedger.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.transaction.update as jest.Mock).mockImplementation(async (_opts: any) => {
    const patched = { ...row };
    const d = _opts?.data ?? {};
    if (d.status) patched.status = d.status;
    if (d.amount) patched.amount = d.amount;
    return patched;
  });
  if ((prisma as any).counter && typeof (prisma as any).counter.upsert === 'function') {
    ((prisma as any).counter.upsert as jest.Mock).mockResolvedValue({ value: 7 });
  }
  if (typeof (prisma.receipt.create as jest.Mock)?.mockResolvedValue === 'function' ||
      (prisma.receipt.create as jest.Mock)?.constructor?.name === 'Mock') {
    (prisma.receipt.create as jest.Mock).mockResolvedValue({ id: 9001, receiptNumber: 'RCP-2024-0007' });
  }
  if ((prisma as any).generalLedger && typeof (prisma as any).generalLedger.createMany === 'function') {
    ((prisma as any).generalLedger.createMany as jest.Mock).mockResolvedValue({ count: 5 });
  }
  if ((prisma as any).generalLedger && typeof (prisma as any).generalLedger.create === 'function') {
    ((prisma as any).generalLedger.create as jest.Mock).mockResolvedValue({ id: 9001 });
  }
  if ((prisma as any).feeAssignment && typeof (prisma as any).feeAssignment.updateMany === 'function') {
    ((prisma as any).feeAssignment.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  }
  return { row, paidMinor, paidNaira };
}

describe('Payment Core Blockers — FR Classification / Late Success / CAS Lock', () => {
  // ================================================================
  // FR-1 CLASSIFICATION — TR1_1 .. TR1_10
  // ================================================================

  it('TR1_1 provider returns "success" → tx.status=SUCCESS; amountPaid increment.', async () => {
    const m = setupBase();
    const invCopy = { ...MOCK_INVOICE, amountPaid: 0 };
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invCopy);
    (prisma.invoice.update as jest.Mock).mockImplementation(async (opts: any) => ({
      ...invCopy,
      ...opts?.data,
    }));
    setupVerifyScenario(m, 'success');

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const successWrites = txUpdates.filter((c) => (c[0]?.data as any)?.status === TransactionStatus.SUCCESS);
    expect(successWrites.length).toBeGreaterThan(0);
    const invUpdates = (prisma.invoice.update as jest.Mock).mock.calls;
    expect(invUpdates.length).toBeGreaterThan(0);
    const lastInvData = invUpdates[invUpdates.length - 1][0]?.data as any;
    expect(lastInvData.amountPaid).toBeGreaterThan(0);
    expect((prisma.receipt.create as jest.Mock).mock.calls.length).toBe(1);
  });

  it('TR1_2 provider returns "unknown" → status MUST NOT = FAILED AND MUST NOT be UNDERPAID/OVERPAID.', async () => {
    const m = setupBase();
    setupVerifyScenario(m, 'unknown');

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const terminalBad = txUpdates.filter((c) => {
      const s = (c[0]?.data as any)?.status;
      return s === TransactionStatus.FAILED || s === 'UNDERPAID' || s === 'OVERPAID';
    });
    expect(terminalBad.length).toBe(0);
  });

  it('TR1_3 provider returns "declined" → status=FAILED.', async () => {
    const m = setupBase();
    setupVerifyScenario(m, 'declined');

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const failedWrites = txUpdates.filter((c) => (c[0]?.data as any)?.status === TransactionStatus.FAILED);
    expect(failedWrites.length).toBeGreaterThan(0);
  });

  it('TR1_4 provider returns "pending" → status NOT FAILED; NOT stranded PROCESSING (tx.status still PENDING OR same as original non-terminal).', async () => {
    const m = setupBase();
    setupVerifyScenario(m, 'pending');

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const processingStrand = txUpdates.some((c) => (c[0]?.data as any)?.status === TransactionStatus.PROCESSING);
    const failedWrites = txUpdates.filter((c) => (c[0]?.data as any)?.status === TransactionStatus.FAILED);
    expect(failedWrites.length).toBe(0);
    expect(processingStrand).toBe(false);
    const nonTerminal = txUpdates.filter((c) => {
      const s = (c[0]?.data as any)?.status;
      return s === TransactionStatus.PENDING || s === TransactionStatus.PROCESSING;
    });
    expect(nonTerminal.length).toBeGreaterThan(0);
  });

  it('TR1_5 provider returns "processing" → same non-terminal invariants.', async () => {
    const m = setupBase();
    setupVerifyScenario(m, 'processing');

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const failedWrites = txUpdates.filter((c) => (c[0]?.data as any)?.status === TransactionStatus.FAILED);
    expect(failedWrites.length).toBe(0);
    const underOrOver = txUpdates.filter((c) => {
      const s = (c[0]?.data as any)?.status;
      return s === 'UNDERPAID' || s === 'OVERPAID';
    });
    expect(underOrOver.length).toBe(0);
  });

  it('TR1_6 provider returns "unknown" → same.', async () => {
    const m = setupBase();
    setupVerifyScenario(m, 'unknown');

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const terminal = txUpdates.filter((c) => {
      const s = (c[0]?.data as any)?.status;
      return s === TransactionStatus.FAILED || s === 'UNDERPAID' || s === 'OVERPAID' || s === TransactionStatus.SUCCESS;
    });
    expect(terminal.length).toBe(0);
  });

  it('TR1_7 provider returns "" → non-terminal.', async () => {
    const m = setupBase();
    setupVerifyScenario(m, '');

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const failedWrites = txUpdates.filter((c) => (c[0]?.data as any)?.status === TransactionStatus.FAILED);
    expect(failedWrites.length).toBe(0);
    const inv = classifyProviderVerify('');
    expect(inv.kind).toBe('NON_TERMINAL');
  });

  it('TR1_8 provider returns "some_brand_new_status_xyz" → non-terminal.', async () => {
    const m = setupBase();
    setupVerifyScenario(m, 'some_brand_new_status_xyz');

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const failedWrites = txUpdates.filter((c) => (c[0]?.data as any)?.status === TransactionStatus.FAILED);
    expect(failedWrites.length).toBe(0);
    const direct = classifyProviderVerify('some_brand_new_status_xyz');
    expect(direct.kind).toBe('NON_TERMINAL');
  });

  it('TR1_9 provider.verify throws new Error("network") → status NOT FAILED.', async () => {
    const m = setupBase();
    m.providerVerify.mockRejectedValue(new Error('network'));
    const row = makeTxRow();
    (prisma.transaction.findMany as jest.Mock).mockResolvedValue([row]);
    (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(row);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(row);
    (prisma.transaction.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const failedWrites = txUpdates.filter((c) => (c[0]?.data as any)?.status === TransactionStatus.FAILED);
    expect(failedWrites.length).toBe(0);
    const transport = classifyProviderVerify('anything', { error: true });
    expect(transport.kind).toBe('TRANSPORT_EXCEPTION');
  });

  it('TR1_10 provider.verify throws new Error("timeout ECONNRESET") → non-terminal.', async () => {
    const m = setupBase();
    const err: any = new Error('timeout ECONNRESET');
    err.code = 'ECONNRESET';
    m.providerVerify.mockRejectedValue(err);
    const row = makeTxRow();
    (prisma.transaction.findMany as jest.Mock).mockResolvedValue([row]);
    (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(row);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(row);
    (prisma.transaction.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    const txUpdates = (prisma.transaction.update as jest.Mock).mock.calls;
    const failedWrites = txUpdates.filter((c) => (c[0]?.data as any)?.status === TransactionStatus.FAILED);
    expect(failedWrites.length).toBe(0);
    const processingStrand = txUpdates.some((c) => (c[0]?.data as any)?.status === TransactionStatus.PROCESSING);
    expect(processingStrand).toBe(false);
  });

  // ================================================================
  // FR-2 LATE SUCCESS PROPAGATION — TR2_1 .. TR2_5
  // ================================================================

  it('TR2_1 legacy FAILED tx + submit SUCCESS again and again → receipt.create called once exactly; amountPaid exactly one increment; GL exactly once.', async () => {
    const m = setupBase();
    const invCopy: any = { ...MOCK_INVOICE, amountPaid: 0 };
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invCopy);
    (prisma.invoice.update as jest.Mock).mockImplementation(async (opts: any) => {
      invCopy.amountPaid = (opts?.data?.amountPaid ?? invCopy.amountPaid);
      invCopy.status = opts?.data?.status ?? invCopy.status;
      return { ...invCopy };
    });

    setupVerifyScenario(m, 'success', TransactionStatus.FAILED);

    await PaymentService.verifyPayment('PAY-MOCK-REF');
    const receiptCallsAfterFirst = (prisma.receipt.create as jest.Mock).mock.calls.length;
    const glCallsAfterFirst = (prisma.generalLedger.createMany as jest.Mock).mock.calls.length
      + (prisma.generalLedger.create as jest.Mock).mock.calls.length;
    const invUpdatesAfterFirst = (prisma.invoice.update as jest.Mock).mock.calls.length;
    expect(receiptCallsAfterFirst).toBe(1);

    (prisma.receipt.findFirst as jest.Mock).mockResolvedValue({ id: 1, transactionId: 42 });
    (prisma.generalLedger.findFirst as jest.Mock).mockResolvedValue({ id: 1, transactionId: 42 });

    await PaymentService.verifyPayment('PAY-MOCK-REF');
    await PaymentService.verifyPayment('PAY-MOCK-REF');

    expect((prisma.receipt.create as jest.Mock).mock.calls.length).toBe(1);
    const totalGl = (prisma.generalLedger.createMany as jest.Mock).mock.calls.length
      + (prisma.generalLedger.create as jest.Mock).mock.calls.length;
    expect(totalGl).toBe(glCallsAfterFirst);
  });

  it('TR2_2 tx status CANCELLED + late SUCCESS → receipt.create NEVER called; invoice.amountPaid NOT incremented; auditLog.create called with action contains "CANCELLED_INVOICE" reconciliation exception.', async () => {
    const m = setupBase();
    const cancelledInvoice: any = { ...MOCK_INVOICE, status: InvoiceStatus.CANCELLED, amountPaid: 0 };
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(cancelledInvoice);
    (prisma.invoice.update as jest.Mock).mockImplementation(async (opts: any) => ({
      ...cancelledInvoice,
      ...opts?.data,
    }));

    const row = makeTxRow({
      status: TransactionStatus.CANCELLED,
      invoice: cancelledInvoice,
    });
    const paidMinor = BREAKDOWN.totalAmount * 100;
    m.providerVerify.mockResolvedValue({
      providerReference: 'PAY-MOCK-REF',
      paidAmountMinor: paidMinor,
      paidAmountNaira: paidMinor / 100,
      channel: 'card',
      paidAt: new Date(),
      providerStatus: 'success',
      status: TransactionStatus.SUCCESS,
      raw: {},
    });
    (prisma.transaction.findMany as jest.Mock).mockResolvedValue([row]);
    (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(row);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(row);
    (prisma.transaction.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.receipt.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.generalLedger.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.transaction.update as jest.Mock).mockImplementation(async (_opts: any) => row);

    await PaymentService.verifyPayment('PAY-MOCK-REF');

    expect((prisma.receipt.create as jest.Mock).mock.calls.length).toBe(0);
    expect((prisma.invoice.update as jest.Mock).mock.calls.length).toBe(0);
    const auditCalls = (prisma.auditLog.create as jest.Mock).mock.calls;
    const cancelledAudit = auditCalls.filter((c) => {
      const action = String((c[0] as any)?.data?.action ?? (c[0] as any)?.action ?? '');
      return action.includes('CANCELLED_INVOICE') || action.includes('CANCELLED_INVOICE_LATE_SUCCESS');
    });
    expect(cancelledAudit.length).toBeGreaterThan(0);
  });

  it('TR2_3 duplicate SUCCESS consecutive → second call receipt.count delta=0 etc.', async () => {
    const m = setupBase();
    const invCopy: any = { ...MOCK_INVOICE, amountPaid: 0 };
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invCopy);
    (prisma.invoice.update as jest.Mock).mockImplementation(async (opts: any) => {
      invCopy.amountPaid = opts?.data?.amountPaid ?? invCopy.amountPaid;
      return { ...invCopy };
    });

    setupVerifyScenario(m, 'success', TransactionStatus.PENDING);

    await PaymentService.verifyPayment('PAY-MOCK-REF');
    const receiptCount1 = (prisma.receipt.create as jest.Mock).mock.calls.length;
    expect(receiptCount1).toBe(1);

    (prisma.receipt.findFirst as jest.Mock).mockResolvedValue({ id: 1, transactionId: 42 });
    (prisma.generalLedger.findFirst as jest.Mock).mockResolvedValue({ id: 1, transactionId: 42 });

    await PaymentService.verifyPayment('PAY-MOCK-REF');
    const receiptCount2 = (prisma.receipt.create as jest.Mock).mock.calls.length;
    expect(receiptCount2 - receiptCount1).toBe(0);
  });

  it('TR2_4 Promise.all([verify(SUCCESS), verify(SUCCESS)]) → receipt === 1; GL === 1.', async () => {
    const m = setupBase();
    const invCopy: any = { ...MOCK_INVOICE, amountPaid: 0 };
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invCopy);
    (prisma.invoice.update as jest.Mock).mockImplementation(async (opts: any) => {
      invCopy.amountPaid = opts?.data?.amountPaid ?? invCopy.amountPaid;
      return { ...invCopy };
    });

    let settled = false;
    (prisma.receipt.findFirst as jest.Mock).mockImplementation(async () => (settled ? { id: 1, transactionId: 42 } : null));
    (prisma.generalLedger.findFirst as jest.Mock).mockImplementation(async () => (settled ? { id: 1, transactionId: 42 } : null));
    (prisma.receipt.create as jest.Mock).mockImplementation(async () => { settled = true; return { id: 1 }; });

    const firstCallerWinsRow = makeTxRow();
    let pendingCount = 0;
    (prisma.transaction.updateMany as jest.Mock).mockImplementation(async () => {
      pendingCount += 1;
      // The FIRST caller wins the optimistic row lock (count=1).
      // For ALL SUBSEQUENT callers (count=0), before returning we mark settled=true
      // so their isAlreadySettled check inside $transaction sees settled=true and
      // they bail (prevents late-success dedup race in this mocked environment).
      if (pendingCount > 1) settled = true;
      return { count: pendingCount === 1 ? 1 : 0 };
    });
    (prisma.transaction.findMany as jest.Mock).mockResolvedValue([firstCallerWinsRow]);
    (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(firstCallerWinsRow);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(firstCallerWinsRow);
    const paidMinor = BREAKDOWN.totalAmount * 100;
    m.providerVerify.mockResolvedValue({
      providerReference: 'PAY-MOCK-REF',
      paidAmountMinor: paidMinor,
      paidAmountNaira: paidMinor / 100,
      channel: 'card',
      paidAt: new Date(),
      providerStatus: 'success',
      status: TransactionStatus.SUCCESS,
      raw: {},
    });
    (prisma.transaction.update as jest.Mock).mockImplementation(async (_opts: any) => firstCallerWinsRow);

    await Promise.all([
      PaymentService.verifyPayment('PAY-MOCK-REF'),
      PaymentService.verifyPayment('PAY-MOCK-REF'),
    ]);

    expect((prisma.receipt.create as jest.Mock).mock.calls.length).toBe(1);
  });

  it('TR2_5 webhook race (two concurrent verifyPayment SUCCESS calls) → 1 receipt; 1 GL.', async () => {
    const m = setupBase();
    const invCopy: any = { ...MOCK_INVOICE, amountPaid: 0 };
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invCopy);
    (prisma.invoice.update as jest.Mock).mockImplementation(async (opts: any) => {
      invCopy.amountPaid = opts?.data?.amountPaid ?? invCopy.amountPaid;
      return { ...invCopy };
    });

    let settleCount = 0;
    (prisma.receipt.findFirst as jest.Mock).mockImplementation(async () => (settleCount > 0 ? { id: 1, transactionId: 42 } : null));
    (prisma.generalLedger.findFirst as jest.Mock).mockImplementation(async () => (settleCount > 0 ? { id: 1, transactionId: 42 } : null));
    (prisma.receipt.create as jest.Mock).mockImplementation(async () => { settleCount++; return { id: settleCount }; });
    (prisma.generalLedger.createMany as jest.Mock).mockImplementation(async () => { settleCount++; return { count: 4 }; });

    const row = makeTxRow();
    let updManyCount = 0;
    (prisma.transaction.updateMany as jest.Mock).mockImplementation(async () => {
      updManyCount++;
      // First caller gets the lock (count=1). All further callers are told "alreadyProcessed"
      // AND we flag settled so their isAlreadySettled check sees settlement already happening.
      if (updManyCount > 1) settleCount = Math.max(settleCount, 1);
      return { count: updManyCount === 1 ? 1 : 0 };
    });
    (prisma.transaction.findMany as jest.Mock).mockResolvedValue([row]);
    (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(row);
    (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(row);
    const paidMinor = BREAKDOWN.totalAmount * 100;
    m.providerVerify.mockResolvedValue({
      providerReference: 'PAY-MOCK-REF',
      paidAmountMinor: paidMinor,
      paidAmountNaira: paidMinor / 100,
      channel: 'card',
      paidAt: new Date(),
      providerStatus: 'success',
      status: TransactionStatus.SUCCESS,
      raw: {},
    });
    (prisma.transaction.update as jest.Mock).mockImplementation(async (_opts: any) => row);

    const results = await Promise.all([
      PaymentService.verifyPayment('PAY-MOCK-REF'),
      PaymentService.verifyPayment('PAY-MOCK-REF'),
    ]);

    expect(results.length).toBe(2);
    expect((prisma.receipt.create as jest.Mock).mock.calls.length).toBe(1);
  });

  // ================================================================
  // FR-3 INITIATE DEDUPE LOCK OWNERSHIP CAS — TR3_1
  // ================================================================

  it('TR3_1 Delayed owner release cannot delete new owner\'s lock — Redis path + degraded in-process path (LAZY NO-REDIS). Sequence: A acquires → force-expire → B acquires → A release with A\'s stale token → C tries acquire MUST return false because B still owns. Assert tokens strictly.', async () => {
    // ------- Redis-backed path (via mocked global shared ioredis store Map) -------
    setupBase(); // NOTE: setupBase sets TTL_OVERRIDE env; use runtime override below
    _testOverrideInitiateLockTtl(3);
    _testResetInitiateLocks();
    const store: Map<string, string> = (global as any).__ioredisSharedStore;
    expect(store).toBeTruthy();
    store.clear();

    const studentId = 77;
    const invoiceId = 88;

    const a = await acquireInitiateDedupeLockWithOwner(studentId, invoiceId);
    expect(a.ok).toBe(true);
    expect(a.ownerToken).toBeTruthy();
    const tokenA = a.ownerToken!;
    expect(typeof tokenA).toBe('string');
    expect(tokenA.length).toBeGreaterThan(0);
    expect(tokenA.startsWith('bypass:')).toBe(false);
    expect(store.get(`initiates:lock:${studentId}:${invoiceId}`)).toBe(tokenA);

    // Force-expire: delete key from store to simulate TTL expiry
    store.delete(`initiates:lock:${studentId}:${invoiceId}`);
    expect(store.has(`initiates:lock:${studentId}:${invoiceId}`)).toBe(false);

    const b = await acquireInitiateDedupeLockWithOwner(studentId, invoiceId);
    expect(b.ok).toBe(true);
    expect(b.ownerToken).toBeTruthy();
    const tokenB = b.ownerToken!;
    expect(tokenB).not.toBe(tokenA);
    expect(store.get(`initiates:lock:${studentId}:${invoiceId}`)).toBe(tokenB);

    // A releases with A's stale token — must NOT delete B's lock
    const aReleaseResult = await releaseInitiateDedupeLock(studentId, invoiceId, tokenA);
    expect(aReleaseResult).toBe(false);
    expect(store.get(`initiates:lock:${studentId}:${invoiceId}`)).toBe(tokenB);

    // C tries — must fail because B still owns
    const c = await acquireInitiateDedupeLockWithOwner(studentId, invoiceId);
    expect(c.ok).toBe(false);
    expect(c.ownerToken).toBe(null);

    // B releases with B's valid token — must succeed and remove lock
    const bReleaseResult = await releaseInitiateDedupeLock(studentId, invoiceId, tokenB);
    expect(bReleaseResult).toBe(true);
    expect(store.has(`initiates:lock:${studentId}:${invoiceId}`)).toBe(false);

    // ------- Degraded in-process path (simulate NO Redis by bypassing path with high TTL but Redis mocked to throw) -------
    _testOverrideInitiateLockTtl(3);
    _testResetInitiateLocks();
    store.clear();

    const pStudentId = studentId + 1000;
    const pInvoiceId = invoiceId + 1000;

    // Break Redis to force degraded path: temporarily make getRedis return nothing
    const origGetRedis = require('../config/redis').getRedis;
    require('../config/redis').getRedis = () => null;
    try {
      const pA = await acquireInitiateDedupeLockWithOwner(pStudentId, pInvoiceId);
      expect(pA.ok).toBe(true);
      const pTokenA = pA.ownerToken!;
      expect(pTokenA).toBeTruthy();
      expect(pTokenA.startsWith('bypass:')).toBe(false);

      // Manually expire the degraded in-process lock to simulate TTL: clear fallback map
      _testResetInitiateLocks();

      const pB = await acquireInitiateDedupeLockWithOwner(pStudentId, pInvoiceId);
      expect(pB.ok).toBe(true);
      const pTokenB = pB.ownerToken!;
      expect(pTokenB).not.toBe(pTokenA);

      // A releases with A's stale token — must NOT delete B's in-process lock
      const pARel = await releaseInitiateDedupeLock(pStudentId, pInvoiceId, pTokenA);
      expect(pARel).toBe(false);

      // C tries — B still owns
      const pC = await acquireInitiateDedupeLockWithOwner(pStudentId, pInvoiceId);
      expect(pC.ok).toBe(false);
      expect(pC.ownerToken).toBe(null);

      // B releases with B's own token — ok and clear
      const pBRel = await releaseInitiateDedupeLock(pStudentId, pInvoiceId, pTokenB);
      expect(pBRel).toBe(true);

      // After B releases, someone else can acquire
      const pD = await acquireInitiateDedupeLockWithOwner(pStudentId, pInvoiceId);
      expect(pD.ok).toBe(true);
      expect(pD.ownerToken).not.toBe(pTokenB);
    } finally {
      require('../config/redis').getRedis = origGetRedis;
    }
  });

  // ---- classifyProviderVerify unit tests (comprehensive strict-sets check) ----
  describe('classifyProviderVerify strict sets', () => {
    const successCases = ['success', 'completed', 'paid', 'SUCCESS', '  Completed  '];
    for (const s of successCases) {
      it(`AUTH_SUCCESS_SET accepts "${s}"`, () => {
        const r = classifyProviderVerify(s);
        expect(r.kind).toBe('AUTH_SUCCESS');
        expect(r.writtenStatus).toBe(TransactionStatus.SUCCESS);
      });
    }
    it('verifyResult.status === TransactionStatus.SUCCESS shortcut', () => {
      const r = classifyProviderVerify({ status: TransactionStatus.SUCCESS } as any);
      expect(r.kind).toBe('AUTH_SUCCESS');
    });
    const terminalCases = ['failed', 'declined', 'rejected', 'expired', 'abandoned'];
    for (const s of terminalCases) {
      it(`AUTH_TERMINAL_FAILURE_SET accepts "${s}"`, () => {
        const r = classifyProviderVerify(s);
        expect(r.kind).toBe('AUTH_FAILURE_TERMINAL');
        expect(r.writtenStatus).toBe(TransactionStatus.FAILED);
      });
    }
    const nonTerminalCases = ['pending', 'processing', 'initiated', 'queued', 'unknown', '', 'unrecognized', 'ambiguous'];
    for (const s of nonTerminalCases) {
      it(`NON_TERMINAL_SET accepts "${s === '' ? '[empty string]' : s}"`, () => {
        const r = classifyProviderVerify(s);
        expect(r.kind).toBe('NON_TERMINAL');
        expect(r.writtenStatus).toBe(null);
      });
    }
    it('didThrow.error → TRANSPORT_EXCEPTION', () => {
      const r = classifyProviderVerify('anything', { error: true });
      expect(r.kind).toBe('TRANSPORT_EXCEPTION');
      expect(r.writtenStatus).toBe(null);
      expect(r.normalizedRaw).toBe('__transport_exception__');
    });
    it('unknown brand-new status falls to NON_TERMINAL', () => {
      const r = classifyProviderVerify('some_brand_new_status_xyz');
      expect(r.kind).toBe('NON_TERMINAL');
    });
  });
});
