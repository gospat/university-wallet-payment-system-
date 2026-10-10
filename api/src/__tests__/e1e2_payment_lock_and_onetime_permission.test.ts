// =============================================================================
// E1 — Payment amount recalculation + pending recheck UNDER database lock
// E2 — One-time Bursary release-upgrade (sentinel Counter row)
// =============================================================================

import { PaymentService, _testResetInitiateLocks } from '../services/payment';
import {
  BURSARY_PERMISSION_KEYS,
  BURSARY_RELEASE_UPGRADE_KEYS,
  BURSARY_RELEASE_UPGRADE_SENTINEL_ID,
  seedPermissions,
} from '../services/permissionSeed';
import prisma from '../config/database';
import { Role, TransactionStatus, PaymentGateway, InvoiceStatus } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { _testResetInvoiceLocks } from '../utils/invoiceLock';
import { Decimal } from '@prisma/client/runtime/library';

const TEST_STUDENT = { id: 6101, email: 'e1e2-student@x.test', role: 'STUDENT', firstName: 'A', lastName: 'B' };
const STUDENT_USER_ID = 6101;

jest.mock('../config/database', () => {
  const PrismaClient: any = jest.requireActual('@prisma/client');
  const users: Record<number, any> = {};
  users[6101] = {
    id: 6101, email: 'e1e2-student@x.test', role: 'STUDENT',
    firstName: 'A', lastName: 'B',
    accountStatus: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null,
    lastLoginAt: null, mustChangePassword: false, middleName: null,
    phoneNumber: null, address: null, createdAt: new Date(), updatedAt: new Date(),
  };

  const txns: Record<number, any> = {};
  const invoices: Record<number, any> = {};
  const permissions: Record<string, { id: number; key: string; name: string; category: string; description: string | null }> = {};
  let nextPermissionId = 1;
  const rolePermissions: { role: string; permissionId: number }[] = [];
  const counters: Record<string, { id: string; value: number; updatedAt: Date }> = {};
  const audits: any[] = [];
  let nextTxnId = 700000;

  const _redisKV = new Map<string, string>();
  const runRedisCall = async (cmd: string, ...args: any[]): Promise<any> => {
    if (cmd === 'SET') {
      const key = String(args[0]);
      const val = String(args[1]);
      const nxIdx = args.findIndex((x) => typeof x === 'string' && x.toUpperCase() === 'NX');
      if (nxIdx >= 0 && _redisKV.has(key)) return Promise.resolve(null);
      _redisKV.set(key, val);
      return Promise.resolve('OK');
    }
    if (cmd === 'GET') return Promise.resolve(_redisKV.get(String(args[0])) ?? null);
    if (cmd === 'DEL') { const k = String(args[0]); const had = _redisKV.has(k); if (had) _redisKV.delete(k); return Promise.resolve(had ? 1 : 0); }
    if (cmd === 'EVAL' || cmd === 'EVALSHA') {
      const numKeys = Number(args[1]) | 0;
      const keys = args.slice(2, 2 + numKeys).map(String);
      const argv = args.slice(2 + numKeys).map(String);
      const k = keys[0]; const expected = argv[0];
      if (_redisKV.has(k) && _redisKV.get(k) === expected) { _redisKV.delete(k); return Promise.resolve(1); }
      return Promise.resolve(0);
    }
    return Promise.resolve(null);
  };

  const findInvoice = (where: any) => {
    if (!where?.id) return null;
    const r = invoices[where.id];
    if (!r) return null;
    if (where.studentId && r.studentId !== where.studentId) return null;
    return JSON.parse(JSON.stringify(r));
  };

  const filterTxForWhere = (where: any) => Object.values(txns).filter((t: any) =>
    (!where?.invoiceId || t.invoiceId === where.invoiceId)
    && (!where?.userId || t.userId === where.userId)
    && (!where?.status || t.status === where.status));

  const buildTxClient = () => ({
    invoice: {
      findUnique: (a: any) => Promise.resolve(findInvoice(a.where)),
      update: (a: any) => {
        invoices[a.where.id] = { ...(invoices[a.where.id] ?? { id: a.where.id }), ...a.data, updatedAt: new Date() };
        return Promise.resolve({ ...invoices[a.where.id] });
      },
    },
    transaction: {
      findFirst: (a: any) => {
        const list = filterTxForWhere(a.where);
        if (a.orderBy?.createdAt === 'desc') list.sort((x: any, y: any) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
        return Promise.resolve(list[0] ? JSON.parse(JSON.stringify(list[0])) : null);
      },
      count: (a: any) => Promise.resolve(filterTxForWhere(a.where).length),
      create: (a: any) => {
        const id = nextTxnId++;
        txns[id] = { id, createdAt: new Date(), updatedAt: new Date(), metadata: {}, ...a.data };
        return Promise.resolve({ ...txns[id] });
      },
      update: (a: any) => {
        txns[a.where.id] = { ...(txns[a.where.id] ?? { id: a.where.id }), ...a.data, updatedAt: new Date() };
        return Promise.resolve({ ...txns[a.where.id] });
      },
      findUnique: (a: any) => Promise.resolve(txns[a.where.id] ? JSON.parse(JSON.stringify(txns[a.where.id])) : null),
    },
    counter: {
      findUnique: (a: any) => Promise.resolve(counters[a.where.id] ? { ...counters[a.where.id] } : null),
      upsert: (a: any) => {
        const id = String(a.where.id);
        const existing = counters[id];
        if (existing) { Object.assign(existing, a.update ?? {}, { updatedAt: new Date() }); return Promise.resolve({ ...existing }); }
        const row = { id, value: a.create.value ?? 1, updatedAt: new Date() };
        counters[id] = row; return Promise.resolve({ ...row });
      },
    },
    auditLog: { create: (a: any) => { audits.push({ id: audits.length + 1, ...a.data }); return Promise.resolve({ id: audits.length }); } },
    permission: {
      findMany: (a: any) => {
        const list = Object.values(permissions);
        if (a.where?.key?.in) { const s = new Set(a.where.key.in); return Promise.resolve(list.filter((p) => s.has(p.key))); }
        return Promise.resolve(list);
      },
    },
    rolePermission: {
      findMany: (a: any) => Promise.resolve(rolePermissions.filter((rp) => !a.where?.role || rp.role === a.where.role).map((r) => ({ ...r }))),
    },
  });

  return {
    __esModule: true,
    Prisma: PrismaClient.Prisma,
    default: {
      user: {
        findFirst: jest.fn((a: any) => Promise.resolve(users[a.where.id] ?? null)),
        findUnique: jest.fn((a: any) => Promise.resolve(users[a.where.id] ?? null)),
      },
      invoice: {
        findFirst: jest.fn((a: any) => Promise.resolve(findInvoice(a.where))),
        findUnique: jest.fn((a: any) => Promise.resolve(findInvoice(a.where))),
      },
      transaction: {
        findFirst: jest.fn((a: any) => {
          const list = filterTxForWhere(a.where);
          if (a.orderBy?.createdAt === 'desc') list.sort((x: any, y: any) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
          return Promise.resolve(list[0] ? JSON.parse(JSON.stringify(list[0])) : null);
        }),
        count: jest.fn((a: any) => Promise.resolve(filterTxForWhere(a.where).length)),
        create: jest.fn((a: any) => {
          const id = nextTxnId++;
          txns[id] = { id, createdAt: new Date(), updatedAt: new Date(), metadata: {}, ...a.data };
          return Promise.resolve({ ...txns[id] });
        }),
        update: jest.fn((a: any) => {
          txns[a.where.id] = { ...(txns[a.where.id] ?? { id: a.where.id }), ...a.data, updatedAt: new Date() };
          return Promise.resolve({ ...txns[a.where.id] });
        }),
        findUnique: jest.fn((a: any) => Promise.resolve(txns[a.where.id] ? JSON.parse(JSON.stringify(txns[a.where.id])) : null)),
      },
      permission: {
        findMany: jest.fn((a: any) => {
          const list = Object.values(permissions);
          if (a.where?.key?.in) { const s = new Set(a.where.key.in); return Promise.resolve(list.filter((p) => s.has(p.key))); }
          return Promise.resolve(list);
        }),
        upsert: jest.fn((a: any) => {
          const key = String(a.where.key);
          const existing = permissions[key];
          if (existing) { Object.assign(existing, a.update ?? {}); return Promise.resolve({ ...existing }); }
          const id = nextPermissionId++;
          const row = { id, key, name: a.create.name, category: a.create.category, description: a.create.description ?? null };
          permissions[key] = row; return Promise.resolve({ ...row });
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
          return Promise.resolve(Object.entries(by).map(([role, count]) => ({ role, _count: { role: count } })));
        }),
        deleteMany: jest.fn((a: any) => {
          const permissionIds = new Set<number>(a.where?.permissionId?.in ?? []);
          const role = a.where?.role;
          let removed = 0;
          for (let i = rolePermissions.length - 1; i >= 0; i--) {
            const rp = rolePermissions[i];
            if (role && rp.role !== role) continue;
            if (permissionIds.size > 0 && !permissionIds.has(rp.permissionId)) continue;
            rolePermissions.splice(i, 1); removed++;
          }
          return Promise.resolve({ count: removed });
        }),
        createMany: jest.fn((a: any) => {
          const existing = new Set(rolePermissions.map((rp) => `${rp.role}|${rp.permissionId}`));
          let count = 0;
          for (const row of a.data as any[]) {
            const k = `${row.role}|${row.permissionId}`;
            if (existing.has(k)) continue;
            rolePermissions.push({ role: row.role, permissionId: row.permissionId });
            existing.add(k); count++;
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
        findUnique: jest.fn((a: any) => Promise.resolve(counters[a.where.id] ? { ...counters[a.where.id] } : null)),
        upsert: jest.fn((a: any) => {
          const id = String(a.where.id);
          const existing = counters[id];
          if (existing) { Object.assign(existing, a.update ?? {}, { updatedAt: new Date() }); return Promise.resolve({ ...existing }); }
          const row = { id, value: a.create.value ?? 1, updatedAt: new Date() };
          counters[id] = row; return Promise.resolve({ ...row });
        }),
      },
      auditLog: { create: jest.fn((a: any) => { audits.push({ id: audits.length + 1, ...a.data }); return Promise.resolve({ id: audits.length }); }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn(async (fn: any) => fn(buildTxClient())),
      __testAPI: {
        resetAll: () => {
          for (const k of Object.keys(txns)) delete txns[k as any];
          for (const k of Object.keys(invoices)) delete invoices[k as any];
          for (const k of Object.keys(permissions)) delete permissions[k as any];
          rolePermissions.length = 0;
          for (const k of Object.keys(counters)) delete counters[k as any];
          audits.length = 0;
          nextPermissionId = 1;
          nextTxnId = 700000;
          _redisKV.clear();
        },
        seedInvoice: (row: any) => {
          const id = row.id ?? (Object.keys(invoices).length + 82000);
          invoices[id] = { id, createdAt: new Date(), updatedAt: new Date(), amountPaid: new Decimal(0), status: 'UNPAID', ...row };
          return invoices[id];
        },
        seedTransaction: (row: any) => {
          const id = row.id ?? nextTxnId++;
          txns[id] = { id, createdAt: new Date(), updatedAt: new Date(), metadata: {}, gateway: 'PAYSTACK', ...row };
          return txns[id];
        },
        getInvoice: (id: number) => invoices[id] ?? null,
        getTx: (id: number) => txns[id] ?? null,
        permIdByKey: (key: string) => permissions[key]?.id ?? -1,
        bursaryPermKeys: () => {
          const keySet = new Set<number>();
          for (const rp of rolePermissions) if (rp.role === Role.BURSARY) keySet.add(rp.permissionId);
          const out = new Set<string>();
          for (const [k, p] of Object.entries(permissions)) if (keySet.has(p.id)) out.add(k);
          return out;
        },
        hasSentinel: () => !!counters[BURSARY_RELEASE_UPGRADE_SENTINEL_ID],
        _redisKV,
        _redisCall: runRedisCall,
        _state: { txns, invoices, permissions, rolePermissions, counters, audits },
      },
    },
  };
});

jest.mock('../services/paystack', () => ({
  __esModule: true,
  computePaymentBreakdown: jest.fn(),
}));

jest.mock('../utils/alatpay', () => {
  const actual = jest.requireActual('../utils/alatpay');
  return { __esModule: true, ...actual };
});

jest.mock('../services/payment/providerFactory', () => ({
  __esModule: true,
  getActiveGatewaySetting: jest.fn().mockResolvedValue('PAYSTACK'),
  setActiveGatewaySetting: jest.fn(),
  getPaymentProvider: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue({
      providerReference: 'provider-ref-e1e2',
      access_code: 'access-e1e2',
      authorization_url: 'https://example.com/co/e1e2',
      checkoutUrl: 'https://example.com/co/e1e2',
      channelsUsed: ['card'],
    }),
    verify: jest.fn(),
  })),
}));

jest.mock('../config/queue', () => ({ __esModule: true, dispatchJob: jest.fn().mockResolvedValue({ jobId: 'e1e2-job' }) }));
jest.mock('../queues/emailQueue', () => ({ __esModule: true, dispatchEmail: jest.fn().mockResolvedValue(undefined) }));

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  on: jest.fn(), status: 'ready', disconnect: jest.fn(), quit: jest.fn(),
  call: jest.fn(async (cmd: string, ...args: any[]) => (require('../config/database') as any).default.__testAPI._redisCall(cmd, ...args)),
})));

const testAPI = () => (prisma as any).__testAPI;
const computePaymentBreakdown: jest.Mock = (require('../services/paystack') as any).computePaymentBreakdown;

beforeEach(() => {
  process.env.INVOICE_OP_LOCK_DISABLE = '1';
  testAPI().resetAll();
  _testResetInvoiceLocks();
  _testResetInitiateLocks();
});

function makeDefaultBreakdown() {
  computePaymentBreakdown.mockImplementation((base: number) => ({
    baseAmount: base,
    serviceCharge: Math.round(base * 0.015),
    gatewayFee: 0,
    totalAmount: base + Math.round(base * 0.015),
    serviceChargeMode: 'percentage',
    gatewayFeeMode: 'flat',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// E1
// ─────────────────────────────────────────────────────────────────────────────
describe('E1 Recalculate payment amounts + pending recheck UNDER database lock', () => {
  it('E1.1 Concurrent partial SUCCESS between pre-lock read → lock → re-read throws 409 (authoritative re-read rejects using stale balance)', async () => {
    makeDefaultBreakdown();
    const inv = testAPI().seedInvoice({
      id: 82101, studentId: TEST_STUDENT.id, invoiceNumber: 'INV-E1-01',
      amountDue: new Decimal(100_000), amountPaid: new Decimal(0),
      status: InvoiceStatus.UNPAID, feeId: 1, session: '2025/26', semester: 'Harmattan',
      fee: { id: 1, name: 'Tuition', feeCode: 'TUI', categoryId: 10 },
    });
    // Install an interceptor using wrapped $transaction: inside the locked txn,
    // BEFORE the findUnique lookup completes we simulate a concurrent verifyPayment
    // that wrote amountPaid = 100_000 and status PAID into the in-memory invoices map.
    const original$transaction = (prisma as any).$transaction;
    let toggled = false;
    (prisma as any).$transaction = jest.fn(async (fn: any) => original$transaction(async (txClient: any) => {
      const origFindUnique = txClient.invoice.findUnique;
      txClient.invoice.findUnique = async (a: any) => {
        const res = await origFindUnique(a);
        if (!toggled && a?.where?.id === 82101 && res) {
          toggled = true;
          const row = testAPI().getInvoice(82101);
          row.amountPaid = new Decimal(100_000);
          row.status = InvoiceStatus.PAID;
          return origFindUnique(a);
        }
        return res;
      };
      return fn(txClient);
    }));

    await expect(
      PaymentService.initiatePayment(TEST_STUDENT.id, { invoiceId: 82101 }, { ip: '127.0.0.1', headers: {} } as any),
    ).rejects.toBeInstanceOf(AppError);
    try {
      await PaymentService.initiatePayment(TEST_STUDENT.id, { invoiceId: 82101 }, { ip: '127.0.0.1', headers: {} } as any);
      fail('Expected AppError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(409);
      expect(String(err.message)).toMatch(/paid/i);
    }
  });

  it('E1.2 Breakdown is recomputed from locked balance — provider uses authoritative baseAmount, metadata/tx.expectedAmount match', async () => {
    const capturedBases: number[] = [];
    computePaymentBreakdown.mockImplementation((base: number) => {
      capturedBases.push(base);
      const service = Math.round(base * 0.015);
      return { baseAmount: base, serviceCharge: service, gatewayFee: 0, totalAmount: base + service, serviceChargeMode: 'percentage', gatewayFeeMode: 'flat' };
    });
    testAPI().seedInvoice({
      id: 82102, studentId: TEST_STUDENT.id, invoiceNumber: 'INV-E1-02',
      amountDue: new Decimal(150_000), amountPaid: new Decimal(0),
      status: InvoiceStatus.UNPAID, feeId: 2, session: '2025/26', semester: 'Rain',
      fee: { id: 2, name: 'Hostel', feeCode: 'HOS', categoryId: 11 },
    });
    const res = await PaymentService.initiatePayment(
      TEST_STUDENT.id, { invoiceId: 82102, partialAmount: 75_000 }, { ip: '10.0.0.2', headers: {} } as any,
    );
    expect(res.payment_reference).toBeTruthy();
    expect(capturedBases.length).toBeGreaterThanOrEqual(1);
    expect(capturedBases[capturedBases.length - 1]).toBe(75_000);
    expect(res.expected_amount).toBe(75_000 + Math.round(75_000 * 0.015));
    expect(res.fee_breakdown.baseAmount).toBe(75_000);
    const tx = Object.values<any>(testAPI()._state.txns).find((t: any) => t.reference === res.payment_reference);
    expect(tx).toBeTruthy();
    expect(tx!.expectedAmount).toBe(res.expected_amount);
    expect((tx!.metadata as any).amount.base).toBe(75_000);
  });

  it('E1.3 Pending recheck inside $transaction catches a freshly created PENDING row not visible pre-lock (425)', async () => {
    makeDefaultBreakdown();
    testAPI().seedInvoice({
      id: 82103, studentId: TEST_STUDENT.id, invoiceNumber: 'INV-E1-03',
      amountDue: new Decimal(40_000), amountPaid: new Decimal(0),
      status: InvoiceStatus.UNPAID, feeId: 3,
    });
    const original$transaction = (prisma as any).$transaction;
    let injected = false;
    (prisma as any).$transaction = jest.fn(async (fn: any) => original$transaction(async (txClient: any) => {
      const origCount = txClient.transaction.count;
      const origFindFirst = txClient.transaction.findFirst;
      txClient.transaction.count = async (a: any) => {
        if (!injected && a?.where?.invoiceId === 82103 && a.where.status === TransactionStatus.PENDING) return Promise.resolve(1);
        return origCount(a);
      };
      txClient.transaction.findFirst = async (a: any) => {
        if (!injected && a?.where?.invoiceId === 82103 && a.where.status === TransactionStatus.PENDING) {
          injected = true;
          return Promise.resolve({
            id: 999999, createdAt: new Date(Date.now() - 30_000), status: TransactionStatus.PENDING,
            gateway: PaymentGateway.PAYSTACK, alatpayFinalTransactionId: null,
          });
        }
        return origFindFirst(a);
      };
      return fn(txClient);
    }));

    try {
      await PaymentService.initiatePayment(TEST_STUDENT.id, { invoiceId: 82103 }, { ip: '10.0.0.3', headers: {} } as any);
      fail('Expected AppError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(AppError);
      expect([425, 409]).toContain(err.statusCode);
      expect(String(err.message)).toMatch(/in progress|awaiting confirmation|already/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2
// ─────────────────────────────────────────────────────────────────────────────
describe('E2 One-time Bursary release-upgrade via sentinel Counter row', () => {

  it('E2.1 Initial upgrade (existing Bursary keep-set only) adds VOID_INVOICES/VOID_TRANSACTIONS and writes sentinel ONCE', async () => {
    await seedExistingBursaryKeepSet(new Set(['VIEW_COLLEGES', 'VIEW_INVOICES', 'VIEW_TRANSACTIONS']));
    expect(testAPI().hasSentinel()).toBe(false);

    await seedPermissions();

    const keys = testAPI().bursaryPermKeys();
    expect(keys.has('VOID_INVOICES')).toBe(true);
    expect(keys.has('VOID_TRANSACTIONS')).toBe(true);
    expect(testAPI().hasSentinel()).toBe(true);
    // Non-release-upgrade defaults are NOT restored (custom removal preserved).
    expect(keys.has('CREATE_INVOICE')).toBe(false);
    expect(keys.has('CREATE_STUDENTS')).toBe(false);
  });

  it('E2.2 Repeated startup (sentinel exists) — admin removal of VOID_INVOICES is preserved; unrelated VOID_TRANSACTIONS kept', async () => {
    await seedExistingBursaryKeepSet(new Set(['VIEW_COLLEGES', 'VIEW_INVOICES', 'VIEW_TRANSACTIONS']));
    await seedPermissions();
    expect(testAPI().bursaryPermKeys().has('VOID_INVOICES')).toBe(true);
    // Admin removes VOID_INVOICES and VIEW_TRANSACTIONS (unrelated default):
    removeBursaryPermission('VOID_INVOICES');
    removeBursaryPermission('VIEW_TRANSACTIONS');

    // Restart.
    await seedPermissions();

    const keys = testAPI().bursaryPermKeys();
    expect(keys.has('VOID_INVOICES')).toBe(false);
    expect(keys.has('VIEW_TRANSACTIONS')).toBe(false);
    expect(keys.has('VOID_TRANSACTIONS')).toBe(true);
    expect(testAPI().hasSentinel()).toBe(true);
  });

  it('E2.3 Fresh install grants all safe defaults + sentinel; subsequent admin removal of VOID_INVOICES survives reboot', async () => {
    expect(testAPI().bursaryPermKeys().size).toBe(0);
    expect(testAPI().hasSentinel()).toBe(false);
    await seedPermissions();
    const keys1 = testAPI().bursaryPermKeys();
    for (const k of BURSARY_PERMISSION_KEYS) expect(keys1.has(k)).toBe(true);
    expect(keys1.has('VOID_INVOICES')).toBe(true);
    expect(keys1.has('VOID_TRANSACTIONS')).toBe(true);
    expect(testAPI().hasSentinel()).toBe(true);

    removeBursaryPermission('VOID_INVOICES');
    await seedPermissions();

    const keys2 = testAPI().bursaryPermKeys();
    expect(keys2.has('VOID_INVOICES')).toBe(false);
    expect(keys2.has('VOID_TRANSACTIONS')).toBe(true);
    expect(keys2.has('VIEW_INVOICES')).toBe(true);
  });
});

// Helpers ---------------------------------------------------------------------
async function seedExistingBursaryKeepSet(keepKeys: Set<string>) {
  // First run seedPermissions (fresh): creates perm rows + Bursary full safe defaults
  await seedPermissions();
  // Remove all Bursary perms NOT in keepKeys to simulate pre-upgrade admin custom role:
  const current: Set<string> = testAPI().bursaryPermKeys();
  for (const k of Array.from<string>(current)) if (!keepKeys.has(k)) removeBursaryPermission(k);
  // Remove sentinel (so "pre-upgrade" state)
  delete testAPI()._state.counters[BURSARY_RELEASE_UPGRADE_SENTINEL_ID];
}

function removeBursaryPermission(key: string) {
  const t: any = testAPI();
  const permId: number = t.permIdByKey(key);
  if (permId < 0) return;
  const rps: any[] = t._state.rolePermissions;
  for (let i = rps.length - 1; i >= 0; i--) {
    if (rps[i].role === Role.BURSARY && rps[i].permissionId === permId) rps.splice(i, 1);
  }
}
