import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { globalErrorHandler } from './middlewares/error';
import authRoutes from './routes/auth';
import walletRoutes from './routes/wallet';
import adminRoutes from './routes/admin';
import bursaryRoutes from './routes/bursary';
import path from 'path';
import './config/redis';
import prisma from './config/database';
import client from 'prom-client';

const app = express();

// 1. Security Headers
app.use(helmet());
app.disable('x-powered-by');

// 2. CORS
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
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

app.use('/api/v1', generalLimiter);
app.use('/api/v1/auth', authLimiter);
app.use('/api/v1/wallet/deposit', paymentLimiter);
app.use('/api/v1/wallet/verify', paymentLimiter);

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
      service: 'university-wallet-api',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  });
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
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/bursary', bursaryRoutes);

// Error Handling
app.use(globalErrorHandler);

export default app;
