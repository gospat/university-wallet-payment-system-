/**
 * SECURITY HARDENING SPEC — API SURFACE TESTS
 * =====================================================================
 * Covers the five hardening items:
 *   1. /api/v1/queue-health is no longer public (protect + VIEW_QUEUES).
 *   2. /api/v1/metrics FAILS CLOSED (no token => 404, wrong => 401,
 *      correct => served; timing-safe compare).
 *   3. Authoritative client IP — a forged X-Forwarded-For cannot override
 *      `req.ip` (utils/http.reqIp / utils/security.realClientIp).
 *   4. Query-string `access_token` is REJECTED for template/download routes;
 *      the `Authorization: Bearer` header is the only accepted transport.
 *   5. CSP / security-header / CORS review (no loosening; HSTS off outside prod).
 *
 * Strategy: import the REAL app (so the actual middleware chain is exercised)
 * with a in-memory Prisma double. No live MySQL / Redis is touched.
 */

import request from 'supertest';
import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import app from '../app';
import { reqIp } from '../utils/http';
import { realClientIp } from '../utils/security';
import { assertCanManageTemplates, sendTemplateAuthFailure } from '../utils/templateAuth';

// -----------------------------------------------------------------------------
// In-memory Prisma double (Proxy so any un-stubbed model access is a no-op).
//   · 3001 = FLAG-AWARE Super Admin (role=ADMIN + isSuperAdmin=true)
//   · 3002 = normal ADMIN (role=ADMIN, not flagged) — holds VIEW_QUEUES via role
//   · 3003 = BURSARY with no capabilities
// The ADMIN-baseline sentinel row is PRESENT so the stored ADMIN baseline is
// honoured literally (no full-registry escalation).
// -----------------------------------------------------------------------------
jest.mock('../config/database', () => {
  const users: Record<number, any> = {
    3001: { id: 3001, role: 'ADMIN', isSuperAdmin: true, accountStatus: 'ACTIVE', mustChangePassword: false, authVersion: 0 },
    3002: { id: 3002, role: 'ADMIN', isSuperAdmin: false, accountStatus: 'ACTIVE', mustChangePassword: false, authVersion: 0 },
    3003: { id: 3003, role: 'BURSARY', isSuperAdmin: false, accountStatus: 'ACTIVE', mustChangePassword: false, authVersion: 0 },
  };
  const rolePerms: Record<string, string[]> = {
    ADMIN: ['VIEW_QUEUES'],
    BURSARY: [],
  };
  const base: any = {
    user: {
      findUnique: jest.fn((args: any) => {
        if (args?.where?.id) return Promise.resolve(users[args.where.id] ?? null);
        return Promise.resolve(null);
      }),
      findFirst: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({ id: 0 })),
    },
    rolePermission: {
      findMany: jest.fn((args: any) => {
        const list = rolePerms[args?.where?.role as string] ?? [];
        return Promise.resolve(list.map((key) => ({ permission: { key } })));
      }),
    },
    userPermissionProfile: { findUnique: jest.fn(() => Promise.resolve(null)) },
    counter: { findUnique: jest.fn(() => Promise.resolve({ id: 'rbac_admin_role_initialized_20261017' })) },
    auditLog: { create: jest.fn(() => Promise.resolve({ id: 1 })) },
  };
  const prismaMock = new Proxy(base, {
    get(target: any, prop: string) {
      if (prop in target) return target[prop];
      return new Proxy({}, { get: () => jest.fn(() => Promise.resolve(null)) });
    },
  });
  return { __esModule: true, default: prismaMock };
});

const SECRET = 'test-secret-security-hardening-spec';
const mkToken = (id: number, role: string) =>
  jwt.sign({ id, role, type: 'access' }, SECRET, { expiresIn: '15m' });

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

// =============================================================================
// Task 1 — queue-health is not public
// =============================================================================
describe('Task 1 — /api/v1/queue-health is protected', () => {
  it('rejects anonymous access (401) and discloses no queue internals', async () => {
    const res = await request(app).get('/api/v1/queue-health');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/redisConnected|topics|bullmq|degraded/i);
  });

  it('allows an authenticated user holding the VIEW_QUEUES capability (200)', async () => {
    const res = await request(app)
      .get('/api/v1/queue-health')
      .set('Authorization', `Bearer ${mkToken(3002, 'ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('allows a flag-aware Super Admin (200)', async () => {
    const res = await request(app)
      .get('/api/v1/queue-health')
      .set('Authorization', `Bearer ${mkToken(3001, 'ADMIN')}`);
    expect(res.status).toBe(200);
  });

  it('denies an authenticated user WITHOUT the capability (403)', async () => {
    const res = await request(app)
      .get('/api/v1/queue-health')
      .set('Authorization', `Bearer ${mkToken(3003, 'BURSARY')}`);
    expect(res.status).toBe(403);
  });

  it('a minimal liveness endpoint exists and leaks no queue/Redis/worker internals', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/queue|redis|worker|topics|bullmq|degraded/);
  });
});

// =============================================================================
// Task 2 — metrics fail closed
// =============================================================================
describe('Task 2 — /api/v1/metrics fails closed', () => {
  const ORIGINAL_TOKEN = process.env.METRICS_TOKEN;
  afterAll(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = ORIGINAL_TOKEN;
  });

  it('is NOT publicly readable when METRICS_TOKEN is unset (404)', async () => {
    delete process.env.METRICS_TOKEN;
    const res = await request(app).get('/api/v1/metrics');
    expect(res.status).toBe(404);
    expect(res.text).not.toMatch(/process_cpu_seconds_total/);
  });

  it('is NOT readable when METRICS_TOKEN is empty (404)', async () => {
    process.env.METRICS_TOKEN = '';
    const res = await request(app).get('/api/v1/metrics');
    expect(res.status).toBe(404);
  });

  it('rejects a missing credential (401)', async () => {
    process.env.METRICS_TOKEN = 'correct-metrics-token-value';
    const res = await request(app).get('/api/v1/metrics');
    expect(res.status).toBe(401);
  });

  it('rejects an incorrect credential (401)', async () => {
    process.env.METRICS_TOKEN = 'correct-metrics-token-value';
    const res = await request(app).get('/api/v1/metrics').set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('serves metrics with the correct credential and never echoes the token', async () => {
    const token = 'correct-metrics-token-value';
    process.env.METRICS_TOKEN = token;
    const res = await request(app).get('/api/v1/metrics').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('# HELP');
    expect(res.text).not.toContain(token);
  });
});

// =============================================================================
// Task 3 — authoritative client IP
// =============================================================================
describe('Task 3 — authoritative client IP (forged XFF ignored)', () => {
  it('reqIp() ignores a raw X-Forwarded-For header', () => {
    expect(reqIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, ip: '203.0.113.9' } as any)).toBe('203.0.113.9');
  });

  it('realClientIp() ignores a raw X-Forwarded-For header', () => {
    expect(realClientIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, ip: '203.0.113.9' })).toBe('203.0.113.9');
  });

  it('the app is configured to trust exactly one proxy hop', () => {
    expect((app as any).get('trust proxy')).toBe(1);
  });

  it('a forged left-most X-Forwarded-For cannot override the proxy-set client IP', async () => {
    const probe = express();
    probe.set('trust proxy', 1);
    probe.get('/ip', (req: Request, res: Response) => {
      res.json({ ip: reqIp(req) });
    });
    const res = await request(probe).get('/ip').set('X-Forwarded-For', '1.2.3.4, 203.0.113.7');
    // Only the last entry (the value set by the single trusted proxy hop) is
    // authoritative; the attacker-prepended left-most value is ignored.
    expect(res.body.ip).toBe('203.0.113.7');
    expect(res.body.ip).not.toBe('1.2.3.4');
  });
});

// =============================================================================
// Task 4 — query-string token rejected for template/download routes
// =============================================================================
describe('Task 4 — query-string access_token is rejected', () => {
  let probe: express.Express;
  beforeAll(() => {
    probe = express();
    probe.get('/api/v1/template', async (req: Request, res: Response) => {
      const auth = await assertCanManageTemplates(req, ['ADMIN', 'BURSARY'], 'BULK_UPLOAD_FEES');
      if (!auth.ok) {
        sendTemplateAuthFailure(res, auth);
        return;
      }
      res.status(200).json({ ok: true });
    });
  });

  it('REJECTS a token supplied via ?access_token= (401)', async () => {
    const token = mkToken(3001, 'ADMIN');
    const res = await request(probe).get('/api/v1/template').query({ access_token: token });
    expect(res.status).toBe(401);
  });

  it('ACCEPTS the same token via Authorization: Bearer (200)', async () => {
    const token = mkToken(3001, 'ADMIN');
    const res = await request(probe).get('/api/v1/template').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Task 5 — CSP / security headers / CORS review
// =============================================================================
describe('Task 5 — security headers are not loosened', () => {
  it('sets a CSP with no unsafe-eval and no unsafe-inline in script-src', async () => {
    const res = await request(app).get('/api/v1/health');
    const csp = String(res.headers['content-security-policy'] || '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    const directives = csp.split(';').map((s) => s.trim());
    const scriptSrc = directives.find((s) => s.startsWith('script-src')) || '';
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    const objectSrc = directives.find((s) => s.startsWith('object-src')) || '';
    expect(objectSrc).toContain("'none'");
  });

  it('does not enable HSTS outside production', async () => {
    const res = await request(app).get('/api/v1/health');
    const hsts = res.headers['strict-transport-security'];
    if (process.env.NODE_ENV === 'production') {
      expect(hsts).toBeDefined();
    } else {
      expect(hsts).toBeUndefined();
    }
  });

  it('sets X-Content-Type-Options nosniff and hides x-powered-by', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Task 5 — CORS allowlist', () => {
  it('never responds with a wildcard Access-Control-Allow-Origin', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('allows an explicit allowlisted origin and echoes exactly it', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not reflect an arbitrary/unknown origin', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
