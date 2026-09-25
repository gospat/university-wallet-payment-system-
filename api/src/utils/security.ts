// Centralized security utilities — one source of truth.
// All repeated validation/sanitization patterns across the API MUST live here.

import crypto from 'crypto';

const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r|%]/;
const CSV_DDE_TRIGGER = /^DDE\s*\(/i;

export function randomHex(n: number): string {
  return crypto.randomBytes(n).toString('hex');
}

/**
 * Neutralize CSV formula-injection vectors (OWASP CSV Injection).
 * Prefixes trigger chars (= + - @ \t \r | % DDE(...)) with a SAFE apostrophe '
 * that Excel/Sheets/LibreOffice render as literal text prefix (no execution).
 *
 * Also performs standard CSV quoting: doubles internal quotes and wraps
 * values containing comma/quote/newline in double-quotes.
 */
export function csvCellSafe(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = '';
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);

  if (s.length > 0 && (CSV_FORMULA_TRIGGER.test(s) || CSV_DDE_TRIGGER.test(s))) {
    s = "'" + s;
  }

  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvLineSafe(cells: unknown[]): string {
  return cells.map(csvCellSafe).join(',') + '\r\n';
}

// --- Allowlisted file signatures ---------------------------------------------------------

type SignatureCheck = { mime: string; ext: string; check: (buffer: Buffer) => boolean };

const SIGNATURES: SignatureCheck[] = [
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
    check: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  },
  {
    mime: 'application/vnd.ms-excel',
    ext: 'xls',
    check: (b) =>
      (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) ||
      (b.length >= 4 && b[0] === 0x09 && b[1] === 0x00 && b[2] === 0x04 && b[3] === 0x00),
  },
  {
    mime: 'text/csv',
    ext: 'csv',
    check: (b) => {
      if (b.length === 0) return false;
      // Accept UTF-8 BOM (EF BB BF) or printable ASCII start / printable start
      let offset = 0;
      if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) offset = 3;
      // Quick sanity: first non-empty line either contains a comma, starts with # comment,
      // or the first 64 bytes are printable CSV characters (no binary).
      const head = b.slice(offset, offset + 128);
      for (let i = 0; i < head.length; i++) {
        const c = head[i];
        // Tab, CR, LF, space, printable ASCII, and UTF-8 continuation bytes all permitted.
        const isPrintable = (c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d || c >= 0x80;
        if (!isPrintable) return false;
      }
      return true;
    },
  },
];

export type FileKind = 'csv' | 'xlsx' | 'xls';

export interface FileValidation {
  ok: boolean;
  mime?: string;
  ext?: string;
  error?: string;
}

/**
 * Magic-byte + extension alignment validation for uploaded spreadsheets.
 * Blocks polyglot attacks (e.g. "harmless.csv.php" or "image.php.xlsx" with wrong bytes).
 * Reads up to 16KB from start of file — enough to catch ZIP headers (XLSX) / OLE2 (XLS) / CSV charset.
 */
export function validateSpreadsheetBytes(filepath: string, declaredExtLower: string, allowedKinds: FileKind[] = ['csv', 'xlsx', 'xls']): FileValidation {
  let buf: Buffer;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    const fd = fs.openSync(filepath, 'r');
    try {
      buf = Buffer.alloc(Math.min(16 * 1024, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, error: 'File not accessible for validation. Please re-upload.' };
  }
  if (buf.length === 0) return { ok: false, error: 'Empty file. Please upload a non-empty CSV/XLSX file.' };

  const matched = SIGNATURES.filter((sig) => allowedKinds.includes(sig.ext as FileKind)).find((sig) => sig.check(buf));
  if (!matched) {
    return {
      ok: false,
      error: `Unsupported file content. File extension "${declaredExtLower}" does not match its content bytes. Please upload a valid CSV, XLSX, or XLS file.`,
    };
  }
  // Cross-check declared extension against actual bytes (no "file.csv.exe" tricks, no polyglots).
  const extMatches = declaredExtLower === `.${matched.ext}` || declaredExtLower === matched.ext;
  if (!extMatches) {
    return {
      ok: false,
      error: `File type mismatch. File claims extension "${declaredExtLower}" but its bytes are ${matched.ext.toUpperCase()}. Rename or re-export the file.`,
    };
  }
  return { ok: true, mime: matched.mime, ext: matched.ext };
}

// --- Secure prototype-safe property access -------------------------------------------------

/**
 * Mitigate prototype-pollution fallout when reading user-provided object property names.
 * Prefer hasOwn over in-operator when bracket-accessing req.body/query objects.
 */
export function safeGet<T = unknown>(obj: Record<string, unknown> | null | undefined, key: string | number | symbol): T | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const k = String(key);
  if (!Object.prototype.hasOwnProperty.call(obj, k)) return undefined;
  // Reject dunder-proto / constructor / prototype poisoning outright.
  if (k === '__proto__' || k === 'constructor' || k === 'prototype') return undefined;
  return (obj as any)[k] as T;
}

export function hasOwn(obj: unknown, key: string | number | symbol): boolean {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key as string);
}

// --- Helpers: Trust Proxy / Forwarded IP parsing -------------------------------------------

export function realClientIp(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }): string {
  const header = req.headers?.['x-forwarded-for'];
  if (typeof header === 'string') {
    const first = header.split(',')[0]?.trim();
    if (first) return first;
  }
  return (req.ip ?? '').toString().slice(0, 64);
}

// --- Export integrity (HMAC-SHA256) -------------------------------------------------------

export function hmacIntegrity(input: string | Buffer): string {
  const key = process.env.AUDIT_INTEGRITY_SECRET || process.env.JWT_SECRET || '';
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(input);
  return hmac.digest('hex');
}

const UTF8_BOM = '\uFEFF';

export function appendCsvIntegrityTrailer(csvContent: string): string {
  let content = csvContent;
  if (content.length === 0 || content.charCodeAt(0) !== 0xFEFF) {
    content = UTF8_BOM + content;
  }
  const byteCount = Buffer.byteLength(content, 'utf8');
  const hash = hmacIntegrity(Buffer.from(content, 'utf8'));
  const line1 = `#_integrity:algo=HMAC-SHA256,length=${byteCount}\r\n`;
  const line2 = `#_integrity:hash=${hash}\r\n`;
  return content + line1 + line2;
}

export function verifyCsvIntegrity(content: string): { ok: boolean; byteCount?: number; hash?: string; reason?: string } {
  if (!content || content.length < 2) {
    return { ok: false, reason: 'Content too short' };
  }
  const lines = content.split(/\r?\n/);
  const lastTwo: string[] = [];
  for (let i = lines.length - 1; i >= 0 && lastTwo.length < 2; i--) {
    if (lines[i].trim().length > 0) {
      lastTwo.unshift(lines[i]);
    }
  }
  if (lastTwo.length < 2) {
    return { ok: false, reason: 'Integrity trailer lines not found' };
  }
  const metaMatch = lastTwo[0].match(/^#_integrity:algo=([^,]+),length=(\d+)\s*$/);
  const hashMatch = lastTwo[1].match(/^#_integrity:hash=([0-9a-f]{64})\s*$/i);
  if (!metaMatch || !hashMatch) {
    return { ok: false, reason: 'Integrity trailer format invalid' };
  }
  const algo = metaMatch[1];
  const byteCount = parseInt(metaMatch[2], 10);
  const statedHash = hashMatch[1].toLowerCase();
  if (algo !== 'HMAC-SHA256') {
    return { ok: false, reason: `Unsupported algo: ${algo}` };
  }
  const contentBuf = Buffer.from(content, 'utf8');
  if (byteCount > contentBuf.length) {
    return { ok: false, byteCount, hash: statedHash, reason: 'Byte count exceeds content length' };
  }
  const actualPayload = contentBuf.slice(0, byteCount);
  const actualHash = hmacIntegrity(actualPayload);
  if (actualHash !== statedHash) {
    return { ok: false, byteCount, hash: statedHash, reason: `Hash mismatch (expected ${statedHash}, got ${actualHash})` };
  }
  return { ok: true, byteCount, hash: statedHash };
}
