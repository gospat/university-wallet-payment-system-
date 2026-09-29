// =============================================================================
// Queue Dispatcher — BullMQ with graceful sync fallback
// -----------------------------------------------------------------------------
// Design goals (TR-4.1, TR-4.3):
//   1. Provide a single `dispatchJob()` API used by every controller/service
//      that wants async, at-least-once execution (webhook handlers, receipts,
//      emails, PDF renders, report exports).
//   2. If Redis is unreachable, degrade SILENTLY to in-process synchronous
//      execution. No payloads should be dropped — spec explicitly requires
//      Paystack webhooks to process even when Redis is offline.
//   3. Enforce per-topic concurrency, retries with backoff, and dead-letter
//      bookkeeping so nothing disappears silently.
//
// Usage:
//   dispatchJob('paystack.webhook', { event: 'charge.success', ref: '...' });
//   registerHandler('paystack.webhook', async (payload, ctx) => { ... });
// =============================================================================

import { Job, Queue, Worker, Processor } from 'bullmq';
import Redis from 'ioredis';
import { createBullmqProducerConnection, createBullmqWorkerConnection } from './redis';

export type JobTopic =
  | 'paystack.webhook'
  | 'paystack.refund'
  | 'alatpay.webhook'
  | 'receipt.generate'
  | 'receipt.email'
  | 'student.import'
  | 'fee.assign'
  | 'report.export'
  | 'email.send';

export interface DispatchOptions {
  jobId?: string;
  delayMs?: number;
  retries?: number;
  priority?: 'low' | 'normal' | 'high';
  deduplicate?: boolean;
}

export interface HandlerCtx {
  attempt: number;
  jobId?: string;
}

type Handler<P = unknown> = (payload: P, ctx: HandlerCtx) => Promise<void> | void;

// -----------------------------------------------------------------------------
// Redis connectivity: TWO SEPARATE clients (required by BullMQ v3).
//
// 1. PRODUCER connection: short-lived commands only (job ADDs, ping checks).
//    Keeps strict commandTimeout + bounded retries so HTTP requests don't hang.
//    maxRetriesPerRequest = 1 so any stuck Redis command fails fast.
//
// 2. WORKER connection: BullMQ Worker uses LONG BLOCKING BRPOP / BLPOP /
//    BRPOPLPUSH commands that intentionally hold for 5-30+ seconds (BullMQ
//    default blocking timeout is 30s). Worker connections MUST use:
//      - maxRetriesPerRequest = null (BullMQ warning otherwise every poll)
//      - NO commandTimeout (would interrupt blocking reads on every iteration)
//      - enableReadyCheck true + a resilient retryStrategy
//
// Reusing the producer client for the worker (old code) causes:
//   "Command timed out" spam every 2s when 2s commandTimeout hits on BRPOP
//   "maxRetriesPerRequest is set to 1, this is not compatible..." warnings
//
// Database selection (/2 in REDIS_URL) preserved — createBullmq* factories
// parse REDIS_URL exactly including its path portion.
// -----------------------------------------------------------------------------
let _producerRedis: InstanceType<typeof Redis> | null = null;
let _workerRedis: InstanceType<typeof Redis> | null = null;
let _queueByTopic = new Map<string, Queue>();
let _workerByTopic = new Map<string, Worker>();
let _handlers = new Map<string, Handler>();
let _degradedLogIssued = false;

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const LAZY = process.env.REDIS_LAZY_CONNECT === 'true' || process.env.QUEUE_DISABLE_WORKERS === 'true' || process.env.NODE_ENV === 'test';

/**
 * Producer Redis client used for dispatch/job-ADD + health ping. This is the
 * ONLY client allowed to have commandTimeout (we keep a 2s strict cap since
 * these commands happen inside user-facing HTTP handlers and must fail fast
 * to fall through to sync degraded mode).
 */
function ensureProducerRedis(): InstanceType<typeof Redis> | null {
  if (_producerRedis) return _producerRedis;
  try {
    _producerRedis = createBullmqProducerConnection({
      maxRetriesPerRequest: LAZY ? 0 : 1,
      enableReadyCheck: !LAZY,
      connectTimeout: LAZY ? 400 : 1500,
      commandTimeout: LAZY ? 600 : 2000,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    if (!LAZY) {
      _producerRedis.connect().catch(() => {
        /* lazy connect best-effort — fall through to sync fallback */
      });
    }
    return _producerRedis;
  } catch {
    return null;
  }
}

/**
 * Worker Redis client used ONLY by BullMQ Worker instances. Nulls out every
 * setting that would interrupt the long blocking queue reads that BullMQ
 * Workers rely on. Single shared client for all queue topics (same DB /2)
 * which is safe because ioredis multiplexes commands over one socket.
 */
function ensureWorkerRedis(): InstanceType<typeof Redis> | null {
  if (_workerRedis) return _workerRedis;
  try {
    // maxRetriesPerRequest:null is REQUIRED for BullMQ workers (otherwise
    // every BRPOP emits the "maxRetriesPerRequest must be null" warning).
    _workerRedis = createBullmqWorkerConnection({
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    if (!LAZY) {
      _workerRedis.connect().catch(() => {
        /* worker will retry via its own connection events */
      });
    }
    return _workerRedis;
  } catch {
    return null;
  }
}

/**
 * Probe Redis liveliness synchronously-ish. Used inside `dispatchJob` to
 * decide whether to fall back to sync execution.
 *
 * Uses the PRODUCER connection so the commandTimeout short-fuse applies; if
 * this used the worker connection we'd hang for the full blocking timeout
 * on every dispatch when Redis is down.
 */
async function isRedisHealthy(): Promise<boolean> {
  const r = ensureProducerRedis();
  if (!r) return false;
  try {
    await Promise.race([r.ping(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ping-timed-out')), 700))]);
    return true;
  } catch {
    return false;
  }
}

function backoffFor(attempt: number) {
  // 2s, 10s, 1m, 5m cap — same as BullMQ exponential.
  return Math.min(5 * 60 * 1000, Math.pow(5, attempt) * 2000);
}

// -----------------------------------------------------------------------------
// Topic defaults (concurrency, retries, ttl)
// -----------------------------------------------------------------------------
const TOPIC_DEFAULTS: Record<JobTopic, { concurrency: number; retries: number; attempts: number }> = {
  'paystack.webhook':    { concurrency: 4, retries: 4, attempts: 5 },
  'paystack.refund':     { concurrency: 2, retries: 4, attempts: 5 },
  'alatpay.webhook':     { concurrency: 4, retries: 4, attempts: 5 },
  'receipt.generate':    { concurrency: 3, retries: 3, attempts: 4 },
  'receipt.email':       { concurrency: 4, retries: 4, attempts: 5 },
  'student.import':      { concurrency: 1, retries: 0, attempts: 1 },
  'fee.assign':          { concurrency: 1, retries: 2, attempts: 3 },
  'report.export':       { concurrency: 2, retries: 1, attempts: 2 },
  'email.send':          { concurrency: 4, retries: 4, attempts: 5 },
};

// -----------------------------------------------------------------------------
// Synchronous fallback — runs handler inline with backoff retries on failure.
// Identical semantics to BullMQ (bounded attempts, handlerCtx.attempt).
// On final failure, logs payload to `degraded_job_failures` (console + no-op
// persistence in this scaffold; add a JSONL append or DB table in prod).
// -----------------------------------------------------------------------------
async function runWithRetries<P>(
  topic: string,
  payload: P,
  handler: Handler<P>,
  retries: number,
  jobId?: string,
): Promise<void> {
  const attempts = retries + 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await (handler as Handler<P>)(payload, { attempt, jobId });
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      const delayMs = backoffFor(attempt);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // eslint-disable-next-line no-console
  console.error(
    `[queue:degraded] FAILED topic=${topic} jobId=${jobId ?? 'n/a'} attempts=${attempts} — final error:`,
    lastErr,
    '\n  payload =',
    JSON.stringify(payload).slice(0, 600),
  );
  // Re-raise so callers can surface error for synchronous user-visible flows.
  throw lastErr;
}

function ensureQueue(topic: string): Queue | null {
  const existing = _queueByTopic.get(topic);
  if (existing) return existing;
  const r = ensureProducerRedis();
  if (!r) return null;
  const q = new Queue(topic, { connection: r, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 } });
  _queueByTopic.set(topic, q);
  return q;
}

function ensureWorker<P>(topic: string, handler: Handler<P>): Worker | null {
  const existing = _workerByTopic.get(topic);
  if (existing) return existing;
  // Avoid spinning up BullMQ Worker sockets during tests — they open Redis
  // connections even when lazy=true and keep the event loop alive. The
  // dispatchJob() sync fallback still exercises handlers in-process.
  if (process.env.NODE_ENV === 'test' || process.env.QUEUE_DISABLE_WORKERS === 'true') {
    return null;
  }
  const r = ensureWorkerRedis();
  if (!r) return null;
  const defaults = TOPIC_DEFAULTS[topic as JobTopic] ?? { concurrency: 2, retries: 2, attempts: 3 };

  const processor: Processor = async (job: Job) => {
    try {
      await (handler as Handler<P>)(job.data as P, { attempt: job.attemptsMade + 1, jobId: job.id });
    } catch (err) {
      // Rethrow so BullMQ increments attempts and applies its own backoff.
      throw err;
    }
  };

  const w = new Worker(topic, processor, {
    connection: r,
    concurrency: defaults.concurrency,
    settings: {
      backoffStrategies: {
        platform_exp: (attemptsMade: number) => backoffFor(attemptsMade),
      },
    },
  } as any);
  w.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[queue:bullmq] FAILED topic=${topic} jobId=${job?.id ?? 'n/a'} attempts=${job?.attemptsMade ?? 0}:`,
      err?.message ?? err,
    );
  });
  _workerByTopic.set(topic, w);
  return w;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Register a handler for a topic. MUST be called exactly once per topic at
 * boot (in `server.ts` or a top-level `queueWorkers.ts`). If another handler
 * is already registered for the same topic, we keep the first one and log a
 * warning — accidental double-registration is a common dev bug.
 */
export function registerHandler<P = unknown>(topic: JobTopic, handler: Handler<P>): void {
  if (_handlers.has(topic)) {
    // eslint-disable-next-line no-console
    console.warn(`[queue] double registerHandler ignored for topic=${topic}`);
    return;
  }
  _handlers.set(topic, handler as Handler);
  // Try to start the BullMQ worker immediately if Redis is up.
  ensureWorker(topic, handler as Handler);
}

/**
 * Submit a job. Idempotent when `opts.deduplicate = true` and `opts.jobId`
 * is supplied — BullMQ will atomically reject duplicate jobIds which is how
 * we layer paystack webhook idempotency on top of the DB `webhook_events`
 * table (belt + suspenders).
 *
 * Returns a promise that resolves when:
 *   - BullMQ accepted the job (Redis online)
 *   - OR the sync handler finished successfully (Redis offline)
 * This allows endpoints like the Paystack webhook to return 200 fast while
 * still guaranteeing no silent data loss.
 */
export async function dispatchJob<P = unknown>(
  topic: JobTopic,
  payload: P,
  opts: DispatchOptions = {},
): Promise<void> {
  const { jobId, delayMs = 0, retries: retriesOpt, priority = 'normal', deduplicate = true } = opts;
  const defaults = TOPIC_DEFAULTS[topic] ?? { retries: 2, attempts: 3 };
  const retries = retriesOpt ?? defaults.retries;
  const handler = _handlers.get(topic);
  if (!handler) {
    throw new Error(`[queue] no handler registered for topic=${topic}`);
  }

  // Fast path: Redis available → enqueue.
  const healthy = await isRedisHealthy();
  if (healthy) {
    try {
      const q = ensureQueue(topic);
      if (q) {
        await q.add(topic, payload, {
          jobId: deduplicate ? jobId : undefined,
          delay: delayMs,
          attempts: retries + 1,
          backoff: { type: 'platform_exp' as any },
          priority: priority === 'high' ? 1 : priority === 'low' ? 10 : 5,
          removeOnComplete: 1000,
          removeOnFail: 5000,
        });
        return;
      }
    } catch (bullErr) {
      if (!_degradedLogIssued) {
        // eslint-disable-next-line no-console
        console.warn('[queue] BullMQ enqueue failed — falling back to sync inline execution:', (bullErr as Error)?.message);
        _degradedLogIssued = true;
      }
      // fall through → sync execution below
    }
  } else if (!_degradedLogIssued) {
    // eslint-disable-next-line no-console
    console.warn('[queue] Redis unavailable — running jobs synchronously (degraded mode).');
    _degradedLogIssued = true;
  }

  // Slow path: synchronous inline execution with retries.
  await runWithRetries(topic, payload, handler as Handler<P>, retries, jobId);
}

/**
 * Admin health probe — returns whether queue is using BullMQ or sync fallback.
 */
export async function getQueueHealth(): Promise<{ mode: 'bullmq' | 'degraded'; redisConnected: boolean; topics: number }> {
  const redisConnected = await isRedisHealthy();
  return {
    mode: redisConnected ? 'bullmq' : 'degraded',
    redisConnected,
    topics: _handlers.size,
  };
}

/**
 * Shutdown hook: drain workers, close queues, disconnect producer + worker
 * Redis connections. Call from server.ts on SIGTERM/SIGINT to avoid stalled
 * jobs. Idempotent: safe to invoke multiple times.
 */
export async function shutdownQueue(): Promise<void> {
  // (1) close workers FIRST (so they don't try to read from a closed queue/redis)
  await Promise.all([..._workerByTopic.values()].map((w) => w.close().catch(() => {})));
  _workerByTopic.clear();

  // (2) close queues (producers)
  await Promise.all([..._queueByTopic.values()].map((q) => q.close().catch(() => {})));
  _queueByTopic.clear();

  // (3) disconnect worker redis — use quit (clean, won't interrupt in-flight
  //     blocking reads); fallback to hard disconnect if quit hangs.
  if (_workerRedis) {
    const client = _workerRedis;
    _workerRedis = null;
    try { await client.quit(); } catch { try { client.disconnect(false); } catch { /* ignore */ } }
  }

  // (4) disconnect producer redis
  if (_producerRedis) {
    const client = _producerRedis;
    _producerRedis = null;
    try { await client.quit(); } catch { try { client.disconnect(false); } catch { /* ignore */ } }
  }
}
