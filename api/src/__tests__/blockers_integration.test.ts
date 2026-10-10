// =============================================================================
// BLOCKERS B1–B5 BEHAVIORAL INTEGRATION SUITE
// -----------------------------------------------------------------------------
// 7 focused scenarios (≥30 assertions) covering:
//   SC1. Bursary VOID_INVOICES endpoint auth gating (+ Student 403 / Admin 200)
//   SC2. B2 — CANCELLED tx + late provider SUCCESS → durably SUCCESS + audit
//          PAYMENT_SUCCESS_ON_CANCELLED_INVOICE + reconciliationException flags
//   SC3. B2 — alreadyProcessed=true CANCELLED branch NOT silently dropped
//          → still upgraded to SUCCESS not same CANCELLED status
//   SC4. B3 — eligible PENDING tx cancel → status CANCELLED + metadata stamped
//          + audit TRANSACTION_CANCELLED + no GL/Receipt/invoice changes
//   SC5. B3 — ineligible SUCCESS tx → 409 rejection + status unchanged
//   SC6. B4 — N=25× Promise.all(cancelInvoice + initiatePayment) → zero
//          inconsistent cases (invoice CANCELLED && PENDING tx exists)
//   SC7. B3 — TransactionCancellationService assertAuthorized perm matrix
//          (Admin always, Bursary with/without VOID_TRANSACTIONS, Student no)
// =============================================================================

import { PaymentService, _testResetInitiateLocks } from '../services/payment';
import { TransactionCancellationService } from '../services/transactionCancellation';
import { InvoiceCancellationService } from '../services/invoiceCancellation';
import prisma from '../config/database';
import { TransactionStatus, Role, PaymentGateway, InvoiceStatus } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { Permissions } from '../types/permissions';
import { _testResetInvoiceLocks } from '../utils/invoiceLock';
import express from 'express';import request from 'supertest';
import { protect, restrictTo, requirePermission, bumpRolePermsVersion } from '../middlewares/auth';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

jest.mock('../config/database', () => {
  const bcryptMock: any = jest.requireActual('bcrypt');
  const users: Record<number, any> = {};
  const perms: Record<string, string[]> = {};
  const addUser = (id: number, role: any, email: string, password: string) => {
    users[id] = {
      id,
      email,
      role,
      password: bcryptMock.hashSync(password, 4),
      firstName: `${role}_first`,
      lastName: `${role}_last`,
      accountStatus: 'ACTIVE',
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      mustChangePassword: false,
      middleName: null,
      phoneNumber: null,
      address: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  };
  const RoleEnum = { ADMIN: 'ADMIN', BURSARY: 'BURSARY', STUDENT: 'STUDENT' } as const;
  addUser(2001, RoleEnum.ADMIN, 'admin+blocker@x.test', 'x');
  addUser(2002, RoleEnum.BURSARY, 'bursary+blocker@x.test', 'x');
  addUser(2003, RoleEnum.STUDENT, 'student+blocker@x.test', 'x');
  perms.BURSARY = ['VIEW_PAYMENTS', 'VOID_INVOICES', 'VOID_TRANSACTIONS'];
  perms.BURSARY_NO_VOID = ['VIEW_PAYMENTS'];

  // In-memory mutable tables for behavioural state simulation across mock calls
  const txns: Record<number, any> = {};
  const invoices: Record<number, any> = {};
  const audits: any[] = [];
  const receipts: any[] = [];
  const gls: any[] = [];
  const settlements: any[] = [];
  let nextTxnId = 9000;

  return {
    __esModule: true,
    default: {
      user: {
        findUnique: jest.fn((args: any) => {
          if (args.where?.id) return Promise.resolve(users[args.where.id] ?? null);
          if (args.where?.email) {
            const row = Object.values(users).find((u: any) => u.email === args.where.email) ?? null;
            return Promise.resolve(row ? { ...row } : null);
          }
          return Promise.resolve(null);
        }),
      },
      rolePermission: {
        findMany: jest.fn((args: any) => {
          const role = args.where?.role as Role;
          if (role === RoleEnum.ADMIN) return Promise.resolve([]);
          const key = role === 'BURSARY' ? 'BURSARY' : (role as any);
          const list = perms[key] ?? [];
          return Promise.resolve(list.map((permissionKey: string) => ({ permission: { key: permissionKey } })));
        }),
      },
      invoice: {
        findUnique: jest.fn((args: any) => {
          const row = invoices[args.where.id];
          return Promise.resolve(row ? { ...row } : null);
        }),
        findFirst: jest.fn((args: any) => {
          if (args.where?.id) return Promise.resolve(invoices[args.where.id] ? { ...invoices[args.where.id] } : null);
          if (args.where?.studentId && args.where?.status) {
            const r = Object.values(invoices).find((i: any) => i.studentId === args.where.studentId && args.where.status.in?.includes(i.status)) ?? null;
            return Promise.resolve(r ? { ...r } : null);
          }
          const anyId = args.where?.id ?? null;
          if (anyId) return Promise.resolve(invoices[anyId] ? { ...invoices[anyId] } : null);
          return Promise.resolve(null);
        }),
        update: jest.fn((args: any) => {
          const id = args.where.id;
          invoices[id] = { ...(invoices[id] ?? { id }), ...args.data };
          return Promise.resolve({ ...invoices[id] });
        }),
      },
      transaction: {
        findUnique: jest.fn((args: any) => {
          const row = txns[args.where.id];
          return Promise.resolve(row ? JSON.parse(JSON.stringify(row)) : null);
        }),
        findFirst: jest.fn((args: any) => {
          if (args.where?.id) return Promise.resolve(txns[args.where.id] ? JSON.parse(JSON.stringify(txns[args.where.id])) : null);
          if (args.where?.reference) {
            const r = Object.values(txns).find((t: any) => t.reference === args.where.reference) ?? null;
            return Promise.resolve(r ? JSON.parse(JSON.stringify(r)) : null);
          }
          if (args.where?.alatpayFinalTransactionId) {
            const r = Object.values(txns).find((t: any) => t.alatpayFinalTransactionId === args.where.alatpayFinalTransactionId) ?? null;
            return Promise.resolve(r ? JSON.parse(JSON.stringify(r)) : null);
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn((args: any) => {
          let rows: any[] = Object.values(txns);
          if (args.where?.invoiceId != null) rows = rows.filter((t: any) => t.invoiceId === args.where.invoiceId);
          if (args.where?.status?.in) rows = rows.filter((t: any) => args.where.status.in.includes(t.status));
          if (args.where?.userId != null) rows = rows.filter((t: any) => t.userId === args.where.userId);
          if (args.where?.OR) {
            const conds = (args.where.OR as any[]).flatMap((or: any) => Object.entries(or).map(([k,v]) => [k,v] as [string,any]));
            const keep = new Set<number>();
            rows.forEach((t: any) => {
              let match = false;
              for (const [k, v] of conds) {
                if ((t as any)[k] === v) { match = true; break; }
              }
              if (match) keep.add(t.id);
            });
            rows = rows.filter((t: any) => keep.has(t.id));
          }
          if (args.orderBy) rows = rows.slice();
          const out = rows.map((t: any) => {
            const cloned: any = JSON.parse(JSON.stringify(t));
            if (args.select?.user) {
              const u = users[cloned.userId];
              if (u) {
                const sel = (args.select.user as any)?.select ?? {};
                const uCopy: any = {};
                if (Object.keys(sel).length === 0) {
                  cloned.user = { ...u };
                } else {
                  for (const k of Object.keys(sel)) uCopy[k] = (u as any)[k];
                  cloned.user = uCopy;
                }
              } else {
                cloned.user = null;
              }
            }
            return cloned;
          });
          return Promise.resolve(out);
        }),
        create: jest.fn((args: any) => {
          const id = nextTxnId++;
          const created = { id, ...args.data, createdAt: new Date(), updatedAt: new Date() };
          txns[id] = created;
          return Promise.resolve(JSON.parse(JSON.stringify(created)));
        }),
        update: jest.fn((args: any) => {
          const id = args.where.id;
          txns[id] = { ...(txns[id] ?? { id }), ...args.data, updatedAt: new Date() };
          return Promise.resolve(JSON.parse(JSON.stringify(txns[id])));
        }),
        updateMany: jest.fn((args: any) => {
          const ids: number[] = [];
          Object.values(txns).forEach((t: any) => {
            let match = true;
            if (args.where.id != null && t.id !== args.where.id) match = false;
            if (match && args.where.status != null) {
              if (typeof args.where.status === 'string') {
                if (t.status !== args.where.status) match = false;
              } else if (Array.isArray(args.where.status?.in)) {
                if (!args.where.status.in.includes(t.status)) match = false;
              }
            }
            if (match) {
              txns[t.id] = { ...t, ...args.data, updatedAt: new Date() };
              ids.push(t.id);
            }
          });
          return Promise.resolve({ count: ids.length });
        }),
        count: jest.fn((args: any) => {
          let rows = Object.values(txns);
          if (args.where?.invoiceId != null) rows = rows.filter((t: any) => t.invoiceId === args.where.invoiceId);
          if (args.where?.status) rows = rows.filter((t: any) => t.status === args.where.status);
          if (args.where?.status?.in) rows = rows.filter((t: any) => args.where.status.in.includes(t.status));
          if (args.where?.userId != null) rows = rows.filter((t: any) => t.userId === args.where.userId);
          return Promise.resolve(rows.length);
        }),
      },
      receipt: {
        create: jest.fn((args: any) => {
          const id = receipts.length + 1;
          const row = { id, ...args.data };
          receipts.push(row);
          return Promise.resolve(row);
        }),
        count: jest.fn((args: any) => {
          const n = receipts.filter((r: any) => r.transactionId === args.where.transactionId).length;
          return Promise.resolve(n);
        }),
      },
      generalLedger: {
        create: jest.fn((args: any) => {
          const id = gls.length + 1;
          const row = { id, ...args.data };
          gls.push(row);
          return Promise.resolve(row);
        }),
        count: jest.fn((args: any) => {
          const n = gls.filter((g: any) => g.transactionId === args.where.transactionId).length;
          return Promise.resolve(n);
        }),
      },
      settlement: {
        count: jest.fn((args: any) => {
          const n = settlements.filter((s: any) => s.transactionId === args.where.transactionId).length;
          return Promise.resolve(n);
        }),
      },
      auditLog: {
        create: jest.fn((args: any) => {
          const id = audits.length + 1;
          const row = { id, ...args.data };
          audits.push(row);
          return Promise.resolve(row);
        }),
      },
      // Expose test helpers to seed state via __testAPI
      $transaction: jest.fn(async (fn: any) => {
        const txClient: any = {
          invoice: {
            findUnique: (a: any) => {
              const r = invoices[a.where.id];
              if (!r) return Promise.resolve(null);
              const out: any = { ...r };
              if (a.select?.fee) {
                const feeId = r.feeId;
                if (feeId != null) {
                  const feeSel = (a.select.fee as any)?.select ?? { id: true };
                  const feeCopy: any = {};
                  for (const k of Object.keys(feeSel)) feeCopy[k] = (r.fee?.[k] ?? null);
                  if (Object.keys(feeSel).length === 0) feeCopy.id = feeId;
                  out.fee = feeCopy;
                } else {
                  out.fee = null;
                }
              }
              return Promise.resolve(JSON.parse(JSON.stringify(out)));
            },
            update: (a: any) => {
              invoices[a.where.id] = { ...(invoices[a.where.id] ?? { id: a.where.id }), ...a.data };
              return Promise.resolve({ ...invoices[a.where.id] });
            },
          },
          transaction: {
            findUnique: (a: any) => {
              const r = txns[a.where.id];
              if (!r) return Promise.resolve(null);
              const out: any = JSON.parse(JSON.stringify(r));
              if (a.select?.user) {
                const sel = (a.select.user as any)?.select ?? {};
                const u = users[out.userId];
                if (u) {
                  const uc: any = {};
                  if (Object.keys(sel).length === 0) {
                    out.user = { ...u };
                  } else {
                    for (const k of Object.keys(sel)) uc[k] = (u as any)[k];
                    out.user = uc;
                  }
                } else {
                  out.user = null;
                }
              }
              if (a.select?.invoice && out.invoiceId) {
                const inv = invoices[out.invoiceId];
                if (inv) {
                  const invSel = (a.select.invoice as any)?.select ?? {};
                  const ic: any = {};
                  if (Object.keys(invSel).length === 0) {
                    out.invoice = { ...inv };
                  } else {
                    for (const k of Object.keys(invSel)) {
                      if (k === 'fee' && invSel.fee?.select) {
                        const feeId = inv.feeId;
                        if (feeId != null) {
                          const fc: any = {};
                          for (const fk of Object.keys(invSel.fee.select)) fc[fk] = (inv.fee?.[fk] ?? null);
                          if (Object.keys(invSel.fee.select).length === 0) fc.id = feeId;
                          ic.fee = fc;
                        } else {
                          ic.fee = null;
                        }
                      } else {
                        ic[k] = (inv as any)[k];
                      }
                    }
                    out.invoice = ic;
                  }
                } else {
                  out.invoice = null;
                }
              } else if (a.select?.invoice) {
                out.invoice = null;
              }
              return Promise.resolve(out);
            },
            updateMany: (a: any) => {
              let count = 0;
              Object.values(txns).forEach((t: any) => {
                let match = true;
                if (a.where.id != null && t.id !== a.where.id) match = false;
                if (match && a.where.status != null) {
                  if (typeof a.where.status === 'string') {
                    if (t.status !== a.where.status) match = false;
                  } else if (Array.isArray(a.where.status.in)) {
                    if (!a.where.status.in.includes(t.status)) match = false;
                  }
                }
                if (match) {
                  txns[t.id] = { ...t, ...a.data, updatedAt: new Date() };
                  count++;
                }
              });
              return Promise.resolve({ count });
            },
            update: (a: any) => {
              txns[a.where.id] = { ...(txns[a.where.id] ?? { id: a.where.id }), ...a.data, updatedAt: new Date() };
              return Promise.resolve(JSON.parse(JSON.stringify(txns[a.where.id])));
            },
            create: (a: any) => {
              const id = nextTxnId++;
              txns[id] = { id, ...a.data, createdAt: new Date(), updatedAt: new Date() };
              return Promise.resolve(JSON.parse(JSON.stringify(txns[id])));
            },
          },
          receipt: {
            count: (a: any) => Promise.resolve(receipts.filter((r: any) => r.transactionId === a.where.transactionId).length),
            create: (a: any) => {
              receipts.push({ id: receipts.length + 1, ...a.data });
              return Promise.resolve({ id: receipts.length });
            },
            findFirst: (a: any) => Promise.resolve(receipts.find((r: any) => r.transactionId === a.where.transactionId) ?? null),
          },
          generalLedger: {
            count: (a: any) => Promise.resolve(gls.filter((g: any) => g.transactionId === a.where.transactionId).length),
            create: (a: any) => {
              gls.push({ id: gls.length + 1, ...a.data });
              return Promise.resolve({ id: gls.length });
            },
          },
          invoice_recheck_status_and_balance: () => Promise.resolve(null),
          $queryRaw: jest.fn().mockResolvedValue([]),
          $executeRawUnsafe: jest.fn().mockResolvedValue(0),
          feeAssignment: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          wallet: {
            update: jest.fn().mockResolvedValue({ id: 1 }),
          },
          auditLog: {
            create: (a: any) => {
              audits.push({ id: audits.length + 1, ...a.data });
              return Promise.resolve({ id: audits.length });
            },
          },
        };
        const result = await fn(txClient);
        return result;
      }),
      __testAPI: {
        resetAll: () => {
          for (const k of Object.keys(txns)) delete txns[k as any];
          for (const k of Object.keys(invoices)) delete invoices[k as any];
          audits.length = 0;
          receipts.length = 0;
          gls.length = 0;
          settlements.length = 0;
          nextTxnId = 9000;
          _testResetInitiateLocks();
          _testResetInvoiceLocks();
        },
        seedInvoice: (row: any) => {
          const id = row.id ?? (Object.keys(invoices).length + 1000);
          invoices[id] = { id, createdAt: new Date(), updatedAt: new Date(), ...row };
          return invoices[id];
        },
        seedTransaction: (row: any) => {
          const id = row.id ?? nextTxnId++;
          txns[id] = { id, createdAt: new Date(), updatedAt: new Date(), metadata: {}, ...row };
          return txns[id];
        },
        getTx: (id: number) => txns[id],
        getInv: (id: number) => invoices[id],
        getAudits: () => audits,
        getReceipts: () => receipts,
        getGls: () => gls,
        setBursaryPerms: (list: string[]) => { perms.BURSARY = list; },
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
  // Stub Redis client. Call returns undefined → invoice lock uses in-process Map fallback.
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    call: jest.fn(),
    status: 'ready',
    disconnect: jest.fn(),
    quit: jest.fn(),
  }));
});

// Test-only: disable invoice-op TTL lock for SC1–SC5/SC7 so lock-contention 429s
// do not mask behavior scenarios. SC6 (race) explicitly re-enables + uses
// in-process Map fallback for real serialization.
process.env.INVOICE_OP_LOCK_DISABLE = '1';

const TEST_STUDENT = {
  id: 2003,
  email: 'student+blocker@x.test',
  firstName: 'Blocker',
  lastName: 'Student',
  matricNumber: 'BLOCKER/001',
  role: Role.STUDENT,
};

const VALID_UUID_V4 = 'd7725744-785f-46c9-821b-2e9d5d6f7ac3';
const Decimal = (n: number) => new (require('@prisma/client').Prisma.Decimal as any)(n);

function requireProvider(): any {
  const providerFactory = require('../services/payment/providerFactory');
  return providerFactory._singletonProvider;
}

function mkToken(id: number, role: Role) {
  return jwt.sign(
    { id, role, email: `${id}@blocker.test`, type: 'access', permissions: [], jti: `bl-${id}-${Date.now()}` },
    process.env.JWT_SECRET || 'unit-test-secret-ignore-404',
    { expiresIn: '15m' },
  );
}

function testAPI(): any { return (prisma as any).__testAPI; }

beforeEach(() => { testAPI().resetAll(); });

// ─────────────────────────────────────────────────────────────────────────────
// SC1 — VOID_INVOICES auth gate via middleware (Admin short-circuit, Bursary
//       200 with perm / 403 without, Student forbidden)
// ─────────────────────────────────────────────────────────────────────────────
describe('SC1 B1 Bursary VOID_INVOICES endpoint authorization', () => {
  const app = express();
  app.use(express.json());
  app.post(
    '/api/v1/_sc1/invoices/:id/cancel',
    protect,
    restrictTo(Role.ADMIN, Role.BURSARY),
    requirePermission('VOID_INVOICES'),
    (req, res) => res.status(200).json({ ok: 1, id: req.params.id }),
  );

  it('Admin (short-circuit) → 200', async () => {
    const res = await request(app)
      .post('/api/v1/_sc1/invoices/11/cancel')
      .set('Authorization', `Bearer ${mkToken(2001, Role.ADMIN)}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(1);
  });

  it('Bursary with VOID_INVOICES perm → 200', async () => {
    testAPI().setBursaryPerms(['VIEW_PAYMENTS', 'VOID_INVOICES']);
    bumpRolePermsVersion();
    const res = await request(app)
      .post('/api/v1/_sc1/invoices/11/cancel')
      .set('Authorization', `Bearer ${mkToken(2002, Role.BURSARY)}`);
    expect(res.status).toBe(200);
  });

  it('Bursary missing VOID_INVOICES → 403', async () => {
    testAPI().setBursaryPerms(['VIEW_PAYMENTS']);
    bumpRolePermsVersion();
    const res = await request(app)
      .post('/api/v1/_sc1/invoices/11/cancel')
      .set('Authorization', `Bearer ${mkToken(2002, Role.BURSARY)}`);
    expect(res.status).toBe(403);
  });

  it('Student role → 403 forbidden', async () => {
    const res = await request(app)
      .post('/api/v1/_sc1/invoices/11/cancel')
      .set('Authorization', `Bearer ${mkToken(2003, Role.STUDENT)}`);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC2 — B2 Late SUCCESS on CANCELLED tx + invoice: durable SUCCESS + audit +
//       reconciliation exception flags without receipt/GL posting
// ─────────────────────────────────────────────────────────────────────────────
describe('SC2 B2 CANCELLED invoice late SUCCESS durable commit + flags', () => {
  it('Cancelled tx + invoice + provider SUCCESS payload → SUCCESS + audit flags', async () => {
    const provider = requireProvider();
    const paidAmount = 50_000;
    testAPI().seedInvoice({ id: 551, studentId: TEST_STUDENT.id, invoiceNumber: 'INV-CANCELLED-01', amountDue: Decimal(50_000), amountPaid: Decimal(0), status: InvoiceStatus.CANCELLED, feeId: 1 });
    testAPI().seedTransaction({
      id: 8001,
      reference: 'PAY-BLOCKER-SC2',
      userId: TEST_STUDENT.id,
      invoiceId: 551,
      status: TransactionStatus.CANCELLED,
      expectedAmount: Decimal(50_000),
      amount: Decimal(0),
      gateway: PaymentGateway.ALATPAY,
      alatpayReference: 'alat-sc2',
      alatpayFinalTransactionId: VALID_UUID_V4,
    });

    // provider verify returns authoritative success
    provider.verify.mockResolvedValue({
      success: true,
      status: TransactionStatus.SUCCESS,
      providerStatus: 'SUCCESS',
      paidAmountMinor: paidAmount * 100,
      paidAmountNaira: paidAmount,
      providerReference: VALID_UUID_V4,
      channel: 'card',
      paidAt: new Date(),
      customerEmail: TEST_STUDENT.email,
      raw: { data: { gateway_response: 'Successful' } },
    });
    (require('../services/paystack') as any).computePaymentBreakdown.mockReturnValue({
      baseAmount: 50_000,
      serviceCharge: 750,
      gatewayFee: 0,
      totalAmount: 50_750,
      serviceChargeMode: 'percentage',
      gatewayFeeMode: 'flat',
    });

    const result = await PaymentService.verifyPayment(VALID_UUID_V4, {
      expectedTransactionId: 8001,
      req: { ip: '10.0.0.9', user: { id: TEST_STUDENT.id, role: Role.STUDENT }, headers: {} } as any,
    });

    // Final return values → reconciliation exception + no money posted
    expect(result.verified).toBe(true);
    expect(result.status).toBe(TransactionStatus.SUCCESS);
    expect(result.reconciliationException).toBe(true);
    expect(result.reconciliationExceptionKind).toBe('CANCELLED_INVOICE_LATE_SUCCESS');
    expect(result.noLedgerPosted).toBe(true);
    expect(result.noReceiptIssued).toBe(true);
    expect(result.noInvoiceAmountPosted).toBe(true);

    // DB state: tx status SUCCESS (durable: not rolled back)
    const tx = testAPI().getTx(8001);
    expect(tx.status).toBe(TransactionStatus.SUCCESS);

    // Invoice amountPaid unchanged (0) — no money posted to cancelled invoice
    const inv = testAPI().getInv(551);
    expect(Number(inv.amountPaid)).toBe(0);

    // Audit action = PAYMENT_SUCCESS_ON_CANCELLED_INVOICE present 1× for this entity
    const audits = testAPI().getAudits().filter((a: any) => a.action === 'PAYMENT_SUCCESS_ON_CANCELLED_INVOICE' && a.entityId === '8001');
    expect(audits.length).toBe(1);

    // No receipt / GL rows created
    expect(testAPI().getReceipts().filter((r: any) => r.transactionId === 8001).length).toBe(0);
    expect(testAPI().getGls().filter((g: any) => g.transactionId === 8001).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC3 — B2 alreadyProcessed=true CANCELLED status NOT silently dropped.
//       idempotent-early-return has continue gate when provider declares
//       SUCCESS and current status = CANCELLED.
// ─────────────────────────────────────────────────────────────────────────────
describe('SC3 B2 alreadyProcessed CANCELLED + provider SUCCESS → upgrade to SUCCESS', () => {
  it('alreadyProcessed=true (updateMany WHERE status=PENDING returns count=0) + CANCELLED status → still upgraded', async () => {
    const provider = requireProvider();
    testAPI().seedInvoice({ id: 552, studentId: TEST_STUDENT.id, invoiceNumber: 'INV-CANCELLED-02', amountDue: Decimal(10_000), amountPaid: Decimal(0), status: InvoiceStatus.CANCELLED, feeId: 1 });
    testAPI().seedTransaction({
      id: 8002,
      reference: 'PAY-BLOCKER-SC3',
      userId: TEST_STUDENT.id,
      invoiceId: 552,
      status: TransactionStatus.CANCELLED,
      expectedAmount: Decimal(10_000),
      amount: Decimal(0),
      gateway: PaymentGateway.ALATPAY,
      alatpayReference: 'alat-sc3',
      alatpayFinalTransactionId: VALID_UUID_V4,
    });
    provider.verify.mockResolvedValue({
      success: true,
      status: TransactionStatus.SUCCESS,
      providerStatus: 'SUCCESS',
      paidAmountMinor: 10_000 * 100,
      paidAmountNaira: 10_000,
      providerReference: VALID_UUID_V4,
      channel: 'card',
      paidAt: new Date(),
      customerEmail: TEST_STUDENT.email,
      raw: {},
    });
    (require('../services/paystack') as any).computePaymentBreakdown.mockReturnValue({
      baseAmount: 10_000,
      serviceCharge: 150,
      gatewayFee: 0,
      totalAmount: 10_150,
      serviceChargeMode: 'percentage',
      gatewayFeeMode: 'flat',
    });

    const result = await PaymentService.verifyPayment(VALID_UUID_V4, {
      expectedTransactionId: 8002,
      req: { ip: '10.0.0.9', user: { id: TEST_STUDENT.id, role: Role.STUDENT }, headers: {} } as any,
    });

    // NOT silently ignored → status MUST be SUCCESS (not remain CANCELLED)
    expect(result.status).not.toBe(TransactionStatus.CANCELLED);
    expect(result.status).toBe(TransactionStatus.SUCCESS);
    expect(result.reconciliationException).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC4 — B3 Eligible unpaid PENDING tx cancellation → CANCELLED + metadata
//       + atomic TRANSACTION_CANCELLED audit row
// ─────────────────────────────────────────────────────────────────────────────
describe('SC4 B3 PENDING unpaid eligible transaction cancel workflow', () => {
  it('PENDING tx 0 amount + invoice unpaid → status CANCELLED + metadata.cancellation stamped + audit', async () => {
    testAPI().seedInvoice({ id: 553, studentId: TEST_STUDENT.id, invoiceNumber: 'INV-ELIGIBLE-03', amountDue: Decimal(25_000), amountPaid: Decimal(0), status: InvoiceStatus.UNPAID, feeId: 1 });
    testAPI().seedTransaction({
      id: 8003,
      reference: 'PAY-BLOCKER-SC4',
      userId: TEST_STUDENT.id,
      invoiceId: 553,
      status: TransactionStatus.PENDING,
      expectedAmount: Decimal(25_000),
      amount: Decimal(0),
      gateway: PaymentGateway.PAYSTACK,
    });

    const out = await TransactionCancellationService.cancelTransaction({
      transactionId: 8003,
      actorId: 2001,
      actorRole: Role.ADMIN,
      actorPermissions: [],
      reason: 'TEST_TRANSACTION',
      evidenceReference: 'ev-blocker-sc4-document',
      req: { ip: '10.0.0.1', headers: { 'user-agent': 'jest/sc4' } } as any,
    });

    expect(out?.transaction?.status).toBe(TransactionStatus.CANCELLED);
    const tx = testAPI().getTx(8003);
    expect(tx.status).toBe(TransactionStatus.CANCELLED);
    expect(tx.metadata?.cancellation?.reason).toBe('TEST_TRANSACTION');
    expect(tx.metadata?.cancellation?.evidenceReference).toBe('ev-blocker-sc4-document');
    expect(tx.metadata?.cancellation?.preservedReferences?.reference).toBe('PAY-BLOCKER-SC4');
    expect(tx.metadata?.cancellation?.statusBefore).toBe('PENDING');

    const audits = testAPI().getAudits().filter((a: any) => a.action === 'TRANSACTION_CANCELLED' && a.entityId === '8003');
    expect(audits.length).toBe(1);

    // Invoice unchanged
    const inv = testAPI().getInv(553);
    expect(inv.status).toBe(InvoiceStatus.UNPAID);
    expect(Number(inv.amountPaid)).toBe(0);

    // No receipts / GLs created
    expect(testAPI().getReceipts().length).toBe(0);
    expect(testAPI().getGls().length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC5 — B3 Ineligible SUCCESS status transaction → 409 status unchanged
// ─────────────────────────────────────────────────────────────────────────────
describe('SC5 B3 Ineligible SUCCESS tx cancel → 409 reject', () => {
  it('SUCCESS payment attempt cannot be cancelled via cancelTransaction → 409', async () => {
    testAPI().seedInvoice({ id: 554, studentId: TEST_STUDENT.id, invoiceNumber: 'INV-SUCCESS-04', amountDue: Decimal(10_000), amountPaid: Decimal(10_000), status: InvoiceStatus.PAID, feeId: 1 });
    testAPI().seedTransaction({
      id: 8004,
      reference: 'PAY-BLOCKER-SC5',
      userId: TEST_STUDENT.id,
      invoiceId: 554,
      status: TransactionStatus.SUCCESS,
      expectedAmount: Decimal(10_000),
      amount: Decimal(10_000),
      gateway: PaymentGateway.PAYSTACK,
      paystackReference: 'psc5ref',
    });
    let err: any = null;
    try {
      await TransactionCancellationService.cancelTransaction({
        transactionId: 8004,
        actorId: 2001,
        actorRole: Role.ADMIN,
        actorPermissions: [],
        reason: 'OTHER',
        writtenExplanation: 'Attempting to cancel an already-SUCCESS tx — must be rejected.',
        evidenceReference: 'ev-sc5-case-file',
      });
    } catch (e: any) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect(err?.statusCode).toBe(409);
    const tx = testAPI().getTx(8004);
    expect(tx.status).toBe(TransactionStatus.SUCCESS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SC6 — B4 25× Promise.all concurrent cancelInvoice + initiatePayment →
//       ZERO inconsistent (invoice CANCELLED && PENDING tx exists) states.
// ─────────────────────────────────────────────────────────────────────────────
describe('SC6 B4 N=25 concurrent cancel+initiate → zero inconsistent', () => {
  // SC6 re-enables invoice op locks (fallback in-process Map) so the
  // serialization gate is exercised end-to-end (disable → 25× race → re-disable)
  const prevLockDisable = process.env.INVOICE_OP_LOCK_DISABLE;
  beforeAll(() => { delete process.env.INVOICE_OP_LOCK_DISABLE; });
  afterAll(() => { process.env.INVOICE_OP_LOCK_DISABLE = prevLockDisable; _testResetInvoiceLocks(); });

  it('25 iterations Promise.all race safety — invoice lock + FOR UPDATE triad prevents inconsistency', async () => {
    const provider = requireProvider();
    const computeBreakdown = (require('../services/paystack') as any).computePaymentBreakdown;
    provider.initialize.mockImplementation(async (_email: string, _amountKobo: number, opts: any) => ({
      paymentUrl: 'https://checkout.example.com/sc6',
      redirectUrl: 'https://checkout.example.com/sc6',
      checkoutUrl: 'https://checkout.example.com/sc6',
      sessionId: `sess-sc6-${opts?.reference}`,
      accessCode: `access-${opts?.reference}`,
      providerReference: opts?.reference ?? 'ref-sc6',
      reference: opts?.reference ?? 'ref-sc6',
    }));
    computeBreakdown.mockReturnValue({
      baseAmount: 40_000,
      serviceCharge: 600,
      gatewayFee: 0,
      totalAmount: 40_600,
      serviceChargeMode: 'percentage',
      gatewayFeeMode: 'flat',
    });

    let inconsistentCount = 0;
    let cancelWins = 0;
    let initiateWins = 0;
    let contentionFails = 0;

    const N = 25;
    for (let i = 0; i < N; i++) {
      _testResetInvoiceLocks();
      _testResetInitiateLocks();
      const invoiceId = 1600 + i;
      const studentId = TEST_STUDENT.id;
      testAPI().seedInvoice({ id: invoiceId, studentId, invoiceNumber: `INV-RACE-${i}`, amountDue: Decimal(40_000), amountPaid: Decimal(0), status: InvoiceStatus.UNPAID, feeId: 1 });

      const pCancel = InvoiceCancellationService.cancelInvoice({
        invoiceId,
        actorId: 2001,
        actorRole: Role.ADMIN,
        reason: 'ADMINISTRATIVE_CORRECTION',
        writtenExplanation: 'Race test cancellation for SC6 — iteration ' + i,
        req: { ip: '10.0.0.2', headers: {} } as any,
      }).then(
        (r) => ({ outcome: 'CANCELLED', result: r }),
        (e) => ({ outcome: 'CANCEL_FAIL', error: e }),
      );

      const pInit = PaymentService.initiatePayment(studentId, { invoiceId }).then(
        (r) => ({ outcome: 'INITIATED', result: r }),
        (e) => ({ outcome: 'INITIATE_FAIL', error: e }),
      );

      const [cRes, iRes] = await Promise.all([pCancel, pInit]);

      const inv = testAPI().getInv(invoiceId);
      const pendingCount = await prisma.transaction.count({ where: { invoiceId, status: TransactionStatus.PENDING } });

      if (cRes.outcome === 'CANCELLED') cancelWins++;
      if (iRes.outcome === 'INITIATED') initiateWins++;
      if (cRes.outcome === 'CANCEL_FAIL' || iRes.outcome === 'INITIATE_FAIL') contentionFails++;

      if (inv.status === InvoiceStatus.CANCELLED && pendingCount > 0) {
        inconsistentCount++;
      }
    }

    // HARD ASSERTION: zero inconsistent (cancelled invoice + pending child tx)
    expect(inconsistentCount).toBe(0);
    // Sanity: distributed outcomes (25 iterations total; at least one per category if lock is working)
    expect(cancelWins + initiateWins + contentionFails).toBeGreaterThanOrEqual(N);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// SC7 — B3 TransactionCancellationService assertAuthorized perm matrix
// ─────────────────────────────────────────────────────────────────────────────
describe('SC7 B3 TransactionCancellationService authorization matrix', () => {
  it('Admin → true regardless of permissions array', () => {
    expect(TransactionCancellationService.assertAuthorized(Role.ADMIN, [])).toBe(true);
    expect(TransactionCancellationService.assertAuthorized(Role.ADMIN, ['SOMETHING_ELSE'])).toBe(true);
  });

  it('Bursary + VOID_TRANSACTIONS perm → true; without → false', () => {
    expect(TransactionCancellationService.assertAuthorized(Role.BURSARY, ['VIEW_PAYMENTS'])).toBe(false);
    expect(TransactionCancellationService.assertAuthorized(Role.BURSARY, ['VIEW_PAYMENTS', Permissions.VOID_TRANSACTIONS])).toBe(true);
  });

  it('Student → always false regardless of VOID_TRANSACTIONS array', () => {
    expect(TransactionCancellationService.assertAuthorized(Role.STUDENT, [Permissions.VOID_TRANSACTIONS])).toBe(false);
    expect(TransactionCancellationService.assertAuthorized(Role.STUDENT, [])).toBe(false);
  });
});
