/**
 * RBAC AUTHORIZATION LAYERS — regression suite
 * =============================================================================
 * Exercises the REAL authorization middlewares (protect / restrictTo /
 * requirePermission) from src/middlewares/auth.ts against a mocked Prisma
 * client. No live DB, no production data, no network.
 *
 * Proves brief §10 (4 defence layers), §11 (backend is authoritative),
 * §16 (report permissions) and §19 TEST A / E / F / J / V / W / X / Y / Z.
 */

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role, AccountStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Mocked Prisma: only user.findUnique (protect) + rolePermission.findMany
// (live permission resolution) are used by the middlewares under test.
// ---------------------------------------------------------------------------
const mockState: {
  users: Record<number, { id: number; role: Role; accountStatus: AccountStatus; isSuperAdmin?: boolean }>;
  rolePerms: Record<string, string[]>;
} = {
  users: {
    9001: { id: 9001, role: Role.ADMIN, accountStatus: AccountStatus.ACTIVE, isSuperAdmin: true },
    9002: { id: 9002, role: Role.BURSARY, accountStatus: AccountStatus.ACTIVE },
    9003: { id: 9003, role: Role.STUDENT, accountStatus: AccountStatus.ACTIVE },
  },
  rolePerms: {},
};

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn((args: any) => Promise.resolve(mockState.users[args.where.id] ?? null)),
    },
    rolePermission: {
      findMany: jest.fn((args: any) => {
        const role = String(args?.where?.role ?? '');
        const keys = mockState.rolePerms[role] ?? [];
        return Promise.resolve(keys.map((key) => ({ permission: { key } })));
      }),
    },
  },
}));

import { protect, restrictTo, requirePermission, bumpRolePermsVersion } from '../middlewares/auth';
import { ALL_PERMISSION_KEYS, isAdminOnlyPermission } from '../services/permissionSeed';

const API = '/api/v1';

const token = (id: number, role: Role, claimedPermissions: string[] = [], type = 'access') =>
  jwt.sign(
    { id, role, email: `${role.toLowerCase()}@uni.edu.ng`, permissions: claimedPermissions, type, jti: `${id}-${Date.now()}` },
    process.env.JWT_SECRET || 'unit-test-secret-ignore-404',
    { expiresIn: '15m' },
  );

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const ADMIN_TOKEN = token(9001, Role.ADMIN);
const BURSARY_TOKEN = token(9002, Role.BURSARY);
const STUDENT_TOKEN = token(9003, Role.STUDENT);

/** Set the authoritative live RolePermission rows for a role. */
const setRolePerms = (role: Role, keys: string[]) => {
  mockState.rolePerms[role] = keys;
  // Force the 1s role-permission cache to be bypassed on the next request.
  bumpRolePermsVersion();
};

const app = express();
app.use(express.json());

// Mirrors the real BURSARY/ADMIN student routes (students.ts): role boundary + capability.
app.get(`${API}/students`, protect, restrictTo(Role.ADMIN, Role.BURSARY), requirePermission('VIEW_STUDENTS'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
// Mirrors /bursary/payments style routes.
app.get(`${API}/bursary/payments`, protect, restrictTo(Role.ADMIN, Role.BURSARY), requirePermission('VIEW_PAYMENTS'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
// ADMIN-only capability that must NEVER be reachable by a non-ADMIN, even with a forged row.
app.get(`${API}/admin/roles`, protect, restrictTo(Role.ADMIN), requirePermission('MANAGE_ROLES'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
app.get(`${API}/admin/scheduled-reports`, protect, restrictTo(Role.ADMIN), requirePermission('REPORTS_SCHEDULE'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
// Report permissions must remain distinct capabilities.
app.get(`${API}/reports/collections`, protect, restrictTo(Role.ADMIN, Role.BURSARY), requirePermission('REPORTS_VIEW_COLLECTIONS'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
app.get(`${API}/reports/revenue`, protect, restrictTo(Role.ADMIN, Role.BURSARY), requirePermission('REPORTS_VIEW_REVENUE'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
// Mirror of the academic levels/sessions read gates.
app.get(`${API}/academic/levels`, protect, restrictTo(Role.ADMIN, Role.BURSARY), requirePermission('VIEW_LEVELS'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err?.statusCode ?? err?.status ?? 500).json({ status: 'error', message: err?.message ?? 'error' });
});

beforeEach(() => {
  mockState.rolePerms = {};
  bumpRolePermsVersion();
});

describe('RBAC — authentication boundary (protect)', () => {
  it('unauthenticated request → 401', async () => {
    const res = await request(app).get(`${API}/students`);
    expect(res.status).toBe(401);
  });

  it('non-access token type → 401', async () => {
    const res = await request(app)
      .get(`${API}/students`)
      .set(auth(token(9002, Role.BURSARY, [], 'refresh')));
    expect(res.status).toBe(401);
  });
});

describe('TEST A — ADMIN is recognised as the protected super-administrator', () => {
  it('ADMIN passes an ADMIN-only capability with ZERO RolePermission rows', async () => {
    setRolePerms(Role.ADMIN, []); // deliberately empty — bypass must not depend on rows
    const res = await request(app).get(`${API}/admin/roles`).set(auth(ADMIN_TOKEN));
    expect(res.status).toBe(200);
    expect(isAdminOnlyPermission('MANAGE_ROLES')).toBe(true);
  });

  it('ADMIN passes every registry capability (REPORTS_SCHEDULE included)', async () => {
    setRolePerms(Role.ADMIN, []);
    const res = await request(app).get(`${API}/admin/scheduled-reports`).set(auth(ADMIN_TOKEN));
    expect(res.status).toBe(200);
  });

  it('ADMIN receives the FULL canonical registry from protect()', async () => {
    setRolePerms(Role.ADMIN, []);
    let effective: string[] = [];
    const probe = express();
    probe.get('/probe', protect, (req: any, res) => {
      effective = req.user.permissions;
      res.status(200).json({ ok: 1 });
    });
    const res = await request(probe).get('/probe').set(auth(ADMIN_TOKEN));
    expect(res.status).toBe(200);
    expect(effective.sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
  });
});

describe('TEST E / F — BURSARY capability is resolved LIVE and is revocable', () => {
  it('TEST W — BURSARY WITH VIEW_STUDENTS reaches the protected Students read', async () => {
    setRolePerms(Role.BURSARY, ['VIEW_STUDENTS']);
    const res = await request(app).get(`${API}/students`).set(auth(BURSARY_TOKEN));
    expect(res.status).toBe(200);
  });

  it('TEST E — removing VIEW_STUDENTS immediately returns 403 (no stale window)', async () => {
    setRolePerms(Role.BURSARY, ['VIEW_STUDENTS']);
    expect((await request(app).get(`${API}/students`).set(auth(BURSARY_TOKEN))).status).toBe(200);

    setRolePerms(Role.BURSARY, []);
    const res = await request(app).get(`${API}/students`).set(auth(BURSARY_TOKEN));
    expect(res.status).toBe(403);
  });

  it('TEST F — restoring VIEW_STUDENTS restores access', async () => {
    setRolePerms(Role.BURSARY, []);
    expect((await request(app).get(`${API}/students`).set(auth(BURSARY_TOKEN))).status).toBe(403);

    setRolePerms(Role.BURSARY, ['VIEW_STUDENTS']);
    const res = await request(app).get(`${API}/students`).set(auth(BURSARY_TOKEN));
    expect(res.status).toBe(200);
  });

  it('STALE TOKEN — a JWT claiming VIEW_STUDENTS cannot override an empty DB grant', async () => {
    setRolePerms(Role.BURSARY, []);
    const staleToken = token(9002, Role.BURSARY, ['VIEW_STUDENTS', 'VIEW_PAYMENTS']);
    const res = await request(app).get(`${API}/students`).set(auth(staleToken));
    expect(res.status).toBe(403);
  });

  it('BURSARY holding VIEW_STUDENTS cannot reach an endpoint needing VIEW_PAYMENTS', async () => {
    setRolePerms(Role.BURSARY, ['VIEW_STUDENTS']);
    const res = await request(app).get(`${API}/bursary/payments`).set(auth(BURSARY_TOKEN));
    expect(res.status).toBe(403);
  });
});

describe('TEST X / J / Z — ADMIN-only layer 4 stops non-ADMIN even with a forged RolePermission row', () => {
  it('TEST X — BURSARY with a forged MANAGE_ROLES row still gets 403', async () => {
    setRolePerms(Role.BURSARY, ['MANAGE_ROLES', 'MANAGE_USERS', 'IMPERSONATE_USERS']);
    const res = await request(app).get(`${API}/admin/roles`).set(auth(BURSARY_TOKEN));
    expect(res.status).toBe(403);
  });

  it('TEST Z — REPORTS_SCHEDULE cannot be reached by BURSARY even if a row exists', async () => {
    setRolePerms(Role.BURSARY, ['REPORTS_SCHEDULE']);
    const res = await request(app).get(`${API}/admin/scheduled-reports`).set(auth(BURSARY_TOKEN));
    expect(res.status).toBe(403);
  });

  it('ADMIN-only keys are never returned as Bursary-assignable by the registry', async () => {
    expect(ALL_PERMISSION_KEYS).not.toContain('__NOT_A_KEY__');
    for (const key of ['MANAGE_ROLES', 'MANAGE_USERS', 'IMPERSONATE_USERS', 'APPROVE_REFUNDS', 'FLUSH_QUEUES', 'REPORTS_SCHEDULE', 'SCHEDULE_REPORTS', 'SYSTEM_SETTINGS', 'PAYSTACK_CONFIG', 'MANAGE_PAYMENT_PROVIDERS', 'MANAGE_EMAIL_TEMPLATES', 'AUDIT_LOGS_VIEW_FULL']) {
      expect(isAdminOnlyPermission(key)).toBe(true);
    }
  });
});

describe('TEST Y — report permissions are distinct capabilities', () => {
  it('REPORTS_VIEW_COLLECTIONS grants only the collections report', async () => {
    setRolePerms(Role.BURSARY, ['REPORTS_VIEW_COLLECTIONS']);
    expect((await request(app).get(`${API}/reports/collections`).set(auth(BURSARY_TOKEN))).status).toBe(200);
    expect((await request(app).get(`${API}/reports/revenue`).set(auth(BURSARY_TOKEN))).status).toBe(403);
  });

  it('REPORTS_VIEW_REVENUE grants only the revenue report', async () => {
    setRolePerms(Role.BURSARY, ['REPORTS_VIEW_REVENUE']);
    expect((await request(app).get(`${API}/reports/revenue`).set(auth(BURSARY_TOKEN))).status).toBe(200);
    expect((await request(app).get(`${API}/reports/collections`).set(auth(BURSARY_TOKEN))).status).toBe(403);
  });
});

describe('TEST G/H-adjacent — zero-permission BURSARY is a valid, functional state', () => {
  it('zero permissions → 403 on capability routes but 200 on nothing protected', async () => {
    setRolePerms(Role.BURSARY, []);
    for (const p of ['/students', '/bursary/payments', '/reports/collections', '/academic/levels']) {
      const res = await request(app).get(`${API}${p}`).set(auth(BURSARY_TOKEN));
      expect(res.status).toBe(403);
    }
  });

  it('academic levels read is permission-gated (VIEW_LEVELS), not role-only', async () => {
    setRolePerms(Role.BURSARY, ['VIEW_LEVELS']);
    expect((await request(app).get(`${API}/academic/levels`).set(auth(BURSARY_TOKEN))).status).toBe(200);
    setRolePerms(Role.BURSARY, ['VIEW_STUDENTS']);
    expect((await request(app).get(`${API}/academic/levels`).set(auth(BURSARY_TOKEN))).status).toBe(403);
  });
});

describe('restrictTo — hard role boundary', () => {
  it('STUDENT is rejected from a BURSARY/ADMIN route → 403', async () => {
    setRolePerms(Role.STUDENT, ['VIEW_STUDENTS']);
    const res = await request(app).get(`${API}/students`).set(auth(STUDENT_TOKEN));
    expect(res.status).toBe(403);
  });
});
