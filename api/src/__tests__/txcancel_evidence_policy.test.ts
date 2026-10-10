import { TransactionCancellationService } from '../services/transactionCancellation';
import prisma from '../config/database';
import { TransactionStatus, Role, PaymentGateway } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { Permissions } from '../types/permissions';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    user: { findFirst: jest.fn(), findUnique: jest.fn() },
    invoice: { findFirst: jest.fn(), findUnique: jest.fn() },
    transaction: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    receipt: {
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    generalLedger: {
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    settlement: {
      count: jest.fn().mockResolvedValue(0),
    },
    webhookEvent: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 1, createdAt: new Date() }) },
    rolePermission: { findMany: jest.fn() },
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
          findUnique: (...args: any[]) => prisma.invoice.findUnique
            ? prisma.invoice.findUnique({ where: args?.[0]?.where, select: args?.[0]?.select })
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
          count: (...args: any[]) => prisma.receipt.count?.(...args) ?? Promise.resolve(0),
        },
        generalLedger: {
          create: (...args: any[]) => prisma.generalLedger.create(...args),
          count: (...args: any[]) => prisma.generalLedger.count?.(...args) ?? Promise.resolve(0),
        },
        settlement: {
          count: (...args: any[]) => prisma.settlement?.count?.(...args) ?? Promise.resolve(0),
        },
        auditLog: {
          create: (...args: any[]) => prisma.auditLog.create(...args),
        },
        wallet: {
          update: (...args: any[]) => (prisma as any).wallet?.update?.(...args),
        },
      };
      return fn(txClient);
    }),
  },
}));

jest.mock('../services/payment/providerFactory', () => {
  const actual = jest.requireActual('@prisma/client');
  const singletonProvider = {
    initialize: jest.fn(),
    verify: jest.fn(),
    computeBreakdown: (baseAmountMajor: number) => ({
      baseAmount: baseAmountMajor,
      serviceCharge: Math.round(baseAmountMajor * 0.015),
      gatewayFee: 0,
      totalAmount: baseAmountMajor + Math.round(baseAmountMajor * 0.015),
      serviceChargeMode: 'percentage',
      gatewayFeeMode: 'flat',
    }),
  };
  return {
    __esModule: true,
    getActiveGatewaySetting: jest.fn().mockResolvedValue(actual.PaymentGateway.PAYSTACK),
    setActiveGatewaySetting: jest.fn(),
    getPaymentProvider: jest.fn(() => singletonProvider),
    _singletonProvider: singletonProvider,
  };
});

jest.mock('../utils/invoiceLock', () => ({
  __esModule: true,
  acquireInvoiceOperationLock: jest.fn().mockResolvedValue({
    ok: true,
    token: 'mock-lock-token',
    acquiredAtMs: Date.now(),
    ttlMs: 8000,
  }),
  releaseInvoiceOperationLockByToken: jest.fn().mockResolvedValue(undefined),
  releaseInvoiceOperationLock: jest.fn().mockResolvedValue(undefined),
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
} {
  const providerFactory = require('../services/payment/providerFactory');
  const provider = providerFactory.getPaymentProvider();
  return {
    getPaymentProvider: providerFactory.getPaymentProvider,
    providerInitialize: provider.initialize,
    providerVerify: provider.verify,
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
};

const PROVIDER_CREATE_ROW = {
  id: 42,
  reference: 'PAY-MOCK-EVIDENCE',
  status: TransactionStatus.PENDING,
  expectedAmount: new (require('@prisma/client').Prisma.Decimal as any)(50000),
  amount: new (require('@prisma/client').Prisma.Decimal as any)(0),
  metadata: {},
  gateway: PaymentGateway.PAYSTACK,
  userId: MOCK_STUDENT.id,
  invoiceId: MOCK_INVOICE.id,
  createdAt: new Date(),
  updatedAt: new Date(),
  invoice: { ...MOCK_INVOICE },
};

function resetMocks() {
  if ((prisma as any).user) {
    (prisma.user.findFirst as jest.Mock)?.mockReset?.();
    (prisma.user.findUnique as jest.Mock)?.mockReset?.();
  }
  if ((prisma as any).invoice) {
    (prisma.invoice.findFirst as jest.Mock)?.mockReset?.();
    (prisma.invoice.findUnique as jest.Mock)?.mockReset?.();
  }
  (prisma.transaction.findFirst as jest.Mock).mockReset();
  (prisma.transaction.findMany as jest.Mock).mockReset();
  (prisma.transaction.findUnique as jest.Mock).mockReset();
  (prisma.transaction.create as jest.Mock).mockReset();
  (prisma.transaction.update as jest.Mock).mockReset();
  (prisma.transaction.updateMany as jest.Mock).mockReset();
  (prisma.transaction.count as jest.Mock).mockReset();
  if ((prisma as any).receipt) {
    (prisma.receipt.create as jest.Mock)?.mockReset?.();
    (prisma.receipt.count as jest.Mock)?.mockReset?.();
    (prisma.receipt.count as jest.Mock)?.mockResolvedValue?.(0);
  }
  if ((prisma as any).generalLedger) {
    (prisma.generalLedger.create as jest.Mock)?.mockReset?.();
    (prisma.generalLedger.count as jest.Mock)?.mockReset?.();
    (prisma.generalLedger.count as jest.Mock)?.mockResolvedValue?.(0);
  }
  if ((prisma as any).settlement) {
    (prisma.settlement.count as jest.Mock)?.mockReset?.();
    (prisma.settlement.count as jest.Mock)?.mockResolvedValue?.(0);
  }
  if ((prisma as any).webhookEvent) {
    (prisma.webhookEvent.findMany as jest.Mock)?.mockReset?.();
    (prisma.webhookEvent.findMany as jest.Mock)?.mockResolvedValue?.([]);
  }
  if ((prisma as any).auditLog && typeof (prisma as any).auditLog.create === 'function') {
    ((prisma as any).auditLog.create as jest.Mock).mockReset();
    ((prisma as any).auditLog.create as jest.Mock).mockResolvedValue({ id: 1, createdAt: new Date() });
  }
  (prisma.transaction.count as jest.Mock).mockResolvedValue(0);
  const m = requireAll();
  m.providerInitialize.mockReset();
  m.providerVerify.mockReset();
  m.getPaymentProvider.mockClear();
}

function setupBase(gateway: PaymentGateway = PaymentGateway.PAYSTACK) {
  resetMocks();
  process.env.INVOICE_OP_LOCK_DISABLE = '1';
  process.env.NODE_ENV = 'test';
  (prisma.user.findFirst as jest.Mock).mockResolvedValue(MOCK_STUDENT);
  (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(MOCK_INVOICE);
  (prisma.transaction.create as jest.Mock).mockResolvedValue({ ...PROVIDER_CREATE_ROW, gateway });
  (prisma.transaction.count as jest.Mock).mockResolvedValue(0);
  (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.transaction.findMany as jest.Mock).mockResolvedValue([]);
  if ((prisma as any).webhookEvent) {
    (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);
  }
  return requireAll();
}

describe('TR4 Transaction Cancellation Evidence Policy (FR-4)', () => {
  describe('TR4_1 PENDING tx + verify returns pending → fail-closed 412, row unchanged', () => {
    it('TR4_1 mandatory: tx PENDING, provider.verify pending status → MUST throw AppError 412, tx row NOT updated', async () => {
      const m = setupBase(PaymentGateway.PAYSTACK);
      const DECIMAL = (require('@prisma/client').Prisma.Decimal as any);
      const pendingTx: any = {
        id: 991,
        reference: 'PAY-PEND-991',
        status: TransactionStatus.PENDING,
        gateway: PaymentGateway.PAYSTACK,
        userId: MOCK_STUDENT.id,
        invoiceId: MOCK_INVOICE.id,
        expectedAmount: new DECIMAL(50000),
        amount: new DECIMAL(0),
        createdAt: new Date(),
        paystackReference: 'pay_pend_ref_991',
        alatpayFinalTransactionId: null,
        metadata: {},
        invoice: { ...MOCK_INVOICE },
      };
      (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(pendingTx);
      (prisma.transaction.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      if ((prisma as any).webhookEvent) {
        (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);
      }

      m.providerVerify.mockResolvedValueOnce({
        providerStatus: 'pending',
        paidAmountMinor: 0,
        paidAmountNaira: 0,
        status: TransactionStatus.PENDING,
        providerReference: 'pay_pend_ref_991',
        channel: 'card',
        paidAt: new Date(),
        currency: 'NGN',
        raw: {},
      });

      let threw: any = null;
      try {
        await TransactionCancellationService.cancelTransaction({
          transactionId: pendingTx.id,
          actorId: 5001,
          actorRole: Role.ADMIN,
          actorPermissions: [Permissions.VOID_TRANSACTIONS],
          reason: 'OTHER',
          writtenExplanation: 'popup closed after 5 minutes',
          evidenceReference: 'ABCD',
        });
      } catch (e) {
        threw = e;
      }

      expect(threw).toBeInstanceOf(AppError);
      const statusCode =
        (threw as any).statusCode ??
        (threw as any).httpCode ??
        (threw as any).code ??
        (threw as AppError).status;
      expect(statusCode).toBe(412);
      const updateManyCalls = (prisma.transaction.updateMany as jest.Mock).mock.calls.filter(
        (c) => {
          const data = (c?.[1]?.data ?? c?.[0]?.data) as any;
          return data?.status === TransactionStatus.CANCELLED;
        },
      );
      expect(updateManyCalls.length).toBe(0);
      const updateCalls = (prisma.transaction.update as jest.Mock).mock.calls.filter((c) => {
        const data = (c?.[1]?.data ?? c?.[0]?.data) as any;
        return data?.status === TransactionStatus.CANCELLED;
      });
      expect(updateCalls.length).toBe(0);
    });
  });

  describe('TR4_2 variant with TIME10 evidence ref → same 412, no row update', () => {
    it('TR4_2 mandatory: writtenExplanation "popup closed 10 minutes ago" + evidenceReference="TIME10" → same 412; tx row NOT updated', async () => {
      const m = setupBase(PaymentGateway.PAYSTACK);
      const DECIMAL = (require('@prisma/client').Prisma.Decimal as any);
      const pendingTx: any = {
        id: 992,
        reference: 'PAY-PEND-992',
        status: TransactionStatus.PENDING,
        gateway: PaymentGateway.PAYSTACK,
        userId: MOCK_STUDENT.id,
        invoiceId: MOCK_INVOICE.id,
        expectedAmount: new DECIMAL(50000),
        amount: new DECIMAL(0),
        createdAt: new Date(),
        paystackReference: 'pay_pend_ref_992',
        alatpayFinalTransactionId: null,
        metadata: {},
        invoice: { ...MOCK_INVOICE },
      };
      (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(pendingTx);
      (prisma.transaction.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      if ((prisma as any).webhookEvent) {
        (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);
      }

      m.providerVerify.mockResolvedValueOnce({
        providerStatus: 'pending',
        paidAmountMinor: 0,
        paidAmountNaira: 0,
        status: TransactionStatus.PENDING,
        providerReference: 'pay_pend_ref_992',
        channel: 'card',
        paidAt: new Date(),
        currency: 'NGN',
        raw: {},
      });

      let threw: any = null;
      try {
        await TransactionCancellationService.cancelTransaction({
          transactionId: pendingTx.id,
          actorId: 5001,
          actorRole: Role.ADMIN,
          actorPermissions: [Permissions.VOID_TRANSACTIONS],
          reason: 'OTHER',
          writtenExplanation: 'popup closed 10 minutes ago, no callback received, student left site',
          evidenceReference: 'TIME10',
        });
      } catch (e) {
        threw = e;
      }

      expect(threw).toBeInstanceOf(AppError);
      const statusCode =
        (threw as any).statusCode ??
        (threw as any).httpCode ??
        (threw as any).code ??
        (threw as AppError).status;
      expect(statusCode).toBe(412);
      const badUpdates = (prisma.transaction.updateMany as jest.Mock).mock.calls.concat(
        (prisma.transaction.update as jest.Mock).mock.calls,
      ).filter((c) => {
        const data = (c?.[1]?.data ?? c?.[0]?.data) as any;
        return data?.status === TransactionStatus.CANCELLED;
      });
      expect(badUpdates.length).toBe(0);
    });
  });

  describe('TR4_3 positive: providerVerify declined → cancel proceeds', () => {
    it('TR4_3 positive sanity: PENDING tx + providerVerify declined status → cancel allowed; status becomes CANCELLED', async () => {
      const m = setupBase(PaymentGateway.PAYSTACK);
      const DECIMAL = (require('@prisma/client').Prisma.Decimal as any);
      const pendingTx: any = {
        id: 993,
        reference: 'PAY-PEND-993',
        status: TransactionStatus.PENDING,
        gateway: PaymentGateway.PAYSTACK,
        userId: MOCK_STUDENT.id,
        invoiceId: MOCK_INVOICE.id,
        expectedAmount: new DECIMAL(50000),
        amount: new DECIMAL(0),
        createdAt: new Date(),
        paystackReference: 'pay_pend_ref_993',
        alatpayFinalTransactionId: null,
        metadata: {},
        invoice: { ...MOCK_INVOICE },
      };
      (prisma.transaction.findUnique as jest.Mock)
        .mockResolvedValueOnce(pendingTx)
        .mockResolvedValueOnce(pendingTx)
        .mockResolvedValueOnce({ ...pendingTx, status: TransactionStatus.CANCELLED });
      (prisma.transaction.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      if ((prisma as any).webhookEvent) {
        (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);
      }

      m.providerVerify.mockResolvedValueOnce({
        providerStatus: 'declined',
        paidAmountMinor: 0,
        paidAmountNaira: 0,
        status: TransactionStatus.FAILED,
        providerReference: 'pay_pend_ref_993',
        channel: 'card',
        paidAt: new Date(),
        currency: 'NGN',
        raw: { data: { status: 'declined' } },
      });

      const result = await TransactionCancellationService.cancelTransaction({
        transactionId: pendingTx.id,
        actorId: 5001,
        actorRole: Role.ADMIN,
        actorPermissions: [Permissions.VOID_TRANSACTIONS],
        reason: 'PROVIDER_SESSION_EXPIRED',
        writtenExplanation: 'Provider verify returned declined status for this attempt',
        evidenceReference: 'provider-declined-993',
      });

      expect(result).toBeDefined();
      const cancelUpdates = (prisma.transaction.updateMany as jest.Mock).mock.calls.filter(
        (c) => {
          const data = (c?.[1]?.data ?? c?.[0]?.data) as any;
          return data?.status === TransactionStatus.CANCELLED;
        },
      );
      expect(cancelUpdates.length).toBeGreaterThanOrEqual(1);
      const finalStatus = (result as any).transaction?.status;
      if (finalStatus !== undefined) {
        expect(finalStatus).toBe(TransactionStatus.CANCELLED);
      }
    });
  });

  describe('TR4_4 positive MANUAL_OVERRIDE path', () => {
    it('TR4_4 positive override: PENDING + ADMIN + VOID_TRANSACTIONS + evidenceOverride + SUPPORT-12345 → cancel allowed, status CANCELLED', async () => {
      setupBase(PaymentGateway.PAYSTACK);
      const DECIMAL = (require('@prisma/client').Prisma.Decimal as any);
      const pendingTx: any = {
        id: 994,
        reference: 'PAY-PEND-994',
        status: TransactionStatus.PENDING,
        gateway: PaymentGateway.PAYSTACK,
        userId: MOCK_STUDENT.id,
        invoiceId: MOCK_INVOICE.id,
        expectedAmount: new DECIMAL(50000),
        amount: new DECIMAL(0),
        createdAt: new Date(),
        paystackReference: null,
        alatpayFinalTransactionId: null,
        metadata: {},
        invoice: { ...MOCK_INVOICE },
      };
      (prisma.transaction.findUnique as jest.Mock)
        .mockResolvedValueOnce(pendingTx)
        .mockResolvedValueOnce(pendingTx)
        .mockResolvedValueOnce({ ...pendingTx, status: TransactionStatus.CANCELLED });
      (prisma.transaction.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      if ((prisma as any).webhookEvent) {
        (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);
      }

      const result = await TransactionCancellationService.cancelTransaction({
        transactionId: pendingTx.id,
        actorId: 5001,
        actorRole: Role.ADMIN,
        actorPermissions: [Permissions.VOID_TRANSACTIONS],
        reason: 'ADMINISTRATIVE_CORRECTION',
        writtenExplanation: 'Support ticket investigation confirms this attempt was a false duplicate; provider session confirmed abandoned by ops team.',
        evidenceReference: 'SUPPORT-12345',
        evidenceOverride: 'MANUAL_SUPPORT_OVERRIDE',
      });

      expect(result).toBeDefined();
      const cancelUpdates = (prisma.transaction.updateMany as jest.Mock).mock.calls.filter(
        (c) => {
          const data = (c?.[1]?.data ?? c?.[0]?.data) as any;
          return data?.status === TransactionStatus.CANCELLED;
        },
      );
      expect(cancelUpdates.length).toBeGreaterThanOrEqual(1);
      const finalStatus = (result as any).transaction?.status;
      if (finalStatus !== undefined) {
        expect(finalStatus).toBe(TransactionStatus.CANCELLED);
      }
    });
  });

  describe('TR4_5 three MANUAL override failure paths', () => {
    it('TR4_5(a): BURSARY role + VOID perm + override + ticket pattern → MUST fail (role not ADMIN)', async () => {
      setupBase(PaymentGateway.PAYSTACK);
      const DECIMAL = (require('@prisma/client').Prisma.Decimal as any);
      const pendingTx: any = {
        id: 995,
        reference: 'PAY-PEND-995',
        status: TransactionStatus.PENDING,
        gateway: PaymentGateway.ALATPAY,
        userId: MOCK_STUDENT.id,
        invoiceId: MOCK_INVOICE.id,
        expectedAmount: new DECIMAL(50000),
        amount: new DECIMAL(0),
        createdAt: new Date(),
        paystackReference: null,
        alatpayFinalTransactionId: null,
        metadata: {},
        invoice: { ...MOCK_INVOICE },
      };
      (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(pendingTx);
      if ((prisma as any).webhookEvent) {
        (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);
      }

      let threw: any = null;
      try {
        await TransactionCancellationService.cancelTransaction({
          transactionId: pendingTx.id,
          actorId: 6001,
          actorRole: Role.BURSARY,
          actorPermissions: [Permissions.VOID_TRANSACTIONS],
          reason: 'ADMINISTRATIVE_CORRECTION',
          writtenExplanation: 'Bursary attempting override (should fail role gate)',
          evidenceReference: 'SUPPORT-99999',
          evidenceOverride: 'MANUAL_SUPPORT_OVERRIDE',
        });
      } catch (e) {
        threw = e;
      }

      expect(threw).toBeDefined();
      const statusCode =
        (threw as any).statusCode ??
        (threw as any).httpCode ??
        (threw as any).code ??
        (threw as AppError)?.status;
      expect(statusCode === 403 || statusCode === 412).toBe(true);
    });

    it('TR4_5(b): ADMIN role + NO VOID perm + override + ticket → MUST fail (permission missing)', async () => {
      setupBase(PaymentGateway.PAYSTACK);
      const DECIMAL = (require('@prisma/client').Prisma.Decimal as any);
      const pendingTx: any = {
        id: 996,
        reference: 'PAY-PEND-996',
        status: TransactionStatus.PENDING,
        gateway: PaymentGateway.PAYSTACK,
        userId: MOCK_STUDENT.id,
        invoiceId: MOCK_INVOICE.id,
        expectedAmount: new DECIMAL(50000),
        amount: new DECIMAL(0),
        createdAt: new Date(),
        paystackReference: null,
        alatpayFinalTransactionId: null,
        metadata: {},
        invoice: { ...MOCK_INVOICE },
      };
      (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(pendingTx);
      if ((prisma as any).webhookEvent) {
        (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);
      }

      let threw: any = null;
      try {
        await TransactionCancellationService.cancelTransaction({
          transactionId: pendingTx.id,
          actorId: 5002,
          actorRole: Role.ADMIN,
          actorPermissions: [],
          reason: 'ADMINISTRATIVE_CORRECTION',
          writtenExplanation: 'ADMIN without VOID_TRANSACTIONS attempting override (must fail)',
          evidenceReference: 'SUPPORT-77777',
          evidenceOverride: 'MANUAL_SUPPORT_OVERRIDE',
        });
      } catch (e) {
        threw = e;
      }

      expect(threw).toBeDefined();
      const statusCode =
        (threw as any).statusCode ??
        (threw as any).httpCode ??
        (threw as any).code ??
        (threw as AppError)?.status;
      expect(statusCode === 403 || statusCode === 412).toBe(true);
    });

    it('TR4_5(c): ADMIN + VOID + override but evidenceRef=ABCD wrong pattern → MUST fail 412 with strict ticket message', async () => {
      setupBase(PaymentGateway.PAYSTACK);
      const DECIMAL = (require('@prisma/client').Prisma.Decimal as any);
      const pendingTx: any = {
        id: 997,
        reference: 'PAY-PEND-997',
        status: TransactionStatus.PENDING,
        gateway: PaymentGateway.PAYSTACK,
        userId: MOCK_STUDENT.id,
        invoiceId: MOCK_INVOICE.id,
        expectedAmount: new DECIMAL(50000),
        amount: new DECIMAL(0),
        createdAt: new Date(),
        paystackReference: null,
        alatpayFinalTransactionId: null,
        metadata: {},
        invoice: { ...MOCK_INVOICE },
      };
      (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(pendingTx);
      if ((prisma as any).webhookEvent) {
        (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);
      }

      let threw: any = null;
      try {
        await TransactionCancellationService.cancelTransaction({
          transactionId: pendingTx.id,
          actorId: 5001,
          actorRole: Role.ADMIN,
          actorPermissions: [Permissions.VOID_TRANSACTIONS],
          reason: 'ADMINISTRATIVE_CORRECTION',
          writtenExplanation: 'Evidence ref wrong pattern ABCD → should fail strict regex gate',
          evidenceReference: 'ABCD',
          evidenceOverride: 'MANUAL_SUPPORT_OVERRIDE',
        });
      } catch (e) {
        threw = e;
      }

      expect(threw).toBeInstanceOf(AppError);
      const statusCode =
        (threw as any).statusCode ??
        (threw as any).httpCode ??
        (threw as any).code ??
        (threw as AppError).status;
      expect(statusCode).toBe(412);
      const msg: string = String((threw as AppError)?.message ?? '').toLowerCase();
      const strictTicketMention =
        msg.includes('ticket') ||
        msg.includes('manual_support_override') ||
        msg.includes('reference pattern') ||
        msg.includes('support-') ||
        msg.includes('strict');
      expect(strictTicketMention).toBe(true);
    });
  });

  describe('TR4_6 network timeout treated as insufficient evidence', () => {
    it('TR4_6: providerVerify throws Error(timeout) → cancel with arbitrary text still 412 (no cancel)', async () => {
      const m = setupBase(PaymentGateway.ALATPAY);
      const DECIMAL = (require('@prisma/client').Prisma.Decimal as any);
      const VALID_UUID_V4 = 'd7725744-785f-46c9-821b-2e9d5d6f7ac3';
      const pendingTx: any = {
        id: 998,
        reference: 'PAY-PEND-998',
        status: TransactionStatus.PENDING,
        gateway: PaymentGateway.ALATPAY,
        userId: MOCK_STUDENT.id,
        invoiceId: MOCK_INVOICE.id,
        expectedAmount: new DECIMAL(50000),
        amount: new DECIMAL(0),
        createdAt: new Date(),
        paystackReference: null,
        alatpayFinalTransactionId: VALID_UUID_V4,
        metadata: {},
        invoice: { ...MOCK_INVOICE },
      };
      (prisma.transaction.findUnique as jest.Mock).mockResolvedValue(pendingTx);
      (prisma.transaction.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      if ((prisma as any).webhookEvent) {
        (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);
      }

      m.providerVerify.mockRejectedValueOnce(new Error('timeout: ALATPAY verify endpoint unreachable'));

      let threw: any = null;
      try {
        await TransactionCancellationService.cancelTransaction({
          transactionId: pendingTx.id,
          actorId: 5001,
          actorRole: Role.ADMIN,
          actorPermissions: [Permissions.VOID_TRANSACTIONS],
          reason: 'STUDENT_ABANDONED',
          writtenExplanation: 'Student popup was closed and network timeout during manual verify check; no evidence.',
          evidenceReference: 'NETFAIL-998',
        });
      } catch (e) {
        threw = e;
      }

      expect(threw).toBeInstanceOf(AppError);
      const statusCode =
        (threw as any).statusCode ??
        (threw as any).httpCode ??
        (threw as any).code ??
        (threw as AppError).status;
      expect(statusCode).toBe(412);
      const cancelUpdates = (prisma.transaction.updateMany as jest.Mock).mock.calls.filter(
        (c) => {
          const data = (c?.[1]?.data ?? c?.[0]?.data) as any;
          return data?.status === TransactionStatus.CANCELLED;
        },
      );
      expect(cancelUpdates.length).toBe(0);
    });
  });
});
