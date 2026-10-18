/**
 * HIERARCHICAL STAFF ACCESS ENDPOINTS — contract regression suite
 * =============================================================================
 * Mounts the REAL admin router (src/routes/admin.ts) with the REAL authorization
 * middlewares and a mocked Prisma client. No live DB, no production data, no
 * network.
 *
 * Proves the §2 / §8 / §14 / §27 individual-access contract:
 *   · GET   /admin/users/:id/access      resolved access payload
 *   · PATCH /admin/users/:id/access      INHERIT / CUSTOM (restrict-only)
 *   · POST  /admin/users/:id/super-admin grant / revoke the protected flag
 * plus the D1 (role transition clears the flag), D7 (final active super admin
 * invariant) and D10 (single-transaction write) hardening.
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role, AccountStatus, AccessMode } from '@prisma/client';
import {
  ALL_PERMISSION_KEYS,
  isAdminOnlyPermission,
  isSuperAdminOnlyPermission,
} from '../services/permissionSeed';

const idByKey = new Map<string, number>(ALL_PERMISSION_KEYS.map((k, i) => [k, i + 1]));
const keyById = new Map<number, string>(ALL_PERMISSION_KEYS.map((k, i) => [i + 1, k]));

const NON_ADMIN_ONLY = ALL_PERMISSION_KEYS.filter((k) => !isAdminOnlyPermission(k));
const ADMIN_ONLY_DELEGABLE = ALL_PERMISSION_KEYS.filter(
  (k) => isAdminOnlyPermission(k) && !isSuperAdminOnlyPermission(k),
);
const SUPER_ADMIN_ONLY = ALL_PERMISSION_KEYS.filter((k) => isSuperAdminOnlyPermission(k));

// Deterministic BURSARY role baseline used by the suite.
const B1 = NON_ADMIN_ONLY[0];
const B2 = NON_ADMIN_ONLY[1];
const B3 = NON_ADMIN_ONLY[2];
const OUT_OF_SCOPE = NON_ADMIN_ONLY.find((k) => ![B1, B2, B3].includes(k)) as string;

type Profile = { id: number; accessMode: AccessMode; keys: string[] };

const state: {
  users: Record<number, any>;
  rolePerms: Record<string, string[]>;
  auditActions: string[];
  profiles: Record<number, Profile>;
  revoked: Array<Record<string, any>>;
  nextProfileId: number;
  financial: {
    invoices: number;
    receipts: number;
    transactions: number;
    refunds: number;
    feeAssignments: number;
    ledgerEntries: number;
  };
} = {
  users: {},
  rolePerms: {},
  auditActions: [],
  profiles: {},
  revoked: [],
  nextProfileId: 5000,
  financial: { invoices: 0, receipts: 0, transactions: 0, refunds: 0, feeAssignments: 0, ledgerEntries: 0 },
};

const db: any = {
  user: {
    findUnique: jest.fn((args: any) => Promise.resolve(state.users[args?.where?.id] ? { ...state.users[args.where.id] } : null)),
    findMany: jest.fn((args: any) => {
      const role = args?.where?.role;
      const list = Object.values(state.users).filter((u) => (role ? u.role === role : true));
      return Promise.resolve(list.map((u) => ({ id: u.id })));
    }),
    update: jest.fn((args: any) => {
      const u = state.users[args.where.id];
      if (u) Object.assign(u, args.data);
      return Promise.resolve({ ...u });
    }),
    count: jest.fn((args: any) => {
      const w = args?.where ?? {};
      const n = Object.values(state.users).filter((u) => {
        if (w.role !== undefined && u.role !== w.role) return false;
        if (w.isSuperAdmin !== undefined && u.isSuperAdmin !== w.isSuperAdmin) return false;
        if (w.accountStatus !== undefined && u.accountStatus !== w.accountStatus) return false;
        if (w.id?.not !== undefined && u.id === w.id.not) return false;
        return true;
      }).length;
      return Promise.resolve(n);
    }),
    delete: jest.fn((args: any) => {
      delete state.users[args.where.id];
      return Promise.resolve({ id: args.where.id });
    }),
  },
  permission: {
    findMany: jest.fn((args: any) => {
      const keys: string[] = args?.where?.key?.in ?? [];
      return Promise.resolve(
        keys.filter((k) => idByKey.has(k)).map((k) => ({ id: idByKey.get(k), key: k })),
      );
    }),
  },
  rolePermission: {
    findMany: jest.fn((args: any) =>
      Promise.resolve(
        (state.rolePerms[String(args?.where?.role)] ?? []).map((key) => ({
          role: String(args.where.role),
          permission: { key },
        })),
      ),
    ),
    deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    createMany: jest.fn(() => Promise.resolve({ count: 0 })),
  },
  // No RBAC_ADMIN_INIT_SENTINEL_ID marker ⇒ the ADMIN baseline is genuinely
  // UNINITIALISED ⇒ the canonical full-registry floor applies. This models the
  // intended production state where a normal ADMIN holds MANAGE_USERS but is
  // still NOT a super administrator.
  counter: {
    findUnique: jest.fn(() => Promise.resolve(null)),
  },
  // No individual-access profile row ⇒ INHERIT the role baseline. (A GENUINE
  // null means INHERIT; only a query FAILURE fails closed.)
  userPermissionProfile: {
    findUnique: jest.fn((args: any) => {
      const p = state.profiles[args?.where?.userId];
      if (!p) return Promise.resolve(null);
      return Promise.resolve({
        id: p.id,
        accessMode: p.accessMode,
        permissions: p.keys.map((key) => ({ permission: { key } })),
      });
    }),
    upsert: jest.fn((args: any) => {
      const userId = args.where.userId;
      const existing = state.profiles[userId];
      if (existing) {
        existing.accessMode = args.update.accessMode;
        return Promise.resolve({ id: existing.id });
      }
      const created: Profile = {
        id: state.nextProfileId++,
        accessMode: args.create.accessMode,
        keys: [],
      };
      state.profiles[userId] = created;
      return Promise.resolve({ id: created.id });
    }),
  },
  userPermission: {
    deleteMany: jest.fn((args: any) => {
      const p = Object.values(state.profiles).find((x) => x.id === args.where.profileId);
      if (p) p.keys = [];
      return Promise.resolve({ count: 0 });
    }),
    createMany: jest.fn((args: any) => {
      const rows: any[] = args.data ?? [];
      const p = Object.values(state.profiles).find((x) => x.id === rows[0]?.profileId);
      if (p) p.keys = rows.map((r) => keyById.get(r.permissionId)!).filter(Boolean);
      return Promise.resolve({ count: rows.length });
    }),
  },
  refreshToken: {
    updateMany: jest.fn((args: any) => {
      state.revoked.push(args.where);
      return Promise.resolve({ count: 1 });
    }),
    deleteMany: jest.fn(() => Promise.resolve({ count: 1 })),
  },
  auditLog: {
    create: jest.fn((args: any) => {
      state.auditActions.push(String(args?.data?.action ?? ''));
      return Promise.resolve({ id: 1 });
    }),
    updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
  },
  // READ-ONLY financial-record counts consulted by the (authoritative) student
  // financial-record deletion gate. Never mutated by the endpoint.
  invoice: { count: jest.fn(() => Promise.resolve(state.financial.invoices)) },
  receipt: { count: jest.fn(() => Promise.resolve(state.financial.receipts)) },
  transaction: { count: jest.fn(() => Promise.resolve(state.financial.transactions)) },
  refund: { count: jest.fn(() => Promise.resolve(state.financial.refunds)) },
  feeAssignment: { count: jest.fn(() => Promise.resolve(state.financial.feeAssignments)) },
  generalLedger: { count: jest.fn(() => Promise.resolve(state.financial.ledgerEntries)) },
  // The DELETE path acquires TWO pessimistic locks inside its transaction — the
  // ACTIVE super-admin SET range lock and the TARGET-row `SELECT … FOR UPDATE`.
  // A mocked Prisma cannot express an InnoDB row lock, so the `$transaction`
  // wrapper below SERIALISES transactions — the observable guarantee those locks
  // provide (see the harness comment). Each query resolves as a no-op, but the
  // calls are recorded so a test can assert LOCK ORDERING (set before row).
  $queryRaw: jest.fn(() => Promise.resolve([])),
};

// ---------------------------------------------------------------------------
// Concurrency harness — models the `SELECT … FOR UPDATE` serialisation the
// final-active-super-admin invariant depends on.
// ---------------------------------------------------------------------------
// InnoDB makes concurrent invariant-affecting transactions queue on the ACTIVE
// super-admin row set, so the SECOND transaction observes the first one's
// committed write instead of both reading the same pre-write count. A mocked
// Prisma cannot hold a real row lock, so every `$transaction` runs inside a
// global FIFO mutex here, which reproduces that observable behaviour. This is
// deliberately STRICTER than a no-op: because the count and the mutating write
// must run inside ONE transaction, the concurrency test below still fails if a
// path counts OUTSIDE its transaction (both transactions would then read the
// stale "1 remaining" and both would write).
// ---------------------------------------------------------------------------
let txTail: Promise<void> = Promise.resolve();

// Captured so a test that overrides `user.findUnique` can restore the default
// implementation (jest.clearAllMocks preserves implementations, so a leaked
// override would corrupt later tests).
const defaultUserFindUnique = db.user.findUnique.getMockImplementation();

const mockPrisma: any = {
  ...db,
  $transaction: jest.fn(async (fn: any) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const wait = txTail;
    txTail = txTail.then(() => gate);
    await wait;
    try {
      return await fn(db);
    } finally {
      release();
    }
  }),
};

jest.mock('../config/database', () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));
jest.mock('../controllers/admin', () => ({ getDashboardStats: jest.fn(), addStudent: jest.fn() }));
jest.mock('../controllers/bulkUpload', () => ({
  confirmStudentUpload: jest.fn(),
  downloadCredentialsCsv: jest.fn(),
  downloadErrorCsv: jest.fn(),
  getImportRun: jest.fn(),
  listImportRunRows: jest.fn(),
  listImportRuns: jest.fn(),
  previewStudentUpload: jest.fn(),
  resendImportRowCredentials: jest.fn(),
  stageStudentUpload: jest.fn(),
}));
jest.mock('../controllers/refunds', () => ({
  adminListRefunds: jest.fn(),
  adminApproveRefund: jest.fn(),
  adminRejectRefund: jest.fn(),
}));
jest.mock('../controllers/payments', () => ({
  getTransactionForVerify: jest.fn(),
  lookupTransactionForVerify: jest.fn(),
  verifyPaymentByTransactionId: jest.fn(),
}));
jest.mock('../services/student', () => {
  const { z } = jest.requireActual('zod');
  return { CreateStudentSchema: z.object({}).passthrough(), StudentService: {} };
});
jest.mock('../services/refund', () => ({ RefundService: { assertTransactionMutable: jest.fn() } }));
jest.mock('../services/search', () => ({ AdminSearchService: {} }));
jest.mock('../services/systemSettings', () => ({ SystemSettingsService: {} }));
jest.mock('../services/adminNotification', () => ({ AdminNotificationService: {} }));
jest.mock('../services/emailTemplate', () => {
  const { z } = jest.requireActual('zod');
  return { EmailTemplateService: {}, EmailTemplateConfigPatchSchema: z.object({}).passthrough() };
});
jest.mock('../services/transactionCancellation', () => {
  const { z } = jest.requireActual('zod');
  return { CancelTransactionBodySchema: z.object({}).passthrough(), TransactionCancellationService: {} };
});

import adminRouter from '../routes/admin';
import { bumpRolePermsVersion } from '../services/permissionResolver';

const API = '/api/v1';

const token = (id: number, role: Role) =>
  jwt.sign(
    { id, role, email: `${role.toLowerCase()}@uni.edu.ng`, permissions: [], type: 'access', jti: `${id}-${Date.now()}` },
    process.env.JWT_SECRET || 'unit-test-secret-ignore-404',
    { expiresIn: '15m' },
  );
const auth = (id: number, role: Role) => ({ Authorization: `Bearer ${token(id, role)}` });

const SUPER = auth(9001, Role.ADMIN);       // flagged super administrator
const NORMAL_ADMIN = auth(9004, Role.ADMIN); // plain ADMIN, NOT flagged
const BURSARY = auth(9002, Role.BURSARY);

const app = express();
app.use(express.json());
app.use(`${API}/admin`, adminRouter);
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err?.statusCode ?? err?.status ?? 500).json({ status: 'error', message: err?.message ?? 'error' });
});

const setUser = (id: number, role: Role, opts: Partial<{ isSuperAdmin: boolean; accountStatus: AccountStatus }> = {}) => {
  state.users[id] = {
    id,
    email: `u${id}@uni.edu.ng`,
    firstName: 'Test',
    middleName: null,
    lastName: `User${id}`,
    role,
    accountStatus: opts.accountStatus ?? AccountStatus.ACTIVE,
    isSuperAdmin: opts.isSuperAdmin ?? false,
  };
};

beforeEach(() => {
  state.users = {};
  state.rolePerms = { [Role.BURSARY]: [B1, B2, B3] };
  state.auditActions = [];
  state.profiles = {};
  state.revoked = [];
  state.nextProfileId = 5000;
  state.financial = { invoices: 0, receipts: 0, transactions: 0, refunds: 0, feeAssignments: 0, ledgerEntries: 0 };
  txTail = Promise.resolve();
  jest.clearAllMocks();
  bumpRolePermsVersion();
  // Default actors.
  setUser(9001, Role.ADMIN, { isSuperAdmin: true });
  setUser(9002, Role.BURSARY);
  setUser(9004, Role.ADMIN, { isSuperAdmin: false });
});

describe('sanity — the derived fixtures are valid', () => {
  it('has a usable BURSARY baseline, a delegable ADMIN-only key and a super-admin-only key', () => {
    expect(B1 && B2 && B3).toBeTruthy();
    expect(OUT_OF_SCOPE).toBeTruthy();
    expect(ADMIN_ONLY_DELEGABLE.length).toBeGreaterThan(0);
    expect(SUPER_ADMIN_ONLY).toContain('MANAGE_ROLES');
  });
});

describe('GET /admin/users/:id/access — resolved access payload (§2/§27)', () => {
  it('returns the canonical payload for a BURSARY user (INHERIT)', async () => {
    const res = await request(app).get(`${API}/admin/users/9002/access`).set(SUPER);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.user.role).toBe(Role.BURSARY);
    expect(d.user.isSuperAdmin).toBe(false);
    expect(d.accessMode).toBe(AccessMode.INHERIT);
    expect(d.rolePermissions.sort()).toEqual([B1, B2, B3].sort());
    expect(d.rolePermissionCount).toBe(3);
    expect(d.selectedPermissions).toEqual([]);
    expect(d.effectivePermissionCount).toBe(3);
    expect(d.isProtected).toBe(false);
    // Never leak credentials.
    expect(JSON.stringify(d)).not.toMatch(/password|refreshToken|hashedPassword/i);
  });

  it('a NON-super ADMIN cannot view another administrator access → 403', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false });
    const res = await request(app).get(`${API}/admin/users/9005/access`).set(NORMAL_ADMIN);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUPER_ADMIN_REQUIRED');
  });

  it('a Super Administrator CAN view an administrator access → 200', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false });
    const res = await request(app).get(`${API}/admin/users/9005/access`).set(SUPER);
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe(Role.ADMIN);
  });

  it('a BURSARY actor cannot reach the endpoint (MANAGE_USERS is ADMIN-only) → 403', async () => {
    const res = await request(app).get(`${API}/admin/users/9002/access`).set(BURSARY);
    expect(res.status).toBe(403);
  });

  it('an unknown user → 404', async () => {
    const res = await request(app).get(`${API}/admin/users/9999/access`).set(SUPER);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /admin/users/:id/access — restrict-only individual access (§8/§9/§14)', () => {
  it('CUSTOM with a subset of the role baseline yields the intersection', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [B1, B3] });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.accessMode).toBe(AccessMode.CUSTOM);
    expect(d.selectedPermissions.sort()).toEqual([B1, B3].sort());
    expect(d.effectivePermissions.sort()).toEqual([B1, B3].sort());
    expect(d.effectivePermissionCount).toBe(2);
    expect(state.auditActions).toContain('USER_ACCESS_MODE_CHANGED');
    expect(state.revoked.some((w) => w.userId === 9002)).toBe(true);
  });

  it('CUSTOM with an EMPTY selection is a VALID explicit zero (never conflated with INHERIT)', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [] });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.accessMode).toBe(AccessMode.CUSTOM);
    expect(d.selectedPermissions).toEqual([]);
    expect(d.effectivePermissionCount).toBe(0);
    // Persisted as CUSTOM (not INHERIT).
    expect(state.profiles[9002].accessMode).toBe(AccessMode.CUSTOM);
    expect(state.profiles[9002].keys).toEqual([]);
  });

  it('CUSTOM WITHOUT permissionKeys → 400', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PERMISSION_KEYS_REQUIRED');
  });

  it('an ADMIN-only key on a BURSARY target → 400', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [ADMIN_ONLY_DELEGABLE[0]] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ADMIN_ONLY_PERMISSION');
  });

  it('the super-admin-only capability is NEVER delegable → 400', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [SUPER_ADMIN_ONLY[0]] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SUPER_ADMIN_ONLY_PERMISSION');
  });

  it('a key OUTSIDE the role maximum can never be granted → 400', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [OUT_OF_SCOPE] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OUT_OF_ROLE_SCOPE');
  });

  it('an UNKNOWN permission key → 400', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: ['NOT_A_REAL_PERMISSION'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_PERMISSION');
  });

  it('applies to ADMIN/BURSARY only — a STUDENT target → 400', async () => {
    setUser(9006, Role.STUDENT);
    const res = await request(app)
      .patch(`${API}/admin/users/9006/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_STAFF');
  });

  it('a repeated identical save is a NO-OP that logs no misleading change', async () => {
    await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [B1] });
    state.auditActions = [];
    state.revoked = [];
    const res = await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [B1] });
    expect(res.status).toBe(200);
    expect(state.auditActions).toEqual([]);
    expect(state.revoked).toEqual([]);
  });

  it('switching back to INHERIT clears the custom selection', async () => {
    await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [B1, B2] });
    const res = await request(app)
      .patch(`${API}/admin/users/9002/access`)
      .set(SUPER)
      .send({ accessMode: AccessMode.INHERIT });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.accessMode).toBe(AccessMode.INHERIT);
    expect(d.selectedPermissions).toEqual([]);
    expect(d.effectivePermissionCount).toBe(3);
  });

  it('a NON-super ADMIN cannot modify another administrator access → 403', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false });
    const res = await request(app)
      .patch(`${API}/admin/users/9005/access`)
      .set(NORMAL_ADMIN)
      .send({ accessMode: AccessMode.CUSTOM, permissionKeys: [] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUPER_ADMIN_REQUIRED');
  });
});

describe('POST /admin/users/:id/super-admin — protected flag (§4/§18)', () => {
  it('grant to a non-ADMIN target → 400', async () => {
    const res = await request(app)
      .post(`${API}/admin/users/9002/super-admin`)
      .set(SUPER)
      .send({ grant: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TARGET_NOT_ADMIN');
  });

  it('grant to an ADMIN → 200 and audits SUPER_ADMIN_GRANTED', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false });
    const res = await request(app)
      .post(`${API}/admin/users/9005/super-admin`)
      .set(SUPER)
      .send({ grant: true });
    expect(res.status).toBe(200);
    expect(state.users[9005].isSuperAdmin).toBe(true);
    expect(state.auditActions).toContain('SUPER_ADMIN_GRANTED');
    expect(state.revoked.some((w) => w.userId === 9005)).toBe(true);
  });

  it('revoking the flag from the FINAL active super admin → 409', async () => {
    // 9001 is the only active super admin; it tries to revoke itself.
    const res = await request(app)
      .post(`${API}/admin/users/9001/super-admin`)
      .set(SUPER)
      .send({ grant: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FINAL_SUPER_ADMIN');
    expect(state.users[9001].isSuperAdmin).toBe(true);
  });

  it('revoking when ANOTHER active super admin remains → 200 (SUPER_ADMIN_REVOKED)', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: true });
    const res = await request(app)
      .post(`${API}/admin/users/9005/super-admin`)
      .set(SUPER)
      .send({ grant: false });
    expect(res.status).toBe(200);
    expect(state.users[9005].isSuperAdmin).toBe(false);
    expect(state.auditActions).toContain('SUPER_ADMIN_REVOKED');
  });

  it('a NON-super ADMIN cannot grant the flag → 403', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false });
    const res = await request(app)
      .post(`${API}/admin/users/9005/super-admin`)
      .set(NORMAL_ADMIN)
      .send({ grant: true });
    expect(res.status).toBe(403);
  });
});

describe('D1/D7/D10 — role transitions and the final-super-admin invariant (§4/§18)', () => {
  it('changing a role AWAY from ADMIN forces isSuperAdmin=false in the SAME write (D1)', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: true });
    const res = await request(app)
      .patch(`${API}/admin/users/9005`)
      .set(SUPER)
      .send({ role: Role.BURSARY });
    expect(res.status).toBe(200);
    expect(state.users[9005].role).toBe(Role.BURSARY);
    expect(state.users[9005].isSuperAdmin).toBe(false);
    const call = (db.user.update as jest.Mock).mock.calls.find((c) => c[0]?.where?.id === 9005);
    expect(call[0].data.isSuperAdmin).toBe(false);
  });

  it('demoting the FINAL active super admin → 409 (D7)', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9001`)
      .set(SUPER)
      .send({ role: Role.BURSARY });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FINAL_SUPER_ADMIN');
    expect(state.users[9001].role).toBe(Role.ADMIN);
  });

  it('suspending the FINAL active super admin via deactivate → 409 (D7)', async () => {
    const res = await request(app).post(`${API}/admin/users/9001/deactivate`).set(SUPER);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FINAL_SUPER_ADMIN');
  });

  it('deleting the FINAL active super admin → 409 (D7)', async () => {
    const res = await request(app).delete(`${API}/admin/users/9001`).set(SUPER);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FINAL_SUPER_ADMIN');
  });
});

// ===========================================================================
// BLOCKER 3 — the final-active-super-admin invariant is CENTRALISED and
// concurrency-safe. Every mutation that can remove a user from the ACTIVE
// super-admin set (role change, status change, deactivate/suspend, delete, flag
// revocation) runs read → invariant → write inside ONE serialised transaction.
// ===========================================================================
const activeSuperAdmins = (): number[] =>
  Object.values(state.users)
    .filter(
      (u) =>
        u.role === Role.ADMIN &&
        u.isSuperAdmin === true &&
        u.accountStatus === AccountStatus.ACTIVE,
    )
    .map((u) => u.id)
    .sort();

describe('BLOCKER 3 — final-active-super-admin invariant across every mutation path', () => {
  it('ADMIN → STUDENT role change on the FINAL active super admin → 409', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9001`)
      .set(SUPER)
      .send({ role: Role.STUDENT });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FINAL_SUPER_ADMIN');
    expect(state.users[9001].role).toBe(Role.ADMIN);
  });

  it('ACTIVE → SUSPENDED status change on the FINAL active super admin → 409', async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/9001`)
      .set(SUPER)
      .send({ accountStatus: AccountStatus.SUSPENDED });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FINAL_SUPER_ADMIN');
    expect(state.users[9001].accountStatus).toBe(AccountStatus.ACTIVE);
  });

  it('role change is ALLOWED when ANOTHER active super admin remains → 200', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: true });
    const res = await request(app)
      .patch(`${API}/admin/users/9005`)
      .set(SUPER)
      .send({ role: Role.BURSARY });
    expect(res.status).toBe(200);
    expect(activeSuperAdmins()).toEqual([9001]);
  });

  it('deactivate is ALLOWED when ANOTHER active super admin remains → 200', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: true });
    const res = await request(app).post(`${API}/admin/users/9005/deactivate`).set(SUPER);
    expect(res.status).toBe(200);
    expect(activeSuperAdmins()).toEqual([9001]);
  });

  it('delete is ALLOWED when ANOTHER active super admin remains → 200', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: true });
    const res = await request(app).delete(`${API}/admin/users/9005`).set(SUPER);
    expect(res.status).toBe(200);
    expect(activeSuperAdmins()).toEqual([9001]);
  });

  it('the invariant only protects ACTIVE super admins — a SUSPENDED one may be demoted → 200', async () => {
    // 9007 is a super admin but SUSPENDED (already outside the ACTIVE set), so
    // demoting it removes nobody from the protected set. 9001 stays the actor.
    setUser(9007, Role.ADMIN, { isSuperAdmin: true, accountStatus: AccountStatus.SUSPENDED });
    const res = await request(app)
      .patch(`${API}/admin/users/9007`)
      .set(SUPER)
      .send({ role: Role.BURSARY });
    expect(res.status).toBe(200);
    expect(state.users[9007].role).toBe(Role.BURSARY);
    expect(activeSuperAdmins()).toEqual([9001]);
  });

  it('CONCURRENCY — two simultaneous mutations can never drop ACTIVE super admins to zero', async () => {
    // Exactly TWO active super administrators exist: 9001 (the actor) and 9005.
    // Both flag revocations are fired concurrently. Without serialisation each
    // would read "1 remaining" and both would succeed, leaving ZERO. With it,
    // exactly one succeeds and the other is rejected → at least ONE remains.
    setUser(9005, Role.ADMIN, { isSuperAdmin: true });
    expect(activeSuperAdmins()).toEqual([9001, 9005]);

    const [r1, r2] = await Promise.all([
      request(app).post(`${API}/admin/users/9005/super-admin`).set(SUPER).send({ grant: false }),
      request(app).post(`${API}/admin/users/9001/super-admin`).set(SUPER).send({ grant: false }),
    ]);

    const successes = [r1, r2].filter((r) => r.status === 200).length;
    expect(successes).toBe(1); // never 2
    expect(activeSuperAdmins()).toHaveLength(1); // never 0
  });

  it('CONCURRENCY — concurrent role change + flag revocation cannot drop ACTIVE super admins to zero', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: true });
    setUser(9006, Role.ADMIN, { isSuperAdmin: true });
    expect(activeSuperAdmins()).toEqual([9001, 9005, 9006]);

    // Demote 9005 and revoke 9006's flag concurrently; 9001 (the actor) remains.
    const [r1, r2] = await Promise.all([
      request(app).patch(`${API}/admin/users/9005`).set(SUPER).send({ role: Role.BURSARY }),
      request(app).post(`${API}/admin/users/9006/super-admin`).set(SUPER).send({ grant: false }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(activeSuperAdmins()).toEqual([9001]);
  });
});

// ===========================================================================
// FINAL RBAC CORRECTION — the DELETE invariant must be derived from the target
// state read INSIDE the transaction, never from the pre-transaction read.
// ===========================================================================
describe('DELETE /admin/users/:id — invariant from the TRANSACTIONAL target read', () => {
  // A NORMAL admin actor: not flagged itself, but (full-registry ADMIN baseline)
  // holds MANAGE_USERS, so it may delete — while contributing NOTHING to the
  // protected ACTIVE super-admin set.
  const actor = NORMAL_ADMIN;

  /** Override `user.findUnique` so the 9005 read returns different states per call. */
  const withTargetStates = (states: Array<Record<string, any>>) => {
    let reads = 0;
    db.user.findUnique.mockImplementation((args: any) => {
      const id = args?.where?.id;
      if (id === 9005) {
        const s = states[Math.min(reads, states.length - 1)];
        reads += 1;
        return Promise.resolve({ ...state.users[9005], ...s });
      }
      return Promise.resolve(state.users[id] ? { ...state.users[id] } : null);
    });
    return () => reads;
  };

  it('uses the IN-TRANSACTION state: an outer super-admin read that is demoted before the tx still deletes → 200', async () => {
    setUser(9001, Role.ADMIN, { isSuperAdmin: false }); // remove the default flagged admin
    setUser(9005, Role.ADMIN, { isSuperAdmin: true }); // pre-tx: the FINAL active super admin
    expect(activeSuperAdmins()).toEqual([9005]);

    // 1st read (OUTSIDE tx): still the final active super admin — the OLD code
    // captured `isActiveSuperAdmin=true` here and would have returned 409.
    // 2nd read (INSIDE tx): demoted to BURSARY ⇒ the invariant no longer applies.
    let reads = 0;
    try {
      const count = withTargetStates([
        { role: Role.ADMIN, isSuperAdmin: true, accountStatus: AccountStatus.ACTIVE },
        { role: Role.BURSARY, isSuperAdmin: false },
      ]);
      const res = await request(app).delete(`${API}/admin/users/9005`).set(actor);
      reads = count();
      expect(res.status).toBe(200);
      expect(state.users[9005]).toBeUndefined(); // deleted
    } finally {
      db.user.findUnique.mockImplementation(defaultUserFindUnique);
    }
    expect(reads).toBeGreaterThanOrEqual(2); // the target was re-read inside the tx
  });

  it('a target that BECOMES the final ACTIVE super admin before the tx delete cannot bypass the invariant → 409', async () => {
    setUser(9001, Role.ADMIN, { isSuperAdmin: false }); // remove the default flagged admin
    setUser(9005, Role.BURSARY); // pre-tx: a plain BURSARY (student gate N/A)
    expect(activeSuperAdmins()).toEqual([]);

    // 1st read (OUTSIDE tx): plain BURSARY — the OLD code captured
    // `isActiveSuperAdmin=false` here and skipped the invariant entirely.
    // 2nd read (INSIDE tx): promoted to the SOLE ACTIVE super admin ⇒ deleting it
    // would drop the ACTIVE super-admin count to zero ⇒ must be rejected.
    let reads = 0;
    try {
      const count = withTargetStates([
        { role: Role.BURSARY, isSuperAdmin: false },
        { role: Role.ADMIN, isSuperAdmin: true, accountStatus: AccountStatus.ACTIVE },
      ]);
      const res = await request(app).delete(`${API}/admin/users/9005`).set(actor);
      reads = count();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FINAL_SUPER_ADMIN');
      expect(state.users[9005]).toBeDefined(); // NOT deleted
    } finally {
      db.user.findUnique.mockImplementation(defaultUserFindUnique);
    }
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// FINAL DELETE CONCURRENCY HARDENING — the target row is locked
// (SELECT … FOR UPDATE) BEFORE the authoritative gates are evaluated, so a
// state change racing the delete is observed under the lock. Proves the
// final-active-super-admin invariant and the student financial gate cannot be
// bypassed, and that locks are taken in ONE consistent order (SET → ROW).
// ===========================================================================
describe('DELETE /admin/users/:id — LOCKED target state cannot be bypassed', () => {
  const actor = NORMAL_ADMIN;

  /** Per-call overrides for the 9005 target read (outer read, then locked read). */
  const withStates = (states: Array<Record<string, any>>) => {
    let reads = 0;
    db.user.findUnique.mockImplementation((args: any) => {
      const id = args?.where?.id;
      if (id === 9005) {
        const s = states[Math.min(reads, states.length - 1)];
        reads += 1;
        return Promise.resolve({ ...state.users[9005], ...s });
      }
      return Promise.resolve(state.users[id] ? { ...state.users[id] } : null);
    });
    return () => reads;
  };

  it('acquires the SET lock BEFORE the TARGET-row lock (one consistent lock order)', async () => {
    setUser(9005, Role.BURSARY);
    const res = await request(app).delete(`${API}/admin/users/9005`).set(actor);
    expect(res.status).toBe(200);

    const sql = (db.$queryRaw as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));
    const setLock = sql.findIndex((s) => s.includes('role ='));
    const rowLock = sql.findIndex((s) => s.includes('WHERE id ='));
    expect(setLock).toBeGreaterThanOrEqual(0);
    expect(rowLock).toBeGreaterThanOrEqual(0);
    // SET first, ROW second — the single order shared by every other
    // invariant-affecting mutation, so no row→set / set→row deadlock cycle.
    expect(setLock).toBeLessThan(rowLock);
  });

  it('a target that becomes a STUDENT with financial records under the lock cannot be deleted → 409', async () => {
    // Outer read: a plain BURSARY ⇒ the early (non-authoritative) gate is skipped.
    setUser(9005, Role.BURSARY);
    // Locked read: STUDENT WITH financial records ⇒ the authoritative gate must stop it.
    state.financial = { invoices: 2, receipts: 1, transactions: 0, refunds: 0, feeAssignments: 0, ledgerEntries: 0 };

    let reads = 0;
    try {
      const count = withStates([{ role: Role.BURSARY }, { role: Role.STUDENT }]);
      const res = await request(app).delete(`${API}/admin/users/9005`).set(actor);
      reads = count();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STUDENT_HAS_FINANCIAL_RECORDS');
      expect(res.body.breakdown.join(' ')).toMatch(/2 invoice/);
      expect(state.users[9005]).toBeDefined(); // NOT deleted — the gate held
    } finally {
      db.user.findUnique.mockImplementation(defaultUserFindUnique);
    }
    expect(reads).toBeGreaterThanOrEqual(2); // re-read under the lock inside the tx
  });

  it('a target that becomes the SOLE ACTIVE super admin under the lock cannot be deleted → 409', async () => {
    setUser(9001, Role.ADMIN, { isSuperAdmin: false }); // no other protected admin
    setUser(9005, Role.BURSARY); // outer read: plain BURSARY ⇒ invariant apparently N/A

    let reads = 0;
    try {
      const count = withStates([
        { role: Role.BURSARY, isSuperAdmin: false },
        { role: Role.ADMIN, isSuperAdmin: true, accountStatus: AccountStatus.ACTIVE },
      ]);
      const res = await request(app).delete(`${API}/admin/users/9005`).set(actor);
      reads = count();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FINAL_SUPER_ADMIN');
      expect(state.users[9005]).toBeDefined(); // NOT deleted
    } finally {
      db.user.findUnique.mockImplementation(defaultUserFindUnique);
    }
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// `isProtected` is derived from the COMPLETE Super Administrator definition
// (role === ADMIN ∧ isSuperAdmin === true) via the centralised helper.
// ===========================================================================
describe('isProtected — complete Super Administrator definition', () => {
  it('a non-ADMIN carrying an inconsistent isSuperAdmin=true flag is NOT protected', async () => {
    setUser(9005, Role.BURSARY, { isSuperAdmin: true }); // inconsistent row
    const res = await request(app).get(`${API}/admin/users/9005/access`).set(SUPER);
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe(Role.BURSARY);
    expect(res.body.data.isProtected).toBe(false);
  });

  it('an ADMIN WITHOUT the flag is NOT protected', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false });
    const res = await request(app).get(`${API}/admin/users/9005/access`).set(SUPER);
    expect(res.status).toBe(200);
    expect(res.body.data.isProtected).toBe(false);
  });

  it('a true Super Administrator (ADMIN ∧ flag) IS protected', async () => {
    const res = await request(app).get(`${API}/admin/users/9001/access`).set(SUPER);
    expect(res.status).toBe(200);
    expect(res.body.data.isProtected).toBe(true);
  });
});

// ===========================================================================
// FINAL RBAC MUTATION LOCK UNIFICATION — every Super-Admin-affecting mutation
// (PATCH role/status, deactivate/reactivate, grant/revoke, DELETE) uses the SAME
// locking context: SET lock → TARGET-row lock → authoritative READ → VALIDATE →
// WRITE, all inside one serialised transaction.
//
// Every final state must satisfy:
//   (1) isSuperAdmin=true ⇒ role=ADMIN   (never an "orphaned" flag), and
//   (2) at least one ACTIVE Super Admin remains.
// ===========================================================================
describe('REQUEST G — unified mutation lock across every Super-Admin path', () => {
  /** Assert both global post-conditions on the resulting table state. */
  const assertFinalInvariants = () => {
    const orphaned = Object.values(state.users)
      .filter((u) => u.isSuperAdmin === true && u.role !== Role.ADMIN)
      .map((u) => u.id);
    expect(orphaned).toEqual([]); // no row may be isSuperAdmin=true ∧ role!=ADMIN
    expect(activeSuperAdmins().length).toBeGreaterThanOrEqual(1); // never zero
  };

  it('all four paths take the SET lock BEFORE the TARGET-row lock (identical ordering)', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false });
    const orders: Array<[number, number]> = [];
    const capture = () => {
      const sql = (db.$queryRaw as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));
      orders.push([sql.findIndex((s) => s.includes('role =')), sql.findIndex((s) => s.includes('WHERE id ='))]);
      (db.$queryRaw as jest.Mock).mockClear();
    };

    await request(app).patch(`${API}/admin/users/9005`).set(SUPER).send({ firstName: 'Renamed' });
    capture();
    await request(app).post(`${API}/admin/users/9005/deactivate`).set(SUPER);
    capture();
    await request(app).post(`${API}/admin/users/9005/super-admin`).set(SUPER).send({ grant: true });
    capture();
    await request(app).delete(`${API}/admin/users/9005`).set(SUPER);
    capture();

    expect(orders).toHaveLength(4);
    for (const [setLock, rowLock] of orders) {
      expect(setLock).toBeGreaterThanOrEqual(0);
      expect(rowLock).toBeGreaterThanOrEqual(0);
      expect(setLock).toBeLessThan(rowLock); // SET first, ROW second — no deadlock cycle
    }
  });

  it('concurrent GRANT vs role→BURSARY: never bypasses the invariant, never orphans the flag', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false }); // starts as a normal ADMIN
    const [grantRes, roleRes] = await Promise.all([
      request(app).post(`${API}/admin/users/9005/super-admin`).set(SUPER).send({ grant: true }),
      request(app).patch(`${API}/admin/users/9005`).set(SUPER).send({ role: Role.BURSARY }),
    ]);
    // At least one operation must have taken effect (grant → 200, or demotion → 200).
    expect([grantRes.status, roleRes.status]).toContain(200);
    expect(state.users[9005].isSuperAdmin === true && state.users[9005].role !== Role.ADMIN).toBe(false);
    assertFinalInvariants();
  });

  it('concurrent GRANT vs DEACTIVATE: never bypasses the invariant, never orphans the flag', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false });
    await Promise.all([
      request(app).post(`${API}/admin/users/9005/super-admin`).set(SUPER).send({ grant: true }),
      request(app).post(`${API}/admin/users/9005/deactivate`).set(SUPER),
    ]);
    expect(state.users[9005].isSuperAdmin === true && state.users[9005].role !== Role.ADMIN).toBe(false);
    assertFinalInvariants();
  });

  it('concurrent REVOKE vs role/status change: never bypasses the invariant', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: true }); // a SECOND active super admin
    await Promise.all([
      request(app).post(`${API}/admin/users/9005/super-admin`).set(SUPER).send({ grant: false }),
      request(app).patch(`${API}/admin/users/9005`).set(SUPER).send({ role: Role.BURSARY }),
    ]);
    expect(state.users[9005].isSuperAdmin === true && state.users[9005].role !== Role.ADMIN).toBe(false);
    assertFinalInvariants();
    expect(activeSuperAdmins()).toContain(9001); // the actor is still an active super admin
  });

  it('concurrent DELETE vs GRANT: never bypasses the invariant', async () => {
    setUser(9005, Role.ADMIN, { isSuperAdmin: false });
    await Promise.all([
      request(app).delete(`${API}/admin/users/9005`).set(SUPER),
      request(app).post(`${API}/admin/users/9005/super-admin`).set(SUPER).send({ grant: true }),
    ]);
    // Either the row is gone, or it survived as a valid (non-orphaned) row.
    if (state.users[9005]) {
      expect(state.users[9005].isSuperAdmin === true && state.users[9005].role !== Role.ADMIN).toBe(false);
    }
    assertFinalInvariants();
  });

  it('concurrent DEACTIVATE vs REVOKE on the SOLE active super admin: both rejected → never zero', async () => {
    // 9001 is the ONLY active super admin; both operations would remove it.
    const [deact, revoke] = await Promise.all([
      request(app).post(`${API}/admin/users/9001/deactivate`).set(NORMAL_ADMIN),
      request(app).post(`${API}/admin/users/9001/super-admin`).set(SUPER).send({ grant: false }),
    ]);
    expect(deact.status).toBe(409);
    expect(revoke.status).toBe(409);
    expect(activeSuperAdmins()).toEqual([9001]);
    assertFinalInvariants();
  });
});
