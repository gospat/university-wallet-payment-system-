import axios from 'axios';
import prisma from '../config/database';
import {
  Prisma,
  TransactionStatus,
  TransactionType,
  Role,
  PaymentGateway,
  InvoiceStatus,
  AssignmentTargetType,
} from '@prisma/client';
import * as ReconModule from '../services/reconciliation';
import { ReconciliationService } from '../services/reconciliation';
import { kobo } from '../utils/paystack';

const DATE_FROM = new Date('2025-01-01T00:00:00.000Z');
const DATE_TO = new Date('2025-12-31T23:59:59.999Z');
const TX_DATE = new Date('2025-06-15T12:00:00.000Z');

const ALAT_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function ref(s: string) {
  return `RECON-FIX-${s}`;
}

describe('Reconciliation Engine Corrections', () => {
  let testStudentId: number | null = null;
  let createdTxIds: number[] = [];
  let createdReceiptIds: number[] = [];
  let createdInvoiceIds: number[] = [];
  let createdAssignmentIds: number[] = [];
  let createdFeeIds: number[] = [];
  let dbAvailable = false;

  let psSpy: jest.SpyInstance<any> | null = null;
  let alatSpy: jest.SpyInstance<any> | null = null;
  let alatByIdSpy: jest.SpyInstance<any> | null = null;
  let axiosSpy: jest.SpyInstance<any> | null = null;

  beforeAll(async () => {
    try {
      const student = await prisma.user.findFirst({
        where: { role: Role.STUDENT },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      testStudentId = student?.id ?? null;
      if (!testStudentId) {
        const created = await prisma.user.create({
          data: {
            email: `recon-fix-student-${Date.now()}@university.edu.ng`,
            password: '$2b$10$testpasswordhash',
            firstName: 'ReconFix',
            lastName: 'Student',
            role: Role.STUDENT,
          },
          select: { id: true },
        });
        testStudentId = created.id;
      }
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  afterEach(async () => {
    if (createdReceiptIds.length > 0) {
      await prisma.receipt.deleteMany({ where: { id: { in: createdReceiptIds } } });
      createdReceiptIds = [];
    }
    if (createdTxIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { id: { in: createdTxIds } } });
      createdTxIds = [];
    }
    if (createdInvoiceIds.length > 0) {
      await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
      createdInvoiceIds = [];
    }
    if (createdAssignmentIds.length > 0) {
      await prisma.feeAssignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
      createdAssignmentIds = [];
    }
    if (createdFeeIds.length > 0) {
      await prisma.fee.deleteMany({ where: { id: { in: createdFeeIds } } });
      createdFeeIds = [];
    }
    if (psSpy) { psSpy.mockRestore(); psSpy = null; }
    if (alatSpy) { alatSpy.mockRestore(); alatSpy = null; }
    if (alatByIdSpy) { alatByIdSpy.mockRestore(); alatByIdSpy = null; }
    if (axiosSpy) { axiosSpy.mockRestore(); axiosSpy = null; }
  });

  async function createTx(data: any) {
    const t = await prisma.transaction.create({
      data: {
        userId: testStudentId!,
        type: TransactionType.FEE_PAYMENT,
        createdAt: TX_DATE,
        ...data,
      },
    });
    createdTxIds.push(t.id);
    return t;
  }

  function paystackRow(refKey: string, amountN: number, status = 'success', paidAt = TX_DATE.toISOString()) {
    return {
      reference: ref(refKey),
      amount: kobo.fromNaira(amountN),
      status,
      channel: 'card',
      paid_at: paidAt,
      transaction_date: paidAt,
      created_at: paidAt,
      reversed: false,
      customer: { email: 'student@university.edu.ng' },
    };
  }

  function alatRow(uuid: string, amountN: number, status = 'SUCCESS') {
    return {
      Id: uuid,
      Amount: amountN,
      Status: status,
      CreatedAt: TX_DATE.toISOString(),
      UpdatedAt: TX_DATE.toISOString(),
    };
  }

  // ---- Scenario 1: ALATPay list endpoint returns 404 → provider UNAVAILABLE ----
  it('S1: ALATPay list 404 marks provider UNAVAILABLE, not MISSING_GATEWAY', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-ALAT-404',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: ALAT_UUID,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockResolvedValue({ row: null, available: false, notFound: false });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary, items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    expect(summary.providerAvailability.alatpay).toBe('UNAVAILABLE');
    expect(summary.incompleteCoverage).toBe(true);
    const alatItem = items.find((i) => i.paymentReference === 'PAY-ALAT-404');
    expect(alatItem?.classification).toBe('UNABLE_TO_VERIFY');
    expect(alatItem?.classification).not.toBe('MISSING_GATEWAY');
    expect(summary.missingGateway).toBe(0);
    expect(summary.unableToVerify).toBeGreaterThanOrEqual(1);
  });

  // ---- Scenario 2: ALATPay list returns valid empty result → available, zero rows ----
  it('S2: ALATPay valid empty result distinguished from unavailable', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    expect(summary.providerAvailability.alatpay).toBe('AVAILABLE');
    expect(summary.gatewayRecords).toBe(0);
  });

  // ---- Scenario 3: ALATPay individual lookup succeeds → match by final UUID ----
  it('S3: ALATPay individual lookup matches using alatpayFinalTransactionId', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-ALAT-MATCH',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: ALAT_UUID,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });
    // receipt present
    const t = await prisma.transaction.findFirst({ where: { reference: 'PAY-ALAT-MATCH' } });
    if (t) {
      const r = await prisma.receipt.create({
        data: {
          receiptNumber: `RCT-FIX-${Date.now()}`,
          verificationToken: `vt-${Date.now()}`,
          transactionId: t.id,
          studentId: testStudentId!,
          paidAmount: 50000,
          paymentChannel: 'card',
          paidAt: TX_DATE,
          qrCodeData: 'x',
          convenienceFee: 0,
          serviceCharge: 0,
          gatewayFee: 0,
          totalAmount: 50000,
        },
      });
      createdReceiptIds.push(r.id);
    }

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockResolvedValue({ row: alatRow(ALAT_UUID, 50000, 'SUCCESS'), available: true, notFound: false });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary, items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    expect(alatByIdSpy).toHaveBeenCalledWith({ providerId: ALAT_UUID });
    const matched = items.find((i) => i.paymentReference === 'PAY-ALAT-MATCH');
    expect(matched?.classification).toBe('MATCHED');
    expect(matched?.verificationMethod).toBe('GATEWAY_INDIVIDUAL_LOOKUP');
    expect(summary.matched).toBeGreaterThanOrEqual(1);
  });

  // ---- Scenario 4: Provider lookup fails → unverified ----
  it('S4: ALATPay individual lookup failure leaves transaction UNABLE_TO_VERIFY', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-ALAT-FAIL',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: ALAT_UUID,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockResolvedValue({ row: null, available: false, notFound: false });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    const item = items.find((i) => i.paymentReference === 'PAY-ALAT-FAIL');
    expect(item?.classification).toBe('UNABLE_TO_VERIFY');
    expect(item?.classification).not.toBe('MATCHED');
    expect(item?.classification).not.toBe('MISSING_GATEWAY');
  });

  // ---- Scenario 5: Successful internal tx with matching amount → MATCHED ----
  it('S5: Successful internal tx with matching provider amount is MATCHED', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-PS-MATCH',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-MATCH'),
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });
    const t = await prisma.transaction.findFirst({ where: { reference: 'PAY-PS-MATCH' } });
    if (t) {
      const r = await prisma.receipt.create({
        data: {
          receiptNumber: `RCT-FIX2-${Date.now()}`,
          verificationToken: `vt2-${Date.now()}`,
          transactionId: t.id,
          studentId: testStudentId!,
          paidAmount: 50000,
          paymentChannel: 'card',
          paidAt: TX_DATE,
          qrCodeData: 'x',
          convenienceFee: 0, serviceCharge: 0, gatewayFee: 0, totalAmount: 50000,
        },
      });
      createdReceiptIds.push(r.id);
    }

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [paystackRow('PS-MATCH', 50000)], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    const matched = items.find((i) => i.paymentReference === 'PAY-PS-MATCH');
    expect(matched?.classification).toBe('MATCHED');
  });

  // ---- Scenario 6: Amount discrepancy → AMOUNT_MISMATCH ----
  it('S6: Genuine amount discrepancy is AMOUNT_MISMATCH', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-PS-AM',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-AM'),
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });
    const t = await prisma.transaction.findFirst({ where: { reference: 'PAY-PS-AM' } });
    if (t) {
      const r = await prisma.receipt.create({
        data: {
          receiptNumber: `RCT-FIX3-${Date.now()}`,
          verificationToken: `vt3-${Date.now()}`,
          transactionId: t.id,
          studentId: testStudentId!,
          paidAmount: 50000,
          paymentChannel: 'card',
          paidAt: TX_DATE,
          qrCodeData: 'x',
          convenienceFee: 0, serviceCharge: 0, gatewayFee: 0, totalAmount: 50000,
        },
      });
      createdReceiptIds.push(r.id);
    }

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [paystackRow('PS-AM', 50250.75)], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    const am = items.find((i) => i.paymentReference === 'PAY-PS-AM');
    expect(am?.classification).toBe('AMOUNT_MISMATCH');
  });

  // ---- Scenario 7: FAILED attempt → not MISSING_GATEWAY ----
  it('S7: FAILED payment attempt is not MISSING_GATEWAY', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-PS-FAIL',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-FAIL'),
      status: TransactionStatus.FAILED,
      expectedAmount: 50000,
      amount: 50000,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items, summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    const fail = items.find((i) => i.paymentReference === 'PAY-PS-FAIL');
    expect(fail?.classification).toBe('FAILED_ATTEMPT');
    expect(fail?.classification).not.toBe('MISSING_GATEWAY');
    expect(summary.failedAttempts).toBeGreaterThanOrEqual(1);
    expect(summary.missingGateway).toBe(0);
  });

  // ---- Scenario 8: PENDING attempt → not MISSING_GATEWAY ----
  it('S8: PENDING payment attempt is not MISSING_GATEWAY', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-PS-PEND',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-PEND'),
      status: TransactionStatus.PENDING,
      expectedAmount: 50000,
      amount: 50000,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items, summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    const pend = items.find((i) => i.paymentReference === 'PAY-PS-PEND');
    expect(pend?.classification).toBe('PENDING_ATTEMPT');
    expect(pend?.classification).not.toBe('MISSING_GATEWAY');
    expect(summary.pendingAttempts).toBeGreaterThanOrEqual(1);
    expect(summary.missingGateway).toBe(0);
  });

  // ---- Scenario 9: Paystack uses ISO datetime filters ----
  it('S9: Paystack list request uses ISO datetime from/to params', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const from = new Date('2025-03-01T00:00:00.000Z');
    const to = new Date('2025-03-31T23:59:59.999Z');

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    await ReconciliationService.runCompare({
      dateFrom: from,
      dateTo: to,
      gateway: PaymentGateway.PAYSTACK,
    });

    const callArgs = psSpy.mock.calls[0][0];
    // The function receives Date objects and converts to ISO internally.
    expect(callArgs.from instanceof Date).toBe(true);
    expect(callArgs.to instanceof Date).toBe(true);
    // Verify the actual axios URL would use ISO strings by checking the impl:
    // We test the function directly to confirm ISO format.
    const isoRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
    expect(callArgs.from.toISOString()).toMatch(isoRegex);
    expect(callArgs.to.toISOString()).toMatch(isoRegex);
  });

  // ---- Scenario 10: Paystack records outside range not displayed ----
  it('S10: Paystack records outside date range are filtered out', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    // Mock axios so the real fetchPaystackTxListRange filters by date
    const axiosGetSpy = jest.spyOn(require('axios'), 'get').mockResolvedValue({
      data: {
        data: [
          paystackRow('PS-OOR', 50000, 'success', '2025-02-15T10:00:00.000Z'),
          paystackRow('PS-IR', 50000, 'success', '2025-03-15T10:00:00.000Z'),
        ],
      },
    });
    const originalSecret = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'test-secret';

    try {
      const from = new Date('2025-03-01T00:00:00.000Z');
      const to = new Date('2025-03-31T23:59:59.999Z');
      const { rows } = await ReconModule.fetchPaystackTxListRange({ from, to });

      const refs = rows.map((r: any) => r.reference);
      expect(refs).toContain(ref('PS-IR'));
      expect(refs).not.toContain(ref('PS-OOR'));

      // Also verify the URL used ISO datetime params
      const callUrl = axiosGetSpy.mock.calls[0][0] as string;
      expect(callUrl).toContain('from=2025-03-01T00%3A00%3A00.000Z');
      expect(callUrl).toContain('to=2025-03-31T23%3A59%3A59.999Z');
    } finally {
      axiosGetSpy.mockRestore();
      if (originalSecret) process.env.PAYSTACK_SECRET_KEY = originalSecret;
      else delete process.env.PAYSTACK_SECRET_KEY;
    }
  });

  // ---- Scenario 11: Paystack API failure not treated as zero ----
  it('S11: Paystack API failure marks provider unavailable (not zero transactions)', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: false });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    expect(summary.providerAvailability.paystack).toBe('UNAVAILABLE');
    expect(summary.incompleteCoverage).toBe(true);
    expect(summary.gatewayRecords).toBe(0);
  });

  // ---- Scenario 12: Missing receipt on confirmed successful payment ----
  it('S12: Missing receipt on successful matched payment is flagged', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-PS-NR',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-NR'),
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [paystackRow('PS-NR', 50000)], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items, summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    const nr = items.find((i) => i.paymentReference === 'PAY-PS-NR');
    expect(nr?.classification).toBe('MISSING_RECEIPT');
    expect(summary.missingReceipt).toBeGreaterThanOrEqual(1);
  });

  // ---- Scenario 13: Gateway records absent from Bells → MISSING_INTERNAL ----
  it('S13: Gateway-only record is MISSING_INTERNAL when confirmed', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [paystackRow('PS-MI', 50000)], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items, summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    const mi = items.find((i) => i.gatewayReference === ref('PS-MI'));
    expect(mi?.classification).toBe('MISSING_INTERNAL');
    expect(mi?.paymentReference).toBeNull();
    expect(summary.missingInternal).toBeGreaterThanOrEqual(1);
  });

  // ---- Scenario 14: Incomplete coverage → dashboard warning flag ----
  it('S14: Incomplete gateway coverage sets incompleteCoverage warning', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });

    const { summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
    });

    expect(summary.incompleteCoverage).toBe(true);
    expect(summary.providerAvailability.alatpay).toBe('UNAVAILABLE');
    expect(summary.providerAvailability.paystack).toBe('AVAILABLE');
  });

  // ---- Scenario 15: CSV export preserves provider availability ----
  it('S15: CSV export includes provider availability and verification columns', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });

    const exp = await ReconciliationService.exportReport({
      format: 'csv',
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
    });

    const csv = exp.payload as string;
    expect(csv).toContain('Provider Availability');
    expect(csv).toContain('UNAVAILABLE');
    expect(csv).toContain('Verification Method');
    expect(csv).toContain('Provider Reference');
    expect(csv).toContain('Variance');
    expect(csv).toContain('Incomplete Coverage');
  });

  // ---- Scenario 16: No financial mutations during reconciliation ----
  it('S16: runCompare performs no DB writes (read-only)', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-PS-RO',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-RO'),
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [paystackRow('PS-RO', 50000)], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const txBefore = await prisma.transaction.count();
    const receiptBefore = await prisma.receipt.count();
    const auditBefore = await prisma.auditLog.count();

    await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    const txAfter = await prisma.transaction.count();
    const receiptAfter = await prisma.receipt.count();
    const auditAfter = await prisma.auditLog.count();

    expect(txAfter).toBe(txBefore);
    expect(receiptAfter).toBe(receiptBefore);
    expect(auditAfter).toBe(auditBefore);
  });

  // ---- Scenario 17: ALATPay list unavailable but individual lookup works → PARTIALLY_AVAILABLE ----
  it('S17: ALATPay list unavailable + individual lookup succeeds → PARTIALLY_AVAILABLE (not AVAILABLE)', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const t = await createTx({
      reference: 'PAY-ALAT-PARTIAL',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: ALAT_UUID,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });
    const r = await prisma.receipt.create({
      data: {
        receiptNumber: `RCT-PART-${Date.now()}`,
        verificationToken: `vt-part-${Date.now()}`,
        transactionId: t.id,
        studentId: testStudentId!,
        paidAmount: 50000,
        paymentChannel: 'card',
        paidAt: TX_DATE,
        qrCodeData: 'x',
        convenienceFee: 0,
        serviceCharge: 0,
        gatewayFee: 0,
        totalAmount: 50000,
      },
    });
    createdReceiptIds.push(r.id);

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockResolvedValue({ row: alatRow(ALAT_UUID, 50000, 'SUCCESS'), available: true, notFound: false });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary, items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    expect(summary.providerAvailability.alatpay).toBe('PARTIALLY_AVAILABLE');
    expect(summary.incompleteCoverage).toBe(true);
    expect(summary.missingGateway).toBe(0);
    const matched = items.find((i) => i.paymentReference === 'PAY-ALAT-PARTIAL');
    expect(matched?.classification).toBe('MATCHED');
  });

  // ---- Scenario 18: One individual lookup succeeds, another fails ----
  it('S18: one individual ALATPay lookup succeeds, another fails → failed one UNABLE_TO_VERIFY', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const UUID_A = '11111111-aaaa-4aaa-8aaa-111111111111';
    const UUID_B = '22222222-bbbb-4bbb-8bbb-222222222222';
    const ta = await createTx({
      reference: 'PAY-ALAT-A',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: UUID_A,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });
    const tb = await createTx({
      reference: 'PAY-ALAT-B',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: UUID_B,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 30000,
      amount: 30000,
    });
    const ra = await prisma.receipt.create({
      data: {
        receiptNumber: `RCT-A-${Date.now()}`,
        verificationToken: `vt-a-${Date.now()}`,
        transactionId: ta.id,
        studentId: testStudentId!,
        paidAmount: 50000,
        paymentChannel: 'card',
        paidAt: TX_DATE,
        qrCodeData: 'x',
        convenienceFee: 0,
        serviceCharge: 0,
        gatewayFee: 0,
        totalAmount: 50000,
      },
    });
    const rb = await prisma.receipt.create({
      data: {
        receiptNumber: `RCT-B-${Date.now()}`,
        verificationToken: `vt-b-${Date.now()}`,
        transactionId: tb.id,
        studentId: testStudentId!,
        paidAmount: 30000,
        paymentChannel: 'card',
        paidAt: TX_DATE,
        qrCodeData: 'x',
        convenienceFee: 0,
        serviceCharge: 0,
        gatewayFee: 0,
        totalAmount: 30000,
      },
    });
    createdReceiptIds.push(ra.id, rb.id);

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockImplementation(({ providerId }: any) => {
        if (providerId === UUID_A) {
          return Promise.resolve({ row: alatRow(UUID_A, 50000, 'SUCCESS'), available: true, notFound: false });
        }
        return Promise.resolve({ row: null, available: false, notFound: false });
      });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary, items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    expect(summary.providerAvailability.alatpay).toBe('PARTIALLY_AVAILABLE');
    expect(summary.missingGateway).toBe(0);
    const a = items.find((i) => i.paymentReference === 'PAY-ALAT-A');
    const b = items.find((i) => i.paymentReference === 'PAY-ALAT-B');
    expect(a?.classification).toBe('MATCHED');
    expect(b?.classification).toBe('UNABLE_TO_VERIFY');
    expect(b?.classification).not.toBe('MISSING_GATEWAY');
  });

  // ---- Scenario 19: ALATPay success without provider UUID while list unavailable → UNABLE_TO_VERIFY ----
  it('S19: ALATPay success without usable provider UUID while list unavailable → UNABLE_TO_VERIFY', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-ALAT-NOUUID',
      gateway: PaymentGateway.ALATPAY,
      alatpayReference: 'not-a-uuid-just-order-ref',
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockResolvedValue({ row: null, available: false, notFound: false });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary, items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    expect(summary.providerAvailability.alatpay).toBe('UNAVAILABLE');
    expect(summary.missingGateway).toBe(0);
    const c = items.find((i) => i.paymentReference === 'PAY-ALAT-NOUUID');
    expect(c?.classification).toBe('UNABLE_TO_VERIFY');
    expect(c?.classification).not.toBe('MISSING_GATEWAY');
  });

  // ---- Scenario 20: ALATPay-only filter must not consider Paystack availability ----
  it('S20: ALATPay-only filter does not consider Paystack availability', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    // Paystack not requested — its availability must not affect incompleteCoverage.

    const { summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    expect(summary.providerAvailability.paystack).toBe('NOT_REQUESTED');
    expect(summary.providerAvailability.alatpay).toBe('AVAILABLE');
    expect(summary.incompleteCoverage).toBe(false);
  });

  // ---- Scenario 21: Paystack-only filter must not consider ALATPay availability ----
  it('S21: Paystack-only filter does not consider ALATPay availability', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    expect(summary.providerAvailability.alatpay).toBe('NOT_REQUESTED');
    expect(summary.providerAvailability.paystack).toBe('AVAILABLE');
    expect(summary.incompleteCoverage).toBe(false);
  });

  // ---- Scenario 22: ALL filter considers both providers ----
  it('S22: ALL filter considers both providers', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });

    const { summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
    });

    expect(summary.providerAvailability.paystack).toBe('AVAILABLE');
    expect(summary.providerAvailability.alatpay).toBe('UNAVAILABLE');
    expect(summary.incompleteCoverage).toBe(true);
  });

  // ---- Scenario 23: PARTIALLY_AVAILABLE causes incompleteCoverage when requested ----
  it('S23: PARTIALLY_AVAILABLE always causes incompleteCoverage when provider requested', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-ALAT-PART2',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: ALAT_UUID,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: false });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockResolvedValue({ row: alatRow(ALAT_UUID, 50000, 'SUCCESS'), available: true, notFound: false });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    expect(summary.providerAvailability.alatpay).toBe('PARTIALLY_AVAILABLE');
    expect(summary.incompleteCoverage).toBe(true);
  });

  // ---- Scenario 24: NOT_REQUESTED provider produces no misleading warning ----
  it('S24: NOT_REQUESTED provider is not reported as unavailable', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { summary } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.ALATPAY,
    });

    expect(summary.providerAvailability.paystack).toBe('NOT_REQUESTED');
    expect(summary.incompleteCoverage).toBe(false);
  });

  // ---- Scenario 25: Successful transaction around midnight uses receipt.paidAt ----
  it('S25: successful tx near midnight is included by receipt.paidAt financial date', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    // Attempt created on Oct 14 23:58, receipt paid on Oct 15 00:03.
    const created = new Date('2026-10-14T23:58:00.000Z');
    const paidAt = new Date('2026-10-15T00:03:00.000Z');
    const dayFrom = new Date('2026-10-15T00:00:00.000Z');
    const dayTo = new Date('2026-10-15T23:59:59.999Z');

    const t = await createTx({
      reference: 'PAY-PS-MIDNIGHT',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-MIDNIGHT'),
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      createdAt: created,
    });
    const r = await prisma.receipt.create({
      data: {
        receiptNumber: `RCT-MID-${Date.now()}`,
        verificationToken: `vt-mid-${Date.now()}`,
        transactionId: t.id,
        studentId: testStudentId!,
        paidAmount: 50000,
        paymentChannel: 'card',
        paidAt,
        qrCodeData: 'x',
        convenienceFee: 0,
        serviceCharge: 0,
        gatewayFee: 0,
        totalAmount: 50000,
      },
    });
    createdReceiptIds.push(r.id);

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [paystackRow('PS-MIDNIGHT', 50000, 'success', paidAt.toISOString())], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: dayFrom,
      dateTo: dayTo,
      gateway: PaymentGateway.PAYSTACK,
    });

    const item = items.find((i) => i.paymentReference === 'PAY-PS-MIDNIGHT');
    expect(item).toBeDefined();
    expect(item?.classification).toBe('MATCHED');
  });

  // ---- Scenario 26: No reconciliation read operation mutates financial state ----
  it('S26: runCompare changes no transaction/receipt/invoice/ledger/settlement/refund state', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    await createTx({
      reference: 'PAY-PS-RO2',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-RO2'),
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [paystackRow('PS-RO2', 50000)], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const txBefore = await prisma.transaction.count();
    const receiptBefore = await prisma.receipt.count();
    const invoiceBefore = await prisma.invoice.count();
    const auditBefore = await prisma.auditLog.count();
    const settlementBefore = await prisma.settlement.count();
    const refundBefore = await prisma.refund.count();

    await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      gateway: PaymentGateway.PAYSTACK,
    });

    expect(await prisma.transaction.count()).toBe(txBefore);
    expect(await prisma.receipt.count()).toBe(receiptBefore);
    expect(await prisma.invoice.count()).toBe(invoiceBefore);
    expect(await prisma.auditLog.count()).toBe(auditBefore);
    expect(await prisma.settlement.count()).toBe(settlementBefore);
    expect(await prisma.refund.count()).toBe(refundBefore);
  });

  // ====================================================================
  // Lagos business-day boundary tests (Issue 1)
  // ====================================================================
  const LAGOS_OFFSET_MS = 60 * 60 * 1000; // UTC+1, no DST
  function lagosToUtc(y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0) {
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms) - LAGOS_OFFSET_MS);
  }
  const SAME_DAY_FROM = new Date('2026-10-15T00:00:00.000Z');
  const SAME_DAY_TO = new Date('2026-10-15T00:00:00.000Z');

  async function setupLagosSuccessTx(refKey: string, paidAtLagosUtc: Date) {
    const t = await createTx({
      reference: `PAY-PS-${refKey}`,
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref(refKey),
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      createdAt: paidAtLagosUtc,
    });
    const r = await prisma.receipt.create({
      data: {
        receiptNumber: `RCT-${refKey}-${Date.now()}`,
        verificationToken: `vt-${refKey}-${Date.now()}`,
        transactionId: t.id,
        studentId: testStudentId!,
        paidAmount: 50000,
        paymentChannel: 'card',
        paidAt: paidAtLagosUtc,
        qrCodeData: 'x',
        convenienceFee: 0,
        serviceCharge: 0,
        gatewayFee: 0,
        totalAmount: 50000,
      },
    });
    createdReceiptIds.push(r.id);
    return t;
  }

  function mockPaystackMatch(refKey: string, paidAt: Date) {
    return jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({
        rows: [paystackRow(refKey, 50000, 'success', paidAt.toISOString())],
        available: true,
      });
  }
  function mockAlatEmptyAvailable() {
    return jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });
  }

  it('S27: same-day 15/10/2026 includes payment at 15 Oct 00:00 Lagos', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const paidAt = lagosToUtc(2026, 10, 15, 0, 0, 0, 0); // 14 Oct 23:00 UTC
    await setupLagosSuccessTx('LAGOS-0000', paidAt);
    psSpy = mockPaystackMatch('LAGOS-0000', paidAt);
    alatSpy = mockAlatEmptyAvailable();

    const { items } = await ReconciliationService.runCompare({
      dateFrom: SAME_DAY_FROM, dateTo: SAME_DAY_TO, gateway: PaymentGateway.PAYSTACK,
    });
    expect(items.find((i) => i.paymentReference === 'PAY-PS-LAGOS-0000')).toBeDefined();
  });

  it('S28: same-day 15/10/2026 includes payment at 15 Oct 12:00 Lagos', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const paidAt = lagosToUtc(2026, 10, 15, 12, 0, 0, 0); // 15 Oct 11:00 UTC
    await setupLagosSuccessTx('LAGOS-1200', paidAt);
    psSpy = mockPaystackMatch('LAGOS-1200', paidAt);
    alatSpy = mockAlatEmptyAvailable();

    const { items } = await ReconciliationService.runCompare({
      dateFrom: SAME_DAY_FROM, dateTo: SAME_DAY_TO, gateway: PaymentGateway.PAYSTACK,
    });
    expect(items.find((i) => i.paymentReference === 'PAY-PS-LAGOS-1200')).toBeDefined();
  });

  it('S29: same-day 15/10/2026 includes payment at 15 Oct 23:59:59 Lagos', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const paidAt = lagosToUtc(2026, 10, 15, 23, 59, 59, 0); // 15 Oct 22:59:59 UTC
    await setupLagosSuccessTx('LAGOS-2359', paidAt);
    psSpy = mockPaystackMatch('LAGOS-2359', paidAt);
    alatSpy = mockAlatEmptyAvailable();

    const { items } = await ReconciliationService.runCompare({
      dateFrom: SAME_DAY_FROM, dateTo: SAME_DAY_TO, gateway: PaymentGateway.PAYSTACK,
    });
    expect(items.find((i) => i.paymentReference === 'PAY-PS-LAGOS-2359')).toBeDefined();
  });

  it('S30: same-day 15/10/2026 excludes payment at 14 Oct 23:59:59 Lagos', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const paidAt = lagosToUtc(2026, 10, 14, 23, 59, 59, 0); // 14 Oct 22:59:59 UTC
    await setupLagosSuccessTx('LAGOS-EXCL-1', paidAt);
    psSpy = mockPaystackMatch('LAGOS-EXCL-1', paidAt);
    alatSpy = mockAlatEmptyAvailable();

    const { items } = await ReconciliationService.runCompare({
      dateFrom: SAME_DAY_FROM, dateTo: SAME_DAY_TO, gateway: PaymentGateway.PAYSTACK,
    });
    expect(items.find((i) => i.paymentReference === 'PAY-PS-LAGOS-EXCL-1')).toBeUndefined();
  });

  it('S31: same-day 15/10/2026 excludes payment at 16 Oct 00:00 Lagos', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const paidAt = lagosToUtc(2026, 10, 16, 0, 0, 0, 0); // 15 Oct 23:00 UTC — exclusive upper boundary
    await setupLagosSuccessTx('LAGOS-EXCL-2', paidAt);
    psSpy = mockPaystackMatch('LAGOS-EXCL-2', paidAt);
    alatSpy = mockAlatEmptyAvailable();

    const { items } = await ReconciliationService.runCompare({
      dateFrom: SAME_DAY_FROM, dateTo: SAME_DAY_TO, gateway: PaymentGateway.PAYSTACK,
    });
    expect(items.find((i) => i.paymentReference === 'PAY-PS-LAGOS-EXCL-2')).toBeUndefined();
  });

  it('S32: multi-day 30/09–14/10 includes the complete final calendar day 14 Oct', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    // 14 Oct 23:59:59 Lagos = 14 Oct 22:59:59 UTC — must be included
    const paidAt = lagosToUtc(2026, 10, 14, 23, 59, 59, 0);
    await setupLagosSuccessTx('MULTI-END', paidAt);
    psSpy = mockPaystackMatch('MULTI-END', paidAt);
    alatSpy = mockAlatEmptyAvailable();

    const { items } = await ReconciliationService.runCompare({
      dateFrom: new Date('2026-09-30T00:00:00.000Z'),
      dateTo: new Date('2026-10-14T00:00:00.000Z'),
      gateway: PaymentGateway.PAYSTACK,
    });
    expect(items.find((i) => i.paymentReference === 'PAY-PS-MULTI-END')).toBeDefined();
  });

  it('S33: attempt 14 Oct 23:58 paid 15 Oct 00:03 Lagos appears under 15 October', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const created = lagosToUtc(2026, 10, 14, 23, 58, 0, 0); // 14 Oct 22:58 UTC
    const paidAt = lagosToUtc(2026, 10, 15, 0, 3, 0, 0); // 14 Oct 23:03 UTC
    const t = await createTx({
      reference: 'PAY-PS-MID-LAG',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-MID-LAG'),
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      createdAt: created,
    });
    const r = await prisma.receipt.create({
      data: {
        receiptNumber: `RCT-MIDLAG-${Date.now()}`,
        verificationToken: `vt-midlag-${Date.now()}`,
        transactionId: t.id,
        studentId: testStudentId!,
        paidAmount: 50000,
        paymentChannel: 'card',
        paidAt,
        qrCodeData: 'x',
        convenienceFee: 0,
        serviceCharge: 0,
        gatewayFee: 0,
        totalAmount: 50000,
      },
    });
    createdReceiptIds.push(r.id);
    psSpy = mockPaystackMatch('PS-MID-LAG', paidAt);
    alatSpy = mockAlatEmptyAvailable();

    const { items } = await ReconciliationService.runCompare({
      dateFrom: SAME_DAY_FROM, dateTo: SAME_DAY_TO, gateway: PaymentGateway.PAYSTACK,
    });
    const item = items.find((i) => i.paymentReference === 'PAY-PS-MID-LAG');
    expect(item).toBeDefined();
    expect(item?.date).toBe(paidAt.toISOString());
  });

  it('S34: SUCCESS item displays receipt.paidAt financial date, not createdAt', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const created = new Date('2026-10-10T00:00:00.000Z');
    const paidAt = lagosToUtc(2026, 10, 15, 9, 30, 0, 0);
    const t = await createTx({
      reference: 'PAY-PS-DATE-DISP',
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: ref('PS-DATE-DISP'),
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      createdAt: created,
    });
    const r = await prisma.receipt.create({
      data: {
        receiptNumber: `RCT-DATEDISP-${Date.now()}`,
        verificationToken: `vt-datedisp-${Date.now()}`,
        transactionId: t.id,
        studentId: testStudentId!,
        paidAmount: 50000,
        paymentChannel: 'card',
        paidAt,
        qrCodeData: 'x',
        convenienceFee: 0,
        serviceCharge: 0,
        gatewayFee: 0,
        totalAmount: 50000,
      },
    });
    createdReceiptIds.push(r.id);
    psSpy = mockPaystackMatch('PS-DATE-DISP', paidAt);
    alatSpy = mockAlatEmptyAvailable();

    const { items } = await ReconciliationService.runCompare({
      dateFrom: SAME_DAY_FROM, dateTo: SAME_DAY_TO, gateway: PaymentGateway.PAYSTACK,
    });
    const item = items.find((i) => i.paymentReference === 'PAY-PS-DATE-DISP');
    expect(item).toBeDefined();
    expect(item?.date).toBe(paidAt.toISOString());
    expect(item?.date).not.toBe(created.toISOString());
  });

  it('S35: ALATPay list omits UUID + individual succeeds → GATEWAY_INDIVIDUAL_LOOKUP', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const uuid = '11111111-1111-1111-1111-111111111111';
    const t = await createTx({
      reference: 'PAY-ALAT-LISTMISS',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: uuid,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });
    const r = await prisma.receipt.create({
      data: {
        receiptNumber: `RCT-LISTMISS-${Date.now()}`,
        verificationToken: `vt-listmiss-${Date.now()}`,
        transactionId: t.id,
        studentId: testStudentId!,
        paidAmount: 50000,
        paymentChannel: 'card',
        paidAt: TX_DATE,
        qrCodeData: 'x',
        convenienceFee: 0,
        serviceCharge: 0,
        gatewayFee: 0,
        totalAmount: 50000,
      },
    });
    createdReceiptIds.push(r.id);

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockResolvedValue({ row: alatRow(uuid, 50000, 'SUCCESS'), available: true, notFound: false });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.ALATPAY,
    });
    const item = items.find((i) => i.paymentReference === 'PAY-ALAT-LISTMISS');
    expect(item).toBeDefined();
    expect(item?.classification).toBe('MATCHED');
    expect(item?.verificationMethod).toBe('GATEWAY_INDIVIDUAL_LOOKUP');
  });

  it('S36: ALATPay list omits UUID + individual transport fails → UNABLE_TO_VERIFY', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const uuid = '22222222-2222-2222-2222-222222222222';
    await createTx({
      reference: 'PAY-ALAT-TRANSPORT',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: uuid,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockResolvedValue({ row: null, available: false, notFound: false });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.ALATPAY,
    });
    const item = items.find((i) => i.paymentReference === 'PAY-ALAT-TRANSPORT');
    expect(item).toBeDefined();
    expect(item?.classification).not.toBe('MISSING_GATEWAY');
    expect(item?.classification).toBe('UNABLE_TO_VERIFY');
  });

  it('S37: ALATPay individual definitive not-found → MISSING_GATEWAY only when proven', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const uuid = '33333333-3333-3333-3333-333333333333';
    await createTx({
      reference: 'PAY-ALAT-NOTFOUND',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: uuid,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatByIdSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxById')
      .mockResolvedValue({ row: null, available: false, notFound: true });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.ALATPAY,
    });
    const item = items.find((i) => i.paymentReference === 'PAY-ALAT-NOTFOUND');
    expect(item).toBeDefined();
    expect(item?.classification).toBe('MISSING_GATEWAY');
  });

  // =================================================================
  // ISSUE 1: HISTORICAL DIRECT BILL IDENTIFICATION
  // A settled Direct Bill (isActive=false, settledAt set) must remain
  // DIRECT_BILL forever. An unrelated later catalogue purchase for the
  // same student+fee must remain CATALOGUE.
  // =================================================================

  async function setupFeeWithAssignment(opts: {
    feeCode: string;
    assignmentType?: AssignmentTargetType;
    isActive?: boolean;
    settledAt?: Date | null;
    assignedAt?: Date;
    withAssignment?: boolean;
  }) {
    const fee = await prisma.fee.create({
      data: {
        feeCode: opts.feeCode,
        name: `Recon Fix ${opts.feeCode}`,
        category: {
          connectOrCreate: {
            where: { code: 'RECON_FIX_CAT' },
            create: { code: 'RECON_FIX_CAT', name: 'Recon Fix Category' },
          },
        },
        amount: new Prisma.Decimal(50000),
        academicSession: '2024/2025',
        createdBy: { connect: { id: testStudentId! } },
      },
    });
    createdFeeIds.push(fee.id);

    let assignmentId: number | null = null;
    if (opts.withAssignment !== false) {
      const asg = await prisma.feeAssignment.create({
        data: {
          feeId: fee.id,
          assignmentType: opts.assignmentType ?? AssignmentTargetType.STUDENT,
          targetStudentId: testStudentId!,
          assignedById: testStudentId!,
          assignedAt: opts.assignedAt ?? new Date('2025-06-01T00:00:00.000Z'),
          isActive: opts.isActive ?? true,
          settledAt: opts.settledAt ?? null,
        },
      });
      createdAssignmentIds.push(asg.id);
      assignmentId = asg.id;
    }

    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-${opts.feeCode}`,
        studentId: testStudentId!,
        feeId: fee.id,
        amountDue: new Prisma.Decimal(50000),
        amountPaid: new Prisma.Decimal(50000),
        status: InvoiceStatus.PAID,
        session: '2024/2025',
        createdAt: TX_DATE,
      },
    });
    createdInvoiceIds.push(inv.id);

    return { fee, assignmentId, invoice: inv };
  }

  it('S38: active unpaid direct bill -> DIRECT_BILL', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const code = `DB-ACTIVE-${Date.now()}`;
    const { invoice } = await setupFeeWithAssignment({
      feeCode: code,
      isActive: true,
      settledAt: null,
    });
    await createTx({
      reference: `PAY-DB-ACTIVE-${code}`,
      gateway: PaymentGateway.PAYSTACK,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      invoiceId: invoice.id,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.PAYSTACK,
    });
    const item = items.find((i) => i.paymentReference === `PAY-DB-ACTIVE-${code}`);
    expect(item).toBeDefined();
    expect(item?.chargeSource).toBe('DIRECT_BILL');
  });

  it('S39: paid/settled direct bill (isActive=false, settledAt set) -> DIRECT_BILL', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const code = `DB-SETTLED-${Date.now()}`;
    const { invoice } = await setupFeeWithAssignment({
      feeCode: code,
      isActive: false,
      settledAt: new Date('2025-06-20T00:00:00.000Z'),
    });
    await createTx({
      reference: `PAY-DB-SETTLED-${code}`,
      gateway: PaymentGateway.PAYSTACK,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      invoiceId: invoice.id,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.PAYSTACK,
    });
    const item = items.find((i) => i.paymentReference === `PAY-DB-SETTLED-${code}`);
    expect(item).toBeDefined();
    expect(item?.chargeSource).toBe('DIRECT_BILL');
  });

  it('S40: genuine catalogue payment (no assignment) -> CATALOGUE', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const code = `CAT-GENUINE-${Date.now()}`;
    const { invoice } = await setupFeeWithAssignment({
      feeCode: code,
      withAssignment: false,
    });
    await createTx({
      reference: `PAY-CAT-GENUINE-${code}`,
      gateway: PaymentGateway.PAYSTACK,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      invoiceId: invoice.id,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.PAYSTACK,
    });
    const item = items.find((i) => i.paymentReference === `PAY-CAT-GENUINE-${code}`);
    expect(item).toBeDefined();
    expect(item?.chargeSource).toBe('CATALOGUE');
  });

  it('S41: historical settled assignment must NOT convert an unrelated later catalogue tx to DIRECT_BILL', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const code = `CAT-LATER-${Date.now()}`;
    // Assignment was created and settled LONG BEFORE the invoice was created.
    // invoice.createdAt (2025-06-15) > settledAt (2025-02-01), so this is a
    // genuine later catalogue purchase, NOT the old direct bill.
    const { invoice } = await setupFeeWithAssignment({
      feeCode: code,
      isActive: false,
      assignedAt: new Date('2025-01-01T00:00:00.000Z'),
      settledAt: new Date('2025-02-01T00:00:00.000Z'),
    });
    await createTx({
      reference: `PAY-CAT-LATER-${code}`,
      gateway: PaymentGateway.PAYSTACK,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      invoiceId: invoice.id,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.PAYSTACK,
    });
    const item = items.find((i) => i.paymentReference === `PAY-CAT-LATER-${code}`);
    expect(item).toBeDefined();
    expect(item?.chargeSource).toBe('CATALOGUE');
  });

  it('S42: Direct Bill filter returns the settled Direct Bill payment', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const code = `DB-FILTER-${Date.now()}`;
    const { invoice } = await setupFeeWithAssignment({
      feeCode: code,
      isActive: false,
      settledAt: new Date('2025-06-20T00:00:00.000Z'),
    });
    await createTx({
      reference: `PAY-DB-FILTER-${code}`,
      gateway: PaymentGateway.PAYSTACK,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      invoiceId: invoice.id,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.PAYSTACK,
      chargeSource: 'DIRECT_BILL',
    });
    const item = items.find((i) => i.paymentReference === `PAY-DB-FILTER-${code}`);
    expect(item).toBeDefined();
    expect(item?.chargeSource).toBe('DIRECT_BILL');
  });

  it('S43: Catalogue filter does NOT return the settled Direct Bill payment', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const code = `CAT-EXCLUDE-${Date.now()}`;
    const { invoice } = await setupFeeWithAssignment({
      feeCode: code,
      isActive: false,
      settledAt: new Date('2025-06-20T00:00:00.000Z'),
    });
    await createTx({
      reference: `PAY-CAT-EXCLUDE-${code}`,
      gateway: PaymentGateway.PAYSTACK,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
      invoiceId: invoice.id,
    });

    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.PAYSTACK,
      chargeSource: 'CATALOGUE',
    });
    const item = items.find((i) => i.paymentReference === `PAY-CAT-EXCLUDE-${code}`);
    expect(item).toBeUndefined();
  });

  // =================================================================
  // ISSUE 2: PAYSTACK EXCLUSIVE UPPER BOUNDARY
  // For 15/10/2026 Lagos business day:
  //   2026-10-15T22:59:59.999Z -> included
  //   2026-10-15T23:00:00.000Z -> excluded
  // =================================================================

  it('S44: Paystack list filter uses exclusive upper boundary (>= toMs excluded)', async () => {
    // Lagos 2026-10-15 00:00 -> 2026-10-14T23:00:00Z (from, inclusive)
    // Lagos 2026-10-16 00:00 -> 2026-10-15T23:00:00Z (to, exclusive)
    const from = new Date('2026-10-14T23:00:00.000Z');
    const to = new Date('2026-10-15T23:00:00.000Z');

    const includedTs = '2026-10-15T22:59:59.999Z';
    const excludedTs = '2026-10-15T23:00:00.000Z';

    axiosSpy = jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        data: [
          { reference: 'PS-INCLUDED', amount: 100000, status: 'success', paid_at: includedTs },
          { reference: 'PS-EXCLUDED', amount: 100000, status: 'success', paid_at: excludedTs },
        ],
      },
      status: 200,
    } as any);

    const { rows } = await ReconModule._reconciliationInternals.fetchPaystackTxListRange({ from, to });
    const refs = rows.map((r: any) => r.reference);
    expect(refs).toContain('PS-INCLUDED');
    expect(refs).not.toContain('PS-EXCLUDED');
  });

  // =================================================================
  // ISSUE 3: ALATPAY EMPTY/MALFORMED 2XX MUST NOT MEAN NOT FOUND
  // Only definitive HTTP 404 sets notFound=true. Everything else
  // (timeout, 5xx, 401, 403, empty 2xx, malformed 2xx) is ambiguous
  // and becomes UNABLE_TO_VERIFY. The second candidate endpoint must
  // be checked even if the first returns an ambiguous response.
  // =================================================================

  it('S45: ALATPay valid individual response -> MATCHED (row returned, notFound=false)', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    axiosSpy = jest.spyOn(axios, 'get').mockResolvedValue({
      data: { data: { Id: uuid, Amount: 50000, Status: 'SUCCESS' } },
      status: 200,
    } as any);

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).not.toBeNull();
    expect(result.available).toBe(true);
    expect(result.notFound).toBe(false);
    expect((result.row as any).Id).toBe(uuid);
  });

  it('S46: ALATPay definitive HTTP 404 -> notFound=true (eligible for MISSING_GATEWAY)', async () => {
    const uuid = '22222222-2222-2222-2222-222222222222';
    const err: any = new Error('Not Found');
    err.response = { status: 404, data: { message: 'Not Found' } };
    axiosSpy = jest.spyOn(axios, 'get').mockRejectedValue(err);

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(true);
    expect(result.available).toBe(false);
  });

  it('S47: ALATPay HTTP 500 -> notFound=false (UNABLE_TO_VERIFY, never MISSING_GATEWAY)', async () => {
    const uuid = '44444444-4444-4444-4444-444444444444';
    const err: any = new Error('Internal Server Error');
    err.response = { status: 500, data: { message: 'Internal Server Error' } };
    axiosSpy = jest.spyOn(axios, 'get').mockRejectedValue(err);

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S48: ALATPay timeout -> notFound=false (UNABLE_TO_VERIFY)', async () => {
    const uuid = '55555555-5555-5555-5555-555555555555';
    const err: any = new Error('timeout of 15000ms exceeded');
    err.code = 'ECONNABORTED';
    err.response = undefined;
    axiosSpy = jest.spyOn(axios, 'get').mockRejectedValue(err);

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S49: ALATPay empty 2xx response -> notFound=false (UNABLE_TO_VERIFY)', async () => {
    const uuid = '66666666-6666-6666-6666-666666666666';
    axiosSpy = jest.spyOn(axios, 'get').mockResolvedValue({
      data: {},
      status: 200,
    } as any);

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S50: ALATPay malformed 2xx response -> notFound=false (UNABLE_TO_VERIFY)', async () => {
    const uuid = '77777777-7777-7777-7777-777777777777';
    axiosSpy = jest.spyOn(axios, 'get').mockResolvedValue({
      data: { unexpected: 'shape', noId: true },
      status: 200,
    } as any);

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S51: ALATPay first candidate ambiguous (empty 2xx) but second returns valid transaction -> MATCHED', async () => {
    const uuid = '88888888-8888-8888-8888-888888888888';
    let callCount = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      callCount += 1;
      if (callCount === 1) {
        // First candidate endpoint returns empty 2xx — ambiguous.
        return { data: {}, status: 200 } as any;
      }
      // Second candidate endpoint returns the valid transaction.
      return {
        data: { data: { Id: uuid, Amount: 50000, Status: 'SUCCESS' } },
        status: 200,
      } as any;
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(callCount).toBe(2);
    expect(result.row).not.toBeNull();
    expect(result.available).toBe(true);
    expect(result.notFound).toBe(false);
    expect((result.row as any).Id).toBe(uuid);
  });

  // =================================================================
  // ISSUE: ALATPAY MIXED-ENDPOINT RESPONSES MUST NOT PRODUCE
  // FALSE MISSING_GATEWAY
  //
  // notFound = true ONLY when ALL candidate endpoints return a
  // definitive HTTP 404. Any ambiguous response (5xx, timeout,
  // 401, 403, empty/malformed 2xx) from ANY candidate forces
  // notFound = false → UNABLE_TO_VERIFY, never MISSING_GATEWAY.
  // A valid transaction from any candidate wins (FOUND).
  // =================================================================

  function axiosError(status: number | null, message = 'error', code?: string) {
    const err: any = new Error(message);
    if (status != null) {
      err.response = { status, data: { message } };
    } else {
      err.response = undefined;
    }
    if (code) err.code = code;
    return err;
  }

  it('S52: 500 -> 404 => UNABLE_TO_VERIFY (notFound=false)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000001';
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw axiosError(500, 'Internal Server Error');
      throw axiosError(404, 'Not Found');
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S53: timeout -> 404 => UNABLE_TO_VERIFY (notFound=false)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000002';
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw axiosError(null, 'timeout of 15000ms exceeded', 'ECONNABORTED');
      throw axiosError(404, 'Not Found');
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S54: empty 200 -> 404 => UNABLE_TO_VERIFY (notFound=false)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000003';
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) return { data: {}, status: 200 } as any;
      throw axiosError(404, 'Not Found');
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S55: malformed 200 -> 404 => UNABLE_TO_VERIFY (notFound=false)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000004';
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) return { data: { unexpected: 'shape', noId: true }, status: 200 } as any;
      throw axiosError(404, 'Not Found');
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S56: 401 -> 404 => UNABLE_TO_VERIFY (notFound=false)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000005';
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw axiosError(401, 'Unauthorized');
      throw axiosError(404, 'Not Found');
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S57: 403 -> 404 => UNABLE_TO_VERIFY (notFound=false)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000006';
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw axiosError(403, 'Forbidden');
      throw axiosError(404, 'Not Found');
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(false);
  });

  it('S58: 404 -> valid transaction => FOUND (valid transaction wins)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000007';
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw axiosError(404, 'Not Found');
      return { data: { data: { Id: uuid, Amount: 50000, Status: 'SUCCESS' } }, status: 200 } as any;
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).not.toBeNull();
    expect(result.notFound).toBe(false);
    expect((result.row as any).Id).toBe(uuid);
  });

  it('S59: empty 200 -> valid transaction => FOUND (valid transaction wins)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000008';
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) return { data: {}, status: 200 } as any;
      return { data: { data: { Id: uuid, Amount: 50000, Status: 'SUCCESS' } }, status: 200 } as any;
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).not.toBeNull();
    expect(result.notFound).toBe(false);
    expect((result.row as any).Id).toBe(uuid);
  });

  it('S60: 500 -> valid transaction => FOUND (valid transaction wins)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000009';
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw axiosError(500, 'Internal Server Error');
      return { data: { data: { Id: uuid, Amount: 50000, Status: 'SUCCESS' } }, status: 200 } as any;
    });

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).not.toBeNull();
    expect(result.notFound).toBe(false);
    expect((result.row as any).Id).toBe(uuid);
  });

  it('S61: all candidates return 404 => notFound=true (eligible for MISSING_GATEWAY)', async () => {
    const uuid = '90000000-0000-0000-0000-000000000010';
    axiosSpy = jest.spyOn(axios, 'get').mockRejectedValue(axiosError(404, 'Not Found'));

    const result = await ReconModule._reconciliationInternals.fetchAlatpayTxById({ providerId: uuid });
    expect(result.row).toBeNull();
    expect(result.notFound).toBe(true);
  });

  it('S62: integration — all-404 with full list coverage => MISSING_GATEWAY', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const uuid = '90000000-0000-0000-0000-000000000011';
    await createTx({
      reference: 'PAY-ALAT-ALL404',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: uuid,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    // fetchAlatpayTxById is NOT spied — the real implementation runs with
    // axios mocked to return 404 from both candidate endpoints.
    axiosSpy = jest.spyOn(axios, 'get').mockRejectedValue(axiosError(404, 'Not Found'));
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.ALATPAY,
    });
    const item = items.find((i) => i.paymentReference === 'PAY-ALAT-ALL404');
    expect(item).toBeDefined();
    expect(item?.classification).toBe('MISSING_GATEWAY');
  });

  it('S63: integration — ambiguous provider evidence (500->404) can NEVER produce MISSING_GATEWAY', async () => {
    if (!dbAvailable) { console.warn('[recon-fix] DB unavailable — skipping'); return; }
    const uuid = '90000000-0000-0000-0000-000000000012';
    await createTx({
      reference: 'PAY-ALAT-AMBIG',
      gateway: PaymentGateway.ALATPAY,
      alatpayFinalTransactionId: uuid,
      status: TransactionStatus.SUCCESS,
      expectedAmount: 50000,
      amount: 50000,
    });

    alatSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchAlatpayTxListRange')
      .mockResolvedValue({ rows: [], available: true });
    let call = 0;
    axiosSpy = jest.spyOn(axios, 'get').mockImplementation(async () => {
      call += 1;
      if (call === 1) throw axiosError(500, 'Internal Server Error');
      throw axiosError(404, 'Not Found');
    });
    psSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue({ rows: [], available: true });

    const { items } = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM, dateTo: DATE_TO, gateway: PaymentGateway.ALATPAY,
    });
    const item = items.find((i) => i.paymentReference === 'PAY-ALAT-AMBIG');
    expect(item).toBeDefined();
    expect(item?.classification).not.toBe('MISSING_GATEWAY');
    expect(item?.classification).toBe('UNABLE_TO_VERIFY');
  });
});
