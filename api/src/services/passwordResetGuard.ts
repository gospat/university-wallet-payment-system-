import { randomBytes } from 'crypto';
import redisProxy, { getRedis } from '../config/redis';

const IN_MEM = new Map<string, { val: string; expireAt: number }>();
const IN_MEM_CLEAN_EVERY_MS = 60_000;
let lastClean = 0;

function cleanInMem() {
  const now = Date.now();
  if (now - lastClean < IN_MEM_CLEAN_EVERY_MS) return;
  lastClean = now;
  for (const [k, v] of Array.from(IN_MEM.entries())) {
    if (v.expireAt <= now) IN_MEM.delete(k);
  }
}

function jtiKey(jti: string): string {
  return `pwd-reset:consumed:${jti}`;
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export type ResetTokenClaim = 'claimed' | 'already-consumed' | 'store-unavailable';

/**
 * ATOMIC single-use claim for a password-reset token.
 *
 * The previous implementation performed a non-atomic `isConsumedOrMissing()`
 * read followed by a separate `markConsumed()` write, so two concurrent
 * requests presenting the SAME still-valid token could both observe
 * "not consumed" and both proceed to reset the password (§ requirement 6).
 *
 * This performs the check and the write in ONE conditional Redis operation
 * (`SET key value EX ttl NX`), which the Redis server evaluates atomically.
 * Exactly one caller can ever be told 'claimed' for a given jti; every other
 * caller gets 'already-consumed'.
 *
 * FAIL CLOSED: if the store is unreachable we return 'store-unavailable' and
 * the CALLER MUST REFUSE the reset. We deliberately do NOT fall back to a
 * process-local Map — that silently weakens the single-use guarantee across
 * multiple instances and would allow a replay after a process restart.
 */
export async function claimResetToken(jti: string, ttlSeconds = 960): Promise<ResetTokenClaim> {
  cleanInMem();
  const key = jtiKey(jti);
  try {
    const r = await getRedis();
    const res = await r.set(key, 'CONSUMED', 'EX', Math.max(1, ttlSeconds), 'NX');
    if (res === 'OK') return 'claimed';
    if (res === null) return 'already-consumed';
    return 'store-unavailable';
  } catch {
    return 'store-unavailable';
  }
}

export async function getSafe(name: string): Promise<string | null> {
  cleanInMem();
  try {
    const r = await getRedis();
    const v = await r.get(name).catch(() => null as any);
    return typeof v === 'string' ? v : null;
  } catch {
    const m = IN_MEM.get(name);
    return m && m.expireAt > Date.now() ? m.val : null;
  }
}

export async function incrAndExpire(name: string, ttlSec: number): Promise<number> {
  cleanInMem();
  try {
    const r = await getRedis();
    const cur = await r.incr(name).catch(() => null as any);
    if (typeof cur === 'number') {
      if (cur === 1) {
        try { await r.expire(name, ttlSec).catch(() => {}); } catch {}
      }
      return cur;
    }
  } catch {
    // fall through in-memory
  }
  const existing = IN_MEM.get(name);
  const now = Date.now();
  const ttlMs = ttlSec * 1000;
  if (!existing || existing.expireAt <= now) {
    IN_MEM.set(name, { val: '1', expireAt: now + ttlMs });
    return 1;
  }
  const next = (parseInt(existing.val, 10) || 0) + 1;
  IN_MEM.set(name, { val: String(next), expireAt: existing.expireAt });
  return next;
}
