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
  adminInitialized: boolean;
} = {
  users: {
    9001: { id: 9001, role: Role.ADMIN, accountStatus: AccountStatus.ACTIVE, isSuperAdmin: true },
    9002: { id: 9002, role: Role.BURSARY, accountStatus: AccountStatus.ACTIVE },
    9003: { id: 9003, role: Role.STUDENT, accountStatus: AccountStatus.ACTIVE },
    // 9004 = a NORMAL ADMIN: role=ADMIN but NOT flagged → governed by its
    // effective permissions (the RBAC-hardening invariant).
    9004: { id: 9004, role: Role.ADMIN, accountStatus: AccountStatus.ACTIVE, isSuperAdmin: false },
  },
  rolePerms: {},
  adminInitialized: true,
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
    // The explicit RBAC_ADMIN_INIT_SENTINEL_ID marker written by seedPermissions().
    // Present ⇒ a stored zero-row ADMIN baseline is honoured literally.
    counter: {
      findUnique: jest.fn(() =>
        Promise.resolve(mockState.adminInitialized ? { id: 'rbac_admin_role_initialized_20261017' } : null),
      ),
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
const NORMAL_ADMIN_TOKEN = token(9004, Role.ADMIN);

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

// ---------------------------------------------------------------------------
// RBAC HARDENING — operational capability mirrors (admin.ts / reports.ts /
// reconciliation.ts). Every one of these is reachable ONLY by a flagged Super
// Admin or a holder of the named canonical capability; a NORMAL ADMIN with an
// empty effective set is denied.
// ---------------------------------------------------------------------------
app.get(`${API}/admin/stats`, protect, restrictTo(Role.ADMIN), requirePermission('VIEW_DASHBOARD'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
app.get(`${API}/admin/email-delivery-logs`, protect, restrictTo(Role.ADMIN, Role.BURSARY), requirePermission('VIEW_EMAIL_DELIVERY_LOGS'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
app.get(`${API}/admin/email-templates/:key`, protect, restrictTo(Role.ADMIN), requirePermission('MANAGE_EMAIL_TEMPLATES'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
app.post(`${API}/admin/users/:id/resend-credentials`, protect, restrictTo(Role.ADMIN), requirePermission('RESEND_CREDENTIALS'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
// Reports EXPORT is a capability (NOT a bare ADMIN grant).
app.get(`${API}/reports/collections/export`, protect, restrictTo(Role.ADMIN, Role.BURSARY), requirePermission('REPORTS_VIEW_COLLECTIONS'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
// Reconciliation internal-item creation needs BOTH view + run capabilities.
app.post(`${API}/reconciliation/items/:reference/create-internal`, protect, restrictTo(Role.ADMIN, Role.BURSARY), requirePermission('VIEW_RECONCILIATION'), requirePermission('RUN_RECONCILIATION'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
// Academic structure mutations require the ADMIN-only canonical capability.
app.post(`${API}/academic/faculties`, protect, restrictTo(Role.ADMIN), requirePermission('MANAGE_ACADEMIC_STRUCTURE'), (_r, res) =>
  res.status(200).json({ ok: 1 }),
);
// Personal-account surface: authentication only, NO capability required.
app.get(`${API}/auth/me`, protect, (_r, res) => res.status(200).json({ ok: 1 }));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err?.statusCode ?? err?.status ?? 500).json({ status: 'error', message: err?.message ?? 'error' });
});

beforeEach(() => {
  mockState.rolePerms = {};
  mockState.adminInitialized = true;
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

// ===========================================================================
// RBAC SECURITY HARDENING — role=ADMIN no longer implies unrestricted access.
// "Only role=ADMIN && isSuperAdmin=true may bypass granular operational
//  permissions. A normal ADMIN must be governed by its effective permissions
//  everywhere."  (9004 is a normal, unflagged ADMIN.)
// ===========================================================================
describe('HARDENING — normal ADMIN is governed by its effective permissions', () => {
  it('a zero-permission normal ADMIN is DENIED on every operational capability route', async () => {
    setRolePerms(Role.ADMIN, []); // stored zero-row ADMIN baseline (sentinel present ⇒ honoured literally)
    const requests: Array<[string, 'get' | 'post']> = [
      ['/admin/stats', 'get'],
      ['/admin/email-delivery-logs', 'get'],
      ['/admin/email-templates/welcome', 'get'],
      ['/admin/users/9003/resend-credentials', 'post'],
      ['/reports/collections/export', 'get'],
      ['/reconciliation/items/REF-1/create-internal', 'post'],
      ['/academic/faculties', 'post'],
    ];
    for (const [path, method] of requests) {
      const res = await (request(app) as any)[method](`${API}${path}`).set(auth(NORMAL_ADMIN_TOKEN));
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it('a normal ADMIN HOLDING the named capability is ALLOWED', async () => {
    setRolePerms(Role.ADMIN, ['VIEW_DASHBOARD']);
    expect((await request(app).get(`${API}/admin/stats`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(200);
    // ...but a capability it does NOT hold is still denied.
    expect((await request(app).get(`${API}/admin/email-delivery-logs`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(403);
  });

  it('capability is per-endpoint — one ADMIN capability never implies another', async () => {
    setRolePerms(Role.ADMIN, ['MANAGE_EMAIL_TEMPLATES']);
    expect((await request(app).get(`${API}/admin/email-templates/welcome`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(200);
    expect((await request(app).get(`${API}/admin/email-delivery-logs`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(403);
    expect((await request(app).post(`${API}/admin/users/9003/resend-credentials`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(403);
    expect((await request(app).get(`${API}/reports/collections/export`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(403);
  });

  it('multi-capability route needs BOTH capabilities (reconciliation create-internal)', async () => {
    setRolePerms(Role.ADMIN, ['VIEW_RECONCILIATION']);
    expect((await request(app).post(`${API}/reconciliation/items/REF-1/create-internal`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(403);
    setRolePerms(Role.ADMIN, ['VIEW_RECONCILIATION', 'RUN_RECONCILIATION']);
    expect((await request(app).post(`${API}/reconciliation/items/REF-1/create-internal`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(200);
  });

  it('personal-account surface stays reachable for a zero-permission ADMIN', async () => {
    setRolePerms(Role.ADMIN, []);
    const res = await request(app).get(`${API}/auth/me`).set(auth(NORMAL_ADMIN_TOKEN));
    expect(res.status).toBe(200);
  });

  it('a stale token claiming capabilities cannot widen a normal ADMIN', async () => {
    setRolePerms(Role.ADMIN, []);
    const stale = token(9004, Role.ADMIN, ['VIEW_DASHBOARD', 'MANAGE_EMAIL_TEMPLATES', 'RESEND_CREDENTIALS']);
    expect((await request(app).get(`${API}/admin/stats`).set(auth(stale))).status).toBe(403);
  });
});

describe('HARDENING — Super Admin regression (flagged ADMIN keeps the bypass)', () => {
  it('flagged ADMIN bypasses EVERY operational capability route with ZERO rows', async () => {
    setRolePerms(Role.ADMIN, []);
    const requests: Array<[string, 'get' | 'post']> = [
      ['/admin/stats', 'get'],
      ['/admin/email-delivery-logs', 'get'],
      ['/admin/email-templates/welcome', 'get'],
      ['/admin/users/9003/resend-credentials', 'post'],
      ['/reports/collections/export', 'get'],
      ['/reconciliation/items/REF-1/create-internal', 'post'],
      ['/academic/faculties', 'post'],
    ];
    for (const [path, method] of requests) {
      const res = await (request(app) as any)[method](`${API}${path}`).set(auth(ADMIN_TOKEN));
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });
});

describe('HARDENING — BURSARY regression (capability-gated, never ADMIN-inherited)', () => {
  it('BURSARY with VIEW_EMAIL_DELIVERY_LOGS reads the delivery log (200)', async () => {
    setRolePerms(Role.BURSARY, ['VIEW_EMAIL_DELIVERY_LOGS']);
    expect((await request(app).get(`${API}/admin/email-delivery-logs`).set(auth(BURSARY_TOKEN))).status).toBe(200);
  });

  it('BURSARY without MANAGE_EMAIL_TEMPLATES is denied template administration (403)', async () => {
    setRolePerms(Role.BURSARY, ['VIEW_EMAIL_DELIVERY_LOGS']);
    expect((await request(app).get(`${API}/admin/email-templates/welcome`).set(auth(BURSARY_TOKEN))).status).toBe(403);
  });

  it('BURSARY cannot reach ADMIN-only academic structure even with a forged row (403)', async () => {
    setRolePerms(Role.BURSARY, ['MANAGE_ACADEMIC_STRUCTURE']);
    expect((await request(app).post(`${API}/academic/faculties`).set(auth(BURSARY_TOKEN))).status).toBe(403);
  });
});

describe('HARDENING — ADMIN baseline initialisation is deterministic (sentinel)', () => {
  it('sentinel PRESENT + zero rows ⇒ zero permissions (no silent full-registry escalation)', async () => {
    mockState.adminInitialized = true;
    setRolePerms(Role.ADMIN, []);
    expect((await request(app).get(`${API}/admin/stats`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(403);
  });

  it('sentinel ABSENT + zero rows ⇒ canonical full-registry floor (prevents administrative lockout)', async () => {
    mockState.adminInitialized = false;
    setRolePerms(Role.ADMIN, []);
    expect((await request(app).get(`${API}/admin/stats`).set(auth(NORMAL_ADMIN_TOKEN))).status).toBe(200);
    mockState.adminInitialized = true; // restored by beforeEach on the next test
  });
});
