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

// -----------------------------------------------------------------------------
// Production hardening guardrails — FAIL-ON-START if any prod-only checks fail.
// These are NON-NEGOTIABLE on paymentapi.bellsuniversity.edu.ng
// -----------------------------------------------------------------------------
(function productionGuardrails() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems: string[] = [];

  const cors = (process.env.CORS_ORIGIN || '').toLowerCase();
  const fbu = (process.env.FRONTEND_BASE_URL || '').toLowerCase();
  const publicUrl = (process.env.PUBLIC_URL || '').toLowerCase();
  const appBase = (process.env.APP_BASE_URL || '').toLowerCase();

  const hasLocalhost = /localhost|127\.0\.0\.1|192\.168\.|10\./.test(cors + fbu + publicUrl + appBase);
  if (hasLocalhost) {
    problems.push(
      'PROD_GUARD: NODE_ENV=production but a URL env contains localhost / private IP. ' +
        'CORS_ORIGIN / FRONTEND_BASE_URL / PUBLIC_URL / APP_BASE_URL must only contain production origins.',
    );
  }
  if (!cors && !fbu) {
    problems.push('PROD_GUARD: NODE_ENV=production but CORS_ORIGIN + FRONTEND_BASE_URL are both empty. Browser frontend will get CORS errors.');
  }
  if (
    !(publicUrl.includes('//payment.') || publicUrl.includes('//paymentapi.') || fbu.includes('//payment.') || cors.includes('payment.bellsuniversity'))
  ) {
    problems.push(
      'PROD_GUARD: Expected PUBLIC_URL / FRONTEND_BASE_URL / CORS_ORIGIN to reference ' +
        'payment.bellsuniversity.edu.ng or paymentapi.bellsuniversity.edu.ng subdomains. ' +
        'Receipt QR / receipt verify URLs may resolve to wrong host.',
    );
  }
  const jwtSec = process.env.JWT_SECRET || '';
  if (
    jwtSec.length < 48 ||
    /change.?me|admin123|password|secret|^dev-|^test-|^sample-/i.test(jwtSec)
  ) {
    problems.push(
      'PROD_GUARD: JWT_SECRET is too short (<48 chars) or looks weak / dev-flavored. ' +
        'Generate a strong 64-byte hex secret: `node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"` ' +
        'and set it in api/.env',
    );
  }
  const enc = process.env.ENCRYPTION_KEY || '';
  if (/0{16,}|a{16,}|b{16,}|fffff{4,}/i.test(enc)) {
    problems.push('PROD_GUARD: ENCRYPTION_KEY looks like a static dev placeholder, NOT a random 32-byte hex. Rotate it.');
  }
  if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST) {
    problems.push(
      'PROD_GUARD: Neither RESEND_API_KEY nor SMTP_HOST are configured. ' +
        'Student welcome emails, password resets, and receipt emails will FAIL. ' +
        'Configure Resend (recommended) or SMTP credentials.',
    );
  }
  if (!process.env.PAYSTACK_SECRET_KEY?.startsWith('sk_live_')) {
    problems.push(
      'PROD_GUARD: PAYSTACK_SECRET_KEY does NOT start with "sk_live_". ' +
        'This is a TEST/DEVELOPMENT key. Real student payments will be rejected by Paystack in production.',
    );
  }
  if (!process.env.ALATPAY_MODE || process.env.ALATPAY_MODE === 'sandbox') {
    problems.push(
      'PROD_GUARD: ALATPAY_MODE is not "prod" (is sandbox/empty). ALAT Pay / WEMA Bank transactions will go to test sandbox. ' +
        'Set ALATPAY_MODE=prod and populate ALATPAY_PROD_SECRET_KEY + ALATPAY_PUBLIC_KEY + ALATPAY_BUSINESS_ID + ALATPAY_WEBHOOK_SECRET.',
    );
  }

  if (problems.length > 0) {
    console.error('\n============================================================');
    console.error('  🛑  PAYMENT API REFUSED TO START — PRODUCTION MISCONFIGURATION');
    console.error('============================================================\n');
    for (const [i, p] of problems.entries()) {
      console.error(`  [${i + 1}/${problems.length}] ${p}\n`);
    }
    console.error('  Fix the problems above, then restart PM2 / the server.');
    console.error('  (If this is a DEVELOPMENT environment, export NODE_ENV=development)\n');
    process.exit(2);
  }
})();

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
