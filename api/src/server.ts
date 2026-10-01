import './config/loadEnv';
import dotenv from 'dotenv';
import app from './app';
import { z } from 'zod';
import { seedPermissions } from './services/permissionSeed';
import { shutdownQueue } from './config/queue';
import { shutdownEmailQueue } from './queues/emailQueue';
import { shutdownProducerRedis } from './config/redis';
import {
  runProductionGuardrails,
  printStartupGuardrailBanners,
  type GuardrailResult,
} from './config/productionGuardrails';

export type { GuardrailResult };
export { runProductionGuardrails };

// dotenv + expandDollarVars are loaded eagerly in ./config/loadEnv ABOVE
// (before importing app -> routes -> controllers -> auth.ts which
// validates JWT_REFRESH_SECRET at module-level).

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
// Production hardening guardrails IIFE — delegates to pure module at
// ./config/productionGuardrails.ts (which is safe to import in Jest tests —
// no side effects). This IIFE performs only the startup side effects:
//   (a) banner printing (loudspeaker warnings on every prod boot)
//   (b) FATAL misconfiguration → process.exit(2)
// The IIFE is intentionally ONLY run when NODE_ENV === "production".
//
// Invariant:
//   • NO silent upgrade of test/sandbox → live.  Payment modes are reported
//     INDEPENDENTLY for Paystack AND Alatpay.  If either provider is live,
//     the banner EXPLICITLY calls out that real Naira charges may flow
//     through that provider.
//   • The banner does NOT print "NO REAL-MONEY POSSIBLE" derived from the
//     (empty) warning array; instead it reads result.summary fields.
// -----------------------------------------------------------------------------
(function applyProductionGuardrails() {
  if (process.env.NODE_ENV !== 'production') return;
  const result = runProductionGuardrails();

  // Banner first, even when fatal problems exist — operator needs to see
  // payment modes on their screen before the process exits.
  try { printStartupGuardrailBanners(result); } catch {
    // banner printing must never kill the process by itself
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
// deploy restart) and SIGINT (Ctrl-C on dev). Systemd default timeout is 90s
// but PM2/other supervisors often use 30s; we hard cap at 25s so the process
// always exits cleanly under its own power before a SIGKILL arrives.
//
// Installed version: bullmq@5.81.5, ioredis@5.11.1.
// BullMQ v5 close order (documented best practices for v4 and v5):
//   1. stop accepting HTTP -> new job dispatches won't be added
//   2. general topic queue workers + email worker stop polling for new jobs
//      (Worker.close() for BullMQ v5 — blocks until in-flight job finishes)
//   3. producers (Queue.close) stop -> no new Redis writes
//   4. close all Redis sockets cleanly via QUIT (graceful) / DISC fallback
//
// Worker Redis sockets are opened with maxRetriesPerRequest:null and NO
// commandTimeout — required for BullMQ v5's 30s default BRPOPLPUSH blocking
// read loop; a 2s commandTimeout was the root cause of prior Command timed
// out spam in journalctl (fixed in config/redis.ts createBullmqWorkerConnection).
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
