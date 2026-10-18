/**
 * RBAC ROLE-UPDATE ENDPOINT — contract regression suite
 * =============================================================================
 * Mounts the REAL admin router (src/routes/admin.ts) with the REAL
 * authorization middlewares and a mocked Prisma client. No live DB, no
 * production data, no network.
 *
 * Proves brief §8 (18-point role update contract), §10 layers 2/4, §17
 * (self-escalation blocked) and §19 TEST B/C/D/G/J/K/L/M/N/O/P
 * plus the ADMIN-protection and catalogue requirements of §2/§3.3/§4/§7.
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role, AccountStatus } from '@prisma/client';
import { ALL_PERMISSION_KEYS } from '../services/permissionSeed';

// ---------------------------------------------------------------------------
// In-memory authoritative RolePermission state
// ---------------------------------------------------------------------------
const permIdByKey = new Map<string, number>(ALL_PERMISSION_KEYS.map((k, i) => [k, i + 1]));
const keyById = new Map<number, string>(ALL_PERMISSION_KEYS.map((k, i) => [i + 1, k]));

const state: { rolePermKeys: Record<string, string[]>; auditActions: string[] } = {
  rolePermKeys: {},
  auditActions: [],
};

const permRow = (key: string) => ({
  key,
  name: key,
  category: 'Test',
  description: null,
});

const txClient: any = {
  rolePermission: {
    deleteMany: jest.fn((args: any) => {
      state.rolePermKeys[String(args.where.role)] = [];
      return Promise.resolve({ count: 0 });
    }),
    createMany: jest.fn((args: any) => {
      const role = String(args.data[0]?.role ?? 'BURSARY');
      state.rolePermKeys[role] = (args.data as any[]).map((d) => keyById.get(d.permissionId)!).filter(Boolean);
      return Promise.resolve({ count: args.data.length });
    }),
    findMany: jest.fn((args: any) =>
      Promise.resolve(
        (state.rolePermKeys[String(args.where.role)] ?? []).map((key) => ({
          role: String(args.where.role),
          permission: permRow(key),
        })),
      ),
    ),
  },
};

const mockPrisma: any = {
  user: {
    findUnique: jest.fn((args: any) => {
      const role = (args?.where?.id as any) === 9101 ? Role.ADMIN : args?.where?.id === 9102 ? Role.BURSARY : Role.STUDENT;
      return Promise.resolve({ id: args.where.id, role, accountStatus: AccountStatus.ACTIVE, isSuperAdmin: role === Role.ADMIN });
    }),
    findMany: jest.fn((args: any) => {
      if (args?.where?.role === Role.BURSARY) return Promise.resolve([{ id: 9102 }]);
      return Promise.resolve([]);
    }),
  },
  permission: {
    findMany: jest.fn((args: any) => {
      const keys: string[] = args?.where?.key?.in ?? [];
      return Promise.resolve(keys.filter((k) => permIdByKey.has(k)).map((k) => ({ id: permIdByKey.get(k), key: k })));
    }),
  },
  rolePermission: {
    findMany: jest.fn((args: any) =>
      Promise.resolve(
        (state.rolePermKeys[String(args?.where?.role)] ?? []).map((key) => ({
          role: String(args.where.role),
          permission: permRow(key),
        })),
      ),
    ),
    deleteMany: jest.fn((args: any) => {
      state.rolePermKeys[String(args.where.role)] = [];
      return Promise.resolve({ count: 0 });
    }),
    createMany: jest.fn((args: any) => {
      const role = String(args.data[0]?.role ?? 'BURSARY');
      state.rolePermKeys[role] = (args.data as any[]).map((d) => keyById.get(d.permissionId)!).filter(Boolean);
      return Promise.resolve({ count: args.data.length });
    }),
  },
  refreshToken: {
    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
  },
  // No RBAC_ADMIN_INIT_SENTINEL_ID marker ⇒ genuinely UNINITIALISED ADMIN
  // baseline ⇒ the canonical full-registry floor applies.
  counter: {
    findUnique: jest.fn(() => Promise.resolve(null)),
  },
  // No individual-access profile ⇒ INHERIT the role baseline.
  userPermissionProfile: {
    findUnique: jest.fn(() => Promise.resolve(null)),
  },
  auditLog: {
    create: jest.fn((args: any) => {
      state.auditActions.push(String(args?.data?.action ?? ''));
      return Promise.resolve({ id: 1 });
    }),
  },
  $transaction: jest.fn(async (fn: any) => {
    const snapshot = JSON.parse(JSON.stringify(state.rolePermKeys));
    try {
      return await fn(txClient);
    } catch (e) {
      state.rolePermKeys = snapshot;
      throw e;
    }
  }),
};

// Lazy getter: the hoisted `import ... from '../services/permissionSeed'` above
// makes Jest execute this factory BEFORE `const mockPrisma` is initialised, so
// the factory must not evaluate `mockPrisma` eagerly (TDZ ReferenceError).
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

const API = '/api/v1';

const token = (id: number, role: Role) =>
  jwt.sign(
    { id, role, email: `${role.toLowerCase()}@uni.edu.ng`, permissions: [], type: 'access', jti: `${id}-${Date.now()}` },
    process.env.JWT_SECRET || 'unit-test-secret-ignore-404',
    { expiresIn: '15m' },
  );

const auth = (id: number, role: Role) => ({ Authorization: `Bearer ${token(id, role)}` });
const ADMIN = auth(9101, Role.ADMIN);
const BURSARY = auth(9102, Role.BURSARY);
const STUDENT = auth(9103, Role.STUDENT);

const app = express();
app.use(express.json());
app.use(`${API}/admin`, adminRouter);
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err?.statusCode ?? err?.status ?? 500).json({ status: 'error', message: err?.message ?? 'error' });
});

beforeEach(() => {
  state.rolePermKeys = {};
  state.auditActions = [];
  jest.clearAllMocks();
});

describe('role-update endpoint — access control (brief §8.1-§8.6, §17)', () => {
  it('TEST L — STUDENT cannot use role management → 403', async () => {
    const res = await request(app).patch(`${API}/admin/roles/BURSARY`).set(STUDENT).send({ permissionKeys: [] });
    expect(res.status).toBe(403);
  });

  it('TEST M — BURSARY cannot use role management → 403 (self-escalation blocked)', async () => {
    const res = await request(app)
      .patch(`${API}/admin/roles/BURSARY`)
      .set(BURSARY)
      .send({ permissionKeys: ['MANAGE_ROLES'] });
    expect(res.status).toBe(403);
    expect(state.rolePermKeys.BURSARY).toBeUndefined();
  });

  it('unauthenticated role management → 401', async () => {
    const res = await request(app).patch(`${API}/admin/roles/BURSARY`).send({ permissionKeys: [] });
    expect(res.status).toBe(401);
  });
});

describe('ADMIN is protected (brief §2, §3.1, TEST B)', () => {
  it('POST /admin/roles targeting ADMIN is rejected → 403, nothing written', async () => {
    const res = await request(app)
      .post(`${API}/admin/roles`)
      .set(ADMIN)
      .send({ role: 'ADMIN', permissionKeys: ['VIEW_DASHBOARD'] });
    expect(res.status).toBe(403);
    expect(state.rolePermKeys.ADMIN).toBeUndefined();
  });

  it('GET /admin/roles reports ADMIN as non-modifiable super-admin with the full catalogue', async () => {
    const res = await request(app).get(`${API}/admin/roles`).set(ADMIN);
    expect(res.status).toBe(200);
    const items = res.body.data.items as any[];
    const admin = items.find((i) => i.role === 'ADMIN');
    const bursary = items.find((i) => i.role === 'BURSARY');
    const student = items.find((i) => i.role === 'STUDENT');
    expect(admin.modifiable).toBe(false);
    expect(admin.isSuperAdmin).toBe(true);
    expect(admin.permissionsCount).toBe(ALL_PERMISSION_KEYS.length);
    expect(bursary.modifiable).toBe(true);
    expect(student.modifiable).toBe(false);
    expect(res.body.data.configurableRoles).toEqual(['BURSARY']);
  });

  it('PATCH targeting STUDENT is rejected by the role parameter schema → 400', async () => {
    const res = await request(app).patch(`${API}/admin/roles/STUDENT`).set(ADMIN).send({ permissionKeys: [] });
    expect(res.status).toBe(400);
  });
});

describe('BURSARY permission replacement (TEST C / D / G / O / P)', () => {
  it('TEST C — BURSARY can be granted a normal permission', async () => {
    const res = await request(app)
      .patch(`${API}/admin/roles/BURSARY`)
      .set(ADMIN)
      .send({ permissionKeys: ['VIEW_DASHBOARD', 'VIEW_STUDENTS'] });
    expect(res.status).toBe(200);
    expect(state.rolePermKeys.BURSARY.sort()).toEqual(['VIEW_DASHBOARD', 'VIEW_STUDENTS']);
    expect(res.body.diff.added.sort()).toEqual(['VIEW_DASHBOARD', 'VIEW_STUDENTS']);
  });

  it('TEST D — BURSARY can have a permission removed, with audit evidence', async () => {
    state.rolePermKeys.BURSARY = ['VIEW_DASHBOARD', 'VIEW_STUDENTS'];
    const res = await request(app)
      .patch(`${API}/admin/roles/BURSARY`)
      .set(ADMIN)
      .send({ permissionKeys: ['VIEW_DASHBOARD'] });
    expect(res.status).toBe(200);
    expect(state.rolePermKeys.BURSARY).toEqual(['VIEW_DASHBOARD']);
    expect(res.body.diff.removed).toEqual(['VIEW_STUDENTS']);
    expect(state.auditActions).toContain('UPDATE_ROLE');
    expect(state.auditActions).toContain('ROLE_PERMS_SYNCED');
  });

  it('TEST G — an EMPTY permissionKeys array is accepted and yields zero permissions', async () => {
    state.rolePermKeys.BURSARY = ['VIEW_DASHBOARD', 'VIEW_STUDENTS'];
    const res = await request(app).patch(`${API}/admin/roles/BURSARY`).set(ADMIN).send({ permissionKeys: [] });
    expect(res.status).toBe(200);
    expect(state.rolePermKeys.BURSARY).toEqual([]);
    expect(res.body.data.permissions).toEqual([]);
    expect(res.body.data.permissionsCount).toBe(0);
  });

  it('TEST O — duplicate permission keys are normalised safely', async () => {
    const res = await request(app)
      .patch(`${API}/admin/roles/BURSARY`)
      .set(ADMIN)
      .send({ permissionKeys: ['VIEW_DASHBOARD', 'VIEW_DASHBOARD', ' VIEW_STUDENTS ', 'VIEW_STUDENTS'] });
    expect(res.status).toBe(200);
    expect(state.rolePermKeys.BURSARY.sort()).toEqual(['VIEW_DASHBOARD', 'VIEW_STUDENTS']);
  });

  it('TEST P — replacement is atomic: a mid-transaction failure leaves the previous set intact', async () => {
    state.rolePermKeys.BURSARY = ['VIEW_DASHBOARD'];
    txClient.rolePermission.createMany.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const res = await request(app)
      .patch(`${API}/admin/roles/BURSARY`)
      .set(ADMIN)
      .send({ permissionKeys: ['VIEW_STUDENTS'] });
    expect(res.status).toBe(500);
    expect(state.rolePermKeys.BURSARY).toEqual(['VIEW_DASHBOARD']);
    expect(state.auditActions).not.toContain('UPDATE_ROLE');
  });
});

describe('ADMIN-only assignment is rejected server-side (TEST J / K, brief §3.2, §10 layer 2)', () => {
  it.each([
    'MANAGE_ROLES',
    'MANAGE_USERS',
    'IMPERSONATE_USERS',
    'APPROVE_REFUNDS',
    'FLUSH_QUEUES',
    'SYSTEM_SETTINGS',
    'PAYSTACK_CONFIG',
    'MANAGE_PAYMENT_PROVIDERS',
    'MANAGE_EMAIL_TEMPLATES',
    'AUDIT_LOGS_VIEW_FULL',
    'REPORTS_SCHEDULE',
    'SCHEDULE_REPORTS',
  ])('TEST K — forged request assigning %s to BURSARY → 400 and no write', async (key) => {
    const res = await request(app).patch(`${API}/admin/roles/BURSARY`).set(ADMIN).send({ permissionKeys: [key] });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain(key);
    expect(state.rolePermKeys.BURSARY).toBeUndefined();
  });

  it('TEST J — a mixed request is rejected wholesale (never partially saved)', async () => {
    const res = await request(app)
      .patch(`${API}/admin/roles/BURSARY`)
      .set(ADMIN)
      .send({ permissionKeys: ['VIEW_DASHBOARD', 'MANAGE_ROLES'] });
    expect(res.status).toBe(400);
    expect(state.rolePermKeys.BURSARY).toBeUndefined();
  });
});

describe('input validation (TEST N, brief §8.7-§8.11)', () => {
  it('TEST N — an unknown permission key is rejected → 400', async () => {
    const res = await request(app)
      .patch(`${API}/admin/roles/BURSARY`)
      .set(ADMIN)
      .send({ permissionKeys: ['VIEW_DASHBOARD', 'TOTALLY_MADE_UP'] });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('TOTALLY_MADE_UP');
    expect(state.rolePermKeys.BURSARY).toBeUndefined();
  });

  it('a non-array permissionKeys is rejected → 400', async () => {
    const res = await request(app).patch(`${API}/admin/roles/BURSARY`).set(ADMIN).send({ permissionKeys: 'VIEW_DASHBOARD' });
    expect(res.status).toBe(400);
  });

  it('a malformed permissionKeys entry is rejected → 400', async () => {
    const res = await request(app).patch(`${API}/admin/roles/BURSARY`).set(ADMIN).send({ permissionKeys: ['  '] });
    expect(res.status).toBe(400);
  });
});

describe('permission catalogue endpoint (brief §4, §7)', () => {
  it('GET /admin/permissions returns the canonical catalogue with ADMIN-only metadata', async () => {
    const res = await request(app).get(`${API}/admin/permissions`).set(ADMIN);
    expect(res.status).toBe(200);
    const items = res.body.data.items as any[];
    expect(items.length).toBe(ALL_PERMISSION_KEYS.length);
    for (const item of items) {
      expect(typeof item.key).toBe('string');
      expect(typeof item.category).toBe('string');
      expect(typeof item.adminOnly).toBe('boolean');
      expect(item.assignable).toBe(!item.adminOnly);
    }
    const schedule = items.find((i) => i.key === 'REPORTS_SCHEDULE');
    expect(schedule.adminOnly).toBe(true);
    expect(schedule.assignable).toBe(false);
    const viewStudents = items.find((i) => i.key === 'VIEW_STUDENTS');
    expect(viewStudents.adminOnly).toBe(false);
    expect(viewStudents.assignable).toBe(true);
  });
});
