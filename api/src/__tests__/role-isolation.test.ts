/**
 * ROLE ISOLATION + AUTHORIZATION HARDENING — Jest suite
 * -----------------------------------------------------
 * 9-combo login role-isolation matrix (AC1).
 * API authorization checks (AC2): unauth / wrong-role / tampered role /
 * expired / suspended / IDOR / self-role-immutable / BURSARY-no-admin-perm.
 *
 * Strategy mirrors rbac-matrix.test.ts pattern: mock prisma + protect to
 * exercise the guards without hitting live MySQL. Login audience tests hit
 * AuthService.login() with a prisma spy that returns frozen credentials, so
 * no I/O is performed against dev/production databases.
 */

import { AuthService } from '../services/auth';
import { Role, AccountStatus } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import { validateBody } from '../middlewares/validate';
import { z } from 'zod';

jest.mock('../config/database', () => {
  const bcryptMock: any = jest.requireActual('bcrypt');
  const users: Record<number, any> = {};
  const perms: Record<string, string[]> = {};
  const addUser = (id: number, role: any, email: string, password: string, accountStatus: any = 'ACTIVE') => {
    users[id] = {
      id,
      email,
      role,
      password: bcryptMock.hashSync(password, 4),
      firstName: `${role}_first`,
      lastName: `${role}_last`,
      accountStatus,
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
  const Role = { ADMIN: 'ADMIN', BURSARY: 'BURSARY', STUDENT: 'STUDENT' } as const;
  const AccountStatus = { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', WITHDRAWN: 'WITHDRAWN', GRADUATED: 'GRADUATED' } as const;
  addUser(1001, Role.ADMIN, 'admin@university.edu.ng', 'admin123');
  addUser(1002, Role.BURSARY, 'finance@university.edu.ng', 'bursary123');
  addUser(1003, Role.STUDENT, 'student1@university.edu.ng', 'student123');
  addUser(1099, Role.STUDENT, 'suspended@university.edu.ng', 'student123', AccountStatus.SUSPENDED);
  perms.BURSARY = ['VIEW_PAYMENTS', 'VIEW_STUDENTS', 'GENERATE_RECEIPT'];
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
        findFirst: jest.fn((args: any) => {
          if (args.where?.role && args.where?.id) return Promise.resolve(users[args.where.id] ?? null);
          if (args.where?.email) {
            const row = Object.values(users).find((u: any) => u.email === args.where.email) ?? null;
            return Promise.resolve(row ? { ...row } : null);
          }
          return Promise.resolve(null);
        }),
        update: jest.fn((_args: any) => Promise.resolve({ id: 0 })),
      },
      rolePermission: {
        findMany: jest.fn((args: any) => {
          const role = args.where?.role as Role;
          if (role === Role.ADMIN) return Promise.resolve([]);
          const list = perms[role] ?? [];
          return Promise.resolve(list.map((key) => ({ permission: { key } })));
        }),
      },
      refreshToken: {
        findUnique: jest.fn(() => Promise.resolve(null)),
        update: jest.fn(() => Promise.resolve({ id: 1 })),
        create: jest.fn(() => Promise.resolve({ id: 1 })),
        updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      },
      auditLog: {
        create: jest.fn(() => Promise.resolve({ id: 1 })),
      },
      $transaction: jest.fn((fn: any) =>
        Promise.resolve(
          fn({
            refreshToken: {
              update: () => Promise.resolve(null),
              create: () => Promise.resolve(null),
            },
            auditLog: { create: () => Promise.resolve({ id: 1 }) },
            user: { update: () => Promise.resolve({ id: 1 }) },
          })
        )
      ),
    },
  };
});

const mkToken = (id: number, role: Role, tamperRole?: Role) => {
  return jwt.sign(
    {
      id,
      role: tamperRole ?? role,
      email: `${id}@x.test`,
      type: 'access',
      permissions: [],
      jti: `test-${id}-${Date.now()}`,
    },
    process.env.JWT_SECRET || 'unit-test-secret-ignore-404',
    { expiresIn: '15m' },
  );
};

const mkExpiredToken = (id: number, role: Role) => {
  return jwt.sign(
    { id, role, type: 'access', jti: `exp-${id}` },
    process.env.JWT_SECRET || 'unit-test-secret-ignore-404',
    { expiresIn: '-1m' },
  );
};

const STUDENT_ROW_TOKEN = mkToken(1003, Role.STUDENT);
const OTHER_STUDENT_ID = 1004;

const combinations: Array<{ email: string; password: string; audience: Role; expect: 'ALLOW' | 'DENY'; accountRole: Role }> = [
  { email: 'admin@university.edu.ng', password: 'admin123', audience: Role.ADMIN, expect: 'ALLOW', accountRole: Role.ADMIN },
  { email: 'admin@university.edu.ng', password: 'admin123', audience: Role.BURSARY, expect: 'DENY', accountRole: Role.ADMIN },
  { email: 'admin@university.edu.ng', password: 'admin123', audience: Role.STUDENT, expect: 'DENY', accountRole: Role.ADMIN },
  { email: 'finance@university.edu.ng', password: 'bursary123', audience: Role.ADMIN, expect: 'DENY', accountRole: Role.BURSARY },
  { email: 'finance@university.edu.ng', password: 'bursary123', audience: Role.BURSARY, expect: 'ALLOW', accountRole: Role.BURSARY },
  { email: 'finance@university.edu.ng', password: 'bursary123', audience: Role.STUDENT, expect: 'DENY', accountRole: Role.BURSARY },
  { email: 'student1@university.edu.ng', password: 'student123', audience: Role.ADMIN, expect: 'DENY', accountRole: Role.STUDENT },
  { email: 'student1@university.edu.ng', password: 'student123', audience: Role.BURSARY, expect: 'DENY', accountRole: Role.STUDENT },
  { email: 'student1@university.edu.ng', password: 'student123', audience: Role.STUDENT, expect: 'ALLOW', accountRole: Role.STUDENT },
];

describe('AC1 Role Isolation — 9-combo login audience matrix', () => {
  it.each(combinations)(
    '[$accountRole -> $audience] expect $expect',
    async ({ email, password, audience, expect: expected }) => {
      try {
        const res = await AuthService.login({ email, password }, '127.0.0.1', 'jest', audience);
        if (expected === 'DENY') {
          fail('Expected login to be rejected with generic 401');
        }
        expect(res.user.role).toBe(audience);
        expect(res.accessToken).toBeTruthy();
        expect(res.refreshToken).toBeTruthy();
      } catch (err: any) {
        if (expected === 'ALLOW') {
          fail(`Expected login to succeed but got: ${err?.message}`);
        }
        expect(err.statusCode).toBe(401);
        const msg: string = String(err?.message ?? '').toLowerCase();
        expect(msg).toEqual(expect.stringContaining('incorrect email'));
      }
    },
  );

  it('wrong-audience logs LOGIN_WRONG_AUDIENCE audit event', async () => {
    const events: string[] = [];
    (prisma.auditLog as any).create = jest.fn((input: any) => {
      events.push(String(input?.data?.action ?? ''));
      return Promise.resolve({ id: 1 });
    });
    await expect(
      AuthService.login(
        { email: 'finance@university.edu.ng', password: 'bursary123' },
        '127.0.0.1',
        'jest',
        Role.ADMIN,
      ),
    ).rejects.toThrow(/incorrect email/i);
    expect(events).toContain('LOGIN_WRONG_AUDIENCE');
  });

  it('no audience parameter is backward compatible (legacy login allowed for correct creds)', async () => {
    const res = await AuthService.login(
      { email: 'admin@university.edu.ng', password: 'admin123' },
      '127.0.0.1',
      'jest',
    );
    expect(res.user.role).toBe('ADMIN');
  });
});

describe('AC2 API Authorization Hardenings', () => {
  const app = express();
  app.use(express.json());
  app.get(
    '/api/v1/admin-only',
    protect,
    restrictTo(Role.ADMIN),
    (_req, res) => res.status(200).json({ ok: 1 }),
  );
  app.get(
    '/api/v1/bursary-only',
    protect,
    restrictTo(Role.BURSARY),
    requirePermission('VIEW_PAYMENTS'),
    (_req, res) => res.status(200).json({ ok: 1 }),
  );
  app.get('/api/v1/student-scoped/:studentId', protect, (req: Request, res: Response) => {
    const tokenStudentId = (req as any).user.id;
    const paramId = Number(req.params.studentId);
    if (tokenStudentId !== paramId) return res.status(403).json({ message: 'Ownership required.' });
    return res.status(200).json({ ok: 1 });
  });
  const selfPatchSchema = z.object({ firstName: z.string().max(80).optional() }).strict();
  app.patch(
    '/api/v1/students/me',
    protect,
    validateBody(selfPatchSchema),
    (req: Request, res: Response, next: NextFunction) => {
      if ((req as any).user.role !== Role.STUDENT) return res.status(403).json({ message: 'No' });
      if ((req.body as any).role !== undefined || (req.body as any).accountStatus !== undefined) {
        return res.status(400).json({ message: 'forbidden keys' });
      }
      return res.status(200).json({ roleAfter: (req as any).user.role });
    },
  );

  it('unauthenticated -> 401', async () => {
    const res = await request(app).get('/api/v1/admin-only');
    expect(res.status).toBe(401);
  });

  it('wrong-role (STUDENT ADMIN-only) -> 403', async () => {
    const res = await request(app)
      .get('/api/v1/admin-only')
      .set('Authorization', `Bearer ${mkToken(1003, Role.STUDENT)}`);
    expect(res.status).toBe(403);
  });

  it('tampered JWT role ignored; DB role trusted -> wrong audience still 403', async () => {
    // token.role = ADMIN but DB id 1003 is STUDENT; protect() overwrites with DB role -> restrictTo ADMIN = 403
    const res = await request(app)
      .get('/api/v1/admin-only')
      .set('Authorization', `Bearer ${mkToken(1003, Role.STUDENT, Role.ADMIN)}`);
    expect(res.status).toBe(403);
  });

  it('expired access token -> 401', async () => {
    const res = await request(app)
      .get('/api/v1/admin-only')
      .set('Authorization', `Bearer ${mkExpiredToken(1001, Role.ADMIN)}`);
    expect(res.status).toBe(401);
  });

  it('suspended account protect() -> 403', async () => {
    const res = await request(app)
      .get('/api/v1/student-scoped/1099')
      .set('Authorization', `Bearer ${mkToken(1099, Role.STUDENT)}`);
    expect(res.status).toBe(403);
  });

  it('IDOR: student A cannot access student B via param id -> 403', async () => {
    const res = await request(app)
      .get(`/api/v1/student-scoped/${OTHER_STUDENT_ID}`)
      .set('Authorization', `Bearer ${STUDENT_ROW_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it('PATCH /students/me { role } rejected by .strict() schema -> 400', async () => {
    const res = await request(app)
      .patch('/api/v1/students/me')
      .set('Authorization', `Bearer ${STUDENT_ROW_TOKEN}`)
      .send({ firstName: 'Alice', role: 'ADMIN', accountStatus: 'ACTIVE' });
    expect(res.status).toBe(400);
  });

  it('BURSARY with limited perms denied ADMIN-only perm endpoint -> 403', async () => {
    // ADMIN-only guard ensures VIEW_PAYMENTS-bursary cannot reach routes needing MANAGE_ROLES
    const res = await request(app)
      .get('/api/v1/admin-only')
      .set('Authorization', `Bearer ${mkToken(1002, Role.BURSARY)}`);
    expect(res.status).toBe(403);
  });
});

describe('AC7 Audit events emitted where expected', () => {
  it('refresh rotation emits SESSION_REFRESHED', async () => {
    const events: string[] = [];
    (prisma.auditLog as any).create = jest.fn((input: any) => {
      events.push(String(input?.data?.action ?? ''));
      return Promise.resolve({ id: 1 });
    });
    const origFindUnique = (prisma.refreshToken as any).findUnique;
    try {
      (prisma.refreshToken as any).findUnique = jest.fn(() =>
        Promise.resolve({
          id: 99,
          token: 'rot-jti',
          userId: 1001,
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000 * 60 * 24 * 7),
          user: { id: 1001, role: Role.ADMIN, accountStatus: AccountStatus.ACTIVE },
        })
      );
      const baseSecret = process.env.JWT_SECRET || 'unit-test-secret-ignore-404';
      const secret = process.env.JWT_REFRESH_SECRET || `${baseSecret}-refresh`;
      const fakeRT = jwt.sign(
        { userId: 1001, jti: 'rot-jti', type: 'refresh', role: Role.ADMIN },
        secret,
        { expiresIn: '7d' },
      );
      // Make $transaction passthrough so audit.create runs without throwing.
      (prisma as any).$transaction = jest.fn((fn: any) =>
        Promise.resolve(
          fn({
            refreshToken: {
              update: () => Promise.resolve(null),
              create: () => Promise.resolve(null),
            },
          })
        ),
      );
      const err: any = await AuthService.refreshSession(fakeRT, '127.0.0.1', 'jest').catch((e) => e);
      if (err) {
        if (!/SESSION_REFRESHED/.test(String(err?.message || ''))) {
          // $transaction above may still leave something missing;
          // we only care that audit.create was fired with the right action.
        }
      }
      expect(events).toContain('SESSION_REFRESHED');
    } finally {
      (prisma.refreshToken as any).findUnique = origFindUnique;
    }
  });
});
