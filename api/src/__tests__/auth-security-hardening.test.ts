/**
 * AUTH SECURITY HARDENING — regression suite
 * =====================================================================
 * Covers the authentication/session requirements of the security-hardening
 * spec that were not already exercised elsewhere:
 *
 *   R1  the bootstrap credential is the student's lower-cased SURNAME and the
 *       mandatory first-login password change is enforced by the BACKEND;
 *   R2  public self-signup is impossible (404, no account created);
 *   R6  a password-reset token is single-use even under CONCURRENCY;
 *   R8  refresh-token rotation is atomic even under CONCURRENCY;
 *   R9  every password/credential security event invalidates existing sessions
 *       (already-issued access tokens included);
 *   R24 a newly chosen password is never written to the application log.
 *
 * The suite is fully DB-free: Prisma and Redis are replaced with in-memory
 * doubles (with a genuinely ATOMIC claim primitive) so it runs in CI where no
 * MySQL / Redis is available. Nothing here touches live financial data.
 */

jest.mock('../config/database', () => {
  const bcryptMock: any = jest.requireActual('bcrypt');

  type Row = Record<string, any>;
  const users: Record<number, Row> = {};
  const rolePerms: Record<string, string[]> = {};
  // A token jti can be claimed at most once — mirrors `SET … NX` semantics.
  const claimedRefreshTokens = new Set<string>();

  const seed = (id: number, role: string, email: string, password: string, extra: Row = {}) => {
    users[id] = {
      id,
      email,
      role,
      isSuperAdmin: false,
      password: bcryptMock.hashSync(password, 4),
      firstName: 'Ada',
      middleName: null,
      lastName: 'Staff',
      matricNumber: null,
      college: null,
      department: null,
      program: null,
      level: null,
      academicSession: null,
      accountStatus: 'ACTIVE',
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      authVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    };
  };

  const STUDENT = 'STUDENT';
  const ADMIN = 'ADMIN';
  const BURSARY = 'BURSARY';

  // 3001 — student still holding the predictable bootstrap credential.
  seed(3001, STUDENT, 'chidi.nwachukwu@university.edu.ng', 'nwachukwu', {
    firstName: 'Chidi',
    lastName: 'Nwachukwu',
    matricNumber: '2024/CSC/0012',
    mustChangePassword: true,
    authVersion: 2,
  });
  // 3002 — staff account used for the forbidden-new-password checks.
  seed(3002, BURSARY, 'finance.office@university.edu.ng', 'bursary123', {
    lastName: 'Chukwuemeka',
  });
  // 3003 — flag-aware Super Admin (login / refresh happy paths).
  seed(3003, ADMIN, 'root@university.edu.ng', 'rootpass1', { isSuperAdmin: true });
  // 3004 — dedicated target for the concurrent reset-token test.
  seed(3004, STUDENT, 'reset.target@university.edu.ng', 'target', {
    lastName: 'Target',
    mustChangePassword: true,
  });
  // 3006 — dedicated target for the matric-number rule.
  seed(3006, STUDENT, 'adeyemi@university.edu.ng', 'stablepass9', {
    lastName: 'Adeyemi',
    matricNumber: '2024/ACC/0045',
    mustChangePassword: true,
  });

  rolePerms.STUDENT = [];
  rolePerms.BURSARY = ['VIEW_PAYMENTS', 'VIEW_STUDENTS', 'GENERATE_RECEIPT'];
  rolePerms.ADMIN = [];

  const pick = (row: Row | null | undefined, select?: Record<string, boolean>) => {
    if (!row) return null;
    if (!select) return { ...row };
    const out: Row = {};
    for (const key of Object.keys(select)) if ((select as any)[key]) out[key] = row[key];
    return out;
  };

  const applyUpdate = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data ?? {})) {
      if (value && typeof value === 'object' && 'increment' in value) {
        row[key] = Number(row[key] ?? 0) + Number((value as any).increment);
      } else {
        row[key] = value;
      }
    }
    return { ...row };
  };

  const tx = {
    user: {
      update: jest.fn(async (args: any) => applyUpdate(users[args.where.id], args.data ?? {})),
    },
    refreshToken: {
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async (args: any) => {
        const token = args?.where?.token;
        if (typeof token === 'string') {
          // ATOMIC single-claim: exactly ONE concurrent caller sees count === 1.
          if (claimedRefreshTokens.has(token)) return { count: 0 };
          claimedRefreshTokens.add(token);
          return { count: 1 };
        }
        return { count: 0 }; // bulk revoke by userId
      }),
      create: jest.fn(async () => ({ id: 1 })),
    },
    auditLog: { create: jest.fn(async () => ({ id: 1 })) },
  };

  const base: Row = {
    user: {
      findUnique: jest.fn(async (args: any) => {
        const where = args?.where ?? {};
        if (typeof where.id === 'number') return pick(users[where.id] ?? null, args?.select);
        if (typeof where.email === 'string') {
          const row = Object.values(users).find((u) => u.email === where.email) ?? null;
          return pick(row, args?.select);
        }
        return null;
      }),
      findFirst: jest.fn(async (args: any) => {
        const where = args?.where ?? {};
        if (typeof where.email === 'string') {
          const row = Object.values(users).find((u) => u.email === where.email) ?? null;
          return pick(row, args?.select);
        }
        if (Array.isArray(where.OR)) {
          const wanted = where.OR.map((clause: any) => clause?.matricNumber).filter(Boolean);
          const row = Object.values(users).find((u) => wanted.includes(u.matricNumber)) ?? null;
          return pick(row, args?.select);
        }
        if (typeof where.id === 'number' && typeof where.role === 'string') {
          const row = users[where.id];
          return row && row.role === where.role ? pick(row, args?.select) : null;
        }
        return null;
      }),
      update: jest.fn(async (args: any) => applyUpdate(users[args.where.id], args.data ?? {})),
    },
    refreshToken: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async () => ({ id: 1 })),
    },
    rolePermission: {
      findMany: jest.fn(async (args: any) => {
        const list = rolePerms[args?.where?.role as string] ?? [];
        return list.map((key) => ({ permission: { key } }));
      }),
    },
    userPermissionProfile: { findUnique: jest.fn(async () => null) },
    counter: { findUnique: jest.fn(async () => ({ id: 'rbac_admin_role_initialized_20261017' })) },
    auditLog: { create: jest.fn(async () => ({ id: 1 })) },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(tx) : Promise.all(arg),
    ),
  };

  return { __esModule: true, default: base, __tx: tx, __users: users };
});

// Redis double — `set(key, value, 'EX', ttl, 'NX')` is evaluated atomically,
// which is exactly the single-use guarantee `claimResetToken` relies on.
jest.mock('../config/redis', () => {
  const store = new Map<string, string>();
  const client: any = {
    status: 'ready',
    set: jest.fn(async (key: string, value: string, _ex?: string, _ttl?: number, mode?: string) => {
      if (mode === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => (store.has(key) ? (store.get(key) as string) : null)),
    incr: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    quit: jest.fn(async () => 'OK'),
    disconnect: jest.fn(),
  };
  return {
    __esModule: true,
    getRedis: () => client,
    connectRedis: () => Promise.resolve(client),
    shutdownProducerRedis: () => Promise.resolve(),
    createBullmqWorkerConnection: () => client,
    createBullmqProducerConnection: () => client,
    default: client,
    __store: store,
  };
});

// Keep the mail/queue graph out of the import path (no BullMQ at import time).
jest.mock('../queues/emailQueue', () => ({ __esModule: true, dispatchEmail: jest.fn() }));

import bcrypt from 'bcrypt';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import authRouter from '../routes/auth';
import { protect } from '../middlewares/auth';
import { globalErrorHandler } from '../middlewares/error';

const SECRET = process.env.JWT_SECRET as string;
const dbMock = (): any => jest.requireMock('../config/database');
const usersOf = (): Record<number, any> => dbMock().__users;
const txOf = (): any => dbMock().__tx;

const ok = (_req: any, res: any) => res.status(200).json({ ok: true });

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  // The HttpOnly refresh cookie is read from `req.cookies`, so the harness must
  // parse cookies exactly as production does (app.ts mounts cookieParser()).
  app.use(cookieParser());
  app.use('/api/v1/auth', authRouter);
  // Protected (financial/student) surfaces — every one of these MUST be blocked
  // for a first-login restricted student.
  app.get('/api/v1/students/dashboard', protect, ok);
  app.get('/api/v1/students/invoices', protect, ok);
  app.get('/api/v1/students/transactions', protect, ok);
  app.post('/api/v1/students/payments/initiate', protect, ok);
  app.get('/api/v1/students/receipts/:id/download', protect, ok);
  app.get('/api/v1/students/statements', protect, ok);
  // Mirror the production error contract ({ status, message }) so the AppError
  // mapping is exercised exactly as it is in the real app.
  app.use(globalErrorHandler);
  return app;
}

const app = buildApp();

/** Access token stamped with the CURRENT authoritative session generation. */
const accessTokenFor = (id: number, role: string, ver?: number) =>
  jwt.sign(
    { id, role, type: 'access', ver: ver ?? Number(usersOf()[id]?.authVersion ?? 0) },
    SECRET,
    { expiresIn: '15m', algorithm: 'HS256' },
  );

beforeEach(() => {
  (jest.requireMock('../config/redis') as any).__store.clear();
  (jest.requireMock('../config/database') as any).default.refreshToken.findUnique.mockReset();
  (jest.requireMock('../config/database') as any).default.refreshToken.findUnique.mockResolvedValue(null);
});

// =============================================================================
// R2 — public self-signup is impossible
// =============================================================================
describe('R2 — anonymous self-signup is impossible', () => {
  it('POST /api/v1/auth/signup answers 404 and creates no account', async () => {
    const before = Object.keys(usersOf()).length;

    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({
        email: 'attacker@university.edu.ng',
        password: 'Sup3rSecret!',
        firstName: 'Mallory',
        lastName: 'Attacker',
        role: 'ADMIN',
      });

    expect(res.status).toBe(404);
    expect(Object.keys(usersOf()).length).toBe(before);
    expect(
      Object.values(usersOf()).some((u: any) => u.email === 'attacker@university.edu.ng'),
    ).toBe(false);
    // Never 403/410 — the endpoint must not disclose anything about prior state.
    expect(res.body.status).toBe('fail');
  });

  it('there is no signup controller or AuthService.signup export to call', () => {
    const controller = jest.requireActual('../controllers/auth');
    expect((controller as any).signup).toBeUndefined();
    const service = jest.requireActual('../services/auth');
    expect((service as any).AuthService.signup).toBeUndefined();
  });
});

// =============================================================================
// R1 — bootstrap credential + backend-enforced first-login password change
// =============================================================================
describe('R1 — student logs in with the bootstrap (surname) credential', () => {
  it('authenticates with the lower-cased surname and reports mustChangePassword=true', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'chidi.nwachukwu@university.edu.ng', password: 'nwachukwu' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.mustChangePassword).toBe(true);
    expect(res.body.data.user.role).toBe('STUDENT');
    // The credential itself is never echoed back, and neither is the internal
    // session-generation counter.
    expect(res.body.data.user.password).toBeUndefined();
    expect(res.body.data.user.authVersion).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('"password"');
  });

  it('also accepts the matriculation number as the login identifier', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: '2024/CSC/0012', password: 'nwachukwu' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(3001);
  });
});

describe('R1 — restricted first-login state is enforced by the BACKEND', () => {
  const restrictedToken = () => accessTokenFor(3001, 'STUDENT');

  it.each([
    ['GET', '/api/v1/students/dashboard'],
    ['GET', '/api/v1/students/invoices'],
    ['GET', '/api/v1/students/transactions'],
    ['POST', '/api/v1/students/payments/initiate'],
    ['GET', '/api/v1/students/receipts/9/download'],
    ['GET', '/api/v1/students/statements'],
  ])('%s %s is blocked with 403 PASSWORD_CHANGE_REQUIRED', async (method, path) => {
    const res = await (method === 'GET'
      ? request(app).get(path as string)
      : request(app).post(path as string)
    ).set('Authorization', `Bearer ${restrictedToken()}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('can still read its own identity (/auth/me) while restricted', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${restrictedToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(3001);
  });

  it('can still reach the change-password endpoint while restricted', async () => {
    const res = await request(app)
      .patch('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${restrictedToken()}`)
      .send({ currentPassword: 'wrong-password', newPassword: 'Bell$2026Pass' });

    // Reached the handler (401 for a wrong current password) — NOT 403
    // PASSWORD_CHANGE_REQUIRED, i.e. the self-service surface is open.
    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
  });

  it('is NOT restricted when the flag is false (sanity check on the gate)', async () => {
    usersOf()[3001].mustChangePassword = false;
    const res = await request(app)
      .get('/api/v1/students/dashboard')
      .set('Authorization', `Bearer ${accessTokenFor(3001, 'STUDENT')}`);
    expect(res.status).toBe(200);
    usersOf()[3001].mustChangePassword = true; // restore the restricted state
  });
});

describe('R1/R9 — a successful first-login change clears the flag and kills old sessions', () => {
  it('changes the password, clears mustChangePassword, bumps the session generation and revokes refresh tokens', async () => {
    const oldToken = accessTokenFor(3001, 'STUDENT');
    const authVersionBefore = usersOf()[3001].authVersion;

    const res = await request(app)
      .patch('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({ currentPassword: 'nwachukwu', newPassword: 'Bell$2026Pass' });

    expect(res.status).toBe(200);
    expect(usersOf()[3001].mustChangePassword).toBe(false);
    expect(usersOf()[3001].authVersion).toBe(authVersionBefore + 1);
    expect(await bcrypt.compare('Bell$2026Pass', usersOf()[3001].password)).toBe(true);
    // Every renewable session was revoked inside the same transaction.
    expect(txOf().refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 3001, revokedAt: null } }),
    );
  });

  it('the previously issued access token is now rejected — sessions invalidated (R9)', async () => {
    const staleToken = accessTokenFor(3001, 'STUDENT', 2); // pre-change generation
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${staleToken}`);

    expect(res.status).toBe(401);
  });

  it('the initial surname password no longer works, and the new password does (R12/R13)', async () => {
    const oldPw = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'chidi.nwachukwu@university.edu.ng', password: 'nwachukwu' });
    expect(oldPw.status).toBe(401);

    const newPw = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'chidi.nwachukwu@university.edu.ng', password: 'Bell$2026Pass' });
    expect(newPw.status).toBe(200);
    expect(newPw.body.data.user.mustChangePassword).toBe(false);
  });

  it('a token minted at the NEW generation can reach the previously blocked surface', async () => {
    const freshToken = accessTokenFor(3001, 'STUDENT');
    const res = await request(app)
      .get('/api/v1/students/dashboard')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(res.status).toBe(200);
  });
});

describe('R1/R14 — the new password may not be the surname, matric number or email', () => {
  const change = (id: number, currentPass: string, newPass: string) =>
    request(app)
      .patch('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessTokenFor(id, id === 3002 ? 'BURSARY' : 'STUDENT')}`)
      .send({ currentPassword: currentPass, newPassword: newPass });

  it('rejects a new password equal to the CURRENT password', async () => {
    const res = await change(3002, 'bursary123', 'bursary123');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/differ from current password/i);
  });

  it('rejects a new password equal to the surname', async () => {
    const res = await change(3002, 'bursary123', 'Chukwuemeka');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/surname|matriculation|email/i);
  });

  it('rejects a new password equal to the email local part', async () => {
    const res = await change(3002, 'bursary123', 'finance.office');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/surname|matriculation|email/i);
  });

  it('rejects a new password equal to the matriculation number', async () => {
    const res = await change(3006, 'stablepass9', '2024/ACC/0045');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/surname|matriculation|email/i);
  });
});

// =============================================================================
// R24 — plaintext credentials never reach the application log
// =============================================================================
describe('R24 — password values are never written to the application log', () => {
  it('a password change logs neither the current nor the new password', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      jest.spyOn(console, level as any).mockImplementation(() => {}),
    );
    const secret = 'Uniq!LogProbe#2026';

    try {
      await request(app)
        .patch('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${accessTokenFor(3006, 'STUDENT')}`)
        .send({ currentPassword: 'stablepass9', newPassword: secret });
    } finally {
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((call) => call.map((c) => (typeof c === 'string' ? c : JSON.stringify(c ?? ''))).join(' '))
        .join('\n');
      spies.forEach((s) => s.mockRestore());

      expect(logged).not.toContain(secret);
      expect(logged).not.toContain('stablepass9');
    }
  });
});

// =============================================================================
// R6 — a password-reset token is single-use under CONCURRENCY
// =============================================================================
describe('R6 — the same password-reset token cannot be redeemed twice', () => {
  const resetToken = (userId: number, jti: string) =>
    jwt.sign(
      { sub: String(userId), jti, role: 'STUDENT', type: 'pwd-reset', aud: 'urn:auth:pwd-reset' },
      SECRET,
      { expiresIn: 900, algorithm: 'HS256' },
    );

  const payload = { newPassword: 'FreshReset#2026', confirmPassword: 'FreshReset#2026' };

  it('two CONCURRENT requests with the same token yield exactly one 200 and one 409', async () => {
    const token = resetToken(3004, 'concurrent-reset-jti-1');

    const [a, b] = await Promise.all([
      request(app).post('/api/v1/auth/reset-password').send({ token, ...payload }),
      request(app).post('/api/v1/auth/reset-password').send({ token, ...payload }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('a replayed token is rejected even when presented strictly afterwards', async () => {
    const token = resetToken(3004, 'sequential-reset-jti-1');

    const first = await request(app).post('/api/v1/auth/reset-password').send({ token, ...payload });
    const second = await request(app).post('/api/v1/auth/reset-password').send({ token, ...payload });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it('a completed reset clears mustChangePassword and invalidates existing sessions (R9)', async () => {
    const token = resetToken(3004, 'reset-jti-session-invalidation');
    const res = await request(app).post('/api/v1/auth/reset-password').send({ token, ...payload });

    expect(res.status).toBe(200);
    expect(usersOf()[3004].mustChangePassword).toBe(false);
    expect(txOf().refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 3004, revokedAt: null } }),
    );
  });

  it('a token that was never issued for this audience is refused', async () => {
    const bad = jwt.sign(
      { sub: '3004', jti: 'wrong-aud', type: 'pwd-reset' },
      SECRET,
      { expiresIn: 900, algorithm: 'HS256' },
    );
    const res = await request(app).post('/api/v1/auth/reset-password').send({ token: bad, ...payload });
    expect(res.status).toBe(409);
  });

  it('FAILS CLOSED (503, no password write) when the replay-protection store is unavailable', async () => {
    const redisClient = (jest.requireMock('../config/redis') as any).getRedis();
    redisClient.set.mockRejectedValueOnce(new Error('redis is down'));
    const token = resetToken(3004, 'store-unavailable-jti');

    const res = await request(app).post('/api/v1/auth/reset-password').send({ token, ...payload });

    expect(res.status).toBe(503);
    expect(txOf().user.update).not.toHaveBeenCalled();
  });
});

// =============================================================================
// R8 — refresh-token rotation is atomic under CONCURRENCY
// =============================================================================
describe('R8 — the same refresh token cannot be rotated twice', () => {
  const makeRefresh = (userId: number, jti: string) =>
    jwt.sign({ userId, jti, type: 'refresh' }, process.env.JWT_REFRESH_SECRET as string, {
      expiresIn: '7d',
      algorithm: 'HS256',
    });

  const primeRefreshRow = (userId: number, jti: string) => {
    (jest.requireMock('../config/database') as any).default.refreshToken.findUnique.mockResolvedValue({
      id: 42,
      token: jti,
      userId,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      user: {
        id: userId,
        role: 'ADMIN',
        isSuperAdmin: true,
        accountStatus: 'ACTIVE',
        authVersion: 0,
      },
    });
  };

  it('two CONCURRENT rotations of one refresh token yield exactly one success', async () => {
    const jti = 'concurrent-refresh-jti-1';
    const refreshJWT = makeRefresh(3003, jti);
    primeRefreshRow(3003, jti);

    const [a, b] = await Promise.all([
      request(app).post('/api/v1/auth/refresh').send({ refreshToken: refreshJWT }),
      request(app).post('/api/v1/auth/refresh').send({ refreshToken: refreshJWT }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 401]);
    // The rotation was attempted via the conditional (revokedAt IS NULL,
    // not-expired) claim on the exact token — never a read-then-write.
    expect(txOf().refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ token: jti, revokedAt: null }),
      }),
    );
  });

  it('a revolved token is refused on a subsequent (non-concurrent) attempt', async () => {
    const jti = 'sequential-refresh-jti-1';
    const refreshJWT = makeRefresh(3003, jti);
    primeRefreshRow(3003, jti);

    const first = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refreshJWT });
    const second = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refreshJWT });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('an access token is rejected where a refresh token is required', async () => {
    const accessJWT = jwt.sign({ id: 3003, role: 'ADMIN', type: 'access' }, SECRET, {
      expiresIn: '15m',
    });
    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: accessJWT });
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// R10 — HttpOnly refresh cookie: cookie-only refresh, body fallback, CSRF guard
// =============================================================================
describe('R10 — refresh honours the HttpOnly cookie, the legacy body, and CSRF origin checks', () => {
  const makeRefresh = (userId: number, jti: string) =>
    jwt.sign({ userId, jti, type: 'refresh' }, process.env.JWT_REFRESH_SECRET as string, {
      expiresIn: '7d',
      algorithm: 'HS256',
    });

  const primeRefreshRow = (userId: number, jti: string) => {
    (jest.requireMock('../config/database') as any).default.refreshToken.findUnique.mockResolvedValue({
      id: 77,
      token: jti,
      userId,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      user: {
        id: userId,
        role: 'ADMIN',
        isSuperAdmin: true,
        accountStatus: 'ACTIVE',
        authVersion: 0,
      },
    });
  };

  const setCookieNames = (res: any): string[] => {
    const header = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    const cookies = Array.isArray(header) ? header : header ? [header] : [];
    return cookies.map((c) => String(c).split('=')[0].trim());
  };

  it('(a) succeeds when the refresh token is supplied ONLY via the HttpOnly cookie', async () => {
    const jti = 'cookie-only-refresh-jti';
    primeRefreshRow(3003, jti);
    const refreshJWT = makeRefresh(3003, jti);

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshJWT}`);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    // The rotated refresh token is delivered via a fresh HttpOnly cookie and
    // NEVER in the JSON body.
    expect(res.body.refreshToken).toBeUndefined();
    const names = setCookieNames(res);
    expect(names).not.toContain('access_token');
    expect(names).toContain('refresh_token');
  });

  it('(b) still accepts the refresh token from the request body (backward compatible)', async () => {
    const jti = 'body-fallback-refresh-jti';
    primeRefreshRow(3003, jti);

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: makeRefresh(3003, jti) });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeUndefined();
  });

  it('(c) rejects a request carrying a DISALLOWED Origin header with 403', async () => {
    const jti = 'csrf-refresh-jti';
    primeRefreshRow(3003, jti);

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Origin', 'https://evil.example.com')
      .set('Cookie', `refresh_token=${makeRefresh(3003, jti)}`);

    expect(res.status).toBe(403);
  });

  it('(c) does not break requests that carry NO Origin header', async () => {
    const jti = 'no-origin-refresh-jti';
    primeRefreshRow(3003, jti);

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: makeRefresh(3003, jti) });

    expect(res.status).toBe(200);
  });
});
