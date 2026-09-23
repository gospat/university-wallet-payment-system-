import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
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

// 1. Security Headers
app.use(helmet());
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
const generalLimiter = rateLimit({
  max: 300,
  windowMs: 15 * 60 * 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  max: 40,
  windowMs: 15 * 60 * 1000,
  message: 'Too many auth attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const paymentLimiter = rateLimit({
  max: 30,
  windowMs: 15 * 60 * 1000,
  message: 'Too many payment requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const webhookLimiter = rateLimit({
  max: 200,
  windowMs: 60 * 1000,
  message: 'Too many webhook requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/v1', generalLimiter);
app.use('/api/v1/auth', authLimiter);
app.use('/api/v1/students/payments/initiate', paymentLimiter);
app.use('/api/v1/students/payments/verify', paymentLimiter);
app.use('/api/v1/webhooks', webhookLimiter);

// 4. Logging
app.use(morgan('dev'));

// Capture raw body for Paystack webhook verification (Idempotency & Security)
app.use(
  express.json({
    verify: (req, res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

app.use(express.urlencoded({ extended: true }));

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
