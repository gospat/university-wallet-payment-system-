import Redis from 'ioredis';
import { RedisOptions } from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const isTestEnv = process.env.NODE_ENV === 'test';
const lazyConnect = isTestEnv || process.env.REDIS_LAZY_CONNECT === 'true';

// Preserve Redis db selection from REDIS_URL path (/2) or default 0 for
// backwards compatibility with existing prod env redis://localhost:6379/2.
function attachCommonListeners(client: Redis, { silentOnConnRefused }: { silentOnConnRefused: boolean } = { silentOnConnRefused: false }): void {
  client.on('connect', () => {
    if (!lazyConnect) console.log('Redis connected');
  });
  client.on('error', (err: any) => {
    const connRefused =
      err?.code === 'ECONNREFUSED' ||
      (err?.name === 'AggregateError' &&
        err.errors?.some((e: any) => e?.code === 'ECONNREFUSED')) ||
      err?.code === 'EPIPE' ||
      err?.code === 'ECONNRESET';
    if (connRefused && silentOnConnRefused) {
      return;
    }
    console.error('Redis error', err);
  });
}

function baseProducerOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: lazyConnect ? 0 : 1,
    lazyConnect: true as const,
    retryStrategy: (times) => {
      if (lazyConnect) return null;
      if (times > 3) {
        console.warn('Redis connection failed. Caching features will be disabled.');
        return null;
      }
      return Math.min(times * 50, 2000);
    },
    connectTimeout: lazyConnect ? 250 : 10000,
  };
}

/**
 * BullMQ WORKER-COMPATIBLE connection factory.
 * Per BullMQ docs: worker connections MUST use `maxRetriesPerRequest: null`
 * because workers rely on long-running blocking BRPOP/BLPOP commands that
 * intentionally last >=30 seconds. A non-null value (e.g. 1) combined with
 * any commandTimeout causes "Command timed out" + "maxRetriesPerRequest:
 * null is required" warnings on every worker poll iteration.
 *
 * - NO commandTimeout on worker connections (blocking commands must be allowed
 *   to block for BullMQ's full blocking timeout)
 * - enableReadyCheck true so we don't send commands mid-handshake
 * - NO retryStrategy abort after N attempts (workers survive transient blips)
 */
export function createBullmqWorkerConnection(extra: RedisOptions = {}): Redis {
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: true as const,
    enableReadyCheck: true,
    connectTimeout: 10000,
    retryStrategy: (times) => Math.min(times * 100, 2000),
    ...extra,
  });
  attachCommonListeners(client, { silentOnConnRefused: true });
  return client;
}

/**
 * BullMQ PRODUCER / Queue-connection factory: producer connections can use
 * stricter commandTimeout + bounded retries because every Redis command is
 * short-lived (job adds, status checks, heartbeats).
 *
 * We keep the singleton producer exported below separate from the worker
 * connections because the worker config (null retries) would mask real
 * production hangs if used for HTTP request-time enqueues.
 */
export function createBullmqProducerConnection(extra: RedisOptions = {}): Redis {
  const client = new Redis(redisUrl, {
    ...baseProducerOptions(),
    ...extra,
  });
  attachCommonListeners(client, { silentOnConnRefused: true });
  return client;
}

/**
 * Singleton Redis client. In tests and when REDIS_LAZY_CONNECT=true we avoid
 * opening the socket at import-time so Jest can exit cleanly. Consumers that
 * actually need Redis must still guard against a missing connection (see the
 * queue module for the graceful synchronous fallback).
 *
 * NOTE: this default singleton is NOT BullMQ-worker-safe. Use
 * createBullmqWorkerConnection for BullMQ workers.
 */
let instance: Redis | null = null;

function create(): Redis {
  const client = new Redis(redisUrl, baseProducerOptions());
  attachCommonListeners(client);
  // Eagerly connect in non-test / non-lazy environments.
  if (!lazyConnect) {
    client.connect().catch(() => {
      /* handled by error listener + graceful fallbacks downstream */
    });
  }
  return client;
}

export function getRedis(): Redis {
  if (!instance) instance = create();
  return instance;
}

/**
 * Waits until the ioredis singleton emits "ready" (real handshake completed +
 * AUTH/SELECT finished) OR a terminal failure fires, whichever comes first.
 *
 * Connect-attempt lifecycle states we see on ioredis 5.x:
 *   wait         → connect() not yet called; socket closed.
 *   connecting   → TCP socket opened; Redis server handshake in progress.
 *   reconnecting → previous attempt failed; retryStrategy has scheduled a retry.
 *   ready        → Handshake OK; AUTH + SELECT db completed. Commands safe.
 *   close / end  → terminal states; socket closed permanently or client ended.
 *
 * IMPORTANT: "connecting" ≠ "ready safe".
 *   The previous buggy implementation short-circuited on status="connecting"
 *   and returned Promise.resolve(client) IMMEDIATELY. That caused the caller
 *   (server.ts bootstrap()) to think Redis pre-connect had completed, so
 *   app.ts was dynamically imported ~500ms BEFORE ioredis actually emitted
 *   "ready".  buildRateLimitStore() then saw status="connecting" and all 8
 *   limiters permanently chose MemoryStore for the process lifetime — even
 *   though Redis was healthy and finished handshaking 500ms later.
 *
 * This function now represents READINESS:
 *   - status === "ready"     → resolve(client) instantly.
 *   - status === "connecting" → do NOT call client.connect() again (would
 *                               throw "Redis is already connecting"). Instead
 *                               install ONE-SHOT event listeners for
 *                               "ready"/"error"/"close"/"end". Clean up all
 *                               competing listeners after the first event to
 *                               avoid listener leaks across repeated calls.
 *   - status === "wait"       → call client.connect() then wait for ready.
 *   - status === "reconnecting" → wait on the same events (an internal retry
 *                               is already in flight). Don't call connect().
 *   - status === "close"/"end" → connect() fresh if possible, else fall back.
 *
 * Graceful degradation: this promise NEVER rejects. On terminal failure or
 * per-call bounded timeout we still resolve(client) so the caller can degrade
 * to MemoryStore (see server.ts bounded Promise.race for the outer cap).
 *
 * Caller (server.ts bootstrap) STILL wraps this with its own outer timeout so
 * a genuine Redis outage cannot indefinitely block the HTTP server from
 * starting.
 */
export function connectRedis(perCallTimeoutMs: number = 30_000): Promise<Redis> {
  const client = getRedis();
  const statusNow: string = (client as any).status ?? '';

  // Fast path: handshake already completed — return immediately.
  if (statusNow === 'ready') {
    return Promise.resolve(client);
  }

  // Slow path: wait for actual "ready" event.
  return new Promise<Redis>((resolve) => {
    const settle = () => resolve(client);
    const safeOff = (evt: string, fn: (...args: any[]) => void) => {
      try { (client as any).removeListener(evt, fn); } catch { /* ignore */ }
    };

    // Competing once() listeners — exactly one will fire; clean up the rest.
    const onReady = () => { cleanupAll(); settle(); };
    const onError = (_err: unknown) => { cleanupAll(); settle(); };
    const onClose = () => { cleanupAll(); settle(); };
    const onEnd = () => { cleanupAll(); settle(); };

    const cleanupAll = () => {
      safeOff('ready', onReady);
      safeOff('error', onError);
      safeOff('close', onClose);
      safeOff('end', onEnd);
      if (timeoutId) clearTimeout(timeoutId);
    };

    // Per-call safety net: never hang longer than perCallTimeoutMs even if
    // the ioredis retryStrategy keeps promising "next retry".
    let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
      timeoutId = null;
      cleanupAll();
      settle();
    }, perCallTimeoutMs);
    if (timeoutId.unref) timeoutId.unref();

    client.once('ready', onReady);
    client.once('error', onError);
    client.once('close', onClose);
    client.once('end', onEnd);

    // Trigger the connect only if ioredis isn't already trying to connect.
    // Calling connect() while status==="connecting" throws synchronously.
    if (statusNow === 'wait' || statusNow === 'close' || statusNow === 'end') {
      try {
        void client.connect().catch(() => { /* handled by event listeners */ });
      } catch {
        // Already connecting or permanently ended — settle via events.
      }
    }
  });
}

/**
 * Graceful shutdown — closes the singleton producer Redis if it was created.
 * Idempotent: safe to call multiple times (e.g. SIGTERM then SIGINT fallback).
 */
export async function shutdownProducerRedis(): Promise<void> {
  if (!instance) return;
  const client = instance;
  instance = null;
  try {
    await client.quit();
  } catch {
    try { client.disconnect(false); } catch { /* ignore */ }
  }
}

export default new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    const client = getRedis();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

