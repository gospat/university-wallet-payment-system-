/**
 * Rate-limit-redis 4.3.1 + ioredis sendCommand contract tests.
 *
 * Two parts:
 *   A) Pure unit tests of the exported helper `normalizeLuaArrayResult` in
 *      `../utils/rateLimitRedis.ts`. This is the exact function we feed
 *      EVALSHA/EVAL results into before rate-limit-redis parseScriptResponse
 *      runs. No real DB, no real Redis.
 *
 *   B) Regression: build a minimal express app with (a) a RedisStore rate
 *      limiter using our mocked ioredis call() returning contract-compliant
 *      shapes, (b) mounted ALATPay webhook handler returning 403 Invalid
 *      HMAC. Verify: POST unsigned /api/v1/webhooks/alatpay returns 403,
 *      NOT HTTP 500 from parseScriptResponse TypeError.
 *
 * No real DB, no real Redis, no real payments, no outbound network.
 */

import { normalizeLuaArrayResult } from '../utils/rateLimitRedis';

// -----------------------------------------------------------------------------
// Part A. pure normalizeLuaArrayResult unit tests.
// -----------------------------------------------------------------------------
describe('normalizeLuaArrayResult — ioredis sendCommand shape coercer for rate-limit-redis 4.3.1', () => {
  it('passes exact happy path: JS numeric array [7, 42000] → [7, 42000]', () => {
    expect(normalizeLuaArrayResult([7, 42000], 60_000)).toEqual([7, 42000]);
  });

  it('coerces RESP3 string array ["1","15000"] → integers [1, 15000]', () => {
    expect(normalizeLuaArrayResult(['1', '15000'], 60_000)).toEqual([1, 15000]);
  });

  it('coerces array of Node Buffers [Buffer("42"), Buffer("300000")] → integers', () => {
    expect(normalizeLuaArrayResult([Buffer.from('42'), Buffer.from('300000')], 60_000)).toEqual([42, 300000]);
  });

  it('coerces mixed Buffer + string → integer tuple', () => {
    expect(normalizeLuaArrayResult([Buffer.from('3'), '90000'], 60_000)).toEqual([3, 90000]);
  });

  it('single Buffer containing RESP2 *2 multi-bulk text splits to tuple', () => {
    const resp2 = `*2\r\n:5\r\n:60000\r\n`;
    expect(normalizeLuaArrayResult(Buffer.from(resp2), 60_000)).toEqual([5, 60000]);
  });

  it('single Buffer containing "12,45000" comma-joined → [12, 45000]', () => {
    expect(normalizeLuaArrayResult(Buffer.from('12,45000'), 60_000)).toEqual([12, 45000]);
  });

  it('single comma-separated string "15,120000" → [15, 120000]', () => {
    expect(normalizeLuaArrayResult('15,120000', 60_000)).toEqual([15, 120000]);
  });

  it('truncates floats: [7.9, 59999.9] → [7, 59999]', () => {
    expect(normalizeLuaArrayResult([7.9, 59999.9], 60_000)).toEqual([7, 59999]);
  });

  it('bigint values coerced to ints: [BigInt(9), "1200"] → [9, 1200]', () => {
    expect(normalizeLuaArrayResult([BigInt(9) as any, '1200'], 60_000)).toEqual([9, 1200]);
  });

  it('array length 1 only → synthetic [1, fallback] safe tuple, never throws TypeError', () => {
    expect(normalizeLuaArrayResult([123], 120_000)).toEqual([1, 120_000]);
  });

  it('unrecognized shapes (null/undefined/{}/42/word-no-comma) → [1, fallback]', () => {
    const fb = 60_000;
    expect(normalizeLuaArrayResult(undefined, fb)).toEqual([1, fb]);
    expect(normalizeLuaArrayResult(null, fb)).toEqual([1, fb]);
    expect(normalizeLuaArrayResult({}, fb)).toEqual([1, fb]);
    expect(normalizeLuaArrayResult(42, fb)).toEqual([1, fb]);
    expect(normalizeLuaArrayResult('just-a-word-no-comma', fb)).toEqual([1, fb]);
  });

  it('invalid/negative fallbackWindowMs → defaulted to 60_000 internally', () => {
    const [, w] = normalizeLuaArrayResult('garbage', -1);
    expect(w).toBe(60_000);
  });

  it('does NOT return strings; typeof every element is always "number"', () => {
    const [a, b] = normalizeLuaArrayResult(['1', '2'], 99);
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
    const [c, d] = normalizeLuaArrayResult(undefined, 5000);
    expect(typeof c).toBe('number');
    expect(typeof d).toBe('number');
  });
});

// -----------------------------------------------------------------------------
// Part B. sendCommand contract + mounted webhook regression test.
// -----------------------------------------------------------------------------
// Mounting the real app.ts is heavy because it pulls in all route modules
// which expect their own mocked controllers. We declare those deep mocks
// INSIDE the test using jest.resetModules() + scoped jest.mock() so they
// do not leak and contaminate other test suites running in the same process.

// Pure helper — no jest.mock side effects. Used by the Part B test to build
// a contract-compliant in-memory Redis stand-in. It returns:
//   SCRIPT LOAD   → 40-hex SHA1 string
//   EVALSHA incr  → [totalHits: number, ttlMs: number]   (2-int tuple)
//   EVALSHA get   → [totalHits | null, ttlMs: number]
//   DECR / DEL    → 1
type CallFn = (...args: string[]) => Promise<any>;
function makeCompliantReadyRedis() {
  const KV: Record<string, { count: number; pttlMs: number }> = {};
  const SHA_INC = 'a'.repeat(40);
  const SHA_GET = 'b'.repeat(40);
  const call: CallFn = async (...args: string[]) => {
    const cmd0 = String(args[0] ?? '').toUpperCase();
    if (cmd0 === 'SCRIPT') {
      const sub = String(args[1] ?? '').toUpperCase();
      if (sub === 'LOAD') {
        const src = String(args[2] ?? '');
        if (/INCR/.test(src)) return SHA_INC;
        if (/GET\s*\(/.test(src) || /GET\b/.test(src)) return SHA_GET;
        return 'c'.repeat(40);
      }
    }
    if (cmd0 === 'EVALSHA') {
      const sha = String(args[1] ?? '');
      const nKeys = Number(args[2] ?? 0);
      const key = String(args[3] ?? '');
      if (!nKeys) return [0, 60000] as [number, number];
      const resetOnChange = String(args[4] ?? '0') === '1';
      const windowMs = Number(args[5] ?? 60_000);
      const now = Date.now();
      if (sha === SHA_INC) {
        const existing = KV[key];
        let ttl = existing ? Math.max(0, existing.pttlMs - now) : 0;
        if (!existing || ttl <= 0) {
          KV[key] = { count: 1, pttlMs: now + windowMs };
          return [1, windowMs] as [number, number];
        }
        const totalHits = existing.count + 1;
        if (resetOnChange) { existing.pttlMs = now + windowMs; ttl = windowMs; }
        else { ttl = Math.max(1, existing.pttlMs - now); }
        existing.count = totalHits;
        return [totalHits, ttl] as [number, number];
      }
      if (sha === SHA_GET) {
        const existing = KV[key];
        if (!existing) return [null, -2] as [null, number];
        return [existing.count, Math.max(-1, existing.pttlMs - now)] as [number, number];
      }
    }
    if (cmd0 === 'DECR') { const key = String(args[1] ?? ''); if (KV[key]) KV[key].count = Math.max(0, KV[key].count - 1); return 1; }
    if (cmd0 === 'DEL') { const key = String(args[1] ?? ''); delete KV[key]; return 1; }
    return undefined;
  };
  return {
    status: 'ready' as const,
    call,
    on: jest.fn(),
    once: jest.fn(),
    disconnect: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
  };
}

describe('webhook rate limiter + rate-limit-redis ioredis adapter regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete (globalThis as any).__rlStoreWrapWarnedOnce;
    delete (globalThis as any).__rlWarnedOnce;
  });

  it('POST unsigned /api/v1/webhooks/alatpay → handler returns 403 Invalid HMAC; NOT 500 from store', async () => {
    jest.resetModules();
    const we: any = {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    };
    jest.mock('../config/database', () => ({
      __esModule: true,
      default: {
        webhookEvent: we, user: { findUnique: jest.fn() },
        $transaction: jest.fn().mockImplementation((fn: any) => Promise.resolve(fn({
          webhookEvent: we, user: { findUnique: jest.fn() },
        }))),
      },
      webhookEvent: we, student: { findUnique: jest.fn() },
      invoice: { findUnique: jest.fn() }, fee: { findMany: jest.fn().mockResolvedValue([]) },
      receipt: { findUnique: jest.fn() },
      paymentTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    }));
    jest.mock('../config/queue', () => ({
      __esModule: true,
      getQueueHealth: jest.fn(() => Promise.resolve({ queues: [], overall: 'ok' as any })),
      registerHandler: jest.fn(),
      dispatchJob: jest.fn().mockResolvedValue({ id: 'j1' }),
    }));
    jest.mock('../controllers/receipt', () => ({
      publicVerifyReceipt: jest.fn((_req: any, res: any) => res.status(200).json({ ok: true })),
      listMyReceipts: jest.fn((_req: any, res: any) => res.status(200).json([])),
      downloadFormalReceipt: jest.fn((_req: any, res: any) => res.status(200).send('pdf')),
      downloadStatement: jest.fn((_req: any, res: any) => res.status(200).send('pdf')),
    }));
    const noop = (_req: any, res: any) => res.status(200).json({ ok: true });
    jest.mock('../controllers/student', () => ({
      getStudentDashboard: noop, getStudentInvoices: noop, getInvoiceById: noop,
      getPaymentHistory: noop, getFeeCatalogue: noop, getAssignedFees: noop, getStudentProfile: noop,
      updateStudentProfile: noop, changePassword: noop, getStudentReceiptById: noop,
      listMyReceipts: noop, downloadReceipt: noop, generateInvoiceFromFee: noop,
      getStudentPayableBreakdown: noop, getActiveGatewayForStudent: noop,
      getMe: jest.fn((_req: any, res: any) => res.status(200).json({ id: 1 })),
      updateMe: noop,
      listStudents: noop, createStudent: noop, getStudent: noop, getStudentByMatric: noop,
      setStudentStatus: noop, resetStudentPassword: noop, updateStudent: noop,
    }));
    jest.mock('../controllers/admin', () => ({
      listStudents: noop, createStudent: noop, updateStudent: noop,
      listFees: noop, createFee: noop, listInvoices: noop,
      getInvoiceById: noop, listPayments: noop, verifyPayment: noop,
      refundPayment: noop, processReceipt: noop,
      exportPaymentsCsv: noop, exportReceiptsCsv: noop,
      importBulkStudents: noop, generateFeeAssignedInvoices: noop,
      getRefunds: noop, approveRefund: noop, rejectRefund: noop,
      getDashboardStats: jest.fn((_req: any, res: any) => res.status(200).json({ totalStudents: 0 })),
      addStudent: noop,
      stageStudentUpload: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
      processStudentUpload: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
      getAllSettings: jest.fn((_req: any, res: any) => res.status(200).json({})),
      updateSettings: noop,
      getGatewayConfig: jest.fn((_req: any, res: any) => res.status(200).json({ active: 'PAYSTACK' })),
      setGateway: noop, processRefund: noop,
    }));
    jest.mock('../controllers/refunds', () => ({
      bursaryListRefunds: noop, bursaryRequestRefund: noop,
      adminListRefunds: noop, adminApproveRefund: noop, adminRejectRefund: noop,
    }));
    jest.mock('../controllers/payments', () => {
      const pass = [(_req: any, _res: any, next: any) => next()];
      return {
        initiatePayment: noop,
        initiatePaymentValidator: pass,
        verifyPayment: noop,
        verifyPaymentValidator: pass,
        billStudentDirect: noop,
        billStudentDirectValidator: pass,
        generateFeeAssignedInvoices: noop,
        confirmPayload: jest.fn((_req: any, res: any) => res.status(200).json({ reference: 'ref' })),
        confirmPayloadValidator: pass,
        getDirectBillInvoice: jest.fn((_req: any, res: any) => res.status(200).json({})),
        getDirectBillInvoiceValidator: pass,
      };
    });
    jest.mock('../controllers/fees', () => {
      const noopF: any = (_req: any, res: any) => res.status(200).json({ ok: true });
      return {
        listFeesCatalogue: jest.fn((_req: any, res: any) => res.status(200).json([])),
        listFees: noopF, createFee: noopF, updateFee: noopF, deleteFee: noopF, getFee: noopF,
        activateFee: noopF, disableFee: noopF, cloneFee: noopF,
        listFeeCategories: noopF, getFeeCategory: noopF, createFeeCategory: noopF,
        updateFeeCategory: noopF, deleteFeeCategory: noopF,
      };
    });
    jest.mock('../controllers/feeAssignments', () => ({
      listMyFeeAssignments: noop, billStudent: noop, generateInvoices: noop,
      listFeeAssignments: noop, getFeeAssignment: noop, createFeeAssignment: noop,
      updateFeeAssignment: noop, deleteFeeAssignment: noop, manualStudentInvoice: noop,
      createDirectStudentBill: noop,
    }));
    jest.mock('../controllers/auth', () => {
      const noopA: any = (_req: any, res: any) => res.status(200).json({ ok: true });
      const nextA: any = [(_req: any, _res: any, next: any) => next()];
      return {
        signup: noopA, login: noopA, refresh: nextA, logout: nextA, logoutAll: noopA,
        me: jest.fn((_req: any, res: any) => res.status(200).json({ id: 1 })),
        changePassword: nextA, forgotPassword: noopA, resetPassword: nextA,
      };
    });
    jest.mock('../controllers/bulkUpload', () => {
      const noopB: any = (_req: any, res: any) => res.status(200).json({ ok: true });
      return {
        bulkUploadStudents: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
        confirmFeeUpload: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
        previewStudentUpload: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
        previewFeeUpload: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
        stageFeeUpload: noopB,
        stageStudentUpload: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
        downloadErrorCsv: jest.fn((_req: any, res: any) => res.status(200).send('csv')),
        confirmStudentUpload: noopB,
      };
    });
    jest.mock('../controllers/feeBulkUpload', () => ({
      bulkUploadFees: jest.fn((_req: any, res: any) => res.status(200).json({})),
      stageFeeUpload: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
      previewFeeUpload: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
      confirmFeeUpload: jest.fn((_req: any, res: any) => res.status(200).json({ rows: 0 })),
      downloadErrorCsv: jest.fn((_req: any, res: any) => res.status(200).send('csv')),
      stageFeeBulkUpload: noop,
      previewFeeBulkUpload: noop,
      confirmFeeBulkUpload: noop,
      downloadFeeErrorCsv: jest.fn((_req: any, res: any) => res.status(200).send('csv')),
    }));
    jest.mock('../middlewares/auth', () => ({
      protect: jest.fn((_req: any, _res: any, next: any) => next()),
      restrictTo: jest.fn(() => (_req: any, _res: any, next: any) => next()),
      requirePermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
      superAdminOnly: jest.fn((_req: any, _res: any, next: any) => next()),
      bursarOrAdminOnly: jest.fn((_req: any, _res: any, next: any) => next()),
      verifyRecaptchaOrBypass: jest.fn((_req: any, _res: any, next: any) => next()),
    }));
    jest.mock('../middlewares/validate', () => ({
      validateBody: jest.fn(() => (_req: any, _res: any, next: any) => next()),
      validateParams: jest.fn(() => (_req: any, _res: any, next: any) => next()),
      validateQuery: jest.fn(() => (_req: any, _res: any, next: any) => next()),
    }));
    jest.mock('../utils/branding', () => ({
      buildBranding: jest.fn(() => ({ schoolName: 'Bells', logoUrl: null, primaryColor: '#2563eb' })),
      brandingEnvOnly: jest.fn(() => ({ schoolName: 'Bells', logoUrl: null, primaryColor: '#2563eb' })),
    }));
    jest.mock('../config/redis', () => {
      let current = makeCompliantReadyRedis();
      return {
        __esModule: true,
        getRedis: jest.fn(() => current),
      };
    });
    const request = require('supertest');
    const appMod = require('../app');
    const serverApp = appMod.default;
    const resp = await request(serverApp)
      .post('/api/v1/webhooks/alatpay')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', '10.0.0.1')
      .send({ Value: { Data: { Id: 'evt-123', Status: 'completed' } } });
    expect(resp.status).not.toBe(500);
    expect(resp.status).toBe(403);
    expect(resp.body?.message).toBe('Invalid HMAC');
  }, 15000);
});
