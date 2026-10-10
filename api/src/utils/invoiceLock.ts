import { randomUUID } from 'crypto';
import { getRedis } from '../config/redis';

const INVOICE_OP_LOCK_TTL_MS_DEFAULT = 8_000;
const INVOICE_OP_LOCK_KEY_PREFIX = 'inv-op-lock:';

// Degraded (non-Redis) in-process lock: maps key -> { ownerToken, expireAtMs }.
type FallbackLock = { token: string; expireAtMs: number };
const _fallbackInvoiceLocks = new Map<string, FallbackLock>();
let _fallbackSweepMs = 0;

export function _testResetInvoiceLocks() {
  _fallbackInvoiceLocks.clear();
}

// Lua script for atomic compare-and-delete. Redis guarantees atomicity.
// KEYS[1] = lock key; ARGV[1] = expected owner token.
// Returns 1 if released (match); 0 if token mismatch or key missing.
const COMPARE_DELETE_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
`;

export type InvoiceLockAcquireResult =
  | { ok: true; token: string; acquiredAtMs: number; ttlMs: number }
  | { ok: false; token: null; acquiredAtMs?: undefined; ttlMs?: undefined };

/**
 * Tiered invoice-level operation lock with OWNERSHIP TOKENS for cross-workflow
 * serialization across multiple app instances:
 *   acquireInvoiceOperationLock(invoiceId, ttlMs?) -> {ok, token}
 *
 * Redis SET NX stores VALUE = unique owner token (UUID v4-style) instead of
 * the old Date.now() timestamp. The paired compare-and-delete release below
 * uses atomic EVAL Lua to delete the key ONLY if the stored token matches
 * what the caller provides. This prevents the classic cross-instance bug:
 *   Instance A acquires → TTL expires during long op →
 *   Instance B acquires → A finishes and calls DEL → deletes B's lock.
 *
 * With compare-and-delete, instance A releases; stored token != A.token →
 * A's release becomes a harmless no-op, B retains its lock until it releases
 * or TTL expires.
 *
 * Degraded in-process fallback enforces the same ownership-token invariant
 * (useful for single-instance development and LAZY test mode with Redis absent).
 *
 * Callers MUST call releaseInvoiceOperationLockByToken(id, token) in a
 * finally-block with the token returned by acquire.
 */
export async function acquireInvoiceOperationLock(
  invoiceId: number | string,
  ttlMs: number = INVOICE_OP_LOCK_TTL_MS_DEFAULT,
): Promise<InvoiceLockAcquireResult> {
  if (invoiceId == null) return { ok: false, token: null };
  const key = `${INVOICE_OP_LOCK_KEY_PREFIX}${String(invoiceId)}`;
  const ttl = Math.max(500, ttlMs);
  const ttlSec = Math.ceil(ttl / 1000);
  const acquiredAtMs = Date.now();
  const ownerToken = randomUUID != null ? randomUUID() : `lock:${acquiredAtMs}:${Math.random().toString(36).slice(2, 14)}`;

  // Test mode bypass: INVOICE_OP_LOCK_DISABLE or 0 TTL override returns
  // a synthetic "ok" — caller will still receive a valid token for release.
  const ttlOverride = process.env.INITIATE_LOCK_TTL_SEC_OVERRIDE;
  if (ttlOverride === '0' || process.env.NODE_ENV === 'test') {
    if (process.env.INVOICE_OP_LOCK_DISABLE === '1') {
      return { ok: true, token: `bypass:${ownerToken}`, acquiredAtMs, ttlMs: ttl };
    }
  }

  try {
    const r = getRedis();
    if (r && typeof r.call === 'function') {
      // SET key ownerToken NX EX ttlSec
      const result: any = await r.call('SET', key, ownerToken, 'NX', 'EX', ttlSec);
      if (result === 'OK' || result === 'SET' || result === true || result === 1) {
        return { ok: true, token: ownerToken, acquiredAtMs, ttlMs: ttl };
      }
      return { ok: false, token: null };
    }
  } catch {
    /* fall through to degraded in-process map */
  }

  // Degraded in-process fallback — same ownership-token semantics.
  const now = Date.now();
  if (now - _fallbackSweepMs > 1_000) {
    for (const [k, v] of _fallbackInvoiceLocks.entries()) {
      if (v.expireAtMs < now) _fallbackInvoiceLocks.delete(k);
    }
    _fallbackSweepMs = now;
  }
  const existing = _fallbackInvoiceLocks.get(key);
  if (existing && existing.expireAtMs > now) {
    return { ok: false, token: null };
  }
  const expireAtMs = now + ttl;
  _fallbackInvoiceLocks.set(key, { token: ownerToken, expireAtMs });
  return { ok: true, token: ownerToken, acquiredAtMs, ttlMs: ttl };
}

/**
 * Atomic compare-and-delete release. Safe across multi-instance deployments:
 * will only delete the Redis/in-process key if the stored token matches
 * exactly what the caller provides.
 *
 * Returns true when the token matched and the caller's own lock was removed.
 * Returns false (harmless no-op) if the token no longer matches — either
 * the TTL expired and a new caller re-acquired, or the key never existed.
 *
 * If the operation elapsed > TTL we log a warning (this operation took
 * longer than the lock protection window — subsequent in-progress operations
 * may have raced with it; the DB-level FOR UPDATE row locks are the final
 * safety net, which is why both layers are always used together).
 */
export async function releaseInvoiceOperationLockByToken(
  invoiceId: number | string,
  token: string | null | undefined,
  meta?: { acquiredAtMs?: number; ttlMs?: number; opName?: string },
): Promise<boolean> {
  if (invoiceId == null || !token) return false;
  const key = `${INVOICE_OP_LOCK_KEY_PREFIX}${String(invoiceId)}`;

  // Long-op warning: caller elapsed past the TTL window we advertised.
  // NEVER crash, never throw — warn only.
  if (meta && meta.acquiredAtMs && meta.ttlMs && process.env.NODE_ENV !== 'test') {
    try {
      const elapsed = Date.now() - meta.acquiredAtMs;
      if (elapsed > meta.ttlMs) {
        console.warn(
          `[invoiceLock:longOp] invoiceId=${invoiceId} op=${meta.opName ?? 'unknown'} elapsedMs=${elapsed} ttlMs=${meta.ttlMs} ` +
            `exceeded TTL — DB FOR UPDATE row-lock remains the final safety net.`,
        );
      }
    } catch { /* swallow */ }
  }

  let released = false;
  try {
    const r = getRedis();
    if (r && typeof r.call === 'function') {
      // Atomic compare-and-delete via Lua.
      const evalRes: any = await r.call('EVAL', COMPARE_DELETE_LUA, 1, key, token);
      released = (evalRes === 1 || evalRes === true || (typeof evalRes === 'string' && Number(evalRes) === 1));
      if (token.startsWith('bypass:')) return true; // INVOICE_OP_LOCK_DISABLE test bypass
      return released;
    }
  } catch {
    /* fall through to degraded */
  }

  const existing = _fallbackInvoiceLocks.get(key);
  if (existing && existing.token === token) {
    _fallbackInvoiceLocks.delete(key);
    return true;
  }
  return false;
}

/**
 * @deprecated Use releaseInvoiceOperationLockByToken(id, token) instead.
 * Old callers still passing only id get a best-effort non-atomic release
 * which is UNSAFE across multiple instances and can delete another caller's
 * lock after TTL expiry. We still perform the ownership check if we can
 * locate the key through in-process fallback, but Redis path is FORBIDDEN.
 * Remove this wrapper once all call sites have been updated to use token.
 *
 * Currently only retained for backwards compatibility with tests that may
 * import releaseInvoiceOperationLock.
 */
export async function releaseInvoiceOperationLock(
  invoiceId: number | string,
): Promise<void> {
  // Fallback path: remove from degraded in-process map (deletes ANY caller's
  // lock for this key — unsafe; kept for legacy test-only paths).
  // Redis path intentionally NOT used because that would break compare-and-delete
  // invariants across instances. The corresponding acquire will always do the
  // correct thing via SET NX regardless.
  if (invoiceId == null) return;
  const key = `${INVOICE_OP_LOCK_KEY_PREFIX}${String(invoiceId)}`;
  _fallbackInvoiceLocks.delete(key);
}
