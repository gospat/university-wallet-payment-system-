import dotenv from 'dotenv';
import app from './app';
import { z } from 'zod';
import { seedPermissions } from './services/permissionSeed';

dotenv.config();

(function expandDollarVars(env = process.env) {
  const MAX = 3;
  for (let pass = 0; pass < MAX; pass++) {
    let changed = false;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') continue;
      if (!/\$\{[^}]+\}/.test(v)) continue;
      const next = v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name) => {
        const rep = env[name];
        if (rep === undefined) return _m;
        changed = true;
        return String(rep);
      });
      if (next !== v) env[k] = next;
    }
    if (!changed) return;
  }
})();

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
  const errCode = (err as any)?.code;
  const errName = (err as any)?.name;
  const nestedErrors: unknown[] = (err as any)?.errors ?? [];
  const hasNestedConnRefused = nestedErrors.some(
    (e: any) => e?.code === 'ECONNREFUSED' || String(e?.message ?? '').includes('ECONNREFUSED'),
  );
  const isRedisOrNetwork =
    msg.includes('ECONNREFUSED') ||
    msg.includes('Connection is closed') ||
    msg.includes('Connection timeout') ||
    msg.includes('Redis') ||
    msg.includes('ioredis') ||
    msg.includes('AggregateError') ||
    errCode === 'ECONNREFUSED' ||
    errCode === 'EPIPE' ||
    errCode === 'ECONNRESET' ||
    errName === 'AggregateError' ||
    hasNestedConnRefused;
  if (isRedisOrNetwork) {
    if (!(globalThis as any).__redisWarned) {
      (globalThis as any).__redisWarned = true;
      console.warn('[runtime] Redis is not running — queue/emails will use sync degraded mode (no further warnings will be logged).');
    }
  } else {
    console.error('Unhandled Rejection', err);
    process.exit(1);
  }
});
