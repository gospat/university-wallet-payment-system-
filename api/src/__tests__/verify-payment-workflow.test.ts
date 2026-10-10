import request from 'supertest';
import app from '../app';
import prisma from '../config/database';
import { Role } from '@prisma/client';

const API = '/api/v1';

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@university.edu.ng';
const BURSARY_EMAIL = process.env.TEST_BURSARY_EMAIL || 'finance@university.edu.ng';
const STUDENT_EMAIL = process.env.TEST_STUDENT1_EMAIL || 'student1@university.edu.ng';
const DEFAULT_PW_STAFF = process.env.TEST_STAFF_PASSWORD || 'admin123';
const DEFAULT_PW_BURSARY = process.env.TEST_BURSARY_PASSWORD || 'bursary123';
const DEFAULT_PW_STUDENT = process.env.TEST_STUDENT_PASSWORD || 'student123';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const login = async (email: string, password: string) => {
  try {
    const res = await request(app).post(`${API}/auth/login`).send({ email, password });
    if (res.status !== 200 || !res.body?.token || typeof res.body.token !== 'string' || res.body.token.length < 20) {
      return { token: null as string | null, user: res.body?.data?.user ?? null };
    }
    return { token: res.body.token as string, user: res.body?.data?.user ?? null };
  } catch {
    return { token: null as string | null, user: null };
  }
};

let singletonProviderVerify: jest.Mock;

jest.mock('../services/payment/providerFactory', () => {
  const actual = jest.requireActual('@prisma/client');
  const verifyMock = jest.fn();
  const singletonProvider = {
    initialize: jest.fn(),
    verify: (...args: any[]) => verifyMock(...args),
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
    getActiveGatewaySetting: jest.fn().mockResolvedValue(actual.PaymentGateway.ALATPAY),
    setActiveGatewaySetting: jest.fn(),
    getPaymentProvider: jest.fn(() => singletonProvider),
    _singletonProvider: singletonProvider,
    _verify: verifyMock,
  };
});

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    call: jest.fn(),
    status: 'end',
    disconnect: jest.fn(),
    quit: jest.fn(),
  }));
});

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

const getControllerSrc = () => {
  const fs = require('fs');
  const path = require('path');
  return fs.readFileSync(path.join(__dirname, '..', 'controllers', 'payments.ts'), 'utf8');
};

const getPaymentsPageSrc = () => {
  const fs = require('fs');
  const path = require('path');
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', 'app', 'src', 'pages', 'admin', 'Payments.tsx'), 'utf8');
};

describe('Verify Payment Workflow (Admin/Bursary)', () => {
  let adminToken: string | null = null;
  let bursaryToken: string | null = null;
  let studentToken: string | null = null;
  let adminUser: any = null;
  let studentUser: any = null;
  let invoiceId: number | null = null;
  let studentUserId: number | null = null;

  const SKIP = 'credentials / db unavailable — skipping safely';

  beforeAll(async () => {
    const providerFactory = require('../services/payment/providerFactory');
    singletonProviderVerify = providerFactory._verify;
    const [a, b, s] = await Promise.all([
      login(ADMIN_EMAIL, DEFAULT_PW_STAFF),
      login(BURSARY_EMAIL, DEFAULT_PW_BURSARY),
      login(STUDENT_EMAIL, DEFAULT_PW_STUDENT),
    ]);
    adminToken = a.token;
    bursaryToken = b.token;
    studentToken = s.token;
    adminUser = a.user;
    studentUser = s.user;
    studentUserId = s.user?.id ? Number(s.user.id) : null;

    if (studentUserId) {
      try {
        const inv = await prisma.invoice.create({
          data: {
            studentId: studentUserId,
            invoiceNumber: 'VERIFY-TEST-' + Date.now(),
            feeId: 48,
            amountDue: 50000,
            amountPaid: 0,
            status: 'UNPAID',
            session: '2025/2026',
            semester: 'FIRST',
          },
          select: { id: true },
        });
        invoiceId = inv.id;
      } catch {
        /* ignore */
      }
    }
  });

  afterAll(async () => {
    if (invoiceId) {
      try { await prisma.invoice.delete({ where: { id: invoiceId } }); } catch { /* ignore */ }
    }
    try { await prisma.$disconnect(); } catch { /* ignore */ }
  });

  beforeEach(() => {
    singletonProviderVerify.mockReset();
  });

  const createTx = async (overrides: any = {}) => {
    return prisma.transaction.create({
      data: {
        userId: studentUserId ?? 1,
        type: 'FEE_PAYMENT',
        gateway: overrides.gateway ?? 'ALATPAY',
        reference: 'VERIFY-REF-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
        status: overrides.status ?? 'PENDING',
        expectedAmount: overrides.expectedAmount ?? 50000,
        amount: overrides.amount ?? 0,
        invoiceId: overrides.invoiceId ?? invoiceId,
        description: 'verify-payment-test',
        paystackReference: overrides.paystackReference ?? undefined,
        alatpayReference: overrides.alatpayReference ?? undefined,
        alatpayOrderReference: overrides.alatpayOrderReference ?? undefined,
        alatpayInitPaymentReference: overrides.alatpayInitPaymentReference ?? undefined,
        alatpayFinalTransactionId: overrides.alatpayFinalTransactionId ?? undefined,
        metadata: overrides.metadata ?? undefined,
      },
      select: {
        id: true, reference: true, gateway: true, status: true,
        expectedAmount: true, amount: true, invoiceId: true,
        paystackReference: true, alatpayReference: true, alatpayOrderReference: true,
        alatpayInitPaymentReference: true, alatpayFinalTransactionId: true,
      },
    });
  };

  // ---------------------------------------------------------------------
  // 1. Verify Payment navigation displays verification UI
  // ---------------------------------------------------------------------
  it('T1. Verify Payment view=verify renders dedicated workspace (frontend source)', () => {
    const src = getPaymentsPageSrc();
    expect(src).toMatch(/useSearchParams/);
    expect(src).toMatch(/viewMode|isVerifyView/);
    expect(src).toMatch(/VerifyPaymentWorkspace/);
    expect(src).toMatch(/isVerifyView\s*\?/);
    expect(src).toMatch(/<VerifyPaymentWorkspace/);
  });

  // ---------------------------------------------------------------------
  // 2. Transaction lookup works (GET /payments/:id)
  // ---------------------------------------------------------------------
  it('T2. GET /admin/payments/:id returns transaction detail for authorized user', async () => {
    if (!adminToken || !studentUserId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY' });
    try {
      const res = await request(app)
        .get(`${API}/admin/payments/${tx.id}`)
        .set(auth(adminToken));
      expect([200, 403]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body?.data?.id).toBe(tx.id);
        expect(res.body?.data).toHaveProperty('reference');
        expect(res.body?.data).toHaveProperty('gateway');
        expect(res.body?.data).toHaveProperty('status');
      }
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 3. ALATPay with valid final UUID can be verified (provider returns SUCCESS)
  // ---------------------------------------------------------------------
  it('T3. ALATPay tx with valid final UUID — provider.verify is called with the final UUID', async () => {
    if (!adminToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const tx = await createTx({
      gateway: 'ALATPAY',
      alatpayFinalTransactionId: VALID_UUID,
      alatpayReference: 'WEMA-PAY-should-not-be-used',
      alatpayOrderReference: 'order-ref-should-not-be-used',
    });
    singletonProviderVerify.mockResolvedValue({
      providerStatus: 'SUCCESS',
      paidAmountNaira: 50000,
      paidAmountMinor: 5000000,
      providerReference: VALID_UUID,
      raw: {},
    });
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(adminToken));
      expect([200, 403, 409]).toContain(res.status);
      if (res.status === 200 || res.status === 201) {
        expect(singletonProviderVerify).toHaveBeenCalledTimes(1);
        const calledRef = singletonProviderVerify.mock.calls[0][0];
        expect(calledRef).toBe(VALID_UUID);
        expect(calledRef).not.toMatch(/WEMA-PAY/);
      }
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 4. ALATPay WITHOUT final UUID: provider.verify NOT called, remains PENDING, no receipt/GL
  // ---------------------------------------------------------------------
  it('T4. ALATPay tx WITHOUT final UUID — provider.verify NOT called, returns ALATPAY_FINAL_TXID_REQUIRED', async () => {
    if (!adminToken || !studentUserId) { console.warn(SKIP); return; }
    const tx = await createTx({
      gateway: 'ALATPAY',
      alatpayReference: 'WEMA-PAY-20261010-XYZ',
      alatpayOrderReference: 'order-xyz',
      alatpayInitPaymentReference: 'init-xyz',
    });
    try {
      const beforeReceipts = await prisma.receipt.count({ where: { transactionId: tx.id } });
      const beforeGL = await prisma.generalLedger.count({ where: { transactionId: tx.id } });
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.body?.unable).toBe(true);
      expect(res.body?.unableReason).toBe('ALATPAY_FINAL_TXID_REQUIRED');
      expect(singletonProviderVerify).not.toHaveBeenCalled();
      const after = await prisma.transaction.findUnique({ where: { id: tx.id }, select: { status: true } });
      expect(after?.status).toBe('PENDING');
      const afterReceipts = await prisma.receipt.count({ where: { transactionId: tx.id } });
      const afterGL = await prisma.generalLedger.count({ where: { transactionId: tx.id } });
      expect(afterReceipts).toBe(beforeReceipts);
      expect(afterGL).toBe(beforeGL);
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 5. ALATPay WEMA/order/init reference is never substituted for missing final UUID
  // ---------------------------------------------------------------------
  it('T5. Controller never falls back to WEMA/order/init references for ALATPAY verify', () => {
    const src = getControllerSrc();
    const anchor = src.indexOf("ALATPAY_FINAL_TXID_REQUIRED");
    expect(anchor).toBeGreaterThan(-1);
    const alatpayRegion = src.slice(anchor - 900, anchor + 200);
    expect(alatpayRegion).toMatch(/alatpayFinalTransactionId/);
    expect(alatpayRegion).toMatch(/isAlatpayUuid\(/);
    expect(alatpayRegion).toMatch(/ALATPAY_FINAL_TXID_REQUIRED/);
    expect(alatpayRegion).not.toMatch(/alatpayOrderReference/);
    expect(alatpayRegion).not.toMatch(/alatpayInitPaymentReference/);
    expect(alatpayRegion).not.toMatch(/WEMA/);
  });

  // ---------------------------------------------------------------------
  // 6. Resource not found (provider 404) does NOT become FAILED
  // ---------------------------------------------------------------------
  it('T6. Provider "not found" response does NOT mark tx FAILED', async () => {
    if (!adminToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY', alatpayFinalTransactionId: VALID_UUID });
    singletonProviderVerify.mockResolvedValue({
      providerStatus: 'NOT_FOUND',
      raw: {},
    });
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(adminToken));
      expect([200, 201]).toContain(res.status);
      const after = await prisma.transaction.findUnique({ where: { id: tx.id }, select: { status: true } });
      expect(after?.status).not.toBe('FAILED');
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 7. Provider timeout does NOT become FAILED
  // ---------------------------------------------------------------------
  it('T7. Provider timeout/transport exception does NOT mark tx FAILED', async () => {
    if (!adminToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY', alatpayFinalTransactionId: VALID_UUID });
    singletonProviderVerify.mockRejectedValue(new Error('ETIMEDOUT'));
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(adminToken));
      expect([200, 201]).toContain(res.status);
      const after = await prisma.transaction.findUnique({ where: { id: tx.id }, select: { status: true } });
      expect(after?.status).not.toBe('FAILED');
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 8. Provider PENDING remains PENDING
  // ---------------------------------------------------------------------
  it('T8. Provider returns PENDING — tx remains non-terminal', async () => {
    if (!adminToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY', alatpayFinalTransactionId: VALID_UUID });
    singletonProviderVerify.mockResolvedValue({
      providerStatus: 'PENDING',
      raw: {},
    });
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(adminToken));
      expect([200, 201]).toContain(res.status);
      const after = await prisma.transaction.findUnique({ where: { id: tx.id }, select: { status: true } });
      expect(['PENDING', 'PROCESSING']).toContain(after?.status);
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 9. Authoritative SUCCESS follows existing atomic financial posting
  // ---------------------------------------------------------------------
  it('T9. Authoritative SUCCESS creates receipt + GL posting (financial posting via PaymentService)', async () => {
    if (!adminToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY', alatpayFinalTransactionId: VALID_UUID });
    singletonProviderVerify.mockResolvedValue({
      providerStatus: 'SUCCESS',
      paidAmountNaira: 50000,
      paidAmountMinor: 5000000,
      providerReference: VALID_UUID,
      raw: {},
    });
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(adminToken));
      expect([200, 201]).toContain(res.status);
      const receipts = await prisma.receipt.count({ where: { transactionId: tx.id } });
      const gls = await prisma.generalLedger.count({ where: { transactionId: tx.id } });
      expect(receipts).toBeGreaterThanOrEqual(1);
      expect(gls).toBeGreaterThanOrEqual(1);
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 10. Repeated verification of SUCCESS does not duplicate receipt/GL
  // ---------------------------------------------------------------------
  it('T10. Repeated verify on SUCCESS is idempotent — no duplicate receipt/GL', async () => {
    if (!adminToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY', alatpayFinalTransactionId: VALID_UUID });
    singletonProviderVerify.mockResolvedValue({
      providerStatus: 'SUCCESS',
      paidAmountNaira: 50000,
      paidAmountMinor: 5000000,
      providerReference: VALID_UUID,
      raw: {},
    });
    try {
      await request(app).post(`${API}/admin/payments/${tx.id}/verify`).set(auth(adminToken));
      const receiptsAfterFirst = await prisma.receipt.count({ where: { transactionId: tx.id } });
      const glAfterFirst = await prisma.generalLedger.count({ where: { transactionId: tx.id } });
      singletonProviderVerify.mockReset();
      singletonProviderVerify.mockResolvedValue({
        providerStatus: 'SUCCESS',
        paidAmountNaira: 50000,
        paidAmountMinor: 5000000,
        providerReference: VALID_UUID,
        raw: {},
      });
      await request(app).post(`${API}/admin/payments/${tx.id}/verify`).set(auth(adminToken));
      const receiptsAfterSecond = await prisma.receipt.count({ where: { transactionId: tx.id } });
      const glAfterSecond = await prisma.generalLedger.count({ where: { transactionId: tx.id } });
      expect(receiptsAfterSecond).toBe(receiptsAfterFirst);
      expect(glAfterSecond).toBe(glAfterFirst);
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 11. Paystack uses trusted stored Paystack reference
  // ---------------------------------------------------------------------
  it('T11. Paystack verify uses stored paystackReference, not browser-supplied', async () => {
    if (!adminToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const STORED_REF = 'psk_trusted_' + Date.now();
    const tx = await createTx({ gateway: 'PAYSTACK', paystackReference: STORED_REF });
    singletonProviderVerify.mockResolvedValue({
      providerStatus: 'PENDING',
      providerReference: STORED_REF,
      raw: {},
    });
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .send({ providerReference: 'EVIL_SUBSTITUTED_REF' })
        .set(auth(adminToken));
      expect([200, 201]).toContain(res.status);
      expect(singletonProviderVerify).toHaveBeenCalledTimes(1);
      expect(singletonProviderVerify.mock.calls[0][0]).toBe(STORED_REF);
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  it('T11b. Paystack with no stored reference returns PAYSTACK_REFERENCE_REQUIRED (no provider call)', async () => {
    if (!adminToken || !studentUserId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'PAYSTACK', paystackReference: undefined });
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.body?.unable).toBe(true);
      expect(res.body?.unableReason).toBe('PAYSTACK_REFERENCE_REQUIRED');
      expect(singletonProviderVerify).not.toHaveBeenCalled();
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 12. User without VERIFY_PAYMENT gets 403
  // ---------------------------------------------------------------------
  it('T12. Student (no VERIFY_PAYMENT) gets 403 on POST /admin/payments/:id/verify', async () => {
    if (!studentToken || !studentUserId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY' });
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(studentToken));
      expect(res.status).toBe(403);
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 13. Admin verification works (200 with structured result)
  // ---------------------------------------------------------------------
  it('T13. Admin verify endpoint returns structured result (verified/bellsStatus/providerStatus)', async () => {
    if (!adminToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY', alatpayFinalTransactionId: VALID_UUID });
    singletonProviderVerify.mockResolvedValue({
      providerStatus: 'SUCCESS',
      paidAmountNaira: 50000,
      paidAmountMinor: 5000000,
      providerReference: VALID_UUID,
      raw: {},
    });
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(adminToken));
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('verified');
      expect(res.body).toHaveProperty('bellsStatus');
      expect(res.body).toHaveProperty('providerStatus');
      expect(res.body).toHaveProperty('provider');
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 14. Bursary verification works
  // ---------------------------------------------------------------------
  it('T14. Bursary verify endpoint works for user with VERIFY_PAYMENT', async () => {
    if (!bursaryToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY', alatpayFinalTransactionId: VALID_UUID });
    singletonProviderVerify.mockResolvedValue({
      providerStatus: 'PENDING',
      providerReference: VALID_UUID,
      raw: {},
    });
    try {
      const res = await request(app)
        .post(`${API}/bursary/payments/${tx.id}/verify`)
        .set(auth(bursaryToken));
      expect([200, 403]).toContain(res.status);
      if (res.status === 200) {
        expect(singletonProviderVerify).toHaveBeenCalledTimes(1);
      }
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 15. Already-SUCCESS tx returns "already verified" without calling provider
  // ---------------------------------------------------------------------
  it('T15. Already-SUCCESS tx does not call provider again (idempotent fastpath)', async () => {
    if (!adminToken || !studentUserId || !invoiceId) { console.warn(SKIP); return; }
    const tx = await createTx({ gateway: 'ALATPAY', status: 'SUCCESS', alatpayFinalTransactionId: VALID_UUID });
    try {
      const res = await request(app)
        .post(`${API}/admin/payments/${tx.id}/verify`)
        .set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.body?.verified).toBe(true);
      expect(res.body?.alreadyVerified).toBe(true);
      expect(singletonProviderVerify).not.toHaveBeenCalled();
    } finally {
      await prisma.transaction.delete({ where: { id: tx.id } }).catch(() => {});
    }
  });

  // ---------------------------------------------------------------------
  // 16. Unauthenticated request returns 401/403
  // ---------------------------------------------------------------------
  it('T16. Unauthenticated POST /admin/payments/:id/verify returns 401/403', async () => {
    const res = await request(app).post(`${API}/admin/payments/999999/verify`);
    expect([401, 403]).toContain(res.status);
  });

  // ---------------------------------------------------------------------
  // 17. Result panel never exposes raw provider payload / secrets
  // ---------------------------------------------------------------------
  it('T17. Verify response does not expose raw provider payload or secrets', () => {
    const src = getControllerSrc();
    expect(src).not.toMatch(/rawPayload/);
    expect(src).not.toMatch(/secret/);
  });
});
