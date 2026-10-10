import { PaymentService, _testResetInitiateLocks } from '../services/payment';
import prisma from '../config/database';
import * as PaystackModule from '../services/paystack';
import { TransactionStatus, Role, PaymentGateway } from '@prisma/client';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    user: { findFirst: jest.fn() },
    invoice: { findFirst: jest.fn() },
    transaction: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    rolePermission: { findMany: jest.fn() },
    $transaction: jest.fn(async (fn: any) => {
      const prisma = (require('../config/database') as any).default;
      const txClient: any = {
        $executeRawUnsafe: jest.fn().mockResolvedValue([]),
        invoice: {
          findUnique: (...args: any[]) => prisma.invoice.findFirst
            ? prisma.invoice.findFirst({ where: args?.[0]?.where, select: args?.[0]?.select })
            : Promise.resolve(null),
        },
        transaction: {
          create: (...args: any[]) => prisma.transaction.create(...args),
          update: (...args: any[]) => prisma.transaction.update(...args),
          updateMany: (...args: any[]) => prisma.transaction.updateMany
            ? prisma.transaction.updateMany(...args)
            : Promise.resolve({ count: 0 }),
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
    computePaymentBreakdown: jest.fn(),
  },
  computePaymentBreakdown: jest.fn(),
}));

jest.mock('../services/payment/providerFactory', () => {
  const actual = jest.requireActual('@prisma/client');
  return {
    __esModule: true,
    getActiveGatewaySetting: jest.fn().mockResolvedValue(actual.PaymentGateway.PAYSTACK),
    setActiveGatewaySetting: jest.fn(),
    getPaymentProvider: jest.fn(() => {
      // Build a PaystackProvider-like adapter on the fly from jest-mocked PaystackService
      const PaystackService = (require('../services/paystack') as any).PaystackService;
      const computePaymentBreakdown = (require('../services/paystack') as any).computePaymentBreakdown;
      return {
        initialize: async (_email: string, amountKobo: number, opts: any) => {
          const result = await PaystackService.initializeTransaction({
            email: _email,
            amount: amountKobo,
            reference: opts?.reference,
            callback_url: opts?.callbackUrl,
            metadata: opts?.metadata,
          });
          return {
            paymentUrl: result?.authorization_url,
            redirectUrl: result?.authorization_url,
            checkoutUrl: result?.authorization_url,
            sessionId: result?.access_code,
            accessCode: result?.access_code,
            providerReference: result?.reference,
            reference: result?.reference,
          };
        },
        verify: async (ref: string) => {
          const r = await PaystackService.verifyTransaction(ref);
          const success = r?.data?.status === 'success';
          return {
            success,
            amountKobo: success ? Math.round(Number(r.data.amount)) : 0,
            amountMajor: success ? Number(r.data.amount) / 100 : 0,
            providerReference: String(r?.data?.reference ?? ref),
            channel: (r?.data?.channel as any) ?? null,
            paidAt: r?.data?.paid_at ? new Date(r.data.paid_at) : null,
            customerEmail: r?.data?.customer?.email ?? null,
            raw: r,
          };
        },
        computeBreakdown: (baseAmountMajor: number) => computePaymentBreakdown(baseAmountMajor),
      };
    }),
  };
});

describe('A5.1 initiatePayment idempotency 425 guard', () => {
  const MOCK_STUDENT = {
    id: 1001,
    email: 'student@test.edu',
    firstName: 'Test',
    lastName: 'Student',
    matricNumber: 'TEST/001',
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

  function resetMocks() {
    (prisma.user.findFirst as jest.Mock).mockReset();
    (prisma.invoice.findFirst as jest.Mock).mockReset();
    (prisma.transaction.findFirst as jest.Mock).mockReset();
    (prisma.transaction.create as jest.Mock).mockReset();
    (prisma.transaction.update as jest.Mock).mockReset();
    (PaystackModule.PaystackService.initializeTransaction as jest.Mock).mockReset();
    (PaystackModule.computePaymentBreakdown as jest.Mock).mockReset();
  }

  beforeEach(() => {
    _testResetInitiateLocks();
    resetMocks();
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(MOCK_STUDENT);
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(MOCK_INVOICE);
    (PaystackModule.computePaymentBreakdown as jest.Mock).mockReturnValue({
      baseAmount: 50000,
      serviceCharge: 750,
      gatewayFee: 0,
      totalAmount: 50750,
      serviceChargeMode: 'percentage',
      gatewayFeeMode: 'flat',
    });
    (PaystackModule.PaystackService.initializeTransaction as jest.Mock).mockResolvedValue({
      authorization_url: 'https://checkout.paystack.mock/pay',
      access_code: 'mock-access',
      reference: 'PAY-TEST-001',
    });
    (prisma.transaction.create as jest.Mock).mockImplementation((data: any) =>
      Promise.resolve({ id: 9000 + Math.random(), reference: data?.data?.reference ?? 'ref', ...data }),
    );
    (prisma.transaction.update as jest.Mock).mockImplementation((_: any) => Promise.resolve({ id: 1 }));
  });

  it('[idempotency-425] 2 rapid calls for same invoice — 2nd throws AppError 425 Too Early', async () => {
    (prisma.transaction.findFirst as jest.Mock).mockImplementation((args: any) => {
      const where = args?.where ?? {};
      if (where.status === TransactionStatus.PENDING && where.invoiceId === 501) {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    const callArgs = { invoiceId: 501 };

    await PaymentService.initiatePayment(MOCK_STUDENT.id, callArgs as any);

    (prisma.transaction.findFirst as jest.Mock).mockImplementation((args: any) => {
      const where = args?.where ?? {};
      if (where.status === TransactionStatus.PENDING && where.invoiceId === 501) {
        return Promise.resolve({
          id: 9001,
          createdAt: new Date(Date.now() - 60_000),
          status: TransactionStatus.PENDING,
        });
      }
      return Promise.resolve(null);
    });

    await expect(
      PaymentService.initiatePayment(MOCK_STUDENT.id, callArgs as any),
    ).rejects.toMatchObject({ statusCode: 425, message: expect.stringContaining('Payment already in progress') });
  });

  it('[idempotency-reinit] PENDING row older than 5 min — PENDING preserved, 409 block, ZERO terminal FAILED/SUCCESS/UNDERPAID/OVERPAID/REVERSED writes', async () => {
    (prisma.transaction.findFirst as jest.Mock).mockImplementation((args: any) => {
      const where = args?.where ?? {};
      if (where.status === TransactionStatus.PENDING && where.invoiceId === 501) {
        return Promise.resolve({
          id: 9010,
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          status: TransactionStatus.PENDING,
          gateway: 'PAYSTACK',
        });
      }
      return Promise.resolve(null);
    });
    (prisma.transaction.count as jest.Mock).mockResolvedValue(1);

    const callArgs = { invoiceId: 501 };
    let threw: any = null;
    try {
      await PaymentService.initiatePayment(MOCK_STUDENT.id, callArgs as any);
    } catch (e) {
      threw = e;
    }

    expect(threw).toBeInstanceOf(Error);
    const statusCode = (threw as any).statusCode ?? (threw as any).httpCode ?? (threw as any).code ?? (threw as any).status;
    expect(statusCode).toBe(409);

    const terminalWrites = (prisma.transaction.update as jest.Mock).mock.calls.filter((call) => {
      const data = ((call?.[1]?.data ?? call?.[0]?.data) as any) ?? {};
      return [
        TransactionStatus.FAILED,
        TransactionStatus.SUCCESS,
        TransactionStatus.UNDERPAID,
        TransactionStatus.OVERPAID,
        TransactionStatus.REVERSED,
      ].includes(data.status);
    });
    expect(terminalWrites.length).toBe(0);

    const reinitFailedWrites = (prisma.transaction.update as jest.Mock).mock.calls.filter((call) => {
      const data = ((call?.[1]?.data ?? call?.[0]?.data) as any) ?? {};
      return String(data.description ?? '').includes('client-reinit-timeout');
    });
    expect(reinitFailedWrites.length).toBe(0);

    expect(PaystackModule.PaystackService.initializeTransaction).not.toHaveBeenCalled();
    expect(prisma.transaction.create).toHaveBeenCalledTimes(0);
  });
});
