import * as net from 'node:net';
import * as dns from 'node:dns';

/**
 * SSRF defence helpers for remote asset (image) URLs.
 *
 * Textual hostname checks are NOT sufficient: they cannot catch DNS
 * rebinding, IPv4-mapped IPv6, decimal/octal IP encodings, or a public
 * hostname that resolves to a private IP. These helpers add a real
 * DNS-resolution + IP-classification layer (plus an explicit allow-list,
 * which remains the strongest control).
 */

export type SsrfCheck = { ok: true; url: string } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// IPv4 classification
// ---------------------------------------------------------------------------

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    // Malformed -> fail closed.
    return true;
  }
  const a = parts[0];
  const b = parts[1];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (+ metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
  if (a >= 240) return true; // 240.0.0.0/4 reserved (incl. 255.255.255.255)
  return false;
}

// ---------------------------------------------------------------------------
// IPv6 parsing / classification
// ---------------------------------------------------------------------------

/** Expand an IPv6 literal into 8 16-bit hextets, or null if unparseable. */
function parseIPv6ToHextets(input: string): number[] | null {
  let s = input.trim();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!s) return null;

  // Handle an embedded dotted-quad tail (e.g. ::ffff:192.168.0.1).
  const lastColon = s.lastIndexOf(':');
  const lastPart = lastColon === -1 ? s : s.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    const octets = lastPart.split('.').map((p) => Number(p));
    if (
      octets.length !== 4 ||
      octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
    ) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hi + ':' + lo;
  }

  const dbl = s.indexOf('::');
  let head: string[];
  let tail: string[];
  if (dbl !== -1) {
    const h = s.slice(0, dbl);
    const t = s.slice(dbl + 2);
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = s.split(':');
    tail = [];
  }

  const hextet = (part: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    return parseInt(part, 16);
  };

  const hextets: number[] = [];
  for (const part of head) {
    const n = hextet(part);
    if (n === null) return null;
    hextets.push(n);
  }
  const zeros = 8 - head.length - tail.length;
  if (zeros < 0) return null;
  if (dbl !== -1) {
    for (let i = 0; i < zeros; i++) hextets.push(0);
  }
  for (const part of tail) {
    const n = hextet(part);
    if (n === null) return null;
    hextets.push(n);
  }
  if (hextets.length !== 8) return null;
  return hextets;
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const h = parseIPv6ToHextets(ip);
  if (!h) return true; // malformed -> fail closed

  // IPv4-mapped ::ffff:a.b.c.d -> map to embedded IPv4 and re-check.
  if (
    h[0] === 0 &&
    h[1] === 0 &&
    h[2] === 0 &&
    h[3] === 0 &&
    h[4] === 0 &&
    h[5] === 0xffff
  ) {
    const v4 = (((h[6] << 16) | h[7]) >>> 0);
    const dotted = `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`;
    return isPrivateOrReservedIPv4(dotted);
  }

  // Loopback ::1
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) {
    return true;
  }
  // Unspecified ::
  if (h.every((x) => x === 0)) return true;
  // Link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfe80) return true;
  // Unique-local fc00::/7
  if ((h[0] & 0xfe00) === 0xfc00) return true;
  // Multicast ff00::/8
  if ((h[0] & 0xff00) === 0xff00) return true;
  // 6to4 2002::/16 — can encapsulate a private IPv4 destination.
  if (h[0] === 0x2002) return true;
  // Teredo 2001::/32 — obfuscated IPv4 tunnel endpoint.
  if (h[0] === 0x2001 && h[1] === 0x0000) return true;
  return false;
}

/**
 * Pure synchronous check: is `ip` a private / reserved / non-public address?
 * Fails closed (returns true) for anything that is not a valid IP literal.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (typeof ip !== 'string') return true;
  const s = ip.trim();
  if (!s) return true;
  // Strip IPv6 brackets if a bracketed literal was passed.
  const bare = s.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIPv4(bare)) return isPrivateOrReservedIPv4(bare);
  if (net.isIPv6(bare)) return isPrivateOrReservedIPv6(bare);
  return true; // not an IP literal -> fail closed
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

const STATIC_BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata.goog']);

function isStaticallyBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    STATIC_BLOCKED_HOSTS.has(h) ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal')
  );
}

/**
 * Async SSRF guard for a remote image URL.
 *
 * Order of controls:
 *   1. parse with `new URL` (malformed -> reject)
 *   2. protocol must be https (or http to localhost/127.0.0.1 when allowLocalHttp)
 *   3. no embedded credentials
 *   4. explicit allow-list (strongest control) — if provided, host must match
 *      exactly and DNS/IP checks are skipped
 *   5. statically-blocked hostnames (localhost/.localhost/*.internal/metadata)
 *   6. DNS resolution — reject if any resolved address is private/reserved
 */
export async function assertSafeRemoteImageUrl(
  rawUrl: string | null | undefined,
  opts: { allowedHosts?: string[]; allowLocalHttp?: boolean } = {},
): Promise<SsrfCheck> {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!raw) return { ok: false, reason: 'empty url' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed url' };
  }

  // URL.hostname keeps brackets around IPv6 literals.
  const hostname = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  const isLocalHttp =
    opts.allowLocalHttp === true &&
    url.protocol === 'http:' &&
    (hostname === 'localhost' || hostname === '127.0.0.1');

  if (url.protocol !== 'https:' && !isLocalHttp) {
    return { ok: false, reason: `protocol not allowed: ${url.protocol}` };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'embedded credentials rejected' };
  }

  // Statically-blocked hostnames are rejected unconditionally (this is a
  // static check, not DNS/IP based). Allow-list matching happens next.
  if (isStaticallyBlockedHost(hostname)) {
    return { ok: false, reason: `blocked hostname: ${hostname}` };
  }

  // Allow-list is the strongest control: if configured, the host must match
  // exactly and we skip the DNS/private-IP check entirely.
  const allow = Array.isArray(opts.allowedHosts)
    ? opts.allowedHosts.map((h) => h.toLowerCase()).filter(Boolean)
    : [];
  if (allow.length > 0) {
    if (!allow.includes(hostname)) {
      return { ok: false, reason: `host not in allow-list: ${hostname}` };
    }
    return { ok: true, url: raw };
  }

  // IP literals: classify directly (no DNS needed).
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return { ok: false, reason: `private/reserved ip: ${hostname}` };
    }
    return { ok: true, url: raw };
  }

  let results: Array<{ address: string; family: number }>;
  try {
    results = await dns.promises.lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: `dns lookup failed: ${hostname}` };
  }
  if (!results || results.length === 0) {
    return { ok: false, reason: `dns returned no addresses: ${hostname}` };
  }
  for (const r of results) {
    if (isPrivateOrReservedIp(r.address)) {
      return { ok: false, reason: `resolves to private/reserved ip: ${r.address}` };
    }
  }
  return { ok: true, url: raw };
}

/**
 * Read the comma-separated `RECEIPT_ASSET_ALLOWED_HOSTS` env var into a list
 * of hostnames: trimmed, lowercased, `http(s)://` prefix stripped to the
 * hostname, empty entries filtered out.
 */
export function defaultReceiptAllowedHosts(): string[] {
  const raw = process.env.RECEIPT_ASSET_ALLOWED_HOSTS;
  if (!raw) return [];
  const out: string[] = [];
  for (const entry of raw.split(',')) {
    let v = entry.trim().toLowerCase();
    if (!v) continue;
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme
    v = v.split('/')[0]; // strip path/query
    v = v.split(':')[0]; // strip port
    if (!v) continue;
    out.push(v);
  }
  return out;
}
