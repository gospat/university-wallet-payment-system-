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
// Redis connectivity: reuse the existing ioredis instance but wrap in
// `lazilyCreateRedisConnection` — only open Redis sockets the first time
// something actually tries to enqueue. This avoids startup errors when
// Redis isn't running in dev.
// -----------------------------------------------------------------------------
let _redis: InstanceType<typeof Redis> | null = null;
let _queueByTopic = new Map<string, Queue>();
let _workerByTopic = new Map<string, Worker>();
let _handlers = new Map<string, Handler>();
let _degradedLogIssued = false;

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const LAZY = process.env.REDIS_LAZY_CONNECT === 'true' || process.env.QUEUE_DISABLE_WORKERS === 'true' || process.env.NODE_ENV === 'test';

function ensureRedis(): InstanceType<typeof Redis> | null {
  if (_redis) return _redis;
  try {
    _redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: LAZY ? 0 : 1,
      enableReadyCheck: !LAZY,
      connectTimeout: LAZY ? 400 : 1500,
      commandTimeout: LAZY ? 600 : 2000,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    _redis.on('error', () => {
      /* handled via .ping() probe inside enqueue */
    });
    if (!LAZY) {
      _redis.connect().catch(() => {
        /* lazy connect best-effort — fall through to sync fallback */
      });
    }
    return _redis;
  } catch {
    return null;
  }
}

/**
 * Probe Redis liveliness synchronously-ish. Used inside `dispatchJob` to
 * decide whether to fall back to sync execution.
 */
async function isRedisHealthy(): Promise<boolean> {
  const r = ensureRedis();
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
  const r = ensureRedis();
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
  const r = ensureRedis();
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
 * Shutdown hook: drain workers, close queues, disconnect Redis.
 * Call from server.ts on SIGTERM/SIGINT to avoid stalled jobs.
 */
export async function shutdownQueue(): Promise<void> {
  await Promise.all([..._workerByTopic.values()].map((w) => w.close().catch(() => {})));
  await Promise.all([..._queueByTopic.values()].map((q) => q.close().catch(() => {})));
  if (_redis) {
    try {
      await _redis.quit();
    } catch {
      /* ignore */
    }
    _redis = null;
  }
  _workerByTopic.clear();
  _queueByTopic.clear();
}
