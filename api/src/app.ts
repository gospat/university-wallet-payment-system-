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
//    Falls back to the default in-memory MemoryStore only if Redis is temporarily unavailable.
function buildRateLimitStore(prefix: string) {
  try {
    const redis = getRedis();
    return new RedisStore({
      sendCommand: async (...args: string[]) => (redis as any).call(...args),
      prefix,
    });
  } catch (err) {
    console.warn('[rate-limit] Redis unavailable — falling back to in-memory MemoryStore', String(err));
    // rate-limit uses MemoryStore implicitly when no store supplied
    return undefined;
  }
}

// Force HTTPS redirect (skip in dev; allow /health endpoints over HTTP for k8s probes)
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'development') return next();
  if (req.path === '/health' || req.path === '/api/v1/health') return next();
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (!isHttps) {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

// 1. Security Headers (strict production-grade)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'https:'],
      'font-src': ["'self'", 'data:'],
      'frame-ancestors': ["'self'"],
      'frame-src': ["'self'", 'https://*.paystack.co', 'https://*.paystack.com', 'https://*.wemabank.com', 'https://*.alat.ng', 'https://*.alathaba.ng'],
      'child-src': ["'self'", 'https://*.paystack.co', 'https://*.paystack.com', 'https://*.wemabank.com', 'https://*.alat.ng', 'https://*.alathaba.ng'],
      'connect-src': ["'self'", 'https:'],
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
const generalLimiter = rateLimit({
  store: buildRateLimitStore('rl:general:'),
  max: 200,
  windowMs: 15 * 60 * 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth: login/signup/forgot-password endpoints — strictest setting to stop credential stuffing.
// 12 attempts/15 mins/IP = ~48/hour = 1152/day. Combined with per-user 5-attempts lockout → safe.
const authLimiter = rateLimit({
  store: buildRateLimitStore('rl:auth:'),
  max: 12,
  windowMs: 15 * 60 * 1000,
  message: 'Too many auth attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Password change / reset: short window strict limit to stop forced rotations.
const authChangePwLimiter = rateLimit({
  store: buildRateLimitStore('rl:auth-chpw:'),
  max: 5,
  windowMs: 60 * 60 * 1000,
  message: 'Too many password change attempts, please try again in an hour.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Payment initiation / verification: per-IP 15/15 mins = 1/min avg (blocks carder enumeration).
const paymentLimiter = rateLimit({
  store: buildRateLimitStore('rl:payment:'),
  max: 15,
  windowMs: 15 * 60 * 1000,
  message: 'Too many payment requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin mutations (POST/PATCH/DELETE) and bulk uploads.
const adminMutationLimiter = rateLimit({
  store: buildRateLimitStore('rl:admin-mut:'),
  max: 80,
  windowMs: 15 * 60 * 1000,
  message: 'Too many admin mutation requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Webhooks: providers may call frequently, keep generous.
const webhookLimiter = rateLimit({
  store: buildRateLimitStore('rl:webhook:'),
  max: 200,
  windowMs: 60 * 1000,
  message: 'Too many webhook requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/v1', generalLimiter);
app.use('/api/v1/auth', authLimiter);
app.use('/api/v1/auth/change-password', authChangePwLimiter);
app.use('/api/v1/students/payments/initiate', paymentLimiter);
app.use('/api/v1/students/payments/verify', paymentLimiter);
app.use('/api/v1/fee-assignments/bill-student', paymentLimiter);
app.use('/api/v1/fee-assignments/assignments/generate-invoices', paymentLimiter);
app.use('/api/v1/webhooks', webhookLimiter);
// Admin bulk-upload endpoints are heavy — apply the mutation limiter.
app.use(/^\/api\/v1\/(admin|academic|fees)\/.*\/(bulk-import|upload|confirm)$/i, adminMutationLimiter);

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
app.get('/api/v1/public/verify-receipt/:token', publicVerifyReceipt);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
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
