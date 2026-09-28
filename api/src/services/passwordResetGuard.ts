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

export async function isConsumedOrMissing(jti: string): Promise<boolean> {
  cleanInMem();
  const key = jtiKey(jti);
  try {
    const v = await redisProxy.get(key).catch(() => null as any);
    if (v !== null && v !== undefined) return true;
  } catch {
    const m = IN_MEM.get(key);
    if (m && m.expireAt > Date.now()) return true;
  }
  return false;
}

export async function markConsumed(jti: string, ttlSeconds = 960): Promise<void> {
  cleanInMem();
  const key = jtiKey(jti);
  const expireAt = Date.now() + ttlSeconds * 1000;
  try {
    const ok = await redisProxy.set(key, 'CONSUMED', 'EX', Math.max(1, ttlSeconds), 'NX').catch(() => null as any);
    if (ok !== null && ok !== undefined) return;
  } catch {
    // fall through to in-mem
  }
  IN_MEM.set(key, { val: 'CONSUMED', expireAt });
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
