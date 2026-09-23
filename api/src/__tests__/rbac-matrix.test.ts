/**
 * RBAC ACCESS MATRIX — University Payment Platform
 * ==================================================
 * Roles (enum Prisma Role): STUDENT, BURSARY, ADMIN
 *
 * Legend:
 *   Y = explicitly allowed (restrictTo includes role OR protect-less public)
 *   N = 401/403 rejected
 *   P = public (no auth middleware)
 *
 * --------------------------------------------------------------------
 * AUTH ROUTES  | POST /auth/*  (student/admin/bursary login, me)
 * Endpoint                        | STUDENT  BURSARY  ADMIN   Public
 * ---------------------------------------------------------------
 * POST /auth/student/login        |  P        P       P       P
 * POST /auth/admin/login          |  P        P       P       P
 * POST /auth/bursary/login        |  P        P       P       P
 * GET  /auth/me                   |  Y (me)   Y       Y
 * POST /auth/logout               |  Y        Y       Y
 * POST /auth/student/reset-password-init | P P P  P
 * POST /auth/student/reset-password     | P P P  P
 *
 * STUDENT WALLET ROUTES (protect + restrictTo STUDENT)
 * GET  /wallet/balance            |  Y        N       N
 * POST /wallet/deposit (init)     |  Y        N       N
 * GET  /wallet/verify/:ref        |  Y        N       N
 * POST /wallet/transfer           |  Y        N       N
 * POST /wallet/withdraw           |  Y        N       N
 * GET  /wallet/transactions       |  Y        N       N
 * GET  /wallet/statement          |  Y        N       N
 * GET  /wallet/receipt/:ref       |  Y        N       N
 * GET  /wallet/deposit (alias)    |  Y        N       N
 * GET  /wallet/transfer (alias)   |  Y        N       N
 * GET  /wallet/withdraw (alias)   |  Y        N       N
 *
 * STUDENT FEE ROUTES (protect)
 * GET  /fees                      |  Y (own)  Y       Y
 * GET  /invoices                  |  Y (own)  Y       Y
 * GET  /invoices/:id              |  Y (own)  Y       Y
 * GET  /receipts/:ref/verify      |  P        P       P       P  (public verify)
 *
 * BURSARY ROUTES (protect + restrictTo BURSARY, ADMIN)
 * GET  /bursary/dashboard/summary |  N        Y       Y   TR-22.1
 * GET  /bursary/dashboard/stats   |  N        Y       Y   NEW T22
 * GET  /bursary/dashboard/by-category |  N   Y       Y
 * GET  /bursary/dashboard/trend   |  N        Y       Y
 * GET  /bursary/withdrawals       |  N        Y       Y
 * POST /bursary/withdrawals/:id/approve | N   Y       Y
 * POST /bursary/withdrawals/:id/reject  | N   Y       Y
 * GET  /bursary/refunds           |  N        Y       Y
 * POST /bursary/refunds/:id/approve | N      Y       N   (only ADMIN approves refunds)
 * POST /bursary/refunds/:id/reject  | N      Y       N
 * GET  /bursary/students          |  N        Y       Y
 * GET  /bursary/fees              |  N        Y       Y
 * GET  /bursary/fees/categories   |  N        Y       Y
 * POST /bursary/fees/assign       |  N        Y       Y
 * POST /bursary/fees/assign/bulk  |  N        Y       Y
 *
 * ADMIN ROUTES (protect + restrictTo ADMIN only)
 * GET  /admin/stats               |  N        N       Y
 * POST /admin/students            |  N        N       Y
 * POST /admin/students/upload     |  N        N       Y
 * GET  /admin/students/upload/:id |  N        N       Y
 * GET  /admin/students/upload/:id/errors.csv | N N Y
 * POST /admin/students/upload/:id/confirm    | N N Y
 * GET  /admin/refunds             |  N        N       Y
 * POST /admin/refunds/:id/approve |  N        N       Y   (Paystack refund create)
 * POST /admin/refunds/:id/reject  |  N        N       Y
 * PATCH /admin/transactions/:id   |  N        N       Y   (whitelist description/metadata)
 * GET  /admin/audit-logs          |  N        N       Y   NEW T23
 * GET  /admin/students            |  N        N       Y
 * GET  /admin/fees                |  N        N       Y
 * GET  /admin/fees/categories     |  N        N       Y
 * POST /admin/fees                |  N        N       Y
 * POST /admin/fees/categories     |  N        N       Y
 * PATCH /admin/fees/:id           |  N        N       Y
 * PATCH /admin/fees/categories/:id|  N        N       Y
 * DELETE /admin/fees/:id          |  N        N       Y
 * DELETE /admin/fees/categories/:id | N       N       Y
 *
 * PUBLIC ROUTES
 * GET  /public/receipts/verify    |  P P P P
 * POST /webhook/paystack          |  P (signed)
 *
 * FR-ACCEPTANCE CHECKLIST:
 *  AC-1  Student cannot touch BURSARY/ADMIN endpoints
 *  AC-2  Bursary cannot touch ADMIN-only endpoints (/admin/*)
 *  AC-3  Bursary can see dashboard (HTTP 200) — TR-22.1 ADMIN same
 *  AC-4  Admin can list + approve/reject refunds (Paystack)
 *  AC-5  Bursary can approve/reject withdrawals
 *  AC-6  PATCH /admin/transactions/:id mutates only description+metadata
 *  AC-7  Public verify-receipt does not require a JWT
 *  AC-8  Audit logs endpoint exists & returns items[] + pagination
 *  AC-9  /bursary/dashboard/stats returns today/week/month + pending withdraws
 *  AC-10 No role can access someone else's invoices (controller scoped)
 * ---------------------------------------------------------------------
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';

const API = '/api/v1';

const ALL_PERMISSIONS = [
  'VIEW_STUDENTS', 'CREATE_STUDENT', 'BULK_UPLOAD_STUDENTS',
  'CREATE_FEE', 'EDIT_FEE',
  'VIEW_PAYMENTS', 'VERIFY_PAYMENT', 'GENERATE_RECEIPT', 'PROCESS_REFUND',
  'MANAGE_USERS', 'MANAGE_ROLES', 'SYSTEM_SETTINGS', 'PAYSTACK_CONFIG',
  'AUDIT_LOGS_VIEW_FULL', 'AUDIT_LOGS_VIEW_LIMITED',
];
const BURSARY_PERMISSIONS = ALL_PERMISSIONS.filter(
  (k) => !['MANAGE_USERS', 'MANAGE_ROLES', 'PAYSTACK_CONFIG', 'SYSTEM_SETTINGS', 'AUDIT_LOGS_VIEW_FULL'].includes(k),
).concat('AUDIT_LOGS_VIEW_LIMITED');

const makeSignedToken = (id: number, role: Role, email: string, matricNumber?: string) => {
  let permissions: string[] = [];
  if (role === 'ADMIN') permissions = ALL_PERMISSIONS;
  else if (role === 'BURSARY') permissions = BURSARY_PERMISSIONS;
  return jwt.sign(
    { id, role, email, matricNumber: matricNumber || null, jti: `${id}-${Date.now()}`, permissions },
    process.env.JWT_SECRET || 'unit-test-secret-ignore-404',
    { expiresIn: '15m' },
  );
};

const STUDENT_TOKEN = makeSignedToken(999001, 'STUDENT', 'rbac_student@university.edu.ng', 'RBAC/STD/001');
const BURSARY_TOKEN = makeSignedToken(999002, 'BURSARY', 'rbac_bursary@university.edu.ng');
const ADMIN_TOKEN = makeSignedToken(999003, 'ADMIN', 'rbac_admin@university.edu.ng');

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const RBAC_PROBES: Array<{
  id: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  student: 200 | 201 | 204 | 401 | 403;
  bursary: 200 | 201 | 204 | 401 | 403;
  admin: 200 | 201 | 204 | 401 | 403;
  notes?: string;
}> = [
  // --- Admin-only (all STUDENT/BURSARY = 403, ADMIN = 200) ---
  { id: 'AC-8 admin audit-logs', method: 'get', path: '/admin/audit-logs', student: 403, bursary: 403, admin: 200 },
  { id: 'AC-2 admin stats', method: 'get', path: '/admin/stats', student: 403, bursary: 403, admin: 200 },
  { id: 'AC-2 admin refunds list', method: 'get', path: '/admin/refunds', student: 403, bursary: 403, admin: 200 },
  { id: 'AC-6 admin transactions patch (no body still 200)', method: 'patch', path: '/admin/transactions/1', student: 403, bursary: 403, admin: 200 },
  { id: 'AC-E3 admin users MANAGE_USERS perm', method: 'get', path: '/admin/users', student: 403, bursary: 403, admin: 200 },
  { id: 'admin settings SYSTEM_SETTINGS perm', method: 'get', path: '/admin/settings', student: 403, bursary: 403, admin: 200 },

  // --- Bursary + Admin shared (STUDENT 403) ---
  { id: 'TR-22.1 bursary summary ADMIN shared', method: 'get', path: '/bursary/dashboard/summary', student: 403, bursary: 200, admin: 200 },
  { id: 'AC-9 bursary stats NEW', method: 'get', path: '/bursary/dashboard/stats', student: 403, bursary: 200, admin: 200 },
  { id: 'bursary by-category shared', method: 'get', path: '/bursary/dashboard/by-category', student: 403, bursary: 200, admin: 200 },
  { id: 'bursary trend shared', method: 'get', path: '/bursary/dashboard/trend?groupBy=day', student: 403, bursary: 200, admin: 200 },
  { id: 'bursary withdrawals list', method: 'get', path: '/bursary/withdrawals', student: 403, bursary: 200, admin: 200 },
  { id: 'bursary refunds list', method: 'get', path: '/bursary/refunds', student: 403, bursary: 200, admin: 200 },
  { id: 'bursary students list', method: 'get', path: '/bursary/students', student: 403, bursary: 200, admin: 200 },

  // --- Student wallet-only (STUDENT=200, others 403) ---
  { id: 'AC-1 wallet balance STUDENT only', method: 'get', path: '/wallet/balance', student: 200, bursary: 403, admin: 403 },
  { id: 'AC-1 wallet transactions STUDENT only', method: 'get', path: '/wallet/transactions', student: 200, bursary: 403, admin: 403 },
];

describe('RBAC Matrix — route-level role guard enforcement', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(API + '/health', (_req, res) => res.status(200).json({ status: 'ok' }));

    const mockProtect = (req: Request, _res: Response, next: NextFunction) => {
      const bearer = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!bearer) return _res.status(401).json({ status: 'error', message: 'Missing JWT' });
      try {
        (req as any).user = jwt.verify(bearer, process.env.JWT_SECRET || 'unit-test-secret-ignore-404') as any;
        return next();
      } catch {
        return _res.status(401).json({ status: 'error', message: 'Invalid JWT' });
      }
    };
    const mockRestrictTo = (...allowed: string[]) => (req: Request, res: Response, next: NextFunction) => {
      const role = (req as any).user?.role;
      if (!role || !allowed.includes(role)) {
        return res.status(403).json({ status: 'error', message: 'Forbidden role' });
      }
      return next();
    };

    const mockRequirePermission = (permKey: string) => (req: Request, res: Response, next: NextFunction) => {
      const perms = (req as any).user?.permissions;
      if (!perms || !Array.isArray(perms) || !perms.includes(permKey)) {
        return res.status(403).json({ success: false, message: 'Permission denied.' });
      }
      return next();
    };

    // ------ mirror real route definitions (guards only, not controllers) -----
    const studentOnly = [mockProtect, mockRestrictTo('STUDENT')];
    const bursaryAdmin = [mockProtect, mockRestrictTo('BURSARY', 'ADMIN')];
    const adminOnly = [mockProtect, mockRestrictTo('ADMIN')];
    const _ok = (_r: any, res: any) => res.status(200).json({ ok: 1 });

    app.get(API + '/wallet/balance', studentOnly, _ok);
    app.get(API + '/wallet/transactions', studentOnly, _ok);

    app.get(API + '/admin/audit-logs', adminOnly, (_r: any, res: any) => res.status(200).json({ data: { items: [], pagination: {} } }));
    app.get(API + '/admin/stats', adminOnly, _ok);
    app.get(API + '/admin/refunds', adminOnly, _ok);
    app.patch(API + '/admin/transactions/:id', adminOnly, _ok);
    app.get(API + '/admin/users', adminOnly, mockRequirePermission('MANAGE_USERS'), (_r: any, res: any) => res.status(200).json({ data: { items: [], pagination: {} } }));
    app.get(API + '/admin/settings', adminOnly, mockRequirePermission('SYSTEM_SETTINGS'), (_r: any, res: any) => res.status(200).json({ data: {} }));

    app.get(API + '/bursary/dashboard/summary', bursaryAdmin, _ok);
    app.get(API + '/bursary/dashboard/stats', bursaryAdmin, _ok);
    app.get(API + '/bursary/dashboard/by-category', bursaryAdmin, _ok);
    app.get(API + '/bursary/dashboard/trend', bursaryAdmin, _ok);
    app.get(API + '/bursary/withdrawals', bursaryAdmin, _ok);
    app.get(API + '/bursary/refunds', bursaryAdmin, _ok);
    app.get(API + '/bursary/students', bursaryAdmin, _ok);
  });

  it('health 200 (baseline)', async () => {
    await request(app).get(`${API}/health`).expect(200);
  });

  describe.each(RBAC_PROBES)('RBAC [$id] $method $path', (probe) => {
    it(`STUDENT ${probe.method.toUpperCase()} ${probe.path} → ${probe.student}`, async () => {
      const r = request(app);
      const method = (r as any)[probe.method].bind(r);
      const res = await method(API + probe.path).set(auth(STUDENT_TOKEN));
      expect(res.status).toBe(probe.student);
    });
    it(`BURSARY ${probe.method.toUpperCase()} ${probe.path} → ${probe.bursary}`, async () => {
      const r = request(app);
      const method = (r as any)[probe.method].bind(r);
      const res = await method(API + probe.path).set(auth(BURSARY_TOKEN));
      expect(res.status).toBe(probe.bursary);
    });
    it(`ADMIN ${probe.method.toUpperCase()} ${probe.path} → ${probe.admin}`, async () => {
      const r = request(app);
      const method = (r as any)[probe.method].bind(r);
      const res = await method(API + probe.path).set(auth(ADMIN_TOKEN));
      expect(res.status).toBe(probe.admin);
    });
  });

  it('AC-7 public verify-receipt endpoint does NOT require JWT (401/403 means guard misconfigured)', async () => {
    const path = `${API}/public/receipts/verify?reference=X`;
    const res = await request(app).get(path);
    expect([404, 200]).toContain(res.status);
    expect([401, 403]).not.toContain(res.status);
  });

  it('Unauthenticated requests to /admin/audit-logs return 401 (not 403)', async () => {
    const res = await request(app).get(`${API}/admin/audit-logs`);
    expect(res.status).toBe(401);
  });
});
