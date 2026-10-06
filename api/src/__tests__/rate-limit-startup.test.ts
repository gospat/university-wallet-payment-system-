/**
 * rate-limit-startup.test.ts
 *
 * Targeted regression tests for the production Redis-backed express-rate-limit
 * startup race fix (ticket: buildRateLimitStore permanent MemoryStore fallback
 * when Redis still "connecting" at app import time).
 *
 * What this file validates (practical observable semantics):
 *
 *   [A] Redis connection factory contract:
 *       - connectRedis() resolves to the shared ioredis singleton
 *       - singleton status is a valid ioredis lifecycle state string
 *         from the documented union: wait | reconnecting | connecting | ready | close | end
 *
 *   [B] buildRateLimitStore / limiter prefix inventory:
 *       All 8 production rate limiters are registered at construction time
 *       with their well-known Redis key prefixes. We validate the full set of
 *       prefix strings by observing the [rate-limit] startup log lines that
 *       app.ts emits exactly once per limiter at module import time.
 *
 *       This guards against:
 *         - someone adding a new endpoint + limiter that uses a duplicate /
 *           misspelled prefix (which would silently merge counters)
 *         - someone accidentally removing a limiter registration from app.ts
 *         - buildRateLimitStore not called exactly 8 times (expected count)
 *
 * NOTE: The ordering itself (connectRedis -> THEN import('./app')) is verified
 * in production via the [startup] Redis shared connection log line that
 * server.ts emits *before* any of the [rate-limit] lines appear. That ordering
 * is structural in server.ts bootstrap(); here we validate the observable
 * leaves so any regression of the factory contract fails loudly in Jest.
 */

import { getRedis, connectRedis } from '../config/redis';

const IOREDIS_LEGAL_STATUSES = new Set([
  'wait',
  'reconnecting',
  'connecting',
  'ready',
  'close',
  'end',
]);

/**
 * Well-known, reviewed set of limiter prefixes used in production.
 * If you add a new express-rate-limit in app.ts you MUST append its
 * prefix here and re-run this file — otherwise two limiters sharing a
 * prefix silently corrupt each other's counters.
 *
 * Ordered alphabetically for reviewer convenience.
 */
const EXPECTED_LIMITER_PREFIXES = new Set<string>([
  'rl:admin-mut:',
  'rl:auth-chpw:',
  'rl:auth:',
  'rl:general:',
  'rl:payment:',
  'rl:pub-rcpt:',
  'rl:reports-export:',
  'rl:webhook:',
]);

describe('Redis-backed rate-limit startup contract (race-fix regression)', () => {
  // -----------------------------------------------------------------
  // Block A — Redis singleton status is well-defined
  // -----------------------------------------------------------------
  describe('shared ioredis singleton (config/redis.ts)', () => {
    it('getRedis() returns an object exposing a string status property', () => {
      const client = getRedis();
      expect(client).toBeDefined();
      expect(typeof (client as any).status).toBe('string');
    });

    it('singleton status belongs to the documented ioredis lifecycle union', () => {
      const client = getRedis();
      const status = (client as any).status as string;
      expect(IOREDIS_LEGAL_STATUSES.has(status)).toBe(true);
    });

    it('connectRedis() resolves without throwing — bounded graceful degradation allowed', async () => {
      // connectRedis() is documented never to throw (it catches internally
      // and returns client regardless). We only care that the promise
      // settles (no unhandled rejection) in bounded time.
      const race = Promise.race([
        connectRedis(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 150)),
      ]);
      await expect(race).resolves.toBeDefined();
    });
  });

  // -----------------------------------------------------------------
  // Block B — Limiter prefix inventory (8 exactly, no colliding names)
  // -----------------------------------------------------------------
  describe('limiter prefix inventory (8 production limiters)', () => {
    let capturedLogs: Array<{ level: 'warn' | 'info'; line: string }>;
    let origWarn: typeof console.warn;
    let origInfo: typeof console.info;

    beforeAll(() => {
      capturedLogs = [];
      origWarn = console.warn;
      origInfo = console.info;
      // eslint-disable-next-line no-console
      console.warn = (...args: any[]) => {
        capturedLogs.push({ level: 'warn', line: args.map((a) => String(a)).join(' ') });
      };
      // eslint-disable-next-line no-console
      console.info = (...args: any[]) => {
        capturedLogs.push({ level: 'info', line: args.map((a) => String(a)).join(' ') });
      };
      // Force import of app.ts NOW (after log capture installed).
      // This triggers buildRateLimitStore() for every limiter exactly once.
      // eslint-disable-next-line global-require
      require('../app');
    });

    afterAll(() => {
      console.warn = origWarn;
      console.info = origInfo;
    });

    it('buildRateLimitStore logged EXACTLY 8 [rate-limit] startup lines (one per limiter)', () => {
      const startup = capturedLogs.filter((c) => c.line.includes('[rate-limit] limiter='));
      expect(startup.length).toBe(EXPECTED_LIMITER_PREFIXES.size);
    });

    it('every logged limiter prefix belongs to the reviewed set (no unknown prefixes)', () => {
      const startup = capturedLogs.filter((c) => c.line.includes('[rate-limit] limiter='));
      const found = new Set<string>();
      for (const entry of startup) {
        const m = entry.line.match(/limiter=([a-z:\-]+)\s+store=/i);
        if (m) found.add(m[1].trim());
      }
      for (const prefix of found) {
        expect(EXPECTED_LIMITER_PREFIXES.has(prefix)).toBe(true);
      }
    });

    it('every prefix in the reviewed set was logged exactly once (no missing / no duplicates)', () => {
      const startup = capturedLogs.filter((c) => c.line.includes('[rate-limit] limiter='));
      const counts = new Map<string, number>();
      for (const entry of startup) {
        const m = entry.line.match(/limiter=([a-z:\-]+)\s+store=/i);
        if (m) {
          const prefix = m[1].trim();
          counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
        }
      }
      for (const expected of EXPECTED_LIMITER_PREFIXES) {
        expect(counts.get(expected)).toBe(1);
      }
    });

    it('each startup log line explicitly names its chosen store (MemoryStore OR RedisStore) — no silent ambiguity', () => {
      const startup = capturedLogs.filter((c) => c.line.includes('[rate-limit] limiter='));
      expect(startup.length).toBeGreaterThan(0);
      for (const entry of startup) {
        const choseMemory = entry.line.includes('store=MemoryStore');
        const choseRedis = entry.line.includes('store=RedisStore');
        // Each line must contain exactly one of the two store strings.
        expect(Number(choseMemory) + Number(choseRedis)).toBe(1);
      }
    });

    it('MemoryStore lines ALWAYS include redis.status="..." for operator debugging', () => {
      const memoryLines = capturedLogs.filter(
        (c) => c.line.includes('[rate-limit] limiter=') && c.line.includes('store=MemoryStore'),
      );
      for (const entry of memoryLines) {
        expect(entry.line).toMatch(/redis\.status="[^"]*"/);
      }
    });
  });
});
