import { getRedis } from '../config/redis';

const INVOICE_OP_LOCK_TTL_MS_DEFAULT = 8_000;
const INVOICE_OP_LOCK_KEY_PREFIX = 'inv-op-lock:';

const _fallbackInvoiceLocks = new Map<string, number>();
let _fallbackSweepMs = 0;

export function _testResetInvoiceLocks() {
  _fallbackInvoiceLocks.clear();
}

/**
 * Tiered invoice-level operation lock for cross-workflow serialization:
 *   acquireInvoiceOperationLock(invoiceId, ttlMs?)
 * Uses the same Redis SET NX / in-process degraded fallback pattern as
 * acquireInitiateDedupeLock, but operates at invoice granularity so
 *   (1) cancelInvoice
 *   (2) initiatePayment
 *   (3) any future invoice-mutating workflow
 * all contend on the same key. Prevents:
 *   - T1 reads UNPAID → T2 cancelInvoice writes CANCELLED → T1 creates a
 *     PENDING tx on a now-CANCELLED invoice
 * Callers are responsible for calling releaseInvoiceOperationLock(id) in a
 * finally-clause so deadlocks do not outlive the TTL.
 */
export async function acquireInvoiceOperationLock(
  invoiceId: number | string,
  ttlMs: number = INVOICE_OP_LOCK_TTL_MS_DEFAULT,
): Promise<boolean> {
  if (invoiceId == null) return false;
  const key = `${INVOICE_OP_LOCK_KEY_PREFIX}${String(invoiceId)}`;
  const ttl = Math.max(500, ttlMs);
  const expireAtMs = Date.now() + ttl;
  const ttlSec = Math.ceil(ttl / 1000);

  // Test mode bypass: same override env var as dedupe lock (LAZY or override to 0)
  // lets tests disable TTL locks to exercise DB-level FOR UPDATE contention.
  if (process.env.INITIATE_LOCK_TTL_SEC_OVERRIDE === '0' || process.env.NODE_ENV === 'test') {
    // Allow override-only disable via dedicated env too.
    if (process.env.INVOICE_OP_LOCK_DISABLE === '1') {
      return true;
    }
  }

  try {
    const r = getRedis();
    if (r && typeof r.call === 'function') {
      const result: any = await r.call('SET', key, String(Date.now()), 'NX', 'EX', ttlSec);
      if (result === 'OK' || result === 'SET' || result === true || result === 1) return true;
      return false;
    }
  } catch {
    /* fall through to degraded in-process map */
  }

  const now = Date.now();
  if (now - _fallbackSweepMs > 1_000) {
    for (const [k, v] of _fallbackInvoiceLocks.entries()) {
      if (v < now) _fallbackInvoiceLocks.delete(k);
    }
    _fallbackSweepMs = now;
  }
  if (_fallbackInvoiceLocks.has(key)) return false;
  _fallbackInvoiceLocks.set(key, expireAtMs);
  return true;
}

export async function releaseInvoiceOperationLock(invoiceId: number | string): Promise<void> {
  if (invoiceId == null) return;
  const key = `${INVOICE_OP_LOCK_KEY_PREFIX}${String(invoiceId)}`;
  try {
    const r = getRedis();
    if (r && typeof r.call === 'function') {
      await r.call('DEL', key).catch(() => {});
      return;
    }
  } catch {
    /* swallow */
  }
  _fallbackInvoiceLocks.delete(key);
}
