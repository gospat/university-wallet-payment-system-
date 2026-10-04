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

export function connectRedis(): Promise<Redis> {
  const client = getRedis();
  if ((client as any).status === 'ready' || (client as any).status === 'connecting') {
    return Promise.resolve(client);
  }
  return client.connect().then(() => client).catch(() => client);
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

