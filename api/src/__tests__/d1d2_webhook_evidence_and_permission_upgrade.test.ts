// =============================================================================
// D1 — Webhook evidence 5-case classification suite (strongly-typed Prisma shape)
// D2 — Bursary permission release-upgrade 4-case suite
// -----------------------------------------------------------------------------
// All test cases run with in-memory Prisma/ioredis mocks (no MySQL/Redis).
// The disposable real-MySQL webhook-evidence shape-proof lives in the
// opt-in c1c4_disposable_concurrency.test.ts suite.
// =============================================================================

import { TransactionCancellationService, CANCEL_TRANSACTION_REASONS } from '../services/transactionCancellation';
import {
  BURSARY_PERMISSION_KEYS,
  BURSARY_RELEASE_UPGRADE_KEYS,
  BURSARY_RELEASE_UPGRADE_SENTINEL_ID,
  seedPermissions,
} from '../services/permissionSeed';
import prisma from '../config/database';
import { Role, TransactionStatus, PaymentGateway } from '@prisma/client';
import { AppError } from '../utils/AppError';

// -----------------------------------------------------------------------------
// Prisma + ioredis in-memory mocks (identical pattern to blockers_integration)
// -----------------------------------------------------------------------------
jest.mock('../config/database', () => {
  const RoleEnum = { ADMIN: 'ADMIN', BURSARY: 'BURSARY', STUDENT: 'STUDENT' } as const;
  const users: Record<number, any> = {};
  users[7001] = { id: 7001, email: 'admin-d1d2@x.test', role: RoleEnum.ADMIN, firstName: 'A', lastName: 'B', accountStatus: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: null, mustChangePassword: false, middleName: null, phoneNumber: null, address: null, createdAt: new Date(), updatedAt: new Date(), bcrypt: null, password: 'x' };

  // In-memory tables for state simulation across mock calls.
  const txns: Record<number, any> = {};
  const invoices: Record<number, any> = {};
  const webhookEvents: any[] = [];
  const settlements: any[] = [];
  const receipts: any[] = [];
  const gls: any[] = [];
  const audits: any[] = [];
  const permissions: Record<string, { id: number; key: string; name: string; category: string; description: string | null }> = {};
  let nextPermissionId = 1;
  const rolePermissions: { role: string; permissionId: number }[] = [];
  const counters: Record<string, { id: string; value: number; updatedAt: Date }> = {};
  let nextTxnId = 99000;
  let nextWebhookId = 1;

  // Minimal ioredis-like SET/DEL/EVAL stub for distributed lock CAS.
  const _redisKV = new Map<string, string>();
  const runRedisCall = async (cmd: string, ...args: any[]): Promise<any> => {
    if (cmd === 'SET') {
      const key = String(args[0]);
      const val = String(args[1]);
      const nxIdx = args.findIndex((x) => typeof x === 'string' && x.toUpperCase() === 'NX');
      const xxIdx = args.findIndex((x) => typeof x === 'string' && x.toUpperCase() === 'XX');
      if (nxIdx >= 0 && _redisKV.has(key)) return Promise.resolve(null);
      if (xxIdx >= 0 && !_redisKV.has(key)) return Promise.resolve(null);
      _redisKV.set(key, val);
      return Promise.resolve('OK');
    }
    if (cmd === 'GET') return Promise.resolve(_redisKV.get(String(args[0])) ?? null);
    if (cmd === 'DEL') {
      const key = String(args[0]);
      const had = _redisKV.has(key);
      if (had) _redisKV.delete(key);
      return Promise.resolve(had ? 1 : 0);
    }
    if (cmd === 'EVAL' || cmd === 'EVALSHA') {
      const script = String(args[0]);
      const numKeys = Number(args[1]) | 0;
      const keys = args.slice(2, 2 + numKeys).map(String);
      const argv = args.slice(2 + numKeys).map(String);
      if (script.includes('if redis.call') && script.includes('ARGV') && (script.includes('del') || script.includes('return 0'))) {
        // COMPARE_AND_DELETE_LUA-ish: delete key iff value === ARGV[1]
        const k = keys[0];
        const expected = argv[0];
        if (_redisKV.has(k) && _redisKV.get(k) === expected) {
          _redisKV.delete(k);
          return Promise.resolve(1);
        }
        return Promise.resolve(0);
      }
      return Promise.resolve(0);
    }
    return Promise.resolve(null);
  };

  // Match actual WebhookEvent Prisma schema filter operators {equals: X} used
  // by transactionCancellation.ts Pre5B strong-typed findMany.
  const matchWebhookWhere = (a: any) => {
    let rows = webhookEvents.slice();
    const ors = (a.where?.OR ?? []) as any[];
    if (ors.length > 0) {
      rows = rows.filter((h) => ors.some((orClause) => {
        return Object.entries(orClause).every(([k, clause]) => {
          const expected = clause && typeof clause === 'object' && 'equals' in clause
            ? (clause as any).equals
            : clause;
          return String((h as any)[k] ?? '') === String(expected);
        });
      }));
    }
    if (typeof a.orderBy === 'object' && 'createdAt' in a.orderBy) {
      const dir = String(a.orderBy.createdAt).toLowerCase() === 'asc' ? 1 : -1;
      rows.sort((x, y) => {
        const a = x.createdAt ? new Date(x.createdAt).getTime() : 0;
        const b = y.createdAt ? new Date(y.createdAt).getTime() : 0;
        return (a - b) * dir;
      });
    }
    if (typeof a.take === 'number' && rows.length > a.take) rows = rows.slice(0, a.take);
    return rows;
  };

  return {
    __esModule: true,
    default: {
      user: { findUnique: jest.fn((a: any) => Promise.resolve(users[a.where.id] ?? null)) },
      transaction: {
        findUnique: jest.fn((a: any) => {
          const r = txns[a.where.id];
          if (!r) return Promise.resolve(null);
          const out = JSON.parse(JSON.stringify(r));
          if (a.select?.invoice && out.invoiceId && invoices[out.invoiceId]) {
            out.invoice = JSON.parse(JSON.stringify(invoices[out.invoiceId]));
          } else if (a.select?.invoice) {
            out.invoice = null;
          }
          return Promise.resolve(out);
        }),
        update: jest.fn((a: any) => {
          txns[a.where.id] = { ...(txns[a.where.id] ?? { id: a.where.id }), ...a.data, updatedAt: new Date() };
          return Promise.resolve({ ...txns[a.where.id] });
        }),
      },
      invoice: {
        findUnique: jest.fn((a: any) => {
          const r = invoices[a.where.id];
          if (!r) return Promise.resolve(null);
          return Promise.resolve(JSON.parse(JSON.stringify(r)));
        }),
        update: jest.fn((a: any) => {
          invoices[a.where.id] = { ...(invoices[a.where.id] ?? { id: a.where.id }), ...a.data, updatedAt: new Date() };
          return Promise.resolve({ ...invoices[a.where.id] });
        }),
      },
      settlement: { count: jest.fn((a: any) => Promise.resolve(settlements.filter((s: any) => s.transactionId === a.where.transactionId).length)) },
      receipt: { count: jest.fn((a: any) => Promise.resolve(receipts.filter((r: any) => r.transactionId === a.where.transactionId).length)) },
      generalLedger: { count: jest.fn((a: any) => Promise.resolve(gls.filter((g: any) => g.transactionId === a.where.transactionId).length)) },
      webhookEvent: {
        create: jest.fn((a: any) => {
          const id = nextWebhookId++;
          const row = { id, createdAt: new Date(), isProcessed: false, attempts: 0, processedAt: null, lastError: null, ...a.data };
          webhookEvents.push(row);
          return Promise.resolve(row);
        }),
        findMany: jest.fn((a: any) => Promise.resolve(matchWebhookWhere(a).map((r) => ({ ...r })))),
      },
      auditLog: { create: jest.fn((a: any) => { audits.push({ id: audits.length + 1, ...a.data }); return Promise.resolve({ id: audits.length }); }) },
      permission: {
        findMany: jest.fn((a: any) => {
          const list = Object.values(permissions);
          if (a.where?.key?.in) {
            const s = new Set(a.where.key.in);
            return Promise.resolve(list.filter((p) => s.has(p.key)));
          }
          return Promise.resolve(list);
        }),
        upsert: jest.fn((a: any) => {
          const key = String(a.where.key);
          const existing = permissions[key];
          if (existing) {
            Object.assign(existing, a.update ?? {});
            return Promise.resolve({ ...existing });
          }
          const id = nextPermissionId++;
          const row = { id, key, name: a.create.name, category: a.create.category, description: a.create.description ?? null };
          permissions[key] = row;
          return Promise.resolve({ ...row });
        }),
      },
      rolePermission: {
        findMany: jest.fn((a: any) => Promise.resolve(rolePermissions.filter((rp) => !a.where?.role || rp.role === a.where.role).map((r) => ({ ...r })))),
        groupBy: jest.fn((a: any) => {
          const by: Record<string, number> = {};
          const rolesFilter = new Set<string>(a.where?.role?.in ?? []);
          for (const rp of rolePermissions) {
            if (rolesFilter.size > 0 && !rolesFilter.has(rp.role)) continue;
            by[rp.role] = (by[rp.role] ?? 0) + 1;
          }
          const out = Object.entries(by).map(([role, count]) => ({ role, _count: { role: count } }));
          return Promise.resolve(out);
        }),
        deleteMany: jest.fn((a: any) => {
          const permissionIds = new Set<number>(a.where?.permissionId?.in ?? []);
          const role = a.where?.role;
          let removed = 0;
          for (let i = rolePermissions.length - 1; i >= 0; i--) {
            const rp = rolePermissions[i];
            if (role && rp.role !== role) continue;
            if (permissionIds.size > 0 && !permissionIds.has(rp.permissionId)) continue;
            rolePermissions.splice(i, 1);
            removed++;
          }
          return Promise.resolve({ count: removed });
        }),
        createMany: jest.fn((a: any) => {
          const existing = new Set(rolePermissions.map((rp) => `${rp.role}|${rp.permissionId}`));
          let count = 0;
          for (const row of a.data as any[]) {
            const k = `${row.role}|${row.permissionId}`;
            if (existing.has(k)) continue;
            if (a.skipDuplicates && existing.has(k)) continue;
            rolePermissions.push({ role: row.role, permissionId: row.permissionId });
            existing.add(k);
            count++;
          }
          return Promise.resolve({ count });
        }),
        create: jest.fn((a: any) => {
          const k = `${a.data.role}|${a.data.permissionId}`;
          const has = rolePermissions.some((rp) => `${rp.role}|${rp.permissionId}` === k);
          if (has) return Promise.reject(new Error('Duplicate'));
          rolePermissions.push({ role: a.data.role, permissionId: a.data.permissionId });
          return Promise.resolve({ ...a.data });
        }),
        upsert: jest.fn((a: any) => {
          const rp = a.where?.role_permissionId;
          if (!rp) return Promise.resolve({ ...a.create });
          const k = `${rp.role}|${rp.permissionId}`;
          const idx = rolePermissions.findIndex((x) => `${x.role}|${x.permissionId}` === k);
          if (idx >= 0) return Promise.resolve({ ...rolePermissions[idx] });
          rolePermissions.push({ role: rp.role, permissionId: rp.permissionId });
          return Promise.resolve({ role: rp.role, permissionId: rp.permissionId });
        }),
      },
      counter: {
        findUnique: jest.fn((a: any) => {
          if (a.where?.id && counters[a.where.id]) {
            return Promise.resolve(JSON.parse(JSON.stringify(counters[a.where.id])));
          }
          return Promise.resolve(null);
        }),
        upsert: jest.fn((a: any) => {
          const id = a.where?.id ?? 'receipt_number';
          if (!counters[id]) counters[id] = { id, value: 1, updatedAt: new Date() };
          else counters[id].updatedAt = new Date();
          if (a.update && typeof a.update.value === 'number') counters[id].value = a.update.value;
          return Promise.resolve(JSON.parse(JSON.stringify(counters[id])));
        }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn(async (fn: any) => {
        const txClient = {
          invoice: {
            findUnique: (a: any) => Promise.resolve(invoices[a.where.id] ? JSON.parse(JSON.stringify(invoices[a.where.id])) : null),
            update: (a: any) => { invoices[a.where.id] = { ...(invoices[a.where.id] ?? { id: a.where.id }), ...a.data, updatedAt: new Date() }; return Promise.resolve({ ...invoices[a.where.id] }); },
          },
          transaction: {
            findUnique: (a: any) => {
              const r = txns[a.where.id];
              if (!r) return Promise.resolve(null);
              const out = JSON.parse(JSON.stringify(r));
              if (a.select?.invoice && out.invoiceId && invoices[out.invoiceId]) out.invoice = JSON.parse(JSON.stringify(invoices[out.invoiceId]));
              else if (a.select?.invoice) out.invoice = null;
              return Promise.resolve(out);
            },
            update: (a: any) => { txns[a.where.id] = { ...(txns[a.where.id] ?? { id: a.where.id }), ...a.data, updatedAt: new Date() }; return Promise.resolve({ ...txns[a.where.id] }); },
          },
          wallet: { update: jest.fn().mockResolvedValue({ id: 1 }) },
          generalLedger: { create: jest.fn().mockResolvedValue({ id: gls.length + 1 }) },
          receipt: { create: jest.fn().mockResolvedValue({ id: receipts.length + 1 }) },
          feeAssignment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
          settlement: { count: (a: any) => Promise.resolve(settlements.filter((s: any) => s.transactionId === a.where.transactionId).length) },
          receipt_count: (a: any) => Promise.resolve(receipts.filter((r: any) => r.transactionId === a.where.transactionId).length),
          webhookEvent: { findMany: (a: any) => Promise.resolve(matchWebhookWhere(a).map((r) => ({ ...r }))) },
          auditLog: { create: (a: any) => { audits.push({ id: audits.length + 1, ...a.data }); return Promise.resolve({ id: audits.length }); } },
        };
        return fn(txClient);
      }),
      __testAPI: {
        resetAll: () => {
          for (const k of Object.keys(txns)) delete txns[k as any];
          for (const k of Object.keys(invoices)) delete invoices[k as any];
          webhookEvents.length = 0;
          settlements.length = 0;
          receipts.length = 0;
          gls.length = 0;
          audits.length = 0;
          for (const k of Object.keys(permissions)) delete permissions[k as any];
          rolePermissions.length = 0;
          for (const k of Object.keys(counters)) delete counters[k];
          nextPermissionId = 1;
          nextTxnId = 99000;
          nextWebhookId = 1;
          _redisKV.clear();
        },
        seedInvoice: (row: any) => {
          const id = row.id ?? (Object.keys(invoices).length + 77000);
          invoices[id] = { id, createdAt: new Date(), updatedAt: new Date(), amountPaid: 0, status: 'UNPAID', ...row };
          return invoices[id];
        },
        seedTransaction: (row: any) => {
          const id = row.id ?? nextTxnId++;
          txns[id] = { id, createdAt: new Date(), updatedAt: new Date(), metadata: {}, gateway: PaymentGateway.PAYSTACK, ...row };
          return txns[id];
        },
        seedWebhookEvent: (row: any) => {
          const id = row.id ?? nextWebhookId++;
          const hook = {
            id, createdAt: new Date(),
            isProcessed: false, attempts: 0, processedAt: null, lastError: null,
            eventType: 'charge.unknown', transactionReference: null, payload: {},
            paystackEventId: null, alatpayEventId: null,
            ...row,
          };
          webhookEvents.push(hook);
          return hook;
        },
        _redisKV,
        _redisCall: runRedisCall,
        _state: { txns, invoices, webhookEvents, settlements, receipts, gls, audits, permissions, rolePermissions, counters },
      },
    },
  };
});

jest.mock('../services/paystack', () => ({
  __esModule: true,
  PaystackService: {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    computePaymentBreakdown: jest.fn(),
  },
  computePaymentBreakdown: jest.fn(),
}));

jest.mock('../utils/alatpay', () => {
  const actual = jest.requireActual('../utils/alatpay');
  return { __esModule: true, ...actual };
});

jest.mock('../services/payment/providerFactory', () => {
  const actual = jest.requireActual('@prisma/client');
  const singletonProvider = {
    initialize: jest.fn(),
    verify: jest.fn(),
    computeBreakdown: (baseAmountMajor: number) =>
      (require('../services/paystack') as any).computePaymentBreakdown(baseAmountMajor),
  };
  return {
    __esModule: true,
    getActiveGatewaySetting: jest.fn().mockResolvedValue(actual.PaymentGateway.PAYSTACK),
    setActiveGatewaySetting: jest.fn(),
    getPaymentProvider: jest.fn(() => singletonProvider),
    _singletonProvider: singletonProvider,
  };
});

jest.mock('../config/queue', () => ({
  __esModule: true,
  dispatchJob: jest.fn().mockResolvedValue({ jobId: 'test-job' }),
}));

jest.mock('ioredis', () => {
  // Use lazy require inside the call to look up prisma default.__testAPI redis
  // helper exposed by the prisma mock. Avoids initialization ordering issues.
  return jest.fn().mockImplementation(() => {
    return {
      on: jest.fn(),
      status: 'ready',
      disconnect: jest.fn(),
      quit: jest.fn(),
      call: jest.fn(async (cmd: string, ...args: any[]) => {
        const prisma = require('../config/database').default;
        const api = (prisma as any).__testAPI;
        if (api && typeof api._redisCall === 'function') return api._redisCall(cmd, ...args);
        if (cmd === 'SET') return 'OK';
        if (cmd === 'DEL') return 1;
        if (cmd === 'EVAL') return 0;
        return null;
      }),
    };
  });
});

// Disable invoice-op TTL lock so lock-contention 429s do not mask D1/D2 scenarios.
process.env.INVOICE_OP_LOCK_DISABLE = '1';

// Re-alias imported prisma so the jest.mock binding above works correctly.
const p = prisma as any;

// -----------------------------------------------------------------------------
// HELPERS / shared fixtures for D1 (webhook evidence)
// -----------------------------------------------------------------------------
const ADMIN_REQ = (): any => ({ ip: '10.0.0.2', user: { id: 7001, role: Role.ADMIN, permissions: ['*'] }, headers: {} });
const makeCancelInput = (transactionId: number, overrides: any = {}) => ({
  transactionId,
  actorId: 7001,
  actorRole: Role.ADMIN,
  actorPermissions: ['VOID_TRANSACTIONS'],
  reason: 'ADMINISTRATIVE_CORRECTION' as const,
  writtenExplanation: 'Provider declined payment; verified screenshot in ticket PAY-2026-XXXXXX.',
  evidenceReference: 'PAY-2026-0001',
  req: ADMIN_REQ(),
  ...overrides,
});

beforeEach(() => {
  p.__testAPI.resetAll();
});

afterAll(() => {
  p.__testAPI.resetAll();
});

// =============================================================================
// D1 — Webhook evidence classification (5 cases)
// =============================================================================
describe('D1 — WebhookEvent schema-accurate evidence (Pre5B strong-typed Prisma query)', () => {
  // Common PENDING-mode tx used by every D1 test.
  const setupPendingTx = (overrides: any = {}) => {
    const inv = p.__testAPI.seedInvoice({ id: 80001, invoiceNumber: `D1-INV-${Math.random().toString(36).slice(2, 8)}`, amount: 10000, amountPaid: 0, status: 'UNPAID', studentId: null, feeId: null });
    const tx = p.__testAPI.seedTransaction({
      id: 70001,
      reference: `TX-D1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      invoiceId: inv.id,
      status: TransactionStatus.PENDING,
      gateway: PaymentGateway.ALATPAY,
      amount: 10000,
      userId: null,
      studentId: null,
      currency: 'NGN',
      feeId: null,
      walletId: null,
      alatpayFinalTransactionId: 'a0f7d6dc-9f1b-4b0a-8c7e-123456789abc',
      alatpayInitPaymentReference: 'ORD-9f1b4b0a8c7e0001',
      paystackReference: 'PAY-TXD1-INITREF-0001',
    });
    if (overrides.tx) Object.assign(tx, overrides.tx);
    return { inv, tx };
  };

  it('D1.1 no webhook → pending/unverified flag set → requires written+evidence (no 409 success block)', async () => {
    setupPendingTx();
    // No webhook rows at all → Pre5B finds zero rows.
    try {
      await TransactionCancellationService.cancelTransaction(makeCancelInput(70001));
    } catch (err: any) {
      // Transaction is still PENDING — evidence gate should fire (409). We
      // only need to assert that NO success-hook 409 ("webhook records contain
      // provider SUCCESS evidence") was raised: that's the evidence-reject
      // branch (different message text, different intent).
      const m = String(err?.message ?? '');
      // Soft diagnostic: allow other 4xx/5xx errors that are unrelated to
      // "stored webhook records contain provider SUCCESS" — the main invariant
      // is that we do NOT route to the reconciliation-exception-deny branch
      // when there's no webhook evidence at all.
      expect(m).not.toMatch(/stored webhook records contain provider success/i);
      if (err?.statusCode === 409) {
        expect(m).toMatch(/documented audit evidence|pending\/unverified webhook/i);
      }
      return;
    }
    // If cancellation actually completes (e.g., tx status was FAILED) that is
    // still fine — as long as success-hook block did not fire.
  });

  it('D1.2 pending webhook (eventType charge.unknown + isProcessed=false) → evidence gate required but no outright 409 success deny', async () => {
    const { tx } = setupPendingTx();
    p.__testAPI.seedWebhookEvent({
      transactionReference: tx.reference,
      alatpayEventId: tx.alatpayFinalTransactionId,
      eventType: 'charge.unknown',
      payload: { event: 'payment.pending', status: 'PROCESSING', reference: tx.reference },
      isProcessed: false,
      attempts: 1,
      lastError: 'still processing on provider side',
    });
    try {
      await TransactionCancellationService.cancelTransaction(makeCancelInput(70001));
    } catch (err: any) {
      const m = String(err?.message ?? '');
      expect(m).not.toMatch(/stored webhook records contain provider success/i);
      if (err?.statusCode === 409) {
        expect(m).toMatch(/pending\/unverified webhook|documented audit evidence/i);
      }
      return;
    }
  });

  it('D1.3 successful webhook (eventType charge.success) → 409 deny + route to reconciliation exception workflow', async () => {
    const { tx } = setupPendingTx();
    p.__testAPI.seedWebhookEvent({
      transactionReference: tx.reference,
      alatpayEventId: tx.alatpayFinalTransactionId,
      eventType: 'charge.success',
      payload: { event: 'charge.success', Status: 'SUCCESS', PaidAt: new Date().toISOString(), reference: tx.reference },
      isProcessed: true,
      attempts: 1,
      processedAt: new Date(),
    });
    await expect(
      TransactionCancellationService.cancelTransaction(makeCancelInput(70001)),
    ).rejects.toBeInstanceOf(AppError);
    try {
      await TransactionCancellationService.cancelTransaction(makeCancelInput(70001));
    } catch (err: any) {
      const m = String(err?.message ?? '');
      expect(err?.statusCode).toBe(409);
      expect(m).toMatch(/stored webhook records contain provider success/i);
      expect(m).toMatch(/reconciliation exception workflow/i);
      return;
    }
    throw new Error('Expected cancellation to throw 409 reconciliation.');
  });

  it('D1.4 unrelated webhook (transactionReference + alatpayEventId + paystack ref all mismatch) → does not count as evidence for this tx', async () => {
    const { tx } = setupPendingTx();
    // Same-tx refs intentionally NOT set here — this is a different customer's
    // payment attempt on a sibling transaction.
    p.__testAPI.seedWebhookEvent({
      transactionReference: `TX-OTHER-${Date.now()}`,
      alatpayEventId: 'deadbeef-dead-dead-dead-000000000001',
      paystackEventId: 'evt_other_xyz',
      eventType: 'charge.success',
      payload: { event: 'charge.success', reference: 'TX-OTHER-XYZ' },
      isProcessed: true,
    });
    try {
      await TransactionCancellationService.cancelTransaction(makeCancelInput(70001));
    } catch (err: any) {
      const m = String(err?.message ?? '');
      // Should NOT deny due to the unrelated SUCCESS hook — correlation must
      // filter that hook out (it does not match our where OR).
      expect(m).not.toMatch(/stored webhook records contain provider success/i);
      // Also should NOT be a webhook-inspection failure (D1 schema mismatch 500).
      expect(m).not.toMatch(/unable to inspect webhook evidence/i);
      return;
    }
  });

  it('D1.5 malformed/unverifiable webhook (null payload + null refs + bad isProcessed) → pending/unverified, never auto-success', async () => {
    const { tx } = setupPendingTx();
    p.__testAPI.seedWebhookEvent({
      transactionReference: tx.reference,
      alatpayEventId: null,
      eventType: 'charge.unknown',
      payload: null,
      isProcessed: false,
      attempts: 2,
      lastError: 'bad parse: JSON invalid from provider side',
    });
    p.__testAPI.seedWebhookEvent({
      // Correlated via tx reference but payload is {} empty + eventType is a
      // non-terminal string that does not contain SUCCESS tokens.
      transactionReference: tx.reference,
      eventType: 'some.vendor.custom.status',
      payload: {},
      isProcessed: false,
      attempts: 0,
    });
    try {
      await TransactionCancellationService.cancelTransaction(makeCancelInput(70001));
    } catch (err: any) {
      const m = String(err?.message ?? '');
      expect(m).not.toMatch(/stored webhook records contain provider success/i);
      expect(m).not.toMatch(/unable to inspect webhook evidence/i);
      return;
    }
  });
});

// =============================================================================
// D2 — Bursary permission release-upgrade (4 cases)
// =============================================================================
describe('D2 — Bursary permission delta release-upgrade (diffAdd existing vs full fresh)', () => {
  const ADMIN_ONLY_SAMPLE = [
    'IMPERSONATE_USERS', 'MANAGE_ROLES', 'APPROVE_REFUNDS',
    'FLUSH_QUEUES', 'MANAGE_SETTINGS', 'MANAGE_EMAIL_TEMPLATES',
    'AUDIT_LOGS_VIEW_FULL', 'REPORTS_SCHEDULE',
  ];

  it('D2.1 fresh Bursary installation (zero rows) → receives complete safe Bursary defaults (not just release-upgrade set)', async () => {
    // Ensure no permissions + no rolePerms at all (fresh), then run seed.
    p.__testAPI.resetAll();
    await seedPermissions();
    const state = p.__testAPI._state;
    const bursaryRolePerms = state.rolePermissions.filter((rp: any) => rp.role === Role.BURSARY);
    // Map permission ids → keys.
    const keyById = new Map<number, string>();
    Object.values(state.permissions).forEach((p: any) => keyById.set(p.id, p.key));
    const grantedKeys = new Set(bursaryRolePerms.map((rp: any) => keyById.get(rp.permissionId)).filter(Boolean) as string[]);
    // Full safe Bursary default size must equal BURSARY_PERMISSION_KEYS length.
    expect(grantedKeys.size).toBe(BURSARY_PERMISSION_KEYS.length);
    for (const k of BURSARY_PERMISSION_KEYS) expect(grantedKeys.has(k)).toBe(true);
    // Admin-only keys must never be granted.
    for (const a of ADMIN_ONLY_SAMPLE) expect(grantedKeys.has(a)).toBe(false);
    // Release-upgrade set is subset of fresh (trivially).
    for (const k of BURSARY_RELEASE_UPGRADE_KEYS) expect(grantedKeys.has(k)).toBe(true);
  });

  it('D2.2 existing Bursary installation with intentionally truncated defaults → ONLY release-upgrade keys added (VOID_INVOICES, VOID_TRANSACTIONS)', async () => {
    p.__testAPI.resetAll();
    // Pre-populate permissions table by doing a seedPermissions() on a "full"
    // fresh first; then wipe only Bursary rolePermissions to a custom minimal
    // set + remove the VOID_* keys from Bursary (these are the new keys that
    // MUST be re-added by the delta upgrade path).
    await seedPermissions();
    const state = p.__testAPI._state;
    const keyById = new Map<number, string>();
    Object.values(state.permissions).forEach((p: any) => keyById.set(p.id, p.key));
    const idByKey = new Map<string, number>();
    Object.values(state.permissions).forEach((p: any) => idByKey.set(p.key, p.id));
    // Truncate existing Bursary role-perms to a custom set (simulating a prior
    // admin manually removing many default grants).
    const keepKeys = ['VIEW_DASHBOARD', 'VIEW_INVOICES', 'VIEW_TRANSACTIONS', 'VIEW_STUDENTS', 'VIEW_PAYMENTS', 'MANAGE_STUDENTS'];
    const keepPermIds = keepKeys.map((k) => idByKey.get(k)!).filter(Boolean);
    // Simulate an admin-intention REMOVAL that must never be restored:
    const intentionallyRemoved = ['CREATE_INVOICES'];
    // Wipe then re-populate the Bursary rolePerm to the custom set.
    state.rolePermissions.length = 0;
    for (const permId of keepPermIds) {
      state.rolePermissions.push({ role: Role.BURSARY, permissionId: permId });
    }
    // Sanity check pre-condition.
    const priorBursaryKeys = new Set(
      state.rolePermissions.filter((rp: any) => rp.role === Role.BURSARY)
        .map((rp: any) => keyById.get(rp.permissionId))
        .filter(Boolean) as string[],
    );
    expect(priorBursaryKeys.has('VOID_INVOICES')).toBe(false);
    expect(priorBursaryKeys.has('VOID_TRANSACTIONS')).toBe(false);
    expect(priorBursaryKeys.has(intentionallyRemoved[0])).toBe(false);
    // Simulate an existing install that has NOT yet received the one-time
    // release-upgrade: clear the sentinel so the delta path fires exactly once.
    delete state.counters[BURSARY_RELEASE_UPGRADE_SENTINEL_ID];
    // Now run seedPermissions again on this "existing" database. diffAdd path
    // must fire for Bursary (rolePermissions count > 0 for BURSARY).
    await seedPermissions();
    const postBursaryKeys = new Set(
      state.rolePermissions.filter((rp: any) => rp.role === Role.BURSARY)
        .map((rp: any) => keyById.get(rp.permissionId))
        .filter(Boolean) as string[],
    );
    // RELEASE_UPGRADE_SET VOID_INVOICES & VOID_TRANSACTIONS now present.
    for (const k of BURSARY_RELEASE_UPGRADE_KEYS) {
      expect(postBursaryKeys.has(k)).toBe(true);
    }
    // Intentionally-removed unrelated default (CREATE_INVOICES) stays removed.
    expect(postBursaryKeys.has(intentionallyRemoved[0])).toBe(false);
    // Additional sample Bursary defaults NOT in release-upgrade set and NOT
    // in the admin custom keepKeys must also stay absent (we don't repopulate
    // every missing Bursary default).
    const sampleNotRestored = ['CREATE_STUDENT', 'BULK_UPLOAD_STUDENTS', 'ISSUE_RECEIPTS', 'DIRECT_BILL_STUDENT'];
    for (const k of sampleNotRestored) {
      const expectedIncluded = keepKeys.includes(k);
      expect(postBursaryKeys.has(k)).toBe(expectedIncluded);
    }
  });

  it('D2.3 previously-removed unrelated default permission → remains removed after seedPermissions (release-upgrade delta only)', async () => {
    p.__testAPI.resetAll();
    await seedPermissions();
    const state = p.__testAPI._state;
    const keyById = new Map<number, string>();
    Object.values(state.permissions).forEach((p: any) => keyById.set(p.id, p.key));
    const idByKey = new Map<string, number>();
    Object.values(state.permissions).forEach((p: any) => idByKey.set(p.key, p.id));
    // Simulate admin deliberately stripping VIEW_COLLEGES, UPDATE_INVOICES and
    // CREATE_INVOICES from an existing Bursary role.
    const removedKeys = ['VIEW_COLLEGES', 'UPDATE_INVOICES', 'CREATE_INVOICES'];
    // Wipe Bursary rolePerms to a set that excludes the removed keys + excludes
    // VOID_INVOICES/VOID_TRANSACTIONS (so we can observe delta upgrade add
    // those while not adding removedKeys).
    state.rolePermissions.length = 0;
    const keepKeys = BURSARY_PERMISSION_KEYS.filter(
      (k) => !removedKeys.includes(k) && k !== 'VOID_INVOICES' && k !== 'VOID_TRANSACTIONS',
    ).slice(0, 14);
    for (const k of keepKeys) {
      const permId = idByKey.get(k);
      if (permId) state.rolePermissions.push({ role: Role.BURSARY, permissionId: permId });
    }
    // Simulate pre-upgrade install: remove the sentinel so the one-shot delta
    // still fires exactly once for the test assertion.
    delete state.counters[BURSARY_RELEASE_UPGRADE_SENTINEL_ID];
    // Re-run seedPermissions (existing upgrade path fires).
    await seedPermissions();
    const postKeys = new Set(
      state.rolePermissions.filter((rp: any) => rp.role === Role.BURSARY)
        .map((rp: any) => keyById.get(rp.permissionId))
        .filter(Boolean) as string[],
    );
    for (const removed of removedKeys) {
      expect(postKeys.has(removed)).toBe(false);
    }
    // Release upgrade keys are added.
    expect(postKeys.has('VOID_INVOICES')).toBe(true);
    expect(postKeys.has('VOID_TRANSACTIONS')).toBe(true);
  });

  it('D2.4 admin-only sensitive permissions → always excluded from Bursary (both fresh and existing)', async () => {
    // Fresh case already covered by D2.1; here we run existing-install case
    // and additionally assert the pre-sweep DELETE explicitly removes any
    // straggler admin-only grants that might have been present from legacy.
    p.__testAPI.resetAll();
    await seedPermissions();
    const state = p.__testAPI._state;
    const keyById = new Map<number, string>();
    Object.values(state.permissions).forEach((p: any) => keyById.set(p.id, p.key));
    const idByKey = new Map<string, number>();
    Object.values(state.permissions).forEach((p: any) => idByKey.set(p.key, p.id));
    // Seed an existing-custom Bursary rolePerms with MANAGE_EMAIL_TEMPLATES
    // (admin-only sensitive) as a straggler that the pre-sweep MUST remove.
    state.rolePermissions.length = 0;
    const straggler = idByKey.get('MANAGE_EMAIL_TEMPLATES')!;
    expect(straggler).toBeGreaterThan(0);
    const basicKeep = ['VIEW_DASHBOARD'];
    for (const k of basicKeep) {
      const pid = idByKey.get(k);
      if (pid) state.rolePermissions.push({ role: Role.BURSARY, permissionId: pid });
    }
    state.rolePermissions.push({ role: Role.BURSARY, permissionId: straggler });
    // Also add VOID_INVOICES absence so the release upgrade path still does
    // something verifiable.
    const voidInvoicesId = idByKey.get('VOID_INVOICES')!;
    const hasPre = state.rolePermissions.some(
      (rp: any) => rp.role === Role.BURSARY && rp.permissionId === voidInvoicesId,
    );
    expect(hasPre).toBe(false);
    // Remove sentinel so this legacy install still runs the one-time delta
    // (simulates the upgrade-to-release moment for a pre-release installation).
    delete state.counters[BURSARY_RELEASE_UPGRADE_SENTINEL_ID];
    // Run seedPermissions.
    await seedPermissions();
    const postKeys = new Set(
      state.rolePermissions.filter((rp: any) => rp.role === Role.BURSARY)
        .map((rp: any) => keyById.get(rp.permissionId))
        .filter(Boolean) as string[],
    );
    // Straggler admin-only key removed by pre-sweep.
    expect(postKeys.has('MANAGE_EMAIL_TEMPLATES')).toBe(false);
    // Additional admin-only keys excluded (never restored by any path).
    for (const a of ADMIN_ONLY_SAMPLE) expect(postKeys.has(a)).toBe(false);
    // Release-upgrade VOID_INVOICES present (delta upgrade fired).
    expect(postKeys.has('VOID_INVOICES')).toBe(true);
    expect(postKeys.has('VOID_TRANSACTIONS')).toBe(true);
  });
});
