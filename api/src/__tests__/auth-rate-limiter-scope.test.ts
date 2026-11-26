/**
 * auth-rate-limiter-scope.test.ts
 *
 * Regression tests for the AUTH RATE-LIMITER SCOPE CORRECTION.
 *
 * DEFECT (corrected): the login brute-force limiter was mounted with the broad
 *   `app.use('/api/v1/auth', authLimiter);`
 * so its 12-requests / 15-minute counter was consumed by EVERY call under
 * `/api/v1/auth/*` — including `/auth/me`, `/auth/refresh`, `/auth/logout`,
 * `/auth/logout-all` and `/auth/change-password`. Ordinary administrative
 * self-service traffic could therefore exhaust the login budget and receive
 * `429 Too many auth attempts, please try again later.`
 *
 * CORRECTED SCOPE (app.ts):
 *   app.use('/api/v1/auth/login',           authLimiter);            // rl:auth:        12 / 15 min
 *   app.use('/api/v1/auth/change-password', authChangePwLimiter);    // rl:auth-chpw:    5 / 1 h
 *   app.use('/api/v1/auth/reset-password',  resetPasswordLimiter);   // rl:auth-reset:  20 / 1 h
 *
 * These tests boot the REAL app.ts with exhaustive deep mocks (no real DB, no
 * real Redis, no outbound network) and drive it with supertest, asserting the
 * observable HTTP behaviour required by the correction.
 *
 * Client IP under test: the app runs `trust proxy = 1`, so `req.ip` resolves to
 * the RIGHT-MOST `X-Forwarded-For` entry — exactly the value nginx OVERWRITES
 * with `$remote_addr` in production. Tests set XFF to select the authoritative
 * client IP and to prove forged (prepended) values cannot reshape the bucket.
 */

export {};

type CallFn = (...args: string[]) => Promise<any>;

interface MockRedis {
  status: 'ready' | 'connecting' | 'end';
  call: CallFn;
  on: jest.Mock;
  once: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
  set: jest.Mock;
  get: jest.Mock;
  del: jest.Mock;
  incr: jest.Mock;
  expire: jest.Mock;
}

/**
 * A Redis mock that satisfies the rate-limit-redis 4.x sendCommand contract:
 * SCRIPT LOAD -> 40-hex SHA, EVALSHA increment -> [totalHits, ttlMs].
 * (Same shape validated by rate-limit-redis-ioredis-contract.test.ts.)
 */
function makeCompliantReadyRedis(): MockRedis & { calls: string[][] } {
  const KV: Record<string, { count: number; pttlMs: number }> = {};
  const SHA_INC = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const SHA_GET = 'eeeeeedddddddddaaaaaaaaaabbbbbbbbbbcccccccccc';
  const calls: string[][] = [];
  const call: CallFn = async (...argsIn: string[]) => {
    const args = argsIn.map((x) => String(x));
    calls.push(args);
    const cmd0 = String(args[0] ?? '').toUpperCase();
    if (cmd0 === 'SCRIPT') {
      const sub = String(args[1] ?? '').toUpperCase();
      if (sub === 'LOAD') {
        const src = String(args[2] ?? '');
        if (/redis\.call\s*\(\s*['"]INCR/i.test(src)) return SHA_INC;
        if (/redis\.call\s*\(\s*['"]PTTL/i.test(src) || /totalHits|timeToExpire/i.test(src)) return SHA_GET;
        return 'ffffffffffffffffffffffffffffffffffffffff';
      }
    }
    if (cmd0 === 'EVALSHA') {
      const sha = String(args[1] ?? '');
      const nKeys = Number(args[2] ?? 0);
      const key = String(args[3] ?? '');
      if (!nKeys) return [0, 60000] as [number, number];
      // Command shape (rate-limit-redis 4.3.1 retryableIncrement):
      //   EVALSHA <sha> 1 <prefixedKey> <resetExpiryOnChange:0|1> <windowMs>
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
    if (cmd0 === 'EVAL') return [1, 60000] as [number, number];
    if (cmd0 === 'DECR') { const key = String(args[1] ?? ''); if (KV[key]) KV[key].count = Math.max(0, KV[key].count - 1); return 1; }
    if (cmd0 === 'DEL') { const key = String(args[1] ?? ''); delete KV[key]; return 1; }
    return undefined;
  };
  return {
    status: 'ready' as const,
    call,
    on: jest.fn(),
    once: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    calls,
  };
}

type MockFn = (_req: any, _res: any, next: any) => any;

/**
 * Install the exhaustive deep mocks required to import the real app.ts without
 * touching a real DB / Redis / network, then return a freshly-required app.
 */
function bootApp(): any {
  jest.resetModules();

  const we: any = { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() };
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
    publicVerifyReceipt: jest.fn((_r: any, res: any) => res.status(200).json({ ok: true })),
    listMyReceipts: jest.fn((_r: any, res: any) => res.status(200).json([])),
    downloadFormalReceipt: jest.fn((_r: any, res: any) => res.status(200).send('pdf')),
    downloadStatement: jest.fn((_r: any, res: any) => res.status(200).send('pdf')),
  }));
  const noop: MockFn = (_r, res) => res.status(200).json({ ok: true });
  const passArr: MockFn[] = [(_r, _re, n) => n()];
  jest.mock('../controllers/student', () => ({
    getStudentDashboard: noop, getStudentInvoices: noop, getInvoiceById: noop,
    getPaymentHistory: noop, getFeeCatalogue: noop, getAssignedFees: noop, getStudentProfile: noop,
    updateStudentProfile: noop, changePassword: passArr, getStudentReceiptById: noop,
    listMyReceipts: noop, downloadReceipt: noop, generateInvoiceFromFee: noop,
    getStudentPayableBreakdown: noop, getActiveGatewayForStudent: noop,
    getMe: noop, updateMe: noop,
    listStudents: noop, createStudent: noop, getStudent: noop, getStudentByMatric: noop,
    setStudentStatus: noop, resetStudentPassword: noop, updateStudent: noop,
  }));
  jest.mock('../controllers/admin', () => ({
    listStudents: noop, createStudent: noop, updateStudent: noop,
    listFees: noop, createFee: noop, listInvoices: noop,
    getInvoiceById: noop, listPayments: noop, verifyPayment: noop,
    refundPayment: noop, processReceipt: noop, exportPaymentsCsv: noop,
    exportReceiptsCsv: noop, importBulkStudents: noop, generateFeeAssignedInvoices: noop,
    getRefunds: noop, approveRefund: noop, rejectRefund: noop,
    getDashboardStats: noop, addStudent: noop,
    stageStudentUpload: noop, processStudentUpload: noop,
    getAllSettings: noop, updateSettings: noop,
    getGatewayConfig: noop, setGateway: noop, processRefund: noop,
  }));
  jest.mock('../controllers/refunds', () => ({
    bursaryListRefunds: noop, bursaryRequestRefund: noop,
    adminListRefunds: noop, adminApproveRefund: noop, adminRejectRefund: noop,
  }));
  jest.mock('../controllers/payments', () => ({
    initiatePayment: noop, initiatePaymentValidator: passArr,
    verifyPayment: noop, verifyPaymentValidator: passArr,
    billStudentDirect: noop, billStudentDirectValidator: passArr,
    generateFeeAssignedInvoices: noop, confirmPayload: noop, confirmPayloadValidator: passArr,
    getDirectBillInvoice: noop, getDirectBillInvoiceValidator: passArr,
    getContinueOption: noop, getContinueOptionValidator: passArr,
    getPaymentStatus: noop, getPaymentStatusValidator: passArr,
    getTransactionForVerify: noop, lookupTransactionForVerify: noop, verifyPaymentByTransactionId: noop,
  }));
  jest.mock('../controllers/fees', () => ({
    listFeesCatalogue: jest.fn((_r: any, res: any) => res.status(200).json([])),
    listFees: noop, createFee: noop, updateFee: noop, deleteFee: noop, getFee: noop,
    activateFee: noop, disableFee: noop, cloneFee: noop,
    listFeeCategories: noop, getFeeCategory: noop, createFeeCategory: noop,
    updateFeeCategory: noop, deleteFeeCategory: noop,
  }));
  jest.mock('../controllers/feeAssignments', () => ({
    listMyFeeAssignments: noop, billStudent: noop, generateInvoices: noop,
    listFeeAssignments: noop, getFeeAssignment: noop, createFeeAssignment: noop,
    updateFeeAssignment: noop, deleteFeeAssignment: noop, manualStudentInvoice: noop,
    createDirectStudentBill: noop, cancelInvoice: noop, enableInvoice: noop, disableInvoice: noop,
  }));
  jest.mock('../controllers/auth', () => ({
    signup: noop, login: noop, refresh: passArr, logout: passArr, logoutAll: noop, me: noop,
    changePassword: passArr, forgotPassword: noop, resetPassword: passArr,
    mfaChallenge: passArr, mfaSetup: noop, mfaEnable: passArr, mfaDisable: passArr,
    mfaStatus: noop, mfaRegenerateRecoveryCodes: passArr,
  }));
  jest.mock('../controllers/bulkUpload', () => ({
    bulkUploadStudents: noop, confirmFeeUpload: noop, previewStudentUpload: noop,
    previewFeeUpload: noop, stageFeeUpload: noop, stageStudentUpload: noop,
    downloadErrorCsv: jest.fn((_r: any, res: any) => res.status(200).send('csv')),
    confirmStudentUpload: noop,
    listImportRuns: passArr, getImportRun: passArr, listImportRunRows: passArr,
    downloadCredentialsCsv: passArr, resendImportRowCredentials: passArr,
  }));
  jest.mock('../controllers/feeBulkUpload', () => ({
    bulkUploadFees: noop, stageFeeUpload: noop, previewFeeUpload: noop,
    confirmFeeUpload: noop, downloadErrorCsv: jest.fn((_r: any, res: any) => res.status(200).send('csv')),
    stageFeeBulkUpload: noop, previewFeeBulkUpload: noop,
    confirmFeeBulkUpload: noop, downloadFeeErrorCsv: jest.fn((_r: any, res: any) => res.status(200).send('csv')),
  }));
  jest.mock('../middlewares/auth', () => ({
    protect: jest.fn((_r: any, _re: any, n: any) => n()),
    protectSelfService: jest.fn((_r: any, _re: any, n: any) => n()),
    restrictTo: jest.fn(() => (_r: any, _re: any, n: any) => n()),
    requirePermission: jest.fn(() => (_r: any, _re: any, n: any) => n()),
    requireSuperAdmin: jest.fn((_r: any, _re: any, n: any) => n()),
    superAdminOnly: jest.fn((_r: any, _re: any, n: any) => n()),
    bursarOrAdminOnly: jest.fn((_r: any, _re: any, n: any) => n()),
    verifyRecaptchaOrBypass: jest.fn((_r: any, _re: any, n: any) => n()),
  }));
  jest.mock('../middlewares/validate', () => ({
    validateBody: jest.fn(() => (_r: any, _re: any, n: any) => n()),
    validateParams: jest.fn(() => (_r: any, _re: any, n: any) => n()),
    validateQuery: jest.fn(() => (_r: any, _re: any, n: any) => n()),
  }));
  jest.mock('../utils/branding', () => ({
    buildBranding: jest.fn(() => ({ schoolName: 'Bells', logoUrl: null, primaryColor: '#2563eb' })),
    brandingEnvOnly: jest.fn(() => ({ schoolName: 'Bells', logoUrl: null, primaryColor: '#2563eb' })),
  }));
  jest.mock('../config/redis', () => ({
    __esModule: true, getRedis: jest.fn(() => makeCompliantReadyRedis()),
  }));

  // eslint-disable-next-line global-require
  return require('../app').default;
}

const LOGIN_BODY = { identifier: 'staff@bells.edu.ng', password: 'CorrectHorse1!' };

/** POST /auth/login once for the given authoritative client IP. */
async function login(app: any, ip: string) {
  // eslint-disable-next-line global-require
  const request = require('supertest');
  return request(app)
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', ip)
    .send(LOGIN_BODY);
}

/** Assert the login limiter allows exactly `allowed` attempts then returns 429. */
async function expectLoginThreshold(app: any, ip: string, allowed: number) {
  const results: number[] = [];
  for (let i = 0; i < allowed; i++) results.push((await login(app, ip)).status);
  expect(results.every((s) => s !== 429)).toBe(true);
  const over = await login(app, ip);
  expect(over.status).toBe(429);
  // express-rate-limit sends the configured string message via res.send() (text).
  expect(String(over.text ?? '')).toMatch(/Too many auth attempts/i);
}

describe('AUTH RATE-LIMITER SCOPE CORRECTION', () => {
  afterEach(() => { jest.clearAllMocks(); });

  // (1) --------------------------------------------------------------------
  it('login is protected by the login authLimiter: 12 attempts allowed, 13th -> 429', async () => {
    const app = bootApp();
    await expectLoginThreshold(app, '10.10.10.10', 12);
  }, 20000);

  // (2) --------------------------------------------------------------------
  it('/auth/me does NOT consume the login-attempt counter', async () => {
    // eslint-disable-next-line global-require
    const request = require('supertest');
    const app = bootApp();
    const ip = '10.10.10.11';
    for (let i = 0; i < 40; i++) {
      const r = await request(app).get('/api/v1/auth/me').set('X-Forwarded-For', ip);
      expect(r.status).not.toBe(429);
    }
    // The login budget must still be fully intact: 12 allowed, 13th -> 429.
    await expectLoginThreshold(app, ip, 12);
  }, 20000);

  // (3) --------------------------------------------------------------------
  it('/auth/refresh does NOT consume the login-attempt counter (Combo 403 OK; login budget intact)', async () => {
    // eslint-disable-next-line global-require
    const request = require('supertest');
    const app = bootApp();
    const ip = '10.10.10.12';
    for (let i = 0; i < 40; i++) {
      const r = await request(app).post('/api/v1/auth/refresh').set('X-Forwarded-For', ip).send({});
      // refresh has NO app-level login limiter; it must never be a login 429.
      expect(r.status).not.toBe(429);
    }
    await expectLoginThreshold(app, ip, 12);
  }, 20000);

  // (4) --------------------------------------------------------------------
  it('/auth/logout does NOT consume the login-attempt counter (CSRF guard unchanged)', async () => {
    // eslint-disable-next-line global-require
    const request = require('supertest');
    const app = bootApp();
    const ip = '10.10.10.13';
    for (let i = 0; i < 40; i++) {
      const r = await request(app).post('/api/v1/auth/logout').set('X-Forwarded-For', ip).send({});
      expect(r.status).not.toBe(429);
    }
    await expectLoginThreshold(app, ip, 12);
  }, 20000);

  // (5) --------------------------------------------------------------------
  it('/auth/logout-all does NOT consume the login-attempt counter', async () => {
    // eslint-disable-next-line global-require
    const request = require('supertest');
    const app = bootApp();
    const ip = '10.10.10.14';
    for (let i = 0; i < 40; i++) {
      const r = await request(app).post('/api/v1/auth/logout-all').set('X-Forwarded-For', ip).send({});
      expect(r.status).not.toBe(429);
    }
    await expectLoginThreshold(app, ip, 12);
  }, 20000);

  // (6) --------------------------------------------------------------------
  it('/auth/change-password uses its DEDICATED limiter (5/1h) and does NOT consume the login counter', async () => {
    // eslint-disable-next-line global-require
    const request = require('supertest');
    const app = bootApp();
    const ip = '10.10.10.15';
    const body = { currentPassword: 'old', newPassword: 'new' };
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await request(app).patch('/api/v1/auth/change-password').set('X-Forwarded-For', ip).send(body);
      codes.push(r.status);
    }
    // Dedicated limiter max = 5 → first five pass, sixth is throttled.
    expect(codes.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(codes[5]).toBe(429);
    // And the login counter is untouched by change-password traffic.
    await expectLoginThreshold(app, ip, 12);
  }, 20000);

  // (7) --------------------------------------------------------------------
  it('/auth/forgot-password retains its DEDICATED per-email (3/15m) control and does NOT use the login limiter', async () => {
    // eslint-disable-next-line global-require
    const request = require('supertest');
    const app = bootApp();
    const ip = '10.10.10.16';
    const email = 'reset.me@bells.edu.ng';
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await request(app).post('/api/v1/auth/forgot-password').set('X-Forwarded-For', ip).send({ email });
      codes.push(r.status);
    }
    // per-email limiter max = 3 → first three pass, fourth is throttled.
    expect(codes.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(codes[3]).toBe(429);
    // The login budget is consumed only by /login.
    await expectLoginThreshold(app, ip, 12);
  }, 20000);

  // (8) --------------------------------------------------------------------
  it('/auth/reset-password has INDEPENDENT abuse protection after the broad auth mount is removed', async () => {
    // eslint-disable-next-line global-require
    const request = require('supertest');
    const app = bootApp();
    const ip = '10.10.10.17';
    const body = { token: 'signed.reset.token', newPassword: 'new-Passw0rd!' };
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await request(app).post('/api/v1/auth/reset-password').set('X-Forwarded-For', ip).send(body);
      codes.push(r.status);
    }
    // Dedicated reset limiter max = 20 → first twenty pass, twenty-first throttled.
    expect(codes.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(codes[20]).toBe(429);
    // And it does NOT consume the login counter.
    await expectLoginThreshold(app, ip, 12);
  }, 30000);

  // (9) --------------------------------------------------------------------
  it('different authoritative client IPs do NOT share a login counter', async () => {
    const app = bootApp();
    // Exhaust IP-A.
    await expectLoginThreshold(app, '10.10.20.1', 12);
    // IP-B must still start from a full budget (independent bucket).
    await expectLoginThreshold(app, '10.10.20.2', 12);
  }, 30000);

  // (10) -------------------------------------------------------------------
  it('forged (prepended) X-Forwarded-For values cannot bypass the authoritative IP limiting', async () => {
    // eslint-disable-next-line global-require
    const request = require('supertest');
    const app = bootApp();
    // `trust proxy = 1` => req.ip is the RIGHT-MOST XFF entry, i.e. the value
    // nginx OVERWRITES with $remote_addr. An attacker may prepend arbitrary
    // values, but they are ignored: only the right-most (proxy-authoritative)
    // entry keys the bucket. The real client stays '10.10.30.9'.
    const realIp = '10.10.30.9';
    const codes: number[] = [];
    for (let i = 0; i < 13; i++) {
      const r = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', `172.16.${i}.${i + 1}, ${realIp}`)
        .send(LOGIN_BODY);
      codes.push(r.status);
    }
    // Unique forged prefixes each time MUST NOT create unique buckets:
    // the shared right-most authoritative IP is exhausted at the 13th attempt.
    expect(codes.slice(0, 12).every((s) => s !== 429)).toBe(true);
    expect(codes[12]).toBe(429);
  }, 20000);

  // (11) -------------------------------------------------------------------
  it('app still exposes the Redis-backed auth limiters (contract/startup invariants preserved)', async () => {
    const app = bootApp();
    expect(typeof app).toBe('function');
    // eslint-disable-next-line global-require
    const mod = require('../app');
    expect(typeof mod.authLimiter).toBe('function');
    expect(typeof mod.authChangePwLimiter).toBe('function');
    expect(typeof mod.resetPasswordLimiter).toBe('function');
    expect(typeof mod.generalLimiter).toBe('function');
  }, 20000);
});
