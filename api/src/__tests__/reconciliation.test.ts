import prisma from '../config/database';
import { Prisma, TransactionStatus, TransactionType, Role } from '@prisma/client';
import * as ReconModule from '../services/reconciliation';
import { ReconciliationService } from '../services/reconciliation';
import { kobo } from '../utils/paystack';

let fetchSpy: jest.SpyInstance<any> | null = null;
const originalFetch = ReconModule._reconciliationInternals.fetchPaystackTxListRange;

const DATE_FROM = new Date('2025-01-01T00:00:00.000Z');
const DATE_TO = new Date('2025-12-31T23:59:59.999Z');
const TX_DATE = new Date('2025-06-15T12:00:00.000Z');

function ref(s: string) {
  return `RECON-TEST-${s}`;
}

describe('AC-D1 Reconciliation Bucket Counts (10-payment fixture)', () => {
  let testStudentId: number | null = null;
  let testAdminId: number | null = null;
  let createdTxIds: number[] = [];
  let createdReceiptIds: number[] = [];
  let createdAuditIds: number[] = [];

  beforeAll(async () => {
    const student = await prisma.user.findFirst({
      where: { role: Role.STUDENT },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    testStudentId = student?.id ?? null;
    if (!testStudentId) {
      const created = await prisma.user.create({
        data: {
          email: `recon-test-student-${Date.now()}@university.edu.ng`,
          password: '$2b$10$testpasswordhash',
          firstName: 'ReconTest',
          lastName: 'Student',
          role: Role.STUDENT,
        },
        select: { id: true },
      });
      testStudentId = created.id;
    }
    const admin = await prisma.user.findFirst({
      where: { role: Role.ADMIN },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    testAdminId = admin?.id ?? null;
    if (!testAdminId) {
      const created = await prisma.user.create({
        data: {
          email: `recon-test-admin-${Date.now()}@university.edu.ng`,
          password: '$2b$10$testpasswordhash',
          firstName: 'ReconTest',
          lastName: 'Admin',
          role: Role.ADMIN,
        },
        select: { id: true },
      });
      testAdminId = created.id;
    }
  });

  beforeEach(async () => {
    if (fetchSpy) {
      fetchSpy.mockRestore();
      fetchSpy = null;
    }
  });

  afterEach(async () => {
    if (createdAuditIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { id: { in: createdAuditIds } } });
      createdAuditIds = [];
    }
    if (createdReceiptIds.length > 0) {
      await prisma.receipt.deleteMany({ where: { id: { in: createdReceiptIds } } });
      createdReceiptIds = [];
    }
    if (createdTxIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { id: { in: createdTxIds } } });
      createdTxIds = [];
    }
    if (fetchSpy) {
      fetchSpy.mockRestore();
      fetchSpy = null;
    }
    ReconModule._reconciliationInternals.fetchPaystackTxListRange = originalFetch;
  });

  function buildPaystackFixtures(): ReconModule.PaystackTxRow[] {
    const baseMatch = (refKey: string, amountNaira: number): ReconModule.PaystackTxRow => ({
      reference: ref(refKey),
      amount: kobo.fromNaira(amountNaira),
      status: 'success',
      channel: 'card',
      transaction_date: TX_DATE.toISOString(),
      paid_at: TX_DATE.toISOString(),
      created_at: TX_DATE.toISOString(),
      reversed: false,
      customer: { email: 'student@university.edu.ng' },
    });

    return [
      baseMatch('M1', 50000),
      baseMatch('M2', 25000),
      baseMatch('M3', 100000),
      baseMatch('M4', 75000),
      baseMatch('M5', 40000),
      baseMatch('M6', 15000),
      {
        ...baseMatch('AM', 60000),
        amount: kobo.fromNaira(60250.75),
      },
      baseMatch('MI', 80000),
      {
        ...baseMatch('DUP', 35000),
      },
      {
        ...baseMatch('DUP', 35000),
      },
      {
        ...baseMatch('REV', 45000),
        reversed: true,
      },
      baseMatch('MR', 55000),
    ];
  }

  async function seedInternalFixtures(studentId: number, adminId: number) {
    const baseTx = (
      refKey: string,
      paystackRef: string,
      amountN: number,
      status: TransactionStatus,
    ): any => ({
      reference: `PAY-${refKey}-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      paystackReference: paystackRef,
      userId: studentId,
      type: TransactionType.FEE_PAYMENT,
      status,
      expectedAmount: amountN,
      amount: amountN,
      paystackChannel: 'card',
      createdAt: TX_DATE,
      description: `Recon fixture ${refKey}`,
    });

    const fixtures: any[] = [
      baseTx('M1', ref('M1'), 50000, TransactionStatus.SUCCESS),
      baseTx('M2', ref('M2'), 25000, TransactionStatus.SUCCESS),
      baseTx('M3', ref('M3'), 100000, TransactionStatus.SUCCESS),
      baseTx('M4', ref('M4'), 75000, TransactionStatus.SUCCESS),
      baseTx('M5', ref('M5'), 40000, TransactionStatus.SUCCESS),
      baseTx('M6', ref('M6'), 15000, TransactionStatus.SUCCESS),
      baseTx('AM', ref('AM'), 60000, TransactionStatus.SUCCESS),
      baseTx('MP', ref('MP'), 90000, TransactionStatus.SUCCESS),
      baseTx('REV', ref('REV'), 45000, TransactionStatus.REVERSED),
      baseTx('MR', ref('MR'), 55000, TransactionStatus.SUCCESS),
    ];

    const createdTxes = [];
    for (const f of fixtures) {
      const t = await prisma.transaction.create({ data: f });
      createdTxIds.push(t.id);
      createdTxes.push(t);
    }

    const receiptedTxKeys = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'AM', 'MP', 'REV'];
    const counterRow = await (prisma.receipt.aggregate({ _max: { id: true } }) as Promise<{
      _max: { id: number | null };
    }>);
    let nextReceiptId = (counterRow._max.id ?? 0) + 1;
    for (let i = 0; i < fixtures.length; i++) {
      const key = fixtures[i].paystackReference!.replace('RECON-TEST-', '');
      if (!receiptedTxKeys.includes(key)) continue;
      const tx = createdTxes[i];
      const receiptNum = `RCT-REC-${nextReceiptId}`;
      nextReceiptId += 1;
      const receipt = await prisma.receipt.create({
        data: {
          receiptNumber: receiptNum,
          verificationToken: `vt-recon-${tx.id}-${nextReceiptId}-${Date.now()}`,
          transactionId: tx.id,
          studentId: studentId,
          paidAmount: Number(tx.amount),
          paystackReference: tx.paystackReference!,
          paymentChannel: 'card',
          paidAt: TX_DATE,
          qrCodeData: `https://example.com/verify/${receiptNum}`,
        },
      });
      createdReceiptIds.push(receipt.id);
    }
    void adminId;
  }

  it('AC-D1: 10-tx fixture produces exact expected bucket counts (Matched=6, AM=1, MI=1, MP=1, Dup=1, Rev=1, MR=1)', async () => {
    expect(testStudentId).toBeTruthy();
    expect(testAdminId).toBeTruthy();

    await seedInternalFixtures(testStudentId!, testAdminId!);

    fetchSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue(buildPaystackFixtures() as any);

    const result = await ReconciliationService.runCompare({
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
    });

    expect(typeof result.summary.systemRecords).toBe('number');
    expect(typeof result.summary.gatewayRecords).toBe('number');
    expect(result.summary.gatewayRecords).toBeGreaterThanOrEqual(10);

    expect(result.summary.matched).toBe(6);
    expect(result.summary.amountMismatch).toBe(1);
    expect(result.summary.missingInternal).toBe(1);
    expect(result.summary.missingGateway).toBe(1);
    expect(result.summary.duplicateReference).toBe(1);
    expect(result.summary.reversedTxn).toBe(1);
    expect(result.summary.missingReceipt).toBe(1);

    const totalBuckets =
      result.summary.matched +
      result.summary.amountMismatch +
      result.summary.missingInternal +
      result.summary.missingGateway +
      result.summary.duplicateReference +
      result.summary.reversedTxn +
      result.summary.missingReceipt;
    expect(totalBuckets).toBe(result.items.length);

    expect(result.items.length).toBeGreaterThanOrEqual(12);

    const byClass = new Map<string, number>();
    for (const it of result.items) {
      byClass.set(it.classification, (byClass.get(it.classification) ?? 0) + 1);
    }
    expect(byClass.get('MATCHED')).toBe(6);
    expect(byClass.get('AMOUNT_MISMATCH')).toBe(1);
    expect(byClass.get('MISSING_INTERNAL')).toBe(1);
    expect(byClass.get('MISSING_GATEWAY')).toBe(1);
    expect(byClass.get('DUPLICATE_REFERENCE')).toBe(1);
    expect(byClass.get('REVERSED_TXN')).toBe(1);
    expect(byClass.get('MISSING_RECEIPT')).toBe(1);

    const dupItem = result.items.find((i) => i.classification === 'DUPLICATE_REFERENCE');
    expect(dupItem).toBeTruthy();
    expect(dupItem?.gatewayReference).toBe(ref('DUP'));

    const mrItem = result.items.find((i) => i.classification === 'MISSING_RECEIPT');
    expect(mrItem).toBeTruthy();
    expect(mrItem?.gatewayReference).toBe(ref('MR'));
    expect(mrItem?.paymentReference).toBeTruthy();

    const miItem = result.items.find((i) => i.classification === 'MISSING_INTERNAL');
    expect(miItem).toBeTruthy();
    expect(miItem?.gatewayReference).toBe(ref('MI'));
    expect(miItem?.paymentReference).toBeNull();

    const mpItem = result.items.find((i) => i.classification === 'MISSING_GATEWAY');
    expect(mpItem).toBeTruthy();
    expect(mpItem?.gatewayReference).toBe(ref('MP'));
    expect(mpItem?.paymentReference).toBeTruthy();

    const revItem = result.items.find((i) => i.classification === 'REVERSED_TXN');
    expect(revItem).toBeTruthy();
    expect(revItem?.gatewayReference).toBe(ref('REV'));

    const amItem = result.items.find((i) => i.classification === 'AMOUNT_MISMATCH');
    expect(amItem).toBeTruthy();
    expect(amItem?.gatewayReference).toBe(ref('AM'));
    const delta = Math.abs((amItem?.expectedAmount ?? 0) - (amItem?.actualAmount ?? 0));
    expect(delta).toBeGreaterThan(0.5);
  });

  it('markReconciled writes exactly 1 audit_logs row with RECONCILIATION entityType', async () => {
    expect(testAdminId).toBeTruthy();
    const beforeCount = await prisma.auditLog.count({
      where: {
        entityType: 'RECONCILIATION',
        action: 'MARK_RECONCILED',
      },
    });

    const TEST_REF = `MARK-RECON-TEST-${Date.now()}`;
    const result = await ReconciliationService.markReconciled({
      paystackReference: TEST_REF,
      userId: testAdminId!,
      notes: 'Reconciliation Jest test — mark reconciled',
      ipAddress: '127.0.0.1',
      userAgent: 'jest-test',
    });

    createdAuditIds.push(result.auditId);

    expect(result.paystackReference).toBe(TEST_REF);
    expect(typeof result.auditId).toBe('number');
    expect(result.auditId).toBeGreaterThan(0);

    const afterCount = await prisma.auditLog.count({
      where: {
        entityType: 'RECONCILIATION',
        action: 'MARK_RECONCILED',
      },
    });
    expect(afterCount - beforeCount).toBe(1);

    const row = await prisma.auditLog.findUnique({ where: { id: result.auditId } });
    expect(row).toBeTruthy();
    expect(row?.entityType).toBe('RECONCILIATION');
    expect(row?.action).toBe('MARK_RECONCILED');
    expect(row?.entityId).toBe(TEST_REF);
    expect(row?.userId).toBe(testAdminId);
  });

  it('exportReport format=csv returns a BOM-prefixed CSV with header + subtotals + grand totals', async () => {
    expect(testStudentId).toBeTruthy();
    expect(testAdminId).toBeTruthy();
    await seedInternalFixtures(testStudentId!, testAdminId!);
    fetchSpy = jest
      .spyOn(ReconModule._reconciliationInternals, 'fetchPaystackTxListRange')
      .mockResolvedValue(buildPaystackFixtures() as any);

    const exp = await ReconciliationService.exportReport({
      format: 'csv',
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
    });

    expect(exp.format).toBe('csv');
    expect(exp.filename).toMatch(/^recon-\d{8}-\d{8}\.csv$/);
    const csv = exp.payload as string;
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Gateway Reference');
    expect(csv).toContain('Classification');
    expect(csv).toContain('Category Subtotals');
    expect(csv).toContain('GRAND TOTAL Items');
    expect(csv).toContain('Matched');
    expect(csv).toContain('Amount Mismatch');
    expect(csv).toContain('Missing Internal');
    expect(csv).toContain('Missing Gateway');
    expect(csv).toContain('Duplicate Reference');
    expect(csv).toContain('Reversed Transaction');
    expect(csv).toContain('Missing Receipt');
  });
});
