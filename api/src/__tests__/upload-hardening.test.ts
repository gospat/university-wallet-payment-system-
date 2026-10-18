/**
 * UPLOAD / EXPORT HARDENING TESTS (Requirements 21 + 22)
 * =====================================================================
 * Exercises the REAL enforcement points without a database:
 *   · extension allow-list + magic-byte/content alignment  -> validateSpreadsheetBytes
 *   · row / column ceilings                                -> assertUploadWithinBounds
 *   · spreadsheet formula-injection neutralization         -> csvCellSafe / neutralizeSpreadsheetFormula
 *   · HTML escaping                                        -> escapeHtml
 *   · multipart controller: extension filter, content mismatch, size
 *     ceiling (413), traversal-safe temp handling, temp-file cleanup.
 *
 * The upload controller is mounted on a minimal Express app with a stubbed
 * user + stubbed import service, so no MySQL/Redis is touched.
 */

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { stageStudentUpload } from '../controllers/bulkUpload';
import { BulkStudentUploadService } from '../services/studentImport';
import {
  MAX_UPLOAD_COLUMNS,
  MAX_UPLOAD_ROWS,
  assertUploadWithinBounds,
  csvCellSafe,
  csvLineSafe,
  escapeHtml,
  neutralizeSpreadsheetFormula,
  validateSpreadsheetBytes,
} from '../utils/security';
import { AppError } from '../utils/AppError';

// Only `BulkStudentUploadService.stageUpload` is consumed by the controller.
jest.mock('../services/studentImport', () => ({
  BulkStudentUploadService: {
    stageUpload: jest.fn(async () => ({ summary: { uploadId: 'up-test' }, preview: {} })),
  },
}));

const stageUploadMock = BulkStudentUploadService.stageUpload as unknown as jest.Mock;

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
const VALID_CSV = Buffer.from('email,firstName,lastName,matricNumber,phoneNumber\nx@y.z,A,B,M/1,08030000000\n');

function buildApp(): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: 42, role: 'ADMIN' };
    next();
  });
  app.post('/upload', stageStudentUpload as any);
  // Minimal error handler mirroring the production response shape.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ status: 'fail', message: err?.message ?? 'error' });
  });
  return app;
}

describe('Req 21c — extension allow-list & magic-byte/content alignment', () => {
  let tmpDir: string;
  let csvPath: string;
  let xlsxPath: string;
  let emptyPath: string;
  let junkPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-hardening-'));
    csvPath = path.join(tmpDir, 'students.csv');
    xlsxPath = path.join(tmpDir, 'students.xlsx');
    emptyPath = path.join(tmpDir, 'empty.csv');
    junkPath = path.join(tmpDir, 'junk.bin');
    fs.writeFileSync(csvPath, VALID_CSV);
    fs.writeFileSync(xlsxPath, XLSX_MAGIC);
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    fs.writeFileSync(junkPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff, 0xfe]));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a CSV whose declared extension matches its bytes', () => {
    expect(validateSpreadsheetBytes(csvPath, '.csv').ok).toBe(true);
  });

  it('accepts an XLSX (ZIP) whose declared extension matches its bytes', () => {
    expect(validateSpreadsheetBytes(xlsxPath, '.xlsx').ok).toBe(true);
  });

  it('rejects when the declared extension does NOT match the content bytes (polyglot)', () => {
    const res = validateSpreadsheetBytes(xlsxPath, '.csv');
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/mismatch/i);
  });

  it('rejects CSV bytes declared as XLSX', () => {
    expect(validateSpreadsheetBytes(csvPath, '.xlsx').ok).toBe(false);
  });

  it('rejects a disallowed extension (.exe) regardless of content', () => {
    expect(validateSpreadsheetBytes(csvPath, '.exe').ok).toBe(false);
  });

  it('rejects an empty file', () => {
    const res = validateSpreadsheetBytes(emptyPath, '.csv');
    expect(res.ok).toBe(false);
  });

  it('rejects binary junk that matches no allow-listed signature', () => {
    expect(validateSpreadsheetBytes(junkPath, '.csv').ok).toBe(false);
  });
});

describe('Req 21e — bounded row / column ceilings', () => {
  it('accepts counts exactly at the ceiling', () => {
    expect(() => assertUploadWithinBounds(MAX_UPLOAD_ROWS, MAX_UPLOAD_COLUMNS)).not.toThrow();
  });

  it('rejects rows over the ceiling with a 413', () => {
    try {
      assertUploadWithinBounds(MAX_UPLOAD_ROWS + 1, 1);
      throw new Error('expected assertUploadWithinBounds to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(413);
    }
  });

  it('rejects columns over the ceiling with a 413', () => {
    try {
      assertUploadWithinBounds(1, MAX_UPLOAD_COLUMNS + 1);
      throw new Error('expected assertUploadWithinBounds to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(413);
    }
  });

  it('rejects non-finite counts (fail closed)', () => {
    expect(() => assertUploadWithinBounds(Number.NaN, 1)).toThrow(AppError);
  });
});

describe('CSV / XLSX formula-injection neutralization', () => {
  // csvCellSafe ALSO performs CSV quoting, so a neutralized value may be
  // wrapped in double-quotes. Strip that wrapping before asserting the
  // apostrophe neutralizer is the first character of the field payload.
  const unwrapCsv = (v: string): string =>
    v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/""/g, '"') : v;

  it.each(['=1+1', '+cmd|calc', '-2+3', '@SUM(A1)', '\tDDE', '\rX', '|x', 'DDE("cmd")'])(
    'neutralizes formula trigger %p in csvCellSafe',
    (payload) => {
      const out = csvCellSafe(payload);
      expect(unwrapCsv(out).startsWith("'")).toBe(true);
    },
  );

  it('leaves an ordinary value unchanged (no spurious prefix)', () => {
    expect(csvCellSafe('Ada Okafor')).toBe('Ada Okafor');
  });

  it('neutralizeSpreadsheetFormula prefixes a trigger value without CSV quoting', () => {
    expect(neutralizeSpreadsheetFormula('=2+2')).toBe("'=2+2");
    expect(neutralizeSpreadsheetFormula('normal text')).toBe('normal text');
    expect(neutralizeSpreadsheetFormula(null)).toBe('');
  });

  it('csvLineSafe neutralizes every cell in a row and terminates with CRLF', () => {
    const line = csvLineSafe(['=HYPERLINK("x")', 'safe', '@bad']);
    expect(line.endsWith('\r\n')).toBe(true);
    expect(line).toContain("'=HYPERLINK");
    expect(line).toContain("'@bad");
  });
});

describe('Req 22 — HTML escaping helper', () => {
  it('escapes angle brackets, quotes and ampersands', () => {
    expect(escapeHtml('<script>alert("x")&\'</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;',
    );
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('Req 21a/21b/21c/21f — multipart controller hardening (no DB)', () => {
  beforeEach(() => stageUploadMock.mockClear());

  it('rejects a disallowed file extension (extension allow-list)', async () => {
    const res = await request(buildApp())
      .post('/upload')
      .attach('file', VALID_CSV, 'students.txt');
    expect(res.status).toBe(400);
    expect(stageUploadMock).not.toHaveBeenCalled();
  });

  it('rejects a file whose bytes do not match its .csv extension', async () => {
    const res = await request(buildApp())
      .post('/upload')
      .attach('file', XLSX_MAGIC, 'students.csv');
    expect(res.status).toBe(400);
    expect(stageUploadMock).not.toHaveBeenCalled();
  });

  it('accepts a valid CSV, stages it, then removes the temp file', async () => {
    const res = await request(buildApp())
      .post('/upload')
      .attach('file', VALID_CSV, 'students.csv');
    expect(res.status).toBe(200);
    expect(stageUploadMock).toHaveBeenCalledTimes(1);
    const arg = stageUploadMock.mock.calls[0][0] as { filePath: string; fileName: string };
    expect(path.isAbsolute(arg.filePath)).toBe(true);
    expect(fs.existsSync(arg.filePath)).toBe(false); // cleaned up in `finally`
  });

  it('does NOT derive the stored temp path from a client path-traversal filename', async () => {
    const res = await request(buildApp())
      .post('/upload')
      .attach('file', VALID_CSV, '../../../../etc/evil.csv');
    expect(res.status).toBe(200);
    const arg = stageUploadMock.mock.calls[0][0] as { filePath: string };
    expect(arg.filePath).not.toContain('..');
    expect(fs.existsSync(arg.filePath)).toBe(false);
  });

  it('rejects a file larger than the 20 MB cap with 413', async () => {
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1024, 0x61);
    const res = await request(buildApp())
      .post('/upload')
      .attach('file', oversized, 'big.csv');
    expect(res.status).toBe(413);
    expect(stageUploadMock).not.toHaveBeenCalled();
  }, 30000);
});
