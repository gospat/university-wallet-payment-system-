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

const app = express();

// 1. Security Headers
app.use(helmet());

// 2. CORS
app.use(cors());

// 3. Rate Limiting (Prevent Brute Force & DDoS)
const limiter = rateLimit({
  max: 100, // Limit each IP to 100 requests per `window`
  windowMs: 15 * 60 * 1000, // 15 minutes
  message: 'Too many requests from this IP, please try again in 15 minutes!',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

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

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/bursary', bursaryRoutes);

// Error Handling
app.use(globalErrorHandler);

export default app;
