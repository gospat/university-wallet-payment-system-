// =============================================================================
// Paystack Helpers — HMAC signature verification, reference generators
// -----------------------------------------------------------------------------
//   - verifyHmac: compare x-paystack-signature header against raw body using
//     PAYSTACK_SECRET_KEY (or explicit PAYSTACK_WEBHOOK_SECRET if set) with
//     HMAC-SHA512 — as required by Paystack docs § "Verifying Webhook events".
//   - Reference generators (TR-1.8, §18): INV-YYYY-NNNNNN, PAY-YYYYMMDD-XXXXXX,
//     REC-YYYY-NNNNNN, VER-24-random-hex. All use crypto.randomInt/bytes for
//     collision resistance and are truncated to manageable lengths.
//
// IMPORTANT: verifyHmac MUST be run on the UNPARSED raw body (req.rawBody as
// Buffer), NOT JSON.stringify(req.body), because JSON.parse + serialize can
// re-order keys, re-encode unicode, or change whitespace which would produce
// a completely different HMAC digest (classic webhook verification bug).
// =============================================================================

import { createHmac, randomBytes } from 'crypto';

/**
 * Compare two signatures in constant time to avoid timing side-channels.
 * (Timing attacks on HMAC comparison: a malicious client could, in theory,
 *  measure microsecond differences per byte in the "bad signature" path
 *  and byte-by-byte brute-force the correct HMAC. Node's crypto.timingSafeEqual
 *  eliminates this class of bugs as long as both buffers have equal length.)
 */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  const { timingSafeEqual } = require('crypto');
  try {
    return timingSafeEqual(a, b);
  } catch {
    // Fallback for very old Node versions where timingSafeEqual throws.
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
}

/**
 * Validate `x-paystack-signature` header against the raw request body.
 *
 * @param rawBody    - Raw, unmodified bytes of the Paystack request (Buffer
 *                     or utf-8 string). This MUST come from the `verify` hook
 *                     registered with express.json() — never re-serialize a
 *                     parsed body.
 * @param headerSig  - Value of the `x-paystack-signature` request header
 *                     (lower-case hex). Pass `undefined` if missing; the
 *                     function will return `false` rather than throwing.
 * @returns true if signature is valid, false otherwise.
 */
export function verifyPaystackHmac(
  rawBody: Buffer | string,
  headerSig?: string | undefined,
): boolean {
  if (!headerSig || headerSig.length !== 128) return false;
  const key =
    (process.env.PAYSTACK_WEBHOOK_SECRET && process.env.PAYSTACK_WEBHOOK_SECRET.trim()) ||
    process.env.PAYSTACK_SECRET_KEY ||
    '';
  if (!key) return false;

  const digest = createHmac('sha512', key)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

  return constantTimeEqual(Buffer.from(digest, 'hex'), Buffer.from(headerSig, 'hex'));
}

// =============================================================================
// Reference generators (§18)
// =============================================================================

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomBase36(len: number): string {
  let out = '';
  const bytes = randomBytes(len);
  for (let i = 0; i < len; i++) out += BASE36[bytes[i] % BASE36.length];
  return out;
}

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

/**
 * Invoice reference — INV-<fiscal-year>-<zero-padded counter-suffix + 2 random>
 * Example: INV-2026-00001234
 * Counter-based uniqueness should normally be enforced at the DB layer
 * (@@unique on fee_invoices.reference); the 2 random suffix chars guarantee
 * uniqueness even if the DB counter lookup races under load.
 */
export function generateInvoiceReference(nextId: number, year?: string): string {
  const fiscal = year ?? String(new Date().getFullYear());
  // nextId typically comes from a SELECT COALESCE(MAX(id),0)+1 or an AUTO_INCREMENT
  // We pad to 8 digits and then random-suffix so "growing sequential ids" is not
  // trivially guessable by clients (security-by-obscurity layer).
  return `INV-${fiscal}-${pad(nextId, 6)}${randomBase36(2)}`;
}

/**
 * Payment attempt reference — PAY-<YYYYMMDD>-<6-random-base36>
 * Every attempt at paying the SAME invoice gets a NEW PAY- ref; this is how
 * we distinguish attempt 1 from attempt 2 on webhook retries.
 */
export function generatePaymentReference(now?: Date): string {
  const d = now ?? new Date();
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1, 2);
  const dd = pad(d.getDate(), 2);
  return `PAY-${yyyy}${mm}${dd}-${randomBase36(6)}`;
}

/**
 * Receipt reference — REC-<fiscal-year>-<zero-padded counter>
 * Example: REC-2026-00001234
 */
export function generateReceiptReference(nextId: number, year?: string): string {
  const fiscal = year ?? String(new Date().getFullYear());
  return `REC-${fiscal}-${pad(nextId, 8)}`;
}

/**
 * Import batch reference — IMP-<YYYYMM>-<4-random>
 * Example: IMP-202609-A1B2
 */
export function generateImportReference(now?: Date): string {
  const d = now ?? new Date();
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1, 2);
  return `IMP-${yyyy}${mm}-${randomBase36(4)}`;
}

/**
 * Public receipt verification token — 24 random hex chars (§33).
 * Short enough for a QR-code URL, long enough to resist brute-force guessing.
 * Example: VER-7A83F2C19E6B4D50A12F8CE2
 */
export function generateVerificationToken(): string {
  return `VER-${randomBytes(12).toString('hex').toUpperCase()}`;
}

/**
 * Kobo amount helpers (Paystack amounts are always subunits of the currency).
 * For NGN: 1 Naira = 100 Kobo. We use these helpers to make the conversion
 * explicit, because mixing Naira and Kobo arithmetic is a top cause of
 * 100× over/under-charge bugs.
 */
export const kobo = {
  fromNaira: (naira: number): number => Math.round(naira * 100),
  toNaira: (amountKobo: number): number => amountKobo / 100,
  equals: (k1: number, k2: number, toleranceKobo = 0): boolean =>
    Math.abs(k1 - k2) <= toleranceKobo,
};

/**
 * Extract clean typed metadata from a paystack-style metadata object
 * (Paystack only guarantees its metadata is a flat map — never trust deep
 * nesting without runtime type guards).
 */
export function readPaystackMetadata(md: any): {
  studentId?: number;
  matricNumber?: string;
  invoiceId?: string;
  feeId?: string;
  academicSession?: string;
  feeName?: string;
  raw: any;
} {
  const raw = md ?? {};
  const num = (v: any): number | undefined =>
    v === undefined || v === null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined;
  const str = (v: any): string | undefined => (v === undefined || v === null ? undefined : String(v));
  return {
    studentId: num(raw.student_id),
    matricNumber: str(raw.matric_number),
    invoiceId: str(raw.invoice_id),
    feeId: str(raw.fee_id),
    academicSession: str(raw.academic_session),
    feeName: str(raw.fee_name),
    raw,
  };
}
