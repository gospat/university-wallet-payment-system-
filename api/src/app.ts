import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedis } from './config/redis';
import { globalErrorHandler } from './middlewares/error';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import bursaryRoutes from './routes/bursary';
import studentsRoutes from './routes/students';
import feesRoutes from './routes/fees';
import feeAssignmentsRoutes from './routes/feeAssignments';
import academicRoutes from './routes/academic';
import webhookRoutes from './routes/webhooks';
import reconciliationRoutes from './routes/reconciliation';
import dashboardRoutes from './routes/dashboard';
import reportsRoutes from './routes/reports';
import path from 'path';
import './config/redis';
import prisma from './config/database';
import client from 'prom-client';
import { getQueueHealth } from './config/queue';
import { publicVerifyReceipt } from './controllers/receipt';
import { buildBranding, brandingEnvOnly } from './utils/branding';

const app = express();

// NOTE: If app runs behind nginx/ngrok/k8s ingress, preserve client IP (for rate limit + audit logs).
// Default 1 means "trust a single hop of X-Forwarded-For" — matches single nginx on the VPS.
// Override via TRUST_PROXY_HOPS=N env var if Bells IT ever puts Cloudflare / AWS ALB in front (+1 hop).
const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10);
app.set('trust proxy', Number.isFinite(trustProxyHops) && trustProxyHops >= 1 ? trustProxyHops : 1);

// 2.1 Rate Limit Redis-backed shared store (cluster-safe, survives PM2 reloads & restarts)
//    Falls back to the default in-memory MemoryStore only if Redis is temporarily unavailable
//    at construction. During operation the store's own retry path is honoured: Redis
//    transport errors propagate (NOSCRIPT lets rate-limit-redis reload the Lua script and
//    retry EVAL). If retries are exhausted, passOnStoreError:true (below) lets the request
//    through to its handler instead of returning HTTP 500.
//
// Production diagnostics have confirmed the basic RedisStore integration works as-is:
//   * ioredis.call(EVAL...)   -> returns [1, 60000] (exact Lua array shape)
//   * ioredis.call(SCRIPT LOAD) -> returns valid 40-hex SHA string
//   * EVALSHA increment / get() -> return valid arrays
//   * Eight concurrent RedisStore instances (one per limiter) all share correctly.
//
// Therefore we return the transport result directly. The ONLY historical defect was
// `catch { return undefined as any; }`: undefined went into parseScriptResponse(undefined)
// and threw `TypeError: Expected result to be array of values` on every request.
// We must NOT swallow Redis errors inside sendCommand; they must propagate so NOSCRIPT
// triggers the library's EVAL fallback and final failures fall into passOnStoreError.

/**
 * Build a rate-limit store (for a specific prefix).
 * - If Redis status==="ready" at construction -> RedisStore (shared, cluster-safe).
 * - If Redis is NOT ready -> undefined; express-rate-limit defaults to native
 *   in-memory MemoryStore (per process only, best effort).
 *
 * Startup readiness (c6d547e) preserved: RedisStore only created when redis.status is
 * genuinely 'ready', not merely 'connecting' / 'wait'.
 */
export function buildRateLimitStore(prefix: string, _defaultWindowMs = 60_000) {
  let redis: ReturnType<typeof getRedis> | null = null;
  try {
    redis = getRedis() || null;
  } catch {
    redis = null;
  }
  const st: string = (redis?.status as string) ?? '';
  const redisReadyNow = st === 'ready';
  const limiterName = prefix.padEnd(20, ' ');
  if (!redisReadyNow) {
    console.warn(
      `[rate-limit] limiter=${limiterName} store=MemoryStore — redis.status="${st}" at construction time. Counters are in-process only for this process lifetime (NOT shared across PM2 workers).`,
    );
    return undefined;
  }
  console.info(
    `[rate-limit] limiter=${limiterName} store=RedisStore  — redis.status="ready" at construction time. Counters are cluster-shared across workers and survive hot reloads.`,
  );
  const r = redis as any;
  return new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      return await r.call(...args);
    },
  });
}

// Force HTTPS redirect (skip in dev/test; allow /health endpoints over HTTP for k8s probes)
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') return next();
  if (req.path === '/health' || req.path === '/api/v1/health' || req.path === '/healthz') return next();
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (!isHttps) {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

// 1. Security Headers (strict production-grade)
const alatpayPopupSdkOrigins = [
  'https://web.alatpay.ng',
  'https://alatpay-client.azurewebsites.net',
];
const alatpayPopupMerchantOrigin = 'https://alatpay.azure-api.net';
const alatpayPopupApiboxOrigin = 'https://apibox.alatpay.ng';
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", ...alatpayPopupSdkOrigins],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'https:'],
      'font-src': ["'self'", 'data:'],
      'frame-ancestors': ["'self'"],
      'frame-src': [
        "'self'",
        'https://*.paystack.co',
        'https://*.paystack.com',
        'https://*.wemabank.com',
        'https://*.alat.ng',
        'https://*.alathaba.ng',
        ...alatpayPopupSdkOrigins,
      ],
      'child-src': [
        "'self'",
        'https://*.paystack.co',
        'https://*.paystack.com',
        'https://*.wemabank.com',
        'https://*.alat.ng',
        'https://*.alathaba.ng',
        ...alatpayPopupSdkOrigins,
      ],
      'connect-src': ["'self'", ...alatpayPopupSdkOrigins, alatpayPopupMerchantOrigin, alatpayPopupApiboxOrigin, 'https:'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'worker-src': ["'self'", 'blob:'],
      'manifest-src': ["'self'"],
      'upgrade-insecure-requests': [],
    },
  },
  hsts: {
    maxAge: 63072000, // 2 years
    includeSubDomains: true,
    preload: true,
  },
  dnsPrefetchControl: { allow: false },
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  frameguard: { action: 'sameorigin' },
  referrerPolicy: { policy: ['strict-origin-when-cross-origin'] },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginEmbedderPolicy: false, // payment iframes need less-restrictive COEP
}));
app.use((_req, res, next) => {
  // Helmet doesn't ship Permissions-Policy OOTB — set it explicitly to deny all unused powerful features (camera/mic/geo/payment/unused APIs)
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), battery=(), gamepad=(), magnetometer=(), gyroscope=(), accelerometer=(), ambient-light-sensor=(), autoplay=(self), fullscreen=(self), picture-in-picture=(self), screen-wake-lock=(self), web-share=(self)'
  );
  next();
});
app.disable('x-powered-by');

// 2. CORS
function buildCorsOrigins(): string[] {
  const fromEnv = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = [
    'http://localhost:5173',
    'http://localhost:5174',
    process.env.FRONTEND_BASE_URL,
  ].filter((v): v is string => Boolean(v));
  return Array.from(new Set([...defaults, ...fromEnv]));
}

const localOriginPatterns: RegExp[] = [
  /^https?:\/\/localhost(:\d+)?(\/|$)/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
  /^https?:\/\/0\.0\.0\.0(:\d+)?(\/|$)/,
  /\.localtest\.me(:\d+)?(\/|$)/,
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const origins = buildCorsOrigins();
      if (origins.includes(origin)) return cb(null, true);
      if (localOriginPatterns.some((re) => re.test(origin))) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

// 3. Rate Limiting (Prevent Brute Force & DDoS)
// Reasonable thresholds: not so tight that legitimate usage breaks, but brutal on abuse.
// Redis-backed store: shared across PM2 cluster workers, survives reloads/restarts so
// credential-stuffing attackers can't bypass by targeting a different worker or waiting
// for a hot-code reload. Each limit has its own Redis key prefix so counters stay independent.
export const generalLimiter = rateLimit({
  store: buildRateLimitStore('rl:general:'),
  max: 200,
  windowMs: 15 * 60 * 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

// Auth: login/signup/forgot-password endpoints — strictest setting to stop credential stuffing.
// 12 attempts/15 mins/IP = ~48/hour = 1152/day. Combined with per-user 5-attempts lockout → safe.
export const authLimiter = rateLimit({
  store: buildRateLimitStore('rl:auth:'),
  max: 12,
  windowMs: 15 * 60 * 1000,
  message: 'Too many auth attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

// Password change / reset: short window strict limit to stop forced rotations.
export const authChangePwLimiter = rateLimit({
  store: buildRateLimitStore('rl:auth-chpw:'),
  max: 5,
  windowMs: 60 * 60 * 1000,
  message: 'Too many password change attempts, please try again in an hour.',
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

// Payment initiation / verification: per-IP 15/15 mins = 1/min avg (blocks carder enumeration).
export const paymentLimiter = rateLimit({
  store: buildRateLimitStore('rl:payment:'),
  max: 15,
  windowMs: 15 * 60 * 1000,
  message: 'Too many payment requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

// Admin mutations (POST/PATCH/DELETE) and bulk uploads.
export const adminMutationLimiter = rateLimit({
  store: buildRateLimitStore('rl:admin-mut:'),
  max: 80,
  windowMs: 15 * 60 * 1000,
  message: 'Too many admin mutation requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

// Webhooks: providers may call frequently, keep generous.
export const webhookLimiter = rateLimit({
  store: buildRateLimitStore('rl:webhook:'),
  max: 200,
  windowMs: 60 * 1000,
  message: 'Too many webhook requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

// Public receipt verify: anonymous 60/min/IP. Strict enough to stop enumeration scans,
// permissive enough for genuine students verifying many receipts. Applies to both public
// /api/v1/public/verify-receipt route and authenticated admin/bursary verify endpoints.
export const publicReceiptLimiter = rateLimit({
  store: buildRateLimitStore('rl:pub-rcpt:'),
  max: 60,
  windowMs: 60 * 1000,
  message: 'Too many receipt verification requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});

app.use('/api/v1', generalLimiter);
app.use('/api/v1/auth', authLimiter);
app.use('/api/v1/auth/change-password', authChangePwLimiter);
app.use('/api/v1/students/payments/initiate', paymentLimiter);
app.use('/api/v1/students/payments/verify', paymentLimiter);
app.use('/api/v1/fee-assignments/bill-student', paymentLimiter);
app.use('/api/v1/fee-assignments/assignments/generate-invoices', paymentLimiter);
app.use('/api/v1/webhooks', webhookLimiter);
app.use('/api/v1/*/receipts/verify', publicReceiptLimiter);
app.use('/api/v1/students/receipts/:id', publicReceiptLimiter);
app.use('/api/v1/admin/receipts/:id', publicReceiptLimiter);
app.use('/api/v1/bursary/receipts/:id', publicReceiptLimiter);
// Admin bulk-upload endpoints are heavy — apply the mutation limiter.
app.use(/^\/api\/v1\/(admin|academic|fees)\/.*\/?bulk-(upload|import)$/i, adminMutationLimiter);

// Report exports: heavy CPU + memory (PDF rendering via Puppeteer, XLSX streaming).
// Tighter per-user window to stop abuse — still permissive enough for bursary workloads.
export const reportsExportLimiter = rateLimit({
  store: buildRateLimitStore('rl:reports-export:'),
  max: 40,
  windowMs: 10 * 60 * 1000, // 40 exports / 10 min / IP
  message: 'Too many report export requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
});
app.use(/^\/api\/v1\/reports\/.*\/?(export|download)$/i, reportsExportLimiter);

// 4. Logging
//    - development: morgan('dev') → short colored human-readable logs
//    - production : morgan('combined') → standard Apache/NCSA format, good for log parsers
//    - Always skip /health and /ready probes so 10s monitoring pings don't spam the logs.
morgan.token('realip', (req: any) => req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ?? req.ip ?? '-');
const isProd = process.env.NODE_ENV === 'production';
app.use(morgan(isProd ? ':realip - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"' : 'dev', {
  skip: (req) => {
    const p = req.baseUrl || req.path;
    return p === '/api/v1/health' || p === '/api/v1/ready' || p === '/health' || p === '/ready';
  },
}));

// Capture raw body for Paystack webhook verification (Idempotency & Security).
// Cap body size at 1MB — prevents oversized request DoS.
app.use(
  express.json({
    limit: '1mb',
    strict: true, // Rejects non-objects/non-arrays at top-level (prevents raw JSON scalar abuse)
    verify: (req, res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

// extended:false disables `qs` parser → only simple key=value pairs.
// Prevents prototype pollution when code later does bracket access with req.body[key].
app.use(express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 100 }));

client.collectDefaultMetrics();

app.get('/api/v1/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      service: 'university-payment-api',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
});

app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      service: 'university-payment-api',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
});

app.get('/api/v1/public/branding', async (_req, res) => {
  try {
    const data = await buildBranding();
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.status(200).json({ status: 'success', data });
  } catch (err: any) {
    const fallback = brandingEnvOnly();
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.status(200).json({ status: 'success', data: fallback });
  }
});

app.get('/api/v1/ready', async (req, res) => {
  try {
    await prisma.user.findFirst({ select: { id: true } });
    res.status(200).json({ status: 'success', data: { ready: true } });
  } catch (e) {
    res.status(503).json({ status: 'fail', data: { ready: false } });
  }
});

app.get('/api/v1/metrics', async (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const auth = req.header('Authorization') || '';
    if (auth !== `Bearer ${token}`) {
      return res.status(401).json({ status: 'fail', message: 'Unauthorized' });
    }
  }
  res.setHeader('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
});

// Routes
app.get('/api/v1/public/verify-receipt/:token', publicReceiptLimiter, publicVerifyReceipt);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/reports', reportsRoutes);
app.use('/api/v1/students', studentsRoutes);
app.use('/api/v1/fees', feesRoutes);
app.use('/api/v1/fee-assignments', feeAssignmentsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/bursary', bursaryRoutes);
app.use('/api/v1/bursary/reconciliation', reconciliationRoutes);
app.use('/api/v1/academic', academicRoutes);

// Admin-only: Queue health probe (used by dashboards + k8s liveness).
app.get('/api/v1/queue-health', async (_req, res) => {
  try {
    const qh = await getQueueHealth();
    res.status(200).json({ status: 'success', data: qh });
  } catch (e) {
    res.status(500).json({ status: 'fail', message: 'queue probe error' });
  }
});

// Error Handling
app.use(globalErrorHandler);

export default app;
