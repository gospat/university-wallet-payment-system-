// =============================================================================
// RFC 6238 TOTP (Time-based One-Time Password) — dependency-free
// =============================================================================
// Implemented on top of Node's built-in `crypto` ONLY (no third-party library),
// per the MFA hardening specification. Builds on RFC 4226 (HOTP) dynamic
// truncation over HMAC-SHA1 (the authenticator-app default) with RFC 4648
// base32 secret encoding.
//
// Verified against the RFC 6238 Appendix B test vectors (SHA-1, 8 digits):
//   secret (ASCII) "12345678901234567890" → base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
//     T = 59          → 94287082
//     T = 1111111109  → 07081804
//     T = 1111111111  → 14050471
//     T = 1234567890  → 89005924
//     T = 2000000000  → 69279037
//     T = 20000000000 → 65353130
// =============================================================================

import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 encode (no padding — the format authenticator apps expect). */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * RFC 4648 base32 decode. Case-insensitive; whitespace and `=` padding are
 * ignored so a secret pasted from any authenticator app decodes identically.
 * Characters outside the alphabet are skipped (never throw) so a malformed
 * secret degrades to an empty key rather than crashing a request.
 */
export function base32Decode(input: string): Buffer {
  const clean = String(input ?? '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Generate a fresh random base32 TOTP secret (20 bytes = 160-bit = RFC default). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  digits?: number;
  step?: number;
  timestamp?: number;
  algorithm?: TotpAlgorithm;
}

/** RFC 4226 HOTP: HMAC-truncate `counter` and take `digits` decimal digits. */
function hotp(key: Buffer, counter: number, digits: number, algorithm: TotpAlgorithm): string {
  const buf = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter % 0x100000000;
  buf.writeUInt32BE(high >>> 0, 0);
  buf.writeUInt32BE(low >>> 0, 4);

  const digest = crypto.createHmac(algorithm, key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

/** Generate the current TOTP code for a base32 secret (default: 6 digits, 30s). */
export function generateTotp(secret: string, opts: TotpOptions = {}): string {
  const digits = opts.digits ?? 6;
  const step = opts.step ?? 30;
  const algorithm = opts.algorithm ?? 'sha1';
  const timestamp = opts.timestamp ?? Date.now();
  const counter = Math.floor(timestamp / 1000 / step);
  return hotp(base32Decode(secret), counter, digits, algorithm);
}

/** Constant-time string compare with an explicit length guard. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Length is not secret-dependent here (both are fixed-length codes); guard so
  // `timingSafeEqual` (which throws on differing lengths) is never reached with
  // mismatched buffers.
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface VerifyTotpOptions extends TotpOptions {
  /** Number of ± steps (30s each by default) accepted for clock drift. */
  window?: number;
}

/**
 * Verify a TOTP code against a base32 secret. Accepts `window` steps either
 * side of now (default ±1, i.e. ~90s tolerance) to absorb clock skew. Every
 * candidate comparison is constant-time.
 */
export function verifyTotp(token: string, secret: string, opts: VerifyTotpOptions = {}): boolean {
  const digits = opts.digits ?? 6;
  const code = String(token ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return false;

  const step = opts.step ?? 30;
  const algorithm = opts.algorithm ?? 'sha1';
  const timestamp = opts.timestamp ?? Date.now();
  const window = opts.window ?? 1;
  const counter = Math.floor(timestamp / 1000 / step);
  const key = base32Decode(secret);
  if (key.length === 0) return false;

  let matched = false;
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(key, counter + i, digits, algorithm);
    // No early return: evaluate every candidate to avoid leaking (via timing)
    // WHICH step matched.
    if (constantTimeEqual(candidate, code)) matched = true;
  }
  return matched;
}

export interface OtpauthParams {
  secret: string;
  label: string;
  issuer?: string;
  digits?: number;
  period?: number;
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
}

/**
 * Build an `otpauth://totp/...` provisioning URI for an authenticator app.
 * Encoded manually (not via URLSearchParams) so spaces become %20 rather than
 * `+`, which some authenticator apps reject.
 */
export function buildOtpauthUrl(params: OtpauthParams): string {
  const issuer = params.issuer ?? 'University Payment Platform';
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;
  const algorithm = (params.algorithm ?? 'SHA1').toUpperCase();
  const enc = encodeURIComponent;

  const query = [
    `secret=${enc(params.secret)}`,
    `issuer=${enc(issuer)}`,
    `algorithm=${enc(algorithm)}`,
    `digits=${digits}`,
    `period=${period}`,
  ].join('&');

  return `otpauth://totp/${enc(issuer)}:${enc(params.label)}?${query}`;
}
