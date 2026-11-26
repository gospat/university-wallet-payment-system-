/**
 * TOTP MULTI-FACTOR AUTHENTICATION (MFA) — hardening suite
 * =====================================================================
 * Verifies the MFA backend end to end WITHOUT a database:
 *
 *   * the TOTP primitive matches the RFC 6238 Appendix B SHA-1 vectors;
 *   * `login` returns a single-use challenge token (and NO session/cookie) for
 *     an MFA-enabled account, while remaining byte-identical for everyone else;
 *   * the challenge endpoint mints a session only after a valid TOTP / recovery
 *     factor, consumes the challenge token exactly once, and FAILS CLOSED (503)
 *     when the replay-protection store is unavailable;
 *   * `protect()` forces staff enrolment (403 MFA_ENROLLMENT_REQUIRED) but does
 *     not block students;
 *   * enrolment issues 10 recovery codes and each is redeemable at most once;
 *   * disable / regenerate require a proof of possession.
 *
 * Prisma and Redis are replaced with in-memory doubles (the Redis double offers
 * a genuinely ATOMIC `SET … NX` claim) so the suite runs in CI with no services.
 */

jest.mock('../config/database', () => {
  const bcryptMock: any = jest.requireActual('bcrypt');

  type Row = Record<string, any>;
  const users: Record<number, Row> = {};
  const rolePerms: Record<string, string[]> = {};
  const recoveryCodes: Row[] = [];
  let nextRecoveryId = 1;

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
      mfaEnabled: false,
      mfaSecret: null,
      mfaEnrolledAt: null,
      authVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    };
  };

  rolePerms.STUDENT = [];
  rolePerms.ADMIN = [];
  rolePerms.BURSARY = ['VIEW_PAYMENTS'];

  const pick = (row: Row | null | undefined, select?: Record<string, boolean>) => {
    if (!row) return null;
    if (!select) return { ...row };
    const out: Row = {};
    for (const key of Object.keys(select)) if ((select as any)[key]) out[key] = row[key];
    return out;
  };

  const applyUpdate = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data ?? {})) {
      if (value && typeof value === 'object' && 'increment' in (value as any)) {
        row[key] = Number(row[key] ?? 0) + Number((value as any).increment);
      } else {
        row[key] = value;
      }
    }
    return { ...row };
  };

  const recoveryApi = {
    findMany: jest.fn(async (args: any) => {
      const { userId, usedAt } = args?.where ?? {};
      return recoveryCodes
        .filter((r) => r.userId === userId && (usedAt === undefined || r.usedAt === usedAt))
        .map((r) => pick(r, args?.select));
    }),
    count: jest.fn(async (args: any) => {
      const { userId, usedAt } = args?.where ?? {};
      return recoveryCodes.filter((r) => r.userId === userId && (usedAt === undefined || r.usedAt === usedAt)).length;
    }),
    create: jest.fn(async (args: any) => {
      const row = { id: nextRecoveryId++, userId: args.data.userId, codeHash: args.data.codeHash, usedAt: null, createdAt: new Date() };
      recoveryCodes.push(row);
      return { ...row };
    }),
    // ATOMIC single-use claim: only a row that is STILL unused can be consumed.
    updateMany: jest.fn(async (args: any) => {
      const { id, usedAt } = args?.where ?? {};
      const row = recoveryCodes.find((r) => r.id === id && (usedAt === undefined || r.usedAt === usedAt));
      if (!row) return { count: 0 };
      row.usedAt = args.data.usedAt ?? new Date();
      return { count: 1 };
    }),
    deleteMany: jest.fn(async (args: any) => {
      const { userId } = args?.where ?? {};
      let removed = 0;
      for (let i = recoveryCodes.length - 1; i >= 0; i--) {
        if (recoveryCodes[i].userId === userId) {
          recoveryCodes.splice(i, 1);
          removed++;
        }
      }
      return { count: removed };
    }),
  };

  const userApi = {
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
      return null;
    }),
    update: jest.fn(async (args: any) => applyUpdate(users[args.where.id], args.data ?? {})),
  };

  const tx = {
    user: { update: jest.fn(async (args: any) => applyUpdate(users[args.where.id], args.data ?? {})) },
    refreshToken: { updateMany: jest.fn(async () => ({ count: 0 })), create: jest.fn(async () => ({ id: 1 })) },
    mfaRecoveryCode: {
      deleteMany: recoveryApi.deleteMany,
      create: recoveryApi.create,
    },
    auditLog: { create: jest.fn(async () => ({ id: 1 })) },
  };

  const base: Row = {
    user: userApi,
    refreshToken: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async () => ({ id: 1 })),
    },
    mfaRecoveryCode: recoveryApi,
    rolePermission: {
      findMany: jest.fn(async (args: any) => {
        const list = rolePerms[args?.where?.role as string] ?? [];
        return list.map((key) => ({ permission: { key } }));
      }),
    },
    userPermissionProfile: { findUnique: jest.fn(async () => null) },
    counter: { findUnique: jest.fn(async () => ({ id: 'rbac_admin_role_initialized_20261017' })) },
    auditLog: { create: jest.fn(async () => ({ id: 1 })) },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg))),
  };

  return { __esModule: true, default: base, __tx: tx, __users: users, __recovery: recoveryCodes };
});

// Redis double — `set(key, value, 'EX', ttl, 'NX')` is evaluated atomically,
// which is exactly the single-use guarantee the challenge claim relies on.
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

jest.mock('../queues/emailQueue', () => ({ __esModule: true, dispatchEmail: jest.fn() }));

import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import bcrypt from 'bcrypt';
import authRouter from '../routes/auth';
import { protect } from '../middlewares/auth';
import { globalErrorHandler } from '../middlewares/error';
import { encrypt } from '../utils/encryption';
import { generateTotp, base32Encode } from '../utils/totp';
import { signMfaChallengeToken } from '../services/mfa';

// Recovery codes are bcrypt-hashed (10 per enrolment). Use the lowest sensible
// cost so the DB-free suite stays fast — this ONLY affects the test process.
process.env.BCRYPT_ROUNDS = '4';

const SECRET = process.env.JWT_SECRET as string;

// A fixed, valid base32 secret used to pre-provision MFA-enabled accounts.
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
// RFC 6238 Appendix B: ASCII "12345678901234567890" → this base32 value.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

const dbMock = (): any => jest.requireMock('../config/database');
const usersOf = (): Record<number, any> => dbMock().__users;
const recoveryOf = (): any[] => dbMock().__recovery;

// ---------------------------------------------------------------------------
// Seed accounts.
// ---------------------------------------------------------------------------
const bcryptHash = (p: string) => bcrypt.hashSync(p, 4);

const baseUser = (id: number, role: string, email: string, password: string, extra: any = {}) => ({
  id,
  email,
  role,
  isSuperAdmin: false,
  password: bcryptHash(password),
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
  mfaEnabled: false,
  mfaSecret: null,
  mfaEnrolledAt: null,
  authVersion: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

// 4001 — ADMIN with a confirmed second factor (login-mfa / challenge paths).
usersOf()[4001] = baseUser(4001, 'ADMIN', 'mfa.admin@university.edu.ng', 'staffpass1', {
  mfaEnabled: true,
  mfaSecret: encrypt(TOTP_SECRET),
  mfaEnrolledAt: new Date(),
});
// 4002 — BURSARY that has NOT enrolled (protect() gate).
usersOf()[4002] = baseUser(4002, 'BURSARY', 'notenrolled.bursary@university.edu.ng', 'staffpass2');
// 4003 — STUDENT (never gated by the staff policy).
usersOf()[4003] = baseUser(4003, 'STUDENT', 'student.user@university.edu.ng', 'studentpass', {
  matricNumber: '2024/CSC/0099',
  lastName: 'User',
});
// 4004 — ADMIN used for the enrolment lifecycle.
usersOf()[4004] = baseUser(4004, 'ADMIN', 'enroll.admin@university.edu.ng', 'staffpass4');

const ok = (_req: any, res: any) => res.status(200).json({ ok: true });

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/auth', authRouter);
  app.get('/api/v1/students/dashboard', protect, ok);
  app.get('/api/v1/admin/overview', protect, ok);
  app.use(globalErrorHandler);
  return app;
}

const app = buildApp();

const accessTokenFor = (id: number, role: string, ver?: number) =>
  jwt.sign(
    { id, role, type: 'access', ver: ver ?? Number(usersOf()[id]?.authVersion ?? 0) },
    SECRET,
    { expiresIn: '15m', algorithm: 'HS256' },
  );

const setCookieNames = (res: any): string[] => {
  const header = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  return cookies.map((c) => String(c).split('=')[0].trim());
};

beforeEach(() => {
  (jest.requireMock('../config/redis') as any).__store.clear();
});

// =============================================================================
// 1–2. TOTP primitive (RFC 6238 / RFC 4226)
// =============================================================================
describe('TOTP primitive', () => {
  it('matches the RFC 6238 Appendix B SHA-1 vectors', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, expected] of vectors) {
      expect(generateTotp(RFC_SECRET, { timestamp: t * 1000, digits: 8 })).toBe(expected);
    }
  });

  it('verifies the current code (with drift window) and rejects a wrong code', async () => {
    const { verifyTotp } = await import('../utils/totp');
    const now = Date.now();
    const code = generateTotp(TOTP_SECRET, { timestamp: now });
    expect(verifyTotp(code, TOTP_SECRET, { timestamp: now })).toBe(true);
    // One step of drift is tolerated (±1 window default).
    expect(verifyTotp(code, TOTP_SECRET, { timestamp: now + 30_000 })).toBe(true);
    expect(verifyTotp('000000', TOTP_SECRET, { timestamp: now })).toBe(false);
  });
});

// =============================================================================
// 3–4. login contract
// =============================================================================
describe('login', () => {
  it('returns an mfaRequired challenge token — and NO session/cookie — for an MFA-enabled account', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'mfa.admin@university.edu.ng', password: 'staffpass1' });

    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(typeof res.body.challengeToken).toBe('string');
    expect(res.body.challengeToken.length).toBeGreaterThan(10);
    // No real session is minted and no refresh credential is delivered.
    expect(res.body.accessToken).toBeFalsy();
    expect(res.body.token).toBeFalsy();
    expect(setCookieNames(res)).not.toContain('refresh_token');
  });

  it('is unchanged for a non-MFA account (accessToken + user + refresh cookie)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'notenrolled.bursary@university.edu.ng', password: 'staffpass2' });

    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBeUndefined();
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.data.user.id).toBe(4002);
    expect(res.body.data.user.password).toBeUndefined();
    expect(setCookieNames(res)).toContain('refresh_token');
  });
});

// =============================================================================
// 5–7. challenge completion, single-use, fail-closed
// =============================================================================
describe('MFA challenge', () => {
  it('mints a session for a valid challenge token + current TOTP code', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'mfa.admin@university.edu.ng', password: 'staffpass1' });
    const challengeToken = login.body.challengeToken as string;

    const code = generateTotp(TOTP_SECRET);
    const res = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ challengeToken, code });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.data.user.id).toBe(4001);
    expect(setCookieNames(res)).toContain('refresh_token');
  });

  it('consumes the challenge token exactly once (a replay is rejected)', async () => {
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'mfa.admin@university.edu.ng', password: 'staffpass1' });
    const challengeToken = login.body.challengeToken as string;

    const first = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ challengeToken, code: generateTotp(TOTP_SECRET) });
    const second = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ challengeToken, code: generateTotp(TOTP_SECRET) });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body.message).toMatch(/already been completed|invalid/i);
  });

  it('FAILS CLOSED (503) when the replay-protection store is unavailable', async () => {
    const { token } = signMfaChallengeToken(4001);
    const redisClient = (jest.requireMock('../config/redis') as any).getRedis();
    redisClient.set.mockRejectedValueOnce(new Error('redis is down'));

    const res = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ challengeToken: token, code: generateTotp(TOTP_SECRET) });

    expect(res.status).toBe(503);
  });
});

// =============================================================================
// 8–9. protect() enrolment gate
// =============================================================================
describe('protect() MFA enrolment gate', () => {
  beforeEach(() => {
    process.env.MFA_ENFORCEMENT = 'staff';
  });
  afterEach(() => {
    process.env.MFA_ENFORCEMENT = 'off';
  });

  it('blocks a non-enrolled staff account with 403 MFA_ENROLLMENT_REQUIRED', async () => {
    const res = await request(app)
      .get('/api/v1/admin/overview')
      .set('Authorization', `Bearer ${accessTokenFor(4002, 'BURSARY')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('does not gate students, and passes an enrolled staff account', async () => {
    const student = await request(app)
      .get('/api/v1/students/dashboard')
      .set('Authorization', `Bearer ${accessTokenFor(4003, 'STUDENT')}`);
    expect(student.status).toBe(200);

    const enrolled = await request(app)
      .get('/api/v1/admin/overview')
      .set('Authorization', `Bearer ${accessTokenFor(4001, 'ADMIN')}`);
    expect(enrolled.status).toBe(200);
  });
});

// =============================================================================
// 10–12. enrolment lifecycle, recovery codes, disable / regenerate
// =============================================================================
describe('MFA enrolment lifecycle', () => {
  let enrolledSecret = '';
  let recoveryCodes: string[] = [];

  it('setup returns a secret + otpauth URL; enable issues 10 recovery codes', async () => {
    const auth = accessTokenFor(4004, 'ADMIN');

    const setup = await request(app).post('/api/v1/auth/mfa/setup').set('Authorization', `Bearer ${auth}`);
    expect(setup.status).toBe(200);
    expect(typeof setup.body.data.secret).toBe('string');
    expect(setup.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    enrolledSecret = setup.body.data.secret;

    const enable = await request(app)
      .post('/api/v1/auth/mfa/enable')
      .set('Authorization', `Bearer ${auth}`)
      .send({ code: generateTotp(enrolledSecret) });

    expect(enable.status).toBe(200);
    recoveryCodes = enable.body.data.recoveryCodes;
    expect(Array.isArray(recoveryCodes)).toBe(true);
    expect(recoveryCodes).toHaveLength(10);

    expect(usersOf()[4004].mfaEnabled).toBe(true);
    expect(recoveryOf().filter((r: any) => r.userId === 4004)).toHaveLength(10);
  });

  it('accepts a recovery code once as a second factor, then rejects reuse (atomic single-use)', async () => {
    const code = recoveryCodes[0];

    const login1 = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'enroll.admin@university.edu.ng', password: 'staffpass4' });
    const challenge1 = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ challengeToken: login1.body.challengeToken, code });
    expect(challenge1.status).toBe(200);

    const login2 = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: 'enroll.admin@university.edu.ng', password: 'staffpass4' });
    const challenge2 = await request(app)
      .post('/api/v1/auth/mfa/challenge')
      .send({ challengeToken: login2.body.challengeToken, code });
    expect(challenge2.status).toBe(401);
  });

  it('disable and regenerate recovery codes require a valid proof of possession', async () => {
    const auth = accessTokenFor(4004, 'ADMIN');

    const wrong = await request(app)
      .post('/api/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${auth}`)
      .send({ password: 'not-the-password' });
    expect(wrong.status).toBe(401);

    const regen = await request(app)
      .post('/api/v1/auth/mfa/recovery-codes/regenerate')
      .set('Authorization', `Bearer ${auth}`)
      .send({ password: 'staffpass4' });
    expect(regen.status).toBe(200);
    expect(regen.body.data.recoveryCodes).toHaveLength(10);

    const disable = await request(app)
      .post('/api/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${auth}`)
      .send({ password: 'staffpass4' });
    expect(disable.status).toBe(200);
    expect(usersOf()[4004].mfaEnabled).toBe(false);
    expect(recoveryOf().filter((r: any) => r.userId === 4004)).toHaveLength(0);
  });
});
