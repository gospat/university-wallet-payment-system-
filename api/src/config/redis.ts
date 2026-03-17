import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1, // Fail fast if Redis is down
  retryStrategy: (times) => {
    if (times > 3) {
      console.warn('Redis connection failed. Caching features will be disabled.');
      return null; // Stop retrying
    }
    return Math.min(times * 50, 2000);
  },
});

redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('error', (err: any) => {
  // Suppress connection refused errors to avoid console spam if Redis is not running
  // Also check for 'AggregateError' which ioredis v5 sometimes throws
  if (err.code === 'ECONNREFUSED' || (err.name === 'AggregateError' && err.errors?.some((e: any) => e.code === 'ECONNREFUSED'))) {
    // console.warn('Redis connection refused. Is the Redis server running?');
  } else {
    console.error('Redis error', err);
  }
});

export default redis;
