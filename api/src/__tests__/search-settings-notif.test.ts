import prisma from '../config/database';
import { AdminSearchService } from '../services/search';
import { SystemSettingsService } from '../services/systemSettings';
import { AdminNotificationService } from '../services/adminNotification';
import { dispatchEmail, clearCapturesForTests, queueCaptures } from '../queues/emailQueue';
import * as PaystackServiceModule from '../services/paystack';
import { PaymentService } from '../services/payment';
import { generatePaymentReference } from '../utils/paystack';
import { Role, InvoiceStatus, TransactionStatus, TransactionType, Prisma } from '@prisma/client';

describe('Batch E1/E4/B5 Services + B4.1 Post-Commit Hook', () => {
  // ------- Helpers ---------------------------------------------------------
  const rand = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  let seededStudentId: number | null = null;
  let seededInvoiceId: number | null = null;
  let seededTransactionId: number | null = null;

  beforeAll(async () => {
    // Clean up any leftover test data (best-effort)
    clearCapturesForTests();
  });

  afterAll(async () => {
    // Cleanup seeded test rows (best effort, ignore errors)
    try {
      if (seededTransactionId) {
        await prisma.transaction.deleteMany({ where: { id: seededTransactionId } }).catch(() => {});
      }
      if (seededInvoiceId) {
        await prisma.invoice.deleteMany({ where: { id: seededInvoiceId } }).catch(() => {});
      }
      if (seededStudentId) {
        await prisma.user.deleteMany({ where: { id: seededStudentId } }).catch(() => {});
      }
    } catch {
      /* cleanup failures are non-fatal */
    }
    clearCapturesForTests();
  });

  // =========================================================================
  // E1: Composite Global Search
  // =========================================================================
  describe('E1 — AdminSearchService.composite (students search)', () => {
    let studentId: number;
    const STUDENT_MATRIC = '2024/CSC/001';
    const FIRST_NAME = 'John';
    const LAST_NAME = 'Doe';
    const FEE_AMOUNT_DUE = 150000;
    const FEE_AMOUNT_PAID = 0;

    beforeAll(async () => {
      // 1. Seed student John Doe with matric 2024/CSC/001
      const email = rand('john.doe') + '@university.edu.ng';
      const student = await prisma.user.create({
        data: {
          email,
          password: '$2b$10$scaffoldHashPlaceholderForTestingXXXXXXXXXXXXX',
          firstName: FIRST_NAME,
          lastName: LAST_NAME,
          matricNumber: STUDENT_MATRIC,
          phoneNumber: '+2348012345678',
          college: 'College of Engineering',
          department: 'Computer Science',
          program: 'B.Sc. Computer Science',
          level: 100,
          role: Role.STUDENT,
        },
      });
      studentId = student.id;
      seededStudentId = studentId;

      // 2. Seed Fee + Invoice with amountDue=150,000; amountPaid=0 → outstanding=150,000
      const feeCode = rand('FEE-E1');
      const fee = await prisma.fee.create({
        data: {
          feeCode,
          name: 'E1 Test School Fees 150k',
          category: {
            connectOrCreate: {
              where: { code: 'TUITION_E1' },
              create: { code: 'TUITION_E1', name: 'Tuition (E1 test)' },
            },
          },
          amount: new Prisma.Decimal(FEE_AMOUNT_DUE),
          academicSession: '2024/2025',
          createdBy: { connect: { id: 1 } },
        },
      });

      const inv = await prisma.invoice.create({
        data: {
          invoiceNumber: rand('INV-E1'),
          studentId,
          feeId: fee.id,
          amountDue: new Prisma.Decimal(FEE_AMOUNT_DUE),
          amountPaid: new Prisma.Decimal(FEE_AMOUNT_PAID),
          status: InvoiceStatus.UNPAID,
          session: '2024/2025',
        },
      });
      seededInvoiceId = inv.id;
    });

    it('E1: search by exact matric "2024/CSC/001" → students[0] has name, matric, outstanding=150,000, 5 links', async () => {
      const result = await AdminSearchService.composite('2024/CSC/001');
      expect(Array.isArray(result.students)).toBe(true);
      expect(result.tookMs).toBeGreaterThanOrEqual(0);

      const match = result.students.find((s) => s.matricNumber === STUDENT_MATRIC);
      expect(match).toBeTruthy();
      expect(match!.firstName).toBe(FIRST_NAME);
      expect(match!.lastName).toBe(LAST_NAME);
      expect(match!.matricNumber).toBe(STUDENT_MATRIC);
      expect(match!.outstanding).toBe(FEE_AMOUNT_DUE);
      expect(match!.totalFees).toBe(FEE_AMOUNT_DUE);
      expect(match!.totalPaid).toBe(FEE_AMOUNT_PAID);

      expect(match!.links).toBeTruthy();
      const links = match!.links;
      const sid = match!.id;
      expect(links.profile).toBe(`/admin/students/${sid}`);
      expect(links.fees).toBe(`/admin/students/${sid}/fees`);
      expect(links.invoices).toBe(`/admin/students/${sid}/invoices`);
      expect(links.payments).toBe(`/admin/students/${sid}/payments`);
      expect(links.receipts).toBe(`/admin/students/${sid}/receipts`);

      // Sanity: 5 distinct routes
      const unique = new Set(Object.values(links));
      expect(unique.size).toBe(5);
    });

    it('E1: q length < 2 returns empty arrays, no error', async () => {
      const r1 = await AdminSearchService.composite('');
      expect(r1.students).toEqual([]);
      expect(r1.payments).toEqual([]);
      expect(r1.receipts).toEqual([]);
      expect(r1.tookMs).toBeGreaterThanOrEqual(0);

      const r2 = await AdminSearchService.composite('x');
      expect(r2.students).toEqual([]);
    });

    it('E1: search by partial name → returns John Doe', async () => {
      const result = await AdminSearchService.composite('John');
      const match = result.students.find((s) => s.matricNumber === STUDENT_MATRIC);
      expect(match).toBeTruthy();
    });
  });

  // =========================================================================
  // E4: SystemSettings singleton CRUD
  // =========================================================================
  describe('E4 — SystemSettingsService singleton', () => {
    it('get() returns seed row (id=1) with universityName default', async () => {
      const s = await SystemSettingsService.get();
      expect(s).toBeTruthy();
      expect(s.id).toBe(1);
      expect(typeof s.universityName).toBe('string');
      expect(Number(s.largePaymentThreshold ?? 0)).toBeGreaterThan(0);
    });

    it('update(patch) persists fields + returns updated', async () => {
      const before = await SystemSettingsService.get();
      const newName = `E4 Test University ${Date.now()}`;
      const newThreshold = 750000;
      const updated = await SystemSettingsService.update(
        {
          universityName: newName,
          largePaymentThreshold: new Prisma.Decimal(newThreshold),
          importErrorThreshold: 15,
        },
        { updatedById: 1 },
      );
      expect(updated.universityName).toBe(newName);
      expect(Number(updated.largePaymentThreshold)).toBe(newThreshold);
      expect(updated.importErrorThreshold).toBe(15);

      // get() returns the same
      const after = await SystemSettingsService.get();
      expect(after.universityName).toBe(newName);
      expect(Number(after.largePaymentThreshold)).toBe(newThreshold);

      // Restore original name
      await SystemSettingsService.update(
        { universityName: before.universityName },
        { updatedById: 1 },
      ).catch(() => {});
    });
  });

  // =========================================================================
  // B5: AdminNotification emitImportErrors → row created
  // =========================================================================
  describe('B5 — AdminNotificationService.emitImportErrors (IMPORT_ERRORS_10)', () => {
    it('emitImportErrors(importId=1, errorCount=12, threshold=10) → creates row type=IMPORT_ERRORS_10', async () => {
      const importId = 1 + Math.floor(Math.random() * 100000);
      const beforeCount = await prisma.adminNotification.count({
        where: { type: 'IMPORT_ERRORS_10' },
      });
      const row = await AdminNotificationService.emitImportErrors(importId, 12, 10);
      expect(row).not.toBeNull();
      expect(row!.type).toBe('IMPORT_ERRORS_10');
      expect(typeof row!.title).toBe('string');
      expect(row!.severity).toBeDefined();
      const afterCount = await prisma.adminNotification.count({
        where: { type: 'IMPORT_ERRORS_10' },
      });
      expect(afterCount).toBeGreaterThan(beforeCount);
    });

    it('emitImportErrors errorCount=5 < threshold=10 → returns null, no row', async () => {
      const beforeCount = await prisma.adminNotification.count();
      const row = await AdminNotificationService.emitImportErrors(42, 5, 10);
      expect(row).toBeNull();
      const afterCount = await prisma.adminNotification.count();
      expect(afterCount).toBe(beforeCount);
    });
  });

  // =========================================================================
  // B4.1 Post-Commit Hook: verifyPayment SUCCESS → dispatchEmail(PaymentSuccessful)
  //   Lightweight spy only; no actual SMTP / Paystack outbound.
  // =========================================================================
  describe('B4.1 — PaymentService.verifyPayment post-commit enqueues PaymentSuccessful email', () => {
    let verifySpy: jest.SpyInstance<any> | null = null;
    let txRef: string;
    let paystackRef: string;
    let studentId: number;

    beforeAll(async () => {
      // 1. Seed a student
      const email = rand('b41-student') + '@university.edu.ng';
      const student = await prisma.user.create({
        data: {
          email,
          password: '$2b$10$scaffoldHashPlaceholderForTestingXXXXXXXXXXXXX',
          firstName: 'B41First',
          lastName: 'B41Last',
          matricNumber: rand('MAT-B41'),
          phoneNumber: '+2348099990001',
          role: Role.STUDENT,
        },
      });
      studentId = student.id;
      seededStudentId = seededStudentId ?? studentId;

      // 2. Seed a fee + invoice (fully unpaid, amount 50k)
      const feeCode = rand('FEE-B41');
      const fee = await prisma.fee.create({
        data: {
          feeCode,
          name: 'B4.1 Test Fee',
          category: {
            connectOrCreate: {
              where: { code: 'TUITION_B41' },
              create: { code: 'TUITION_B41', name: 'Tuition (B4.1 test)' },
            },
          },
          amount: new Prisma.Decimal(50000),
          academicSession: '2024/2025',
          createdBy: { connect: { id: 1 } },
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          invoiceNumber: rand('INV-B41'),
          studentId,
          feeId: fee.id,
          amountDue: new Prisma.Decimal(50000),
          amountPaid: new Prisma.Decimal(0),
          status: InvoiceStatus.UNPAID,
          session: '2024/2025',
        },
      });
      seededInvoiceId = seededInvoiceId ?? inv.id;

      // 3. Compute breakdown for a 50k fee so verify tolerance matches exactly.
      //    Import computePaymentBreakdown to compute expected amount.
      const { computePaymentBreakdown } = PaystackServiceModule as any;
      const breakdown = computePaymentBreakdown(50000);
      const expectedNaira = breakdown.totalAmount;
      const expectedKobo = Math.round(expectedNaira * 100);

      // 4. Create a PENDING transaction row for verifyPayment to find
      txRef = generatePaymentReference();
      paystackRef = txRef;
      const tx = await prisma.transaction.create({
        data: {
          reference: txRef,
          userId: studentId,
          invoiceId: inv.id,
          type: TransactionType.FEE_PAYMENT,
          status: TransactionStatus.PENDING,
          expectedAmount: new Prisma.Decimal(expectedNaira),
          amount: new Prisma.Decimal(0),
          description: 'B4.1 PaymentSuccessful hook test',
          metadata: {
            invoiceNumber: inv.invoiceNumber,
            fee: { id: fee.id, name: fee.name, feeCode: fee.feeCode, categoryId: fee.categoryId },
            student: { id: studentId, name: 'B41First B41Last', matricNumber: student.matricNumber },
            session: '2024/2025',
            amount: {
              base: breakdown.baseAmount,
              serviceCharge: breakdown.serviceCharge,
              gatewayFee: breakdown.gatewayFee,
              total: breakdown.totalAmount,
              serviceChargeMode: breakdown.serviceChargeMode,
              gatewayFeeMode: breakdown.gatewayFeeMode,
            },
          } as Prisma.InputJsonValue,
        },
      });
      seededTransactionId = tx.id;

      // 5. Spy Paystack verifyTransaction → returns success amount (kobo) matching expected
      verifySpy = jest
        .spyOn(PaystackServiceModule.PaystackService as any, 'verifyTransaction')
        .mockResolvedValue({
          success: true,
          status: 'success',
          reference: paystackRef,
          amount: expectedKobo,
          channel: 'card',
          currency: 'NGN',
          paidAt: new Date().toISOString(),
          transaction_date: new Date().toISOString(),
          ip_address: '127.0.0.1',
          authorization: { card_type: 'visa', bank: 'Mock Bank' },
          metadata: {
            student_id: studentId,
            invoice_id: inv.invoiceNumber,
            fee_id: fee.id,
            academic_session: '2024/2025',
            fee_name: fee.name,
            transaction_id: tx.id,
          },
          raw: { status: 'success', data: { reference: paystackRef } },
        });
    });

    afterAll(() => {
      verifySpy?.mockRestore();
      clearCapturesForTests();
    });

    it('B4.1: verifyPayment(paystackRef) SUCCESS → dispatchEmail called 1× with emailType=PaymentSuccessful', async () => {
      clearCapturesForTests();
      // Set up spy BEFORE the call so the spy intercepts calls that happen
      // synchronously in the same tick (TEST MODE pushes to array synchronously).
      const dispatchSpy = jest.spyOn(
        require('../queues/emailQueue'),
        'dispatchEmail',
      );
      try {
        const result: any = await PaymentService.verifyPayment(paystackRef, {});
        expect(result).toBeTruthy();
        // Sanity: verifyPayment SUCCESS path actually taken
        expect(result.verified).toBe(true);
        expect(result.status).toBe(TransactionStatus.SUCCESS);
        expect(result.receipt).toBeTruthy();

        // dispatchEmail test-mode pushes to queueCaptures synchronously (no await),
        // so no event-loop delay is actually needed; still a small safeguard.
        await new Promise((r) => setTimeout(r, 20));

        // Count from spy + the module-level array we imported at the top
        const spyCallCount = dispatchSpy.mock.calls.length;
        const captureCount = queueCaptures.filter(
          (c: any) => c.emailType === 'PaymentSuccessful',
        ).length;

        expect(spyCallCount + captureCount).toBeGreaterThanOrEqual(1);

        // Validate payload fields from the first available source
        const capture: any = queueCaptures.find(
          (c: any) => c.emailType === 'PaymentSuccessful',
        );
        if (capture) {
          expect(capture.emailType).toBe('PaymentSuccessful');
          expect(typeof capture.to).toBe('string');
          expect(capture.reference).toBe(txRef);
          expect(String(capture.recipientId)).toBe(String(studentId));
          expect(capture.payload).toBeTruthy();
          expect(capture.payload.studentName).toBeTruthy();
          expect(capture.payload.feeName).toBeTruthy();
          expect(typeof capture.payload.amountNgn).toBe('number');
          expect(capture.payload.reference).toBe(txRef);
        }
        if (spyCallCount > 0 && !capture) {
          const firstCall: any = dispatchSpy.mock.calls[0][0];
          expect(firstCall.emailType).toBe('PaymentSuccessful');
          expect(firstCall.reference).toBe(txRef);
        }
      } finally {
        dispatchSpy.mockRestore();
      }
    });
  });
});
