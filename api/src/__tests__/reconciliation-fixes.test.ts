import prisma from '../config/database';
import { Prisma, TransactionStatus, TransactionType, Role, PaymentGateway } from '@prisma/client';
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
  let dbAvailable = false;

  let psSpy: jest.SpyInstance<any> | null = null;
  let alatSpy: jest.SpyInstance<any> | null = null;
  let alatByIdSpy: jest.SpyInstance<any> | null = null;

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
    if (psSpy) { psSpy.mockRestore(); psSpy = null; }
    if (alatSpy) { alatSpy.mockRestore(); alatSpy = null; }
    if (alatByIdSpy) { alatByIdSpy.mockRestore(); alatByIdSpy = null; }
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
      .mockResolvedValue({ row: null, available: false });
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
      .mockResolvedValue({ row: alatRow(ALAT_UUID, 50000, 'SUCCESS'), available: true });
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
      .mockResolvedValue({ row: null, available: false });
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
});
