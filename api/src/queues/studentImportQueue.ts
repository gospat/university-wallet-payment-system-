// =============================================================================
// Student Import Queue — BullMQ driver for the chunked bulk-import engine.
//
// Mirrors the structure of queues/emailQueue.ts:
//   * a lazily-built producer Queue
//   * a dedicated worker Redis connection + Worker
//   * a graceful shutdown hook wired into server.ts
//
// If Redis is unavailable the enqueue silently falls back to running the
// engine INLINE (still DB-progress-tracked) so an admin import never fails
// just because the queue is down.
// =============================================================================

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createBullmqProducerConnection, createBullmqWorkerConnection } from '../config/redis';
import { runStudentImport } from '../services/studentImportRunner';

let _importQueue: Queue | null = null;
let _importProducerRedis: InstanceType<typeof Redis> | null = null;
let _importWorkerRedis: InstanceType<typeof Redis> | null = null;
let _importWorker: Worker | null = null;

export interface EnqueueStudentImportData {
  importRunId: number;
  strategy: 'SKIP' | 'UPDATE';
  actorId: number;
  ip?: string;
  userAgent?: string;
  sendCredentialEmails?: boolean;
  studentImportId?: number | null;
}

function ensureQueue(): Queue | null {
  if (_importQueue) return _importQueue;
  try {
    if (!_importProducerRedis) {
      const LAZY = process.env.REDIS_LAZY_CONNECT === 'true' || process.env.QUEUE_DISABLE_WORKERS === 'true' || process.env.NODE_ENV === 'test';
      _importProducerRedis = createBullmqProducerConnection({
        maxRetriesPerRequest: LAZY ? 0 : 1,
        enableReadyCheck: !LAZY,
        connectTimeout: LAZY ? 400 : 1500,
        commandTimeout: LAZY ? 600 : 2000,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      if (!LAZY) {
        _importProducerRedis.connect().catch(() => { /* inline fallback handles Redis down */ });
      }
    }
    const q = new Queue('student.import', {
      connection: _importProducerRedis,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: { count: 20 },
      },
    });
    _importQueue = q;
    return q;
  } catch {
    return null;
  }
}

/**
 * Enqueue a student import run.
 *
 * In tests nothing is enqueued and nothing runs — the specs drive
 * runStudentImport() directly.
 */
export async function enqueueStudentImport(
  data: EnqueueStudentImportData,
): Promise<{ jobId: string | null; queued: boolean }> {
  if (process.env.NODE_ENV === 'test') {
    return { jobId: null, queued: false };
  }

  try {
    const q = ensureQueue();
    if (q) {
      // String(importRunId) as jobId makes a retried enqueue idempotent:
      // BullMQ rejects a duplicate id while the original job still exists.
      await q.add('import', data, {
        jobId: String(data.importRunId),
        removeOnComplete: true,
        removeOnFail: { count: 20 },
      });
      return { jobId: String(data.importRunId), queued: true };
    }
  } catch (err) {
    try { console.warn('[studentImportQueue] enqueue failed, falling back inline:', (err as Error)?.message?.slice(0, 120)); } catch { /* mute */ }
  }

  // Queue unavailable (or add() threw). NEVER crash the HTTP request — run the
  // engine inline on the next tick. The run is still fully persisted and
  // progress-tracked in the DB, so the admin UI keeps working while Redis is
  // down.
  setImmediate(() => {
    runStudentImport({ ...data, onProgress: undefined }).catch((e) => {
      try { console.warn('[studentImportQueue] inline fallback import failed:', (e as Error)?.message?.slice(0, 200)); } catch { /* mute */ }
    });
  });
  return { jobId: null, queued: false };
}

function createWorker(): Worker | null {
  if (process.env.NODE_ENV === 'test' || process.env.QUEUE_DISABLE_WORKERS === 'true') {
    return null;
  }
  try {
    // Dedicated worker Redis (maxRetriesPerRequest:null, no commandTimeout) —
    // required for BullMQ's long blocking reads.
    if (!_importWorkerRedis) {
      _importWorkerRedis = createBullmqWorkerConnection({
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      _importWorkerRedis.connect().catch(() => { /* worker retries via its own events */ });
    }
    const worker = new Worker('student.import', async (job) => {
      await runStudentImport({
        ...job.data,
        onProgress: (p) => job.updateProgress(p.percent),
      });
    }, {
      connection: _importWorkerRedis,
      concurrency: 1,
      // A 7,000-row run takes minutes, so the lock MUST be long enough to
      // outlive the whole run — otherwise BullMQ would consider the job stalled
      // and re-queue it mid-import.
      lockDuration: 300_000,
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 5_000,
      },
    } as any);
    worker.on('failed', (job, err) => {
      try { console.error('[studentImportQueue] worker failed jobId=', job?.id, ':', err?.message?.slice(0, 120) ?? String(err).slice(0, 120)); } catch { /* mute */ }
    });
    _importWorker = worker;
    return worker;
  } catch {
    return null;
  }
}

let _workerRef = createWorker();
void _workerRef;

/**
 * Graceful shutdown hook for the student-import worker + its two Redis
 * connections. Idempotent, never throws. Called on SIGTERM/SIGINT in server.ts.
 */
export async function shutdownStudentImportQueue(): Promise<void> {
  // (1) worker first — so new jobs stop being pulled mid-close.
  if (_importWorker) {
    const w = _importWorker;
    _importWorker = null;
    try { await w.close(); } catch { /* ignore */ }
  }

  // (2) queue producer
  if (_importQueue) {
    const q = _importQueue;
    _importQueue = null;
    try { await q.close(); } catch { /* ignore */ }
  }

  // (3) worker redis
  if (_importWorkerRedis) {
    const c = _importWorkerRedis;
    _importWorkerRedis = null;
    try { await c.quit(); } catch { try { c.disconnect(false); } catch { /* ignore */ } }
  }

  // (4) producer redis (import-private producer — separate from shared singleton)
  if (_importProducerRedis) {
    const c = _importProducerRedis;
    _importProducerRedis = null;
    try { await c.quit(); } catch { try { c.disconnect(false); } catch { /* ignore */ } }
  }
}
