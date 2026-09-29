import dotenv from 'dotenv';
import app from './app';
import { z } from 'zod';
import { seedPermissions } from './services/permissionSeed';
import { shutdownQueue } from './config/queue';
import { shutdownEmailQueue } from './queues/emailQueue';
import { shutdownProducerRedis } from './config/redis';

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
// Production hardening guardrails
// -----------------------------------------------------------------------------
// Two separate classes of checks:
//
//   1. FATAL problems — things that MUST NOT run on production public URLs,
//      because they either expose user data, or refuse all browser/app traffic,
//      or mean secrets are trivially crackable.  ANY fatal → process.exit(2).
//
//   2. PAYMENT-MODE warnings — PAYSTACK_SECRET_KEY still has sk_test_ prefix
//      and/or ALATPAY_MODE is still sandbox.  These are **intentionally**
//      allowed on production infrastructure during the go-live payment-testing
//      phase the Bells University ops team is currently running.  We:
//        • PRINT A LOUDSPEAKER STARTUP BANNER so operators CANNOT miss it,
//        • NEVER SILENTLY UPGRADE TEST/SANDBOX TO LIVE.
//          Paystack remains in test because the key prefix is sk_test_,
//          Alatpay remains in sandbox because ALATPAY_MODE is sandbox.
//          Real-money transactions therefore CANNOT go through — the code
//          in paystack.ts / utils/alatpay.ts always reads the env values
//          directly; it never derives the mode from NODE_ENV.
//
// Provider mode check details (safety invariant for real-money safety):
//   • Paystack: PaystackService.SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
//     Paystack distinguishes test vs live SOLELY via the key prefix.
//     sk_test_ → always hits api.paystack.co with test mode; no real debits.
//     sk_live_ → real money. Guardrails warn, never modify the key/env.
//   • Alatpay:  ALATPAY_MODE = 'prod' ? prod : sandbox
//     getActiveAlatpaySecretKey() + getAlatpayBaseUrl() both read MODE env,
//     never infer from NODE_ENV.  sandbox mode = https://apibox.alatpay.ng test.
// -----------------------------------------------------------------------------
export interface GuardrailResult {
  fatalProblems: string[];
  paymentModeWarnings: { provider: string; message: string }[];
  paymentModes: {
    paystack: 'live' | 'test' | 'unknown';
    alatpay: 'prod' | 'sandbox' | 'unknown';
  };
}

export function runProductionGuardrails(env: NodeJS.ProcessEnv = process.env): GuardrailResult {
  const fatalProblems: string[] = [];
  const paymentModeWarnings: GuardrailResult['paymentModeWarnings'] = [];

  const cors = (env.CORS_ORIGIN || '').toLowerCase();
  const fbu = (env.FRONTEND_BASE_URL || '').toLowerCase();
  const publicUrl = (env.PUBLIC_URL || '').toLowerCase();
  const appBase = (env.APP_BASE_URL || '').toLowerCase();

  // --- CATEGORY A: FATAL (always hard exit on production NODE_ENV) ---
  const hasLocalhost = /localhost|127\.0\.0\.1|192\.168\.|10\./.test(cors + fbu + publicUrl + appBase);
  if (hasLocalhost) {
    fatalProblems.push(
      'PROD_GUARD: NODE_ENV=production but a URL env contains localhost / private IP. ' +
        'CORS_ORIGIN / FRONTEND_BASE_URL / PUBLIC_URL / APP_BASE_URL must only contain production origins.',
    );
  }
  if (!cors && !fbu) {
    fatalProblems.push('PROD_GUARD: NODE_ENV=production but CORS_ORIGIN + FRONTEND_BASE_URL are both empty. Browser frontend will get CORS errors.');
  }
  if (
    !(publicUrl.includes('//payment.') || publicUrl.includes('//paymentapi.') || fbu.includes('//payment.') || cors.includes('payment.bellsuniversity'))
  ) {
    fatalProblems.push(
      'PROD_GUARD: Expected PUBLIC_URL / FRONTEND_BASE_URL / CORS_ORIGIN to reference ' +
        'payment.bellsuniversity.edu.ng or paymentapi.bellsuniversity.edu.ng subdomains. ' +
        'Receipt QR / receipt verify URLs may resolve to wrong host.',
    );
  }
  const jwtSec = env.JWT_SECRET || '';
  if (
    jwtSec.length < 48 ||
    /change.?me|admin123|password|secret|^dev-|^test-|^sample-/i.test(jwtSec)
  ) {
    fatalProblems.push(
      'PROD_GUARD: JWT_SECRET is too short (<48 chars) or looks weak / dev-flavored. ' +
        'Generate a strong 64-byte hex secret: `node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"` ' +
        'and set it in api/.env',
    );
  }
  const enc = env.ENCRYPTION_KEY || '';
  if (/0{16,}|a{16,}|b{16,}|fffff{4,}/i.test(enc)) {
    fatalProblems.push('PROD_GUARD: ENCRYPTION_KEY looks like a static dev placeholder, NOT a random 32-byte hex. Rotate it.');
  }
  if (!env.RESEND_API_KEY && !env.SMTP_HOST) {
    fatalProblems.push(
      'PROD_GUARD: Neither RESEND_API_KEY nor SMTP_HOST are configured. ' +
        'Student welcome emails, password resets, and receipt emails will FAIL. ' +
        'Configure Resend (recommended) or SMTP credentials.',
    );
  }

  // --- CATEGORY B: PAYMENT-MODE WARNINGS (WARN ONLY. NEVER UPGRADE MODES.) ---
  // Paystack: key prefix = 'sk_test_' → warn but allow startup during test phase.
  const paystackKey = env.PAYSTACK_SECRET_KEY ?? '';
  let paystackMode: GuardrailResult['paymentModes']['paystack'] = 'unknown';
  if (paystackKey.startsWith('sk_live_')) {
    paystackMode = 'live';
  } else if (paystackKey.startsWith('sk_test_')) {
    paystackMode = 'test';
    paymentModeWarnings.push({
      provider: 'PAYSTACK',
      message:
        'PAYSTACK_SECRET_KEY is prefixed sk_test_ so Paystack is in TEST/SANDBOX MODE. ' +
        'No real naira charges can go through — Paystack gateway returns test-env transactions only. ' +
        'To go live, replace PAYSTACK_SECRET_KEY with one starting sk_live_ in api/.env and restart.',
    });
  } else if (paystackKey) {
    paymentModeWarnings.push({
      provider: 'PAYSTACK',
      message:
        'PAYSTACK_SECRET_KEY does not start with sk_live_ OR sk_test_. Confirm validity in the Paystack dashboard Settings → API Keys page.',
    });
  }

  // Alatpay: ALATPAY_MODE !== 'prod' → sandbox (default per zod schema too)
  const alatMode = env.ALATPAY_MODE ?? 'sandbox';
  let alatpayMode: GuardrailResult['paymentModes']['alatpay'] = 'unknown';
  if (alatMode === 'prod') {
    alatpayMode = 'prod';
  } else {
    alatpayMode = 'sandbox';
    paymentModeWarnings.push({
      provider: 'ALATPAY/WEMA',
      message:
        `ALATPAY_MODE is "${alatMode}" → SANDBOX/TEST MODE (ALATPAY PROD is not enabled). ` +
        'All ALAT Pay / WEMA Bank transactions go to https://apibox.alatpay.ng sandbox only. ' +
        'To go live, set ALATPAY_MODE=prod and populate ALATPAY_PROD_SECRET_KEY, ALATPAY_PUBLIC_KEY, ALATPAY_BUSINESS_ID, ALATPAY_WEBHOOK_SECRET in api/.env and restart.',
    });
  }

  return {
    fatalProblems,
    paymentModeWarnings,
    paymentModes: { paystack: paystackMode, alatpay: alatpayMode },
  };
}

function printLargeBanner(lines: string[], style: 'fatal' | 'warn' = 'warn'): void {
  const edge = style === 'fatal' ? '⚠️' : '🔔';
  const width = 72;
  const sep = edge.repeat(Math.max(4, Math.ceil(width / edge.length))).slice(0, width);
  const stream: (...a: any[]) => void = style === 'fatal' ? console.error : console.warn;
  stream('');
  stream(sep);
  for (const line of lines) {
    const wrapped = String(line).length > width - 4 ? String(line).slice(0, width - 4) : String(line);
    stream(`${edge} ${wrapped.padEnd(width - 4)} ${edge}`);
  }
  stream(sep);
  stream('');
}

(function applyProductionGuardrails() {
  if (process.env.NODE_ENV !== 'production') return;
  const result = runProductionGuardrails();

  // PAYMENT MODE WARNINGS FIRST (large banner) — WARN-ONLY, NEVER process.exit.
  if (result.paymentModeWarnings.length > 0) {
    const bannerLines: string[] = [
      '  PAYMENT PROVIDERS — TEST / SANDBOX MODE ONLY — NO REAL-MONEY',
      '  =============================================================',
      '',
    ];
    for (const w of result.paymentModeWarnings) {
      bannerLines.push(`  [${w.provider}] ${w.message.slice(0, 240)}`);
      bannerLines.push('');
    }
    bannerLines.push('  This startup IS intentionally allowed for payment-testing on prod infra.');
    bannerLines.push('  Ops team: swap env vars + restart once Bursary go-live is approved.');
    printLargeBanner(bannerLines, 'warn');
  } else {
    // All providers live. Print OK banner for auditable confirmation.
    printLargeBanner(
      [
        `  PAYSTACK mode = ${String(result.paymentModes.paystack).toUpperCase()}`,
        `  ALATPAY  mode = ${String(result.paymentModes.alatpay).toUpperCase()}`,
        '',
        '  Production payment modes confirmed. Real-money transactions enabled.',
      ],
      'warn',
    );
  }

  // FATAL PROBLEMS → HARD EXIT. Always, no exceptions.
  if (result.fatalProblems.length > 0) {
    console.error('\n============================================================');
    console.error('  🛑  PAYMENT API REFUSED TO START — PRODUCTION MISCONFIGURATION');
    console.error('============================================================\n');
    for (const [i, p] of result.fatalProblems.entries()) {
      console.error(`  [${i + 1}/${result.fatalProblems.length}] ${p}\n`);
    }
    console.error('  Fix the problems above, then restart systemd / the server.');
    console.error('  (If this is a DEVELOPMENT environment, export NODE_ENV=development)\n');
    process.exit(2);
  }
})();

const port = process.env.PORT ? Number(process.env.PORT) : 3001;

let httpServer: ReturnType<typeof app.listen> | null = null;

async function bootstrap() {
  try {
    await seedPermissions();
    console.log('Permissions seed applied (idempotent)');
  } catch (err) {
    console.warn('Permissions seed skipped:', err instanceof Error ? err.message : String(err));
  }
  httpServer = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

bootstrap();

// -----------------------------------------------------------------------------
// Graceful shutdown: idempotent single-run handler for SIGTERM (systemd stop,
// deploy restart) and SIGINT (Ctrl-C on dev). Systemd's default timeout is 90s
// but PM2/other supervisors often use 30s; we hard cap at 25s so the process
// always exits cleanly under its own power before a SIGKILL arrives.
//
// Close order matches BullMQ docs best practices:
//   1. stop accepting HTTP -> new job dispatches won't be added
//   2. general topic queue workers + email worker stop polling for new jobs
//   3. producers (queues) stop -> no Redis writes
//   4. close all Redis sockets cleanly via QUIT (graceful) / DISC fallback
// -----------------------------------------------------------------------------
let shutdownInProgress = false;

async function performGracefulShutdown(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[shutdown] ${signal} received — draining workers then exiting.`);

  // Safety net: force-exit if shutdown doesn't complete in 25s
  const forceTimer = setTimeout(() => {
    console.error('[shutdown] timed out after 25s — force-exit code=143');
    process.exit(143);
  }, 25000);
  forceTimer.unref?.();

  try {
    // Step 1: stop accepting new HTTP requests. Let in-flight requests finish
    // (server.close stops accepting, does NOT drop active keepalive sockets).
    if (httpServer) {
      await new Promise<void>((resolve) => {
        // server.close(cb) may take seconds for keepalive; timeout resolve if hung
        const hung = setTimeout(() => resolve(), 10000);
        hung.unref?.();
        try {
          httpServer?.close(() => { clearTimeout(hung); resolve(); });
        } catch {
          clearTimeout(hung);
          resolve();
        }
      });
      httpServer = null;
      console.log('[shutdown] HTTP server — no longer accepting new connections.');
    }

    // Step 2: close both worker pools first (stop polling for jobs)
    try { await shutdownQueue(); } catch (e) { try { console.warn('[shutdown] shutdownQueue:', (e as Error).message); } catch {} }
    try { await shutdownEmailQueue(); } catch (e) { try { console.warn('[shutdown] shutdownEmailQueue:', (e as Error).message); } catch {} }

    // Step 3: close the shared singleton producer Redis (used outside queues,
    // e.g. rate-limiter store)
    try { await shutdownProducerRedis(); } catch (e) { try { console.warn('[shutdown] shutdownProducerRedis:', (e as Error).message); } catch {} }

    console.log('[shutdown] clean exit code=0');
    clearTimeout(forceTimer);
    process.exit(0);
  } catch (rootErr) {
    console.error('[shutdown] fatal during drain — force-exit code=143:', rootErr instanceof Error ? rootErr.message : String(rootErr));
    clearTimeout(forceTimer);
    process.exit(143);
  }
}

// Only attach production-env signal handlers once and NOT in Jest tests —
// Jest installs its own signal handlers that conflict with user listeners.
if (process.env.NODE_ENV !== 'test') {
  process.once('SIGTERM', () => void performGracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => void performGracefulShutdown('SIGINT'));
}

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
