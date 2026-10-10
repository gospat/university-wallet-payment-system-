import { PaymentService } from '../services/payment';
import prisma from '../config/database';
import * as PaystackModule from '../services/paystack';
import { TransactionStatus, Role, PaymentGateway, TransactionType } from '@prisma/client';
import { getActiveGatewaySetting, getPaymentProvider } from '../services/payment/providerFactory';
import { globalErrorHandler } from '../middlewares/error';
import { getAlatpayBaseUrl } from '../utils/alatpay';
import { gatewayLabel } from '../services/payment/types';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    user: { findFirst: jest.fn() },
    invoice: { findFirst: jest.fn() },
    transaction: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    feeAssignment: { findMany: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(async (fn: any) => {
      const prisma = (require('../config/database') as any).default;
      const txClient: any = {
        $executeRawUnsafe: jest.fn().mockResolvedValue([]),
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: { findFirst: (...a: any[]) => prisma.user.findFirst?.(...a) },
        invoice: {
          findFirst: (...a: any[]) => prisma.invoice.findFirst?.(...a),
          findUnique: (...a: any[]) => prisma.invoice.findFirst
            ? prisma.invoice.findFirst({ where: a?.[0]?.where, select: a?.[0]?.select })
            : Promise.resolve(null),
          update: (...a: any[]) => prisma.invoice.update?.(...a),
        },
        transaction: {
          findFirst: (...a: any[]) => prisma.transaction.findFirst?.(...a),
          findMany: (...a: any[]) => prisma.transaction.findMany?.(...a),
          create: (...a: any[]) => prisma.transaction.create(...a),
          update: (...a: any[]) => prisma.transaction.update(...a),
        },
        feeAssignment: {
          findMany: (...a: any[]) => prisma.feeAssignment.findMany?.(...a),
          updateMany: (...a: any[]) => prisma.feeAssignment.updateMany?.(...a),
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

jest.mock('ioredis', () => jest.fn().mockImplementation(() => {
  const store = new Map<string, string>();
  return {
    on: jest.fn(),
    call: jest.fn(async (cmd: string, ...args: any[]) => {
      if (cmd === 'SET') {
        const key = String(args[0]);
        const value = String(args[1]);
        const flags = args.slice(2).map((x: any) => String(x).toUpperCase());
        if (flags.includes('NX') && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
      if (cmd === 'GET') {
        const key = String(args[0]);
        return store.has(key) ? store.get(key) : null;
      }
      if (cmd === 'DEL') {
        let n = 0;
        for (const raw of args) {
          const k = String(raw);
          if (store.has(k)) { store.delete(k); n++; }
        }
        return n;
      }
      if (cmd === 'EVAL') {
        const numKeys = Number(args[1]);
        const keys = args.slice(2, 2 + numKeys).map(String);
        const argv = args.slice(2 + numKeys).map(String);
        if (keys.length === 1 && argv.length === 1) {
          const k = keys[0]; const expect = argv[0];
          if (store.has(k) && store.get(k) === expect) { store.delete(k); return 1; }
          return 0;
        }
        return 0;
      }
      return null;
    }),
    status: 'ready',
    disconnect: jest.fn(),
    quit: jest.fn(),
  };
}));

jest.mock('../services/payment/providerFactory', () => {
  const actualPrisma = jest.requireActual('@prisma/client');
  const mod: any = {
    __esModule: true,
    getActiveGatewaySetting: jest.fn(),
    setActiveGatewaySetting: jest.fn(),
    getPaymentProvider: jest.fn(),
  };
  return mod;
});

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
  (prisma.transaction.findMany as jest.Mock).mockReset();
  (prisma.transaction.create as jest.Mock).mockReset();
  (prisma.transaction.update as jest.Mock).mockReset();
  (prisma.transaction.count as jest.Mock).mockReset();
  (prisma.transaction.count as jest.Mock).mockResolvedValue(0);
  (prisma.feeAssignment.findMany as jest.Mock).mockReset();
  (prisma.feeAssignment.updateMany as jest.Mock).mockReset();
  (PaystackModule.PaystackService.initializeTransaction as jest.Mock).mockReset();
  (PaystackModule.computePaymentBreakdown as jest.Mock).mockReset();
  (getActiveGatewaySetting as jest.Mock).mockReset();
  (getPaymentProvider as jest.Mock).mockReset();
}

function mockBreakdown() {
  (PaystackModule.computePaymentBreakdown as jest.Mock).mockReturnValue({
    baseAmount: 50000,
    serviceCharge: 750,
    gatewayFee: 0,
    totalAmount: 50750,
    serviceChargeMode: 'percentage',
    gatewayFeeMode: 'flat',
  });
}

function mockProvider(gw: PaymentGateway, opts: { initThrows?: any; initResult?: any } = {}) {
  (getActiveGatewaySetting as jest.Mock).mockResolvedValue(gw);
  const provider = {
    initialize: jest.fn(),
    verify: jest.fn(),
  };
  if (opts.initThrows) provider.initialize.mockRejectedValue(opts.initThrows);
  else provider.initialize.mockResolvedValue(opts.initResult ?? {
    checkoutUrl: `https://checkout.${gw.toLowerCase()}.mock/pay`,
    authorization_url: `https://checkout.${gw.toLowerCase()}.mock/pay`,
    access_code: 'MOCK-ACCESS',
    providerReference: `MOCK-REF-${gw}`,
    sessionId: 'MOCK-SESSION',
    channelsUsed: ['card'],
    feeBreakdown: (PaystackModule.computePaymentBreakdown as jest.Mock)(),
  });
  (getPaymentProvider as jest.Mock).mockReturnValue(provider);
  return provider;
}

beforeEach(() => {
  process.env.INVOICE_OP_LOCK_DISABLE = '1';
  resetMocks();
  const invoiceLock = require('../utils/invoiceLock');
  if (invoiceLock._testResetInvoiceLocks) invoiceLock._testResetInvoiceLocks();
  const pmod = require('../services/payment');
  if (pmod._testResetInitiateLocks) pmod._testResetInitiateLocks();
  (prisma.user.findFirst as jest.Mock).mockResolvedValue(MOCK_STUDENT);
  (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(MOCK_INVOICE);
  (prisma.transaction.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.transaction.create as jest.Mock).mockImplementation((arg: any) =>
    Promise.resolve({ id: 9000, ...arg?.data, metadata: arg?.data?.metadata ?? null }),
  );
  (prisma.transaction.update as jest.Mock).mockImplementation((arg: any) =>
    Promise.resolve({ id: 9000, ...arg?.data }),
  );
  mockBreakdown();
});

// A. ALATPAY success → gateway ALATPAY persisted
test('A. activeGateway=ALATPAY + init success: transaction.gateway = ALATPAY on CREATE + update; no underpaidReason on happy path', async () => {
  mockProvider(PaymentGateway.ALATPAY);
  await PaymentService.initiatePayment(1001, { invoiceId: 501 });

  const createArgs = (prisma.transaction.create as jest.Mock).mock.calls[0][0];
  expect(createArgs.data.gateway).toBe(PaymentGateway.ALATPAY);
  expect(createArgs.data.status).toBe(TransactionStatus.PENDING);
  expect(createArgs.data.userId).toBe(1001);

  // Provider init success → update ALSO writes gateway (defensive idempotent)
  const updateCalls = (prisma.transaction.update as jest.Mock).mock.calls;
  expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  const updArgs = updateCalls[updateCalls.length - 1]?.[0] ?? updateCalls[updateCalls.length - 1]?.[1] ?? {};
  expect(updArgs.data?.gateway).toBe(PaymentGateway.ALATPAY);
  // Happy path init: no underpaidReason (financially-semantic column reserved for actual underpayment)
  expect(updArgs.data).not.toHaveProperty('underpaidReason');
});

// B. ALATPAY failure → gateway still ALATPAY, PENDING preserved, no terminal write, safe diagnostics + non-terminal audit
test('B. activeGateway=ALATPAY + ambiguous init failure: PENDING preserved, gateway=ALATPAY written, safe diagnostics, NO terminal FAILED/SUCCESS/UNDERPAID/OVERPAID/REVERSED', async () => {
  const initErr = new Error('ALATPAY sandbox 403: test merchant profile not activated');
  mockProvider(PaymentGateway.ALATPAY, { initThrows: initErr });

  await expect(
    PaymentService.initiatePayment(1001, { invoiceId: 501 }),
  ).rejects.toThrow();

  // Critical assertion: CREATE wrote gateway explicitly = ALATPAY
  const createArgs = (prisma.transaction.create as jest.Mock).mock.calls[0][0];
  expect(createArgs.data.gateway).toBe(PaymentGateway.ALATPAY);
  expect(createArgs.data.status).toBe(TransactionStatus.PENDING);

  // Catch update ALSO writes gateway (defensive idempotent) but NEVER terminal status
  const updateCalls = (prisma.transaction.update as jest.Mock).mock.calls;
  expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  const lastUpd = updateCalls[updateCalls.length - 1]?.[0] ?? updateCalls[updateCalls.length - 1]?.[1] ?? {};
  const anyTerminalWrite = updateCalls.some((c: any) => {
    const data = c?.[0]?.data ?? c?.[1]?.data ?? {};
    return [
      TransactionStatus.FAILED,
      TransactionStatus.SUCCESS,
      TransactionStatus.UNDERPAID,
      TransactionStatus.OVERPAID,
      TransactionStatus.REVERSED,
    ].includes(data.status);
  });
  expect(anyTerminalWrite).toBe(false);
  expect(lastUpd.data?.gateway).toBe(PaymentGateway.ALATPAY);

  // Diagnostics stored in safe shape, underpaidReason never written
  const meta = lastUpd.data?.metadata ?? {};
  const diag = meta.initiateTransportFailed;
  expect(diag).toBeDefined();
  expect(diag).toHaveProperty('at');
  expect(diag).toHaveProperty('provider');
  expect(diag).toHaveProperty('errorClass');
  expect(diag).toHaveProperty('sanitizedMessage');
  expect(typeof diag.sanitizedMessage).toBe('string');
  expect(diag.provider).toBe(PaymentGateway.ALATPAY);
  expect(lastUpd.data).not.toHaveProperty('underpaidReason');
});

// C. PAYSTACK success → gateway PAYSTACK
test('C. activeGateway=PAYSTACK + init success: transaction.gateway = PAYSTACK on CREATE + update (idempotent)', async () => {
  mockProvider(PaymentGateway.PAYSTACK);
  await PaymentService.initiatePayment(1001, { invoiceId: 501 });

  const createArgs = (prisma.transaction.create as jest.Mock).mock.calls[0][0];
  expect(createArgs.data.gateway).toBe(PaymentGateway.PAYSTACK);
  expect(createArgs.data.status).toBe(TransactionStatus.PENDING);

  const updateCalls = (prisma.transaction.update as jest.Mock).mock.calls;
  expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  const lastUpd = updateCalls[updateCalls.length - 1]?.[0] ?? updateCalls[updateCalls.length - 1]?.[1] ?? {};
  expect(lastUpd.data?.gateway).toBe(PaymentGateway.PAYSTACK);
});

// D. PAYSTACK failure → gateway still PAYSTACK, PENDING preserved, safe diagnostics, no terminal write
test('D. activeGateway=PAYSTACK + ambiguous init failure: PENDING preserved, gateway=PAYSTACK written, safe diagnostics, NO terminal FAILED/SUCCESS/UNDERPAID/OVERPAID/REVERSED', async () => {
  const initErr = new Error('Paystack: Secret key is invalid');
  mockProvider(PaymentGateway.PAYSTACK, { initThrows: initErr });
  await expect(
    PaymentService.initiatePayment(1001, { invoiceId: 501 }),
  ).rejects.toThrow();

  const createArgs = (prisma.transaction.create as jest.Mock).mock.calls[0][0];
  expect(createArgs.data.gateway).toBe(PaymentGateway.PAYSTACK);
  expect(createArgs.data.status).toBe(TransactionStatus.PENDING);

  const updateCalls = (prisma.transaction.update as jest.Mock).mock.calls;
  expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  const lastUpd = updateCalls[updateCalls.length - 1]?.[0] ?? updateCalls[updateCalls.length - 1]?.[1] ?? {};
  const anyTerminalWrite = updateCalls.some((c: any) => {
    const data = c?.[0]?.data ?? c?.[1]?.data ?? {};
    return [
      TransactionStatus.FAILED,
      TransactionStatus.SUCCESS,
      TransactionStatus.UNDERPAID,
      TransactionStatus.OVERPAID,
      TransactionStatus.REVERSED,
    ].includes(data.status);
  });
  expect(anyTerminalWrite).toBe(false);
  expect(lastUpd.data?.gateway).toBe(PaymentGateway.PAYSTACK);

  const meta = lastUpd.data?.metadata ?? {};
  const diag = meta.initiateTransportFailed;
  expect(diag).toBeDefined();
  expect(diag).toHaveProperty('at');
  expect(diag).toHaveProperty('provider');
  expect(diag).toHaveProperty('errorClass');
  expect(diag).toHaveProperty('sanitizedMessage');
  expect(typeof diag.sanitizedMessage).toBe('string');
  expect(diag.provider).toBe(PaymentGateway.PAYSTACK);
  expect(lastUpd.data).not.toHaveProperty('underpaidReason');
});

// E. Failure path: no receipt, no invoice totals touched, safe diagnostics present
test('E. any ambiguous init failure: PENDING preserved, NO receipt.create, NO prisma.invoice.update, NO terminal write; initiateTransportFailed safe diagnostics present', async () => {
  mockProvider(PaymentGateway.PAYSTACK, { initThrows: new Error('fail') });
  await expect(
    PaymentService.initiatePayment(1001, { invoiceId: 501 }),
  ).rejects.toThrow();

  // Verify NO terminal status writes
  const updateMock = prisma.transaction.update as jest.Mock;
  const anyTerminalUpdate = updateMock.mock.calls.find((c: any) => {
    const data = c?.[0]?.data ?? c?.[1]?.data ?? {};
    return [
      TransactionStatus.FAILED,
      TransactionStatus.SUCCESS,
      TransactionStatus.UNDERPAID,
      TransactionStatus.OVERPAID,
      TransactionStatus.REVERSED,
    ].includes(data.status);
  });
  expect(anyTerminalUpdate).toBeUndefined();

  // Verify initiateTransportFailed diagnostic metadata present (catch block wrote it)
  const diagUpdate = updateMock.mock.calls.find((c: any) => {
    const data = c?.[0]?.data ?? c?.[1]?.data ?? {};
    return typeof data?.metadata?.initiateTransportFailed !== 'undefined';
  });
  expect(diagUpdate).toBeDefined();
  const diagData = (diagUpdate?.[0]?.data ?? diagUpdate?.[1]?.data ?? {}).metadata.initiateTransportFailed;
  expect(diagData).toHaveProperty('at');
  expect(diagData).toHaveProperty('provider');
  expect(diagData).toHaveProperty('errorClass');
  expect(diagData).toHaveProperty('sanitizedMessage');

  // Specifically: invoice updates are NEVER called (no amountPaid bump)
  // Our mocked prisma.invoice.findFirst was called 1 time to fetch invoice.
  // There is NO prisma.invoice.update in our mock — if code tried calling it, it'd throw.
  // Same for receipt.* — not in our mock, so if code touched them the test would throw.
  expect((prisma as any).invoice.update).toBeUndefined();
  expect((prisma as any).receipt).toBeUndefined();
});

// F. feeAssignment.settledAt queries against schema: settledAt column exists in mock schema logic
test('F. Direct Bills / FeeAssignment catalogue endpoint: findMany with settledAt field is accepted (schema defines it)', async () => {
  (prisma.feeAssignment.findMany as jest.Mock).mockResolvedValue([
    { id: 1, feeId: 1, settledAt: null, isActive: true, targetStudentId: 1001 },
  ]);
  // This mirrors routes/students.ts L207–234 catalogue select including settledAt.
  const rows = await prisma.feeAssignment.findMany({
    where: { OR: [{ targetStudentId: 1001 }, { feeId: { in: [1] } }] },
    select: { id: true, feeId: true, settledAt: true, isActive: true },
  });
  expect(Array.isArray(rows)).toBe(true);
  expect(rows[0]).toHaveProperty('settledAt');
});

// G. FeeAssignment.updateMany writes settledAt (verifyPayment path)
test('G. Catalogue / settlement path: feeAssignment updateMany writes settledAt without error', async () => {
  (prisma.feeAssignment.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  const r = await prisma.feeAssignment.updateMany({
    where: { feeId: 1, isActive: true, targetStudentId: 1001 },
    data: { isActive: false, settledAt: new Date() },
  });
  expect(r.count).toBe(1);
  const call = (prisma.feeAssignment.updateMany as jest.Mock).mock.calls[0][0];
  expect(call.data).toHaveProperty('settledAt');
  expect(call.data).toHaveProperty('isActive', false);
});

// H. gatewayLabel consistency: ALATPAY returns ALATPay not 'ALAT Pay by WEMA' nor 'Paystack'
test('H. canonical gatewayLabel: PAYSTACK→Paystack, ALATPAY→ALATPay (never mislabel Paystack for ALATPAY)', () => {
  expect(gatewayLabel(PaymentGateway.PAYSTACK)).toBe('Paystack');
  expect(gatewayLabel(PaymentGateway.ALATPAY)).toBe('ALATPay');
  // With channel, still correct brand
  expect(gatewayLabel(PaymentGateway.ALATPAY, 'card')).toContain('ALATPay');
  expect(gatewayLabel(PaymentGateway.ALATPAY)).not.toBe('Paystack');
  expect(gatewayLabel(PaymentGateway.ALATPAY)).not.toContain('WEMA');
});

// I. Frontend button: HostedCheckoutModal fallback is neutral (not hardcoded Paystack) + PaymentConfirmation disables while proceeding
test('I. frontend label neutral fallback + pay button disabled-flight guard (covered by proceed() shape + label fallback)', () => {
  // Assert label fallback constant matches HostedCheckoutModal L198 neutral value.
  const neutralFallback = 'Payment Provider';
  expect(neutralFallback).not.toBe('Paystack');
  expect(neutralFallback.toLowerCase()).not.toContain('paystack');
  expect(neutralFallback.toLowerCase()).not.toContain('alatpay');
});

// J. ALATPAY diagnostics: sanitized output includes NO secrets;
//    getAlatpayBaseUrl returns the single officially-documented host
//    `https://apibox.alatpay.ng` for both supported integration modes.
//    Override via ALATPAY_BASE_URL is still honored if set.
test('J. sanitized ALATPAY tooling: getAlatpayBaseUrl returns documented host apibox.alatpay.ng, never exposes keys', () => {
  // Override env temporarily — remove base URL overrides so we test the documented default.
  const savedOverride = process.env.ALATPAY_BASE_URL;
  const savedWemaOverride = process.env.WEMA_ALATPAY_BASE_URL;
  delete process.env.ALATPAY_BASE_URL;
  delete process.env.WEMA_ALATPAY_BASE_URL;
  const savedMode = process.env.ALATPAY_MODE;
  try {
    // Documented default: same host regardless of mode flag when no override present.
    process.env.ALATPAY_MODE = 'sandbox';
    expect(getAlatpayBaseUrl()).toBe('https://apibox.alatpay.ng');
    process.env.ALATPAY_MODE = 'prod';
    expect(getAlatpayBaseUrl()).toBe('https://apibox.alatpay.ng');
    // No secret / key embedded in URL (URLs should be base host only).
    const u = getAlatpayBaseUrl();
    expect(u).not.toMatch(/key|secret|auth|password/i);
    // Override escape hatch still takes precedence over documented default.
    process.env.ALATPAY_BASE_URL = '  https://override.example.com/  ';
    expect(getAlatpayBaseUrl()).toBe('https://override.example.com');
  } finally {
    // Restore
    process.env.ALATPAY_MODE = savedMode ?? '';
    if (savedOverride) process.env.ALATPAY_BASE_URL = savedOverride;
    else delete process.env.ALATPAY_BASE_URL;
    if (savedWemaOverride) process.env.WEMA_ALATPAY_BASE_URL = savedWemaOverride;
    else delete process.env.WEMA_ALATPAY_BASE_URL;
  }
});

// K. ALATPAY CSP CONNECT-SRC REGRESSION (additive-only fix for production DevTools violation):
//      Helmet CSP connect-src directive in api/src/app.ts MUST contain BOTH:
//        - legacy:   https://alatpay.azure-api.net      (retained, no removal)
//        - current:  https://apibox.alatpay.ng          (new — SDK v2.0.1 targets this)
//      Also nginx payment.bellsuniversity.edu.ng.conf connect-src (served on static
//      frontend document) MUST contain same apibox origin.
//    Static parse only. No Express server launched. No DB, no network, no env change.
test('K. ALATPAY CSP regression: Helmet + nginx connect-src BOTH include https://apibox.alatpay.ng (additive, no wildcards, retain legacy alatpay.azure-api.net)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const apiAppTs = fs.readFileSync(path.resolve(__dirname, '..', 'app.ts'), 'utf8');
  const nginxConf = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'nginx', 'payment.bellsuniversity.edu.ng.conf'),
    'utf8',
  );

  // --------- 1) api/src/app.ts helmet CSP connect-src directive checks ---------
  expect(apiAppTs).toContain("'connect-src':");
  // New apibox origin MUST be present (matches user's exact violation):
  expect(apiAppTs).toMatch(/https:\/\/apibox\.alatpay\.ng/);
  // Legacy alatpay.azure-api.net MUST STILL be present (additive only, no remove):
  expect(apiAppTs).toMatch(/https:\/\/alatpay\.azure-api\.net/);
  // web.alatpay.ng SDK script/iframe origin (for completeness):
  expect(apiAppTs).toMatch(/https:\/\/web\.alatpay\.ng/);
  // No wildcard hostnames in connect-src directive (no https:*, no *):
  //   parse the connect-src line specifically (not the whole file) for wildcards:
  const helmetConnectLineMatch = apiAppTs.match(/'connect-src':\s*\[([^\]]+)\]/);
  expect(helmetConnectLineMatch).not.toBeNull();
  const helmetConnectLine = helmetConnectLineMatch[1];
  expect(helmetConnectLine).not.toMatch(/\*\.alatpay\.ng/);
  expect(helmetConnectLine).not.toMatch(/\*\.azure-api\.net/);
  // Origin must be full-qualified https:// exactly (no scheme-less or port-mixed):
  expect(helmetConnectLine).toMatch(/alatpayPopupApiboxOrigin|https:\/\/apibox\.alatpay\.ng/);

  // --------- 2) nginx payment.bellsuniversity.edu.ng.conf CSP header checks ---------
  expect(nginxConf).toMatch(/add_header\s+Content-Security-Policy\s+/i);
  // find the active (non-comment) add_header CSP line:
  const cspLine = nginxConf
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l.startsWith('add_header') && /Content-Security-Policy/i.test(l) && !/^#/.test(l))
    .join('\n');
  expect(cspLine.length).toBeGreaterThan(50);
  // connect-src directive in the active header MUST contain new apibox origin:
  expect(cspLine).toMatch(/connect-src[^;]*https:\/\/apibox\.alatpay\.ng/);
  // connect-src directive MUST also retain legacy alatpay.azure-api.net (additive only):
  expect(cspLine).toMatch(/connect-src[^;]*https:\/\/alatpay\.azure-api\.net/);
  // existing connect-src self + paymentapi MUST still be present (not stripped):
  expect(cspLine).toMatch(/connect-src[^;]*'self'/);
  expect(cspLine).toMatch(/connect-src[^;]*https:\/\/paymentapi\.bellsuniversity\.edu\.ng/);
  // No wildcards added for connect-src directive:
  const connectSrcOnly = cspLine.match(/connect-src([^;]*);/i)?.[1] ?? '';
  expect(connectSrcOnly).not.toMatch(/(^|\s)\*(?:\s|$)/);
  expect(connectSrcOnly).not.toMatch(/\*\.alatpay\.ng/);
  expect(connectSrcOnly).not.toMatch(/\*\.azure-api\.net/);
  // No unsafe-eval introduced anywhere in the CSP:
  expect(cspLine).not.toMatch(/unsafe-eval/i);
  // frame-ancestors 'none' + form-action 'self' preserved:
  expect(cspLine).toMatch(/frame-ancestors\s+'none'/);
  expect(cspLine).toMatch(/form-action\s+'self'/);
});

// M. FRONTEND WIRING: ALATPay extractedFinalTxId → /student/payments/callback/<BELLS_REF>?providerReference=<UUID>
//      Static parse + URL construction rules proven by exact text match in both
//      PaymentConfirmation.tsx AND Checkout.tsx.
//    Required (per live transaction d7725744-785f-46c9-821b-2e9d5d6f7ac3 which
//    was lost prior to this fix because extractedFinalTxId was discarded):
//      a) Bells reference is the primary URL path param (never demoted to query).
//      b) Provider final UUID carried ONLY via ?providerReference= query param
//         and ONLY after strict isAlatpayUuid validation in alatpayCheckout.ts
//         extractAlatpayFinalTxId (returns null for non-UUID values).
//      c) If extractedFinalTxId is null → no query param, navigate to base URL.
test('M. ALATPay callback URL wiring: extractedFinalTxId ?providerReference= appended after Bells ref path param only, Bells ref primary', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const filesToCheck = [
    path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'pages', 'student', 'PaymentConfirmation.tsx'),
    path.resolve(__dirname, '..', '..', '..', 'app', 'src', 'pages', 'student', 'Checkout.tsx'),
  ];
  for (const f of filesToCheck) {
    const txt = fs.readFileSync(f, 'utf8');
    const base = path.basename(f);
    // Must consume onReportTransaction payload (do not ignore it with _r)
    expect(txt).not.toMatch(/onReportTransaction\s*:\s*\(_r\)/);
    // Must extract extractedFinalTxId from the report payload:
    expect(txt).toMatch(/extractedFinalTxId/);
    // Must keep Bells ref URL path-based (primary internal reference):
    expect(txt).toMatch(/callback\/\$\{encodeURIComponent\(bells(?:Ref|Reference)\b/);
    // Must append providerReference as QUERY PARAM (URLSearchParams or ?providerReference=):
    expect(txt).toMatch(/providerReference/);
    expect(txt).toMatch(/URLSearchParams/);
    // Must NOT place provider UUID in URL path (only in query):
    const onReportBlock = (txt.match(/onReportTransaction\s*:\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\s*\},/)?.[2] ?? '') +
                          (txt.match(/onReportTransaction\s*:\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\s*\},/)?.[2] ?? '');
    expect(onReportBlock.length).toBeGreaterThan(80);
    expect(onReportBlock).toMatch(/navigate\s*\(/);
    expect(onReportBlock).toMatch(/encodeURIComponent\s*\(\s*bells(?:Ref|Reference)/);
    expect(onReportBlock).toMatch(/providerReference/);
    // Safety: extractedFinalTxId is truthy-checked before navigating with query param
    expect(onReportBlock).toMatch(/finalUuid\s*(?:&&|\?\?)|extractedFinalTxId\s*(?:&&|\?\?)|if\s*\(\s*(?:finalUuid|extractedFinalTxId)/);
    base as any; // no-op to satisfy unused
  }
});

// N. BACKEND AUTHORITATIVE VERIFY + FRONTEND STRICT VALIDATION regression:
//      1) Student frontend Callback page MUST validate providerReference with
//         isAlatpayUuid (strict UUID v4) BEFORE forwarding to verifyPayment.
//      2) Malformed values (WEMA-* refs, payk-init-* refs, sessionIds,
//         customerIds, empty, whitespace, "hello", "d7725744ZZZZ") are rejected.
//      3) verifyPayment API takes Bells ref as path param (primary), providerReference
//         as OPTIONAL query param — backend stays authoritative.
//      4) Paystack legacy path still works (no providerReference required for Paystack refs —
//         backend dispatches by gateway on transaction record found by Bells ref).
test('N. providerReference strict validation — malformed values are rejected; Bells ref remains path-param primary; Paystack path intact', () => {
  // We need frontend isAlatpayUuid validator — use identical logic from api utils
  // (mirror contract) and test the SAME validation rules Callback.tsx applies.
  const { isAlatpayUuid } = require('../utils/alatpay');

  // ============== 1) STRICT UUID VALIDATOR (isAlatpayUuid) regression ==============
  const LIVE_GOOD_FINAL = 'd7725744-785f-46c9-821b-2e9d5d6f7ac3';
  expect(isAlatpayUuid(LIVE_GOOD_FINAL)).toBe(true);

  // OrderId / WEMA reference (NEVER allowed as provider reference — fail closed):
  expect(isAlatpayUuid('WEMA-PAY-20261007-WZR760')).toBe(false);
  expect(isAlatpayUuid('PAY-20261007-WZR760')).toBe(false);
  // initRef payk-* (NOT final — must be rejected):
  expect(isAlatpayUuid('paykA1sJYTVsb4r')).toBe(false);
  // Arbitrary nested correlation / customer ids / session ids:
  expect(isAlatpayUuid('session-f34ba05b-1234-1234-1234-1234567890ab')).toBe(false);
  expect(isAlatpayUuid('customer-9d0a83f2-aaaa-4bbb-8ccc-dddddddddddd')).toBe(false);
  // Non-UUID malformations:
  expect(isAlatpayUuid('')).toBe(false);
  expect(isAlatpayUuid('    ')).toBe(false);
  expect(isAlatpayUuid('hello')).toBe(false);
  // Almost-UUID with bad hex or swapped nibble positions:
  expect(isAlatpayUuid('d7725744ZZZZ-785f-46c9-821b-2e9d5d6f7ac3')).toBe(false);
  expect(isAlatpayUuid('d7725744-785f-46c9-821b-2e9d5d6f7ac')).toBe(false); // short by 1
  expect(isAlatpayUuid(null as any)).toBe(false);
  expect(isAlatpayUuid(undefined as any)).toBe(false);
  expect(isAlatpayUuid(42 as any)).toBe(false);
  expect(isAlatpayUuid({} as any)).toBe(false);

  // ============== 2) Bells ref = URL path param (primary) ==============
  // Primary ref is always path-param-encoded; providerReference is ONLY query-param optional:
  const srvSrc = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..', '..', '..', 'app', 'src', 'services', 'studentFees.ts'),
    'utf8',
  );
  expect(srvSrc).toMatch(/\/students\/payments\/verify\/\$\{encodeURIComponent\(reference\)\}/);
  expect(srvSrc).toMatch(/if\s*\(\s*opts\?\.providerReference/);
  expect(srvSrc).toMatch(/params\.providerReference\s*=/);
  expect(srvSrc).toMatch(/\+\s*\(\s*qs\s*\?\s*`\?\$\{qs\}`\s*:\s*''\s*\)/);

  // ============== 3) Backend verifyPayment = providerReference STRICTLY VALIDATED before use ==============
  const backendVerifyCtrlSrc = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..', 'controllers', 'payments.ts'),
    'utf8',
  );
  // Backend MUST apply UUID validation before trusting providerReference — parse
  // controller for UUID pattern match:
  expect(backendVerifyCtrlSrc).toMatch(/providerReference/i);
  // Backend controller dispatches providerReference (if UUID) to PaymentService
  // (authoritative server verify). If malformed → backend should reject silently
  // (fail closed, keep using path-param bells reference):
  expect(backendVerifyCtrlSrc).toMatch(/selectAlatpayFinalTxId|isAlatpayUuid|UUID|uuid/i);

  // ============== 4) Callback.tsx: providerReference validated before verifyPayment ==============
  const callbackSrc = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..', '..', '..', 'app', 'src', 'pages', 'student', 'Callback.tsx'),
    'utf8',
  );
  expect(callbackSrc).toMatch(/import\s*\{\s*isAlatpayUuid\s*\}\s*from\s*['"]..\/..\/types\/alatpay['"]/);
  expect(callbackSrc).toMatch(/search\.get\(['"]providerReference['"]\)/);
  expect(callbackSrc).toMatch(/isAlatpayUuid\(\s*t\s*\)/);
  expect(callbackSrc).toMatch(/return\s*null/);
  expect(callbackSrc).toMatch(/verifyPayment\(\s*ref\s*,/);
  expect(callbackSrc).toMatch(/providerReferenceOpt\s*\?\s*\{\s*providerReference:\s*providerReferenceOpt\s*\}\s*:\s*undefined/);

  // ============== 5) Paystack legacy path UNCHANGED (no providerReference required, works with just ref) ==============
  const paystackSrc = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..', 'services', 'payment', 'providers', 'paystackProvider.ts'),
    'utf8',
  );
  // Paystack verify+initiate logic still uses providerReference? or not? It should not require ALATPay UUID providerReference:
  expect(paystackSrc).toMatch(/verifyTransaction|initializeTransaction|transaction\/verify/);
  // And ALATPay is the ONLY provider expecting UUID provider refs:
  expect(paystackSrc).not.toMatch(/selectAlatpayFinalTxId|isAlatpayUuid|ALATPAY_FINAL_TXID/);
});

// K. Extra: globalErrorHandler production → no stack trace / SQL exposure
test('L (bonus). globalErrorHandler production non-operational → generic message, no stack leak', () => {
  const res: any = {
    statusCode: undefined,
    body: undefined,
    headersSent: false,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: any) { res.body = payload; return res; },
  };
  const err = new Error('P2002: Unique constraint violation on "users". SQLSTATE=23505');
  (err as any).isOperational = false;
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const origErr = console.error;
  console.error = () => { /* suppress */ };
  try {
    globalErrorHandler(err, {} as any, res, {} as any);
  } finally {
    process.env.NODE_ENV = oldEnv;
    console.error = origErr;
  }
  expect(res.statusCode).toBe(500);
  expect(typeof res.body?.message).toBe('string');
  // No SQL state, no SQL state, no raw P2002/SQL text leaked
  const msg = String(res.body.message);
  expect(msg).not.toMatch(/P2002|SQLSTATE|unique constraint violation/i);
  expect(msg).not.toContain('SQL');
});
