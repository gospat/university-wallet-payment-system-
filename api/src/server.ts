import dotenv from 'dotenv';
import app from './app';
import { z } from 'zod';
import { seedPermissions } from './services/permissionSeed';

dotenv.config();

if (process.env.REDIS_LAZY_CONNECT === 'true' && !process.env.QUEUE_DISABLE_WORKERS) {
  process.env.QUEUE_DISABLE_WORKERS = 'true';
}

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_CALLBACK_URL: z.string().url().optional(),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes hex (64 chars)'),
  CORS_ORIGIN: z.string().optional(),
  METRICS_TOKEN: z.string().min(16).optional(),
  ALATPAY_MODE: z.enum(['sandbox', 'prod']).optional().default('sandbox'),
  ALATPAY_SANDBOX_SECRET_KEY: z.string().optional(),
  ALATPAY_PROD_SECRET_KEY: z.string().optional(),
  ALATPAY_PUBLIC_KEY: z.string().optional(),
  ALATPAY_BUSINESS_ID: z.string().optional(),
  ALATPAY_WEBHOOK_SECRET: z.string().optional(),
  ALATPAY_BASE_URL: z.string().url().optional(),
});

envSchema.parse(process.env);

const port = process.env.PORT ? Number(process.env.PORT) : 3001;

async function bootstrap() {
  try {
    await seedPermissions();
    console.log('Permissions seed applied (idempotent)');
  } catch (err) {
    console.warn('Permissions seed skipped:', err instanceof Error ? err.message : String(err));
  }
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

bootstrap();

process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const isRedisOrNetwork =
    msg.includes('ECONNREFUSED') ||
    msg.includes('Connection is closed') ||
    msg.includes('Connection timeout') ||
    msg.includes('Redis') ||
    msg.includes('ioredis') ||
    msg.includes('AggregateError');
  if (isRedisOrNetwork) {
    console.warn('[runtime] swallowed non-fatal unhandled rejection:', msg.slice(0, 200));
  } else {
    console.error('Unhandled Rejection', err);
    process.exit(1);
  }
});
