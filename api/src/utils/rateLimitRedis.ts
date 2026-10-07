/**
 * Pure utility to normalize the result of `ioredis.call(...)` as invoked for
 * rate-limit-redis@4.3.1 Lua EVALSHA / EVAL scripts.
 *
 * rate-limit-redis dist/index.cjs `parseScriptResponse` requires the return
 * value of `sendCommand` (for the EVALSHA/EVAL paths) to be an Array of
 * length 2 where each element is coercible to integer:
 *   [totalHits, timeToExpireMs]
 *
 * ioredis 5.x, depending on RESP mode (2 vs 3) and Redis server version,
 * returns this Lua array as any of:
 *   - [number, number]           -> direct RESP3 translation
 *   - [string, string]           -> e.g. ["1", "15000"] when RESP2
 *   - [Buffer, Buffer]           -> raw buffers, not decoded
 *   - Buffer (single RESP2 *2 multi-bulk concat)
 *   - "a,b" comma string         -> exotic edge cases
 *   - undefined / null / {}      -> transport failure fallback caller path
 *
 * We NEVER throw from here; instead, return a safe 2-tuple default of
 * `[1, fallbackWindowMs]`. Caller's parseScriptResponse will then succeed:
 *   totalHits = 1  (one increment counted; worst case = +1 false positive)
 *   resetTime  = now + fallbackWindowMs (a valid Date within next minute).
 */
export function normalizeLuaArrayResult(raw: unknown, fallbackWindowMs: number): [number, number] {
  const fbWindow = Number.isFinite(fallbackWindowMs) && fallbackWindowMs > 0 ? Math.trunc(fallbackWindowMs) : 60_000;
  const toInt = (x: unknown, defaultInt: number): number => {
    if (typeof x === 'number') return Number.isFinite(x) ? Math.trunc(x) : defaultInt;
    if (Buffer.isBuffer(x)) {
      const s = x.toString('utf8');
      const p = parseInt(s || String(defaultInt), 10);
      return Number.isFinite(p) ? p : defaultInt;
    }
    if (typeof x === 'string' || typeof x === 'bigint') {
      const p = parseInt(String(x) || String(defaultInt), 10);
      return Number.isFinite(p) ? p : defaultInt;
    }
    return defaultInt;
  };

  // 1) Exact happy path: JS array of length >= 2
  if (Array.isArray(raw) && raw.length >= 2) {
    return [toInt(raw[0], 0), toInt(raw[1], fbWindow)];
  }

  // 2) Single Buffer -> parse RESP2 *2 multi-bulk text if present, else comma/tab split
  if (Buffer.isBuffer(raw)) {
    const s = raw.toString('utf8').trim();
    if (s.startsWith('*2')) {
      const lines = s.split(/\r?\n/).filter(Boolean);
      // RESP2 *2 protocol: ["*2", "$1"/":N", "val0", "$1"/":N", "val1"]
      // lines[0] = *2
      // lines[1] = type descriptor for arg 0 (":N" = integer, "$L" = blob with L bytes)
      // lines[2] = integer value OR the blob bytes (value 0)
      // lines[3] = type descriptor for arg 1
      // lines[4] = integer value OR the blob bytes (value 1)
      // Also cover the case where value is on SAME line after ":N" (length prefix inline = no).
      if (lines.length >= 3) {
        let v0Raw: string | undefined;
        let v1Raw: string | undefined;
        // Walk lines; skip "*N" / ":N" / "$L" descriptors; collect values.
        const values: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i];
          if (/^[:$*]/.test(l)) {
            if (/^:/.test(l)) values.push(l.slice(1));
            // "$L" → next line is the blob; skip this descriptor
            continue;
          }
          values.push(l);
          if (values.length >= 2) break;
        }
        v0Raw = values[0];
        v1Raw = values[1];
        if (typeof v0Raw === 'string' && typeof v1Raw === 'string') {
          return [toInt(v0Raw || '0', 0), toInt(v1Raw || String(fbWindow), fbWindow)];
        }
      }
    }
    const parts = s
      .split(/[,;\t\s]+/)
      .map((seg) => parseInt(seg, 10))
      .filter((p) => Number.isFinite(p));
    if (parts.length >= 2) return [parts[0], parts[1]];
  }

  // 3) Single string with a separator (comma or tab)
  if (typeof raw === 'string') {
    const parts = raw.split(/[,;\t]+/).map((seg) => parseInt(seg.trim(), 10));
    if (parts.length >= 2 && parts.every((p) => Number.isFinite(p))) {
      return [parts[0], parts[1]];
    }
  }

  // 4) Unknown shape. Safe synthetic tuple: count as 1 hit, expires in fallbackWindowMs.
  //    parseScriptResponse cannot throw on this; it's well-formed [number, number].
  return [1, fbWindow];
}
