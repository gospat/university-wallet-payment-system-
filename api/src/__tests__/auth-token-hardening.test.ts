import { AuthService } from '../services/auth';
import { Role, AccountStatus } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import * as authController from '../controllers/auth';
import { PERMISSION_DEFS } from '../services/permissionSeed';

jest.mock('../config/database', () => {
  const bcryptMock: any = jest.requireActual('bcrypt');
  const users: Record<number, any> = {};
  const perms: Record<string, string[]> = {};
  const addUser = (
    id: number,
    role: any,
    email: string,
    password: string,
    accountStatus: any = 'ACTIVE',
    isSuperAdmin = false,
  ) => {
    users[id] = {
      id,
      email,
      role,
      isSuperAdmin,
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
      matricNumber: null,
      college: null,
      department: null,
      program: null,
      level: null,
      academicSession: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  };
  const Role = { ADMIN: 'ADMIN', BURSARY: 'BURSARY', STUDENT: 'STUDENT' } as const;
  const AccountStatus = { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', WITHDRAWN: 'WITHDRAWN', GRADUATED: 'GRADUATED' } as const;
  // User 2001 is a FLAG-AWARE Super Administrator (role=ADMIN + isSuperAdmin=true):
  // the canonical full-access principal that intentionally bypasses per-permission
  // checks. A bare role=ADMIN would NOT be a super admin under the current model.
  addUser(2001, Role.ADMIN, 'admin@university.edu.ng', 'admin123', 'ACTIVE', true);
  addUser(2002, Role.BURSARY, 'finance@university.edu.ng', 'bursary123');
  addUser(2003, Role.STUDENT, 'student1@university.edu.ng', 'student123');
  perms.BURSARY = ['VIEW_PAYMENTS', 'VIEW_STUDENTS', 'GENERATE_RECEIPT'];
  perms.STUDENT = [];
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
          const role = args.where?.role as string;
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
      // RBAC baseline sentinel: PRESENT ⇒ marker 'initialized' ⇒ a stored zero-row
      // ADMIN role baseline is honoured literally (no full-registry escalation).
      counter: {
        findUnique: jest.fn(() => Promise.resolve({ id: 1 })),
      },
      // Individual access profile: genuine null ⇒ 'absent' ⇒ INHERIT the role
      // baseline (never the fail-closed 'error' branch).
      userPermissionProfile: {
        findUnique: jest.fn(() => Promise.resolve(null)),
      },
      $transaction: jest.fn((fn: any) =>
        Promise.resolve(
          fn({
            refreshToken: {
              update: () => Promise.resolve(null),
              // Atomic rotation claim (§ requirement 8) — the conditional
              // updateMany must report exactly one claimed row for a valid,
              // unrevoked, unexpired refresh token.
              updateMany: () => Promise.resolve({ count: 1 }),
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

const decodeJwt = (token: string) => {
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  return payload;
};

describe('Auth token payload hardening — permissions resolved server-side', () => {
  it('login access token does NOT embed permissions array in JWT', async () => {
    const res = await AuthService.login(
      { email: 'admin@university.edu.ng', password: 'admin123' },
      '127.0.0.1',
      'jest',
      Role.ADMIN,
    );
    const payload = decodeJwt(res.accessToken);
    expect(payload.type).toBe('access');
    expect(payload.role).toBe('ADMIN');
    expect(payload.id).toBe(2001);
    expect(payload.permissions).toBeUndefined();
  });

  it('login response user object still carries permissions (from DB) even though JWT does not', async () => {
    const res = await AuthService.login(
      { email: 'finance@university.edu.ng', password: 'bursary123' },
      '127.0.0.1',
      'jest',
      Role.BURSARY,
    );
    expect(Array.isArray(res.user.permissions)).toBe(true);
    expect(res.user.permissions).toContain('VIEW_PAYMENTS');
  });

  it('access token size stays well below the threshold that triggered the Nginx upstream header outage', async () => {
    const res = await AuthService.login(
      { email: 'admin@university.edu.ng', password: 'admin123' },
      '127.0.0.1',
      'jest',
      Role.ADMIN,
    );
    const tokenBytes = Buffer.byteLength(res.accessToken, 'utf8');
    const ADMIN_PERM_COUNT = PERMISSION_DEFS.length;
    const estimatedLegacyBytes = tokenBytes + ADMIN_PERM_COUNT * 18;
    expect(tokenBytes).toBeLessThan(1024);
    expect(estimatedLegacyBytes).toBeGreaterThan(tokenBytes);
    expect(tokenBytes).toBeLessThan(estimatedLegacyBytes);
  });
});

describe('Auth transport — HttpOnly refresh cookie, never an access-token cookie', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.post('/api/v1/auth/login', authController.login);
    app.post('/api/v1/auth/refresh', authController.refresh as any);
    app.get('/api/v1/auth/me', protect, authController.me);
    app.post('/api/v1/auth/logout', protect, authController.logout as any);
  });

  it('login sets an HttpOnly SameSite=Lax refresh cookie, never an access_token cookie, and no refreshToken in the body', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@university.edu.ng', password: 'admin123' });
    expect(res.status).toBe(200);

    const setCookieHeader = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    const cookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
      ? [setCookieHeader]
      : [];
    const cookieNames = cookies.map((c) => String(c).split('=')[0].trim());

    // The access token must NEVER be placed in a cookie.
    expect(cookieNames).not.toContain('access_token');

    // The refresh token is delivered via an HttpOnly, SameSite=Lax cookie.
    const refreshCookie = cookies.find((c) => String(c).startsWith('refresh_token='));
    expect(refreshCookie).toBeTruthy();
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(refreshCookie).toMatch(/SameSite=Lax/i);

    // The access token IS still returned in the body; the refresh token is NOT.
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeUndefined();
  });
});

describe('Auth refresh session — token rotation without JWT permissions', () => {
  it('refreshSession returns access token without permissions claim', async () => {
    const loginRes = await AuthService.login(
      { email: 'admin@university.edu.ng', password: 'admin123' },
      '127.0.0.1',
      'jest',
    );
    const refreshJwt = loginRes.refreshToken;
    const decoded = jwt.decode(refreshJwt) as any;
    (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 1,
      token: decoded.jti,
      userId: 2001,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      user: { id: 2001, role: Role.ADMIN, accountStatus: AccountStatus.ACTIVE },
    });
    const refreshRes = await AuthService.refreshSession(refreshJwt, '127.0.0.1', 'jest');
    const payload = decodeJwt(refreshRes.accessToken);
    expect(payload.permissions).toBeUndefined();
    expect(payload.type).toBe('access');
  });
});

describe('Auth /auth/me — permissions resolved server-side', () => {
  it('me() returns permissions for BURSARY from DB rolePermission rows', async () => {
    const me = await AuthService.me(2002);
    expect(Array.isArray(me.permissions)).toBe(true);
    expect(me.permissions).toContain('VIEW_PAYMENTS');
    expect(me.permissions).toContain('VIEW_STUDENTS');
  });

  it('me() returns all PERMISSION_DEFS keys for ADMIN', async () => {
    const me = await AuthService.me(2001);
    expect(me.permissions.length).toBe(PERMISSION_DEFS.length);
  });
});

describe('Auth logout — session revocation', () => {
  it('revokeSingle marks refresh token revoked', async () => {
    const loginRes = await AuthService.login(
      { email: 'admin@university.edu.ng', password: 'admin123' },
      '127.0.0.1',
      'jest',
    );
    const decoded = jwt.decode(loginRes.refreshToken) as any;
    (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 99,
      token: decoded.jti,
      userId: 2001,
      revokedAt: null,
    });
    const result = await AuthService.revokeSingle(2001, loginRes.refreshToken);
    expect(result.revoked).toBe(true);
  });

  it('revokeAll revokes all active sessions for user', async () => {
    (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValueOnce({ count: 3 });
    await AuthService.revokeAll(2001);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
  });
});

describe('Auth middleware — server-side permission resolution', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.get(
      '/api/v1/protected',
      protect,
      requirePermission('VIEW_PAYMENTS'),
      (_req: Request, res: Response) => res.status(200).json({ ok: true }),
    );
    app.get(
      '/api/v1/admin-only',
      protect,
      restrictTo(Role.ADMIN),
      (_req: Request, res: Response) => res.status(200).json({ ok: true }),
    );
  });

  it('BURSARY token with VIEW_PAYMENTS permission (resolved from DB) can access protected route', async () => {
    const bursaryToken = jwt.sign(
      { id: 2002, role: Role.BURSARY, type: 'access' },
      process.env.JWT_SECRET as string,
      { expiresIn: '15m' },
    );
    const res = await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${bursaryToken}`);
    expect(res.status).toBe(200);
  });

  it('STUDENT token (no VIEW_PAYMENTS perm) is denied protected route', async () => {
    const studentToken = jwt.sign(
      { id: 2003, role: Role.STUDENT, type: 'access' },
      process.env.JWT_SECRET as string,
      { expiresIn: '15m' },
    );
    const res = await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });

  it('ADMIN token bypasses requirePermission (role-based superuser)', async () => {
    const adminToken = jwt.sign(
      { id: 2001, role: Role.ADMIN, type: 'access' },
      process.env.JWT_SECRET as string,
      { expiresIn: '15m' },
    );
    const res = await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('STUDENT cannot access ADMIN-only route', async () => {
    const studentToken = jwt.sign(
      { id: 2003, role: Role.STUDENT, type: 'access' },
      process.env.JWT_SECRET as string,
      { expiresIn: '15m' },
    );
    const res = await request(app)
      .get('/api/v1/admin-only')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });

  it('unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/v1/protected');
    expect(res.status).toBe(401);
  });
});
