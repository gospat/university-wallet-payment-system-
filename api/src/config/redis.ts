import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const isTestEnv = process.env.NODE_ENV === 'test';
const lazyConnect = isTestEnv || process.env.REDIS_LAZY_CONNECT === 'true';

/**
 * Singleton Redis client. In tests and when REDIS_LAZY_CONNECT=true we avoid
 * opening the socket at import-time so Jest can exit cleanly. Consumers that
 * actually need Redis must still guard against a missing connection (see the
 * queue module for the graceful synchronous fallback).
 */
let instance: Redis | null = null;

function create(): Redis {
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: lazyConnect ? 0 : 1,
    lazyConnect: true,
    retryStrategy: (times) => {
      if (lazyConnect) return null;
      if (times > 3) {
        console.warn('Redis connection failed. Caching features will be disabled.');
        return null;
      }
      return Math.min(times * 50, 2000);
    },
    connectTimeout: lazyConnect ? 250 : 10000,
  });

  client.on('connect', () => {
    if (!lazyConnect) console.log('Redis connected');
  });

  client.on('error', (err: any) => {
    if (
      err?.code === 'ECONNREFUSED' ||
      (err?.name === 'AggregateError' &&
        err.errors?.some((e: any) => e?.code === 'ECONNREFUSED')) ||
      err?.code === 'EPIPE' ||
      err?.code === 'ECONNRESET'
    ) {
      // Expected when Redis is not running; silent.
      return;
    }
    console.error('Redis error', err);
  });

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

export default new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    const client = getRedis();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
