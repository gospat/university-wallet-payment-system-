// =============================================================================
// Bulk Upload Service — Student CSV/XLSX import (7-step workflow §9-§11)
//
// Steps:
//   1. UPLOAD    : POST upload/students  → multipart file → returns { uploadId, rawRecords }
//   2. PARSE     : (handled inside #1 by parseCsvOrXlsx)
//   3. VALIDATE  : column checks, type checks, email/phone regexes → invalidRows[]
//   4. DUP DETECT: within-file duplicates + vs-DB duplicates → duplicates[]
//   5. PREVIEW   : GET  uploads/:id → {summary, validRecords, problemRecords, errorCsvUrl}
//   6. CONFIRM   : POST uploads/:id/confirm { duplicateStrategy: 'SKIP'|'UPDATE'|'CANCEL' }
//                  → runs import, returns results.
//   7. AUDIT LOG : StudentImport batch + per-student STUDENT_CREATED/STUDENT_UPDATED.
//
// This service uses NO global state. All "pending import" bookkeeping is
// stored in a single in-memory LRU map keyed by `uploadId`. For production
// horizontal scaling this would move to a Redis Hash, but the public API
// stays identical.
// =============================================================================

import path from 'path';
import fs from 'fs';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { i18n } from '../i18n/en';
import { generateImportReference } from '../utils/paystack';
import { StudentService } from './student';
import { validateHierarchy } from './academic';
import { Prisma } from '@prisma/client';
import { AdminNotificationService } from './adminNotification';
import { SystemSettingsService } from './systemSettings';
const JSON_DB_NULL = Prisma.JsonNull;
// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type DuplicateStrategy = 'SKIP' | 'UPDATE' | 'CANCEL';

export type RowErrorCode =
  | 'MISSING_REQUIRED'
  | 'INVALID_EMAIL'
  | 'INVALID_PHONE'
  | 'INVALID_LEVEL'
  | 'INVALID_YEAR'
  | 'DUP_WITHIN_FILE'
  | 'DUP_EXISTING_DB'
  | 'WEAK_PASSWORD'
  | 'HIERARCHY_MISMATCH';

export interface ProblemRow {
  row: number;
  record: Record<string, any>;
  errors: Array<{ code: RowErrorCode; field: string; message: string }>;
}

export interface ValidRow {
  row: number;
  record: Record<string, any>;
}

export interface UploadStage {
  uploadId: string;
  fileName: string;
  actorId: number;
  createdAt: Date;
  rawRecords: Record<string, any>[];
  validRows: ValidRow[];
  problemRows: ProblemRow[];
  withinFileDuplicates: Array<{ keys: string[]; rows: number[]; record: Record<string, any> }>;
  dbDuplicates: Array<{ row: number; keys: string[]; existingUserId?: number; record: Record<string, any> }>;
  missingColumns: string[];
  errorCsvPath?: string;
}

export interface UploadSummary {
  uploadId: string;
  fileName: string;
  createdAt: string;
  totalRecords: number;
  validRecords: number;
  invalidRecords: number;
  missingColumns: string[];
  duplicateWithinFile: number;
  duplicateExistingDb: number;
}

// -----------------------------------------------------------------------------
// Canonical column map: headers people commonly use in Nigerian university
// spreadsheets. We match case-insensitively and normalize to our schema keys.
// -----------------------------------------------------------------------------

const COLUMN_ALIASES: Record<string, string> = {
  email: 'email', 'e-mail': 'email', 'e mail': 'email',
  firstname: 'firstName', 'first_name': 'firstName', 'first': 'firstName',
  middlename: 'middleName', 'middle_name': 'middleName',
  lastname: 'lastName', 'last_name': 'lastName', 'surname': 'lastName',
  matricno: 'matricNumber', 'matric no': 'matricNumber', 'matric-number': 'matricNumber',
  matriculationno: 'matricNumber', 'matric_number': 'matricNumber', 'matric': 'matricNumber',
  regno: 'matricNumber', 'reg_no': 'matricNumber',
  formno: 'admissionNumber', 'form no': 'admissionNumber', 'admissionno': 'admissionNumber',
  jambno: 'jambNumber', 'jamb no': 'jambNumber', 'utmeno:': 'jambNumber',
  faculty: 'college', 'college': 'college', 'school': 'college',
  dept: 'department', 'department': 'department',
  programme: 'program', 'program': 'program', 'courseofstudy': 'program',
  level: 'level', 'class': 'level', 'gradelevel': 'level',
  session: 'academicSession', 'academicsession': 'academicSession',
  studenttype: 'studentType', 'typeofstudent': 'studentType',
  entrymode: 'entryMode', 'entry_mode': 'entryMode', 'modeofentry': 'entryMode',
  admissionyear: 'admissionYear', 'set': 'admissionYear',
  graduationyear: 'graduationYear',
  phone: 'phoneNumber', 'phonenumber': 'phoneNumber', 'mobile': 'phoneNumber', 'tel': 'phoneNumber',
  address: 'address', 'residentialaddress': 'address', 'homeaddress': 'address',
  password: 'password', 'temporarypassword': 'password', 'defaultpassword': 'password',
};

const REQUIRED_COLUMNS: Array<keyof Pick<ReturnType<typeof normalize>, 'firstName' | 'lastName' | 'matricNumber' | 'college' | 'department' | 'program' | 'level' | 'academicSession' | 'email' | 'phoneNumber'>> = [
  'firstName',
  'lastName',
  'matricNumber',
  'college',
  'department',
  'program',
  'level',
  'academicSession',
  'email',
  'phoneNumber',
];

// -----------------------------------------------------------------------------
// In-memory stage LRU. Cap = 50 pending batches, TTL = 60 min.
// -----------------------------------------------------------------------------
const MAX_PENDING = 50;
const STAGE_TTL_MS = 60 * 60 * 1000;
const _stages = new Map<string, UploadStage>();

function touchStage(stage: UploadStage) {
  stage.createdAt = new Date();
  _stages.delete(stage.uploadId);
  _stages.set(stage.uploadId, stage);
  if (_stages.size > MAX_PENDING) {
    // Drop oldest
    const oldest = _stages.keys().next().value;
    if (oldest) _stages.delete(oldest);
  }
}
export function getStage(uploadId: string): UploadStage | undefined {
  const s = _stages.get(uploadId);
  if (!s) return undefined;
  if (Date.now() - s.createdAt.getTime() > STAGE_TTL_MS) {
    _stages.delete(uploadId);
    return undefined;
  }
  return s;
}

function normalizeKey(raw: string): string {
  const k = String(raw).trim().toLowerCase().replace(/[-\s_]+/g, '');
  return COLUMN_ALIASES[k] ?? COLUMN_ALIASES[raw.trim().toLowerCase()] ?? raw.trim().replace(/\s+/g, '');
}

function normalize(rawRow: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(rawRow ?? {})) {
    const key = normalizeKey(k);
    if (!key) continue;
    out[key] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Step 2 — Parse CSV/XLSX into array-of-records using PapaParse or SheetJS
// -----------------------------------------------------------------------------
async function parseCsvOrXlsx(filePath: string, fileName: string): Promise<Record<string, any>[]> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.csv') {
    return new Promise<Record<string, any>[]>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, 'utf-8');
      let rows: Record<string, any>[] = [];
      Papa.parse<Record<string, any>>(stream, {
        header: true,
        skipEmptyLines: true,
        worker: false,
        transformHeader: (h) => h,
        complete: (result) => {
          rows = rows.concat(result.data as any[]);
          resolve(rows);
        },
        error: (err) => reject(err),
      });
    });
  } else if (ext === '.xlsx' || ext === '.xls') {
    const buf = await fs.promises.readFile(filePath);
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true }) as any[];
  }
  throw new AppError(i18n.errors.upload.unsupportedFormat, 400);
}

// -----------------------------------------------------------------------------
// Step 3-4 — Validate + detect duplicates. Does NOT touch the database beyond
// a single findMany to pre-load existing (email,matricNumber) pairs for the
// whole uploaded file.
// -----------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NG_PHONE_RE = /^[+\d][\d\s()-]{7,}$/; // lenient: starts with digit/plus, 8+ chars

type FileDupKey = `${'email' | 'matric'}::${string}`;

async function validateRows(rawRows: Record<string, any>[]) {
  const rows = rawRows.map(normalize);
  // Compute intersection-based missing check (strict): require each *required column key* to be present
  // as a header in the file (first row determines headers; if absent entirely → flag).
  const firstRowKeys = new Set(Object.keys(rows[0] ?? {}));
  const missingHeaders = REQUIRED_COLUMNS.filter((c) => !firstRowKeys.has(c));

  const validRows: ValidRow[] = [];
  const problemRows: ProblemRow[] = [];
  const withinFileMap = new Map<FileDupKey, number[]>(); // key → row numbers
  const emails = new Set<string>();
  const matrics = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // human 1-indexed + header row
    const r = rows[i];
    const errs: ProblemRow['errors'] = [];

    // Required fields
    for (const req of REQUIRED_COLUMNS) {
      const v = r[req];
      if (v === undefined || v === null || v === '') {
        errs.push({ code: 'MISSING_REQUIRED', field: req, message: `${req} is required` });
      }
    }

    if (typeof r.email === 'string' && r.email && !EMAIL_RE.test(r.email)) {
      errs.push({ code: 'INVALID_EMAIL', field: 'email', message: 'invalid email format' });
    }
    if (typeof r.phoneNumber === 'string' && r.phoneNumber && !NG_PHONE_RE.test(r.phoneNumber)) {
      errs.push({ code: 'INVALID_PHONE', field: 'phoneNumber', message: 'invalid phone format' });
    }
    if (r.level !== undefined && r.level !== null && r.level !== '' && (Number.isNaN(Number(r.level)) || Number(r.level) < 100 || Number(r.level) > 1000)) {
      errs.push({ code: 'INVALID_LEVEL', field: 'level', message: 'level must be a number between 100 and 1000' });
    }
    for (const yearField of ['admissionYear', 'graduationYear'] as const) {
      const v = r[yearField];
      if (v !== undefined && v !== null && v !== '' && (Number.isNaN(Number(v)) || Number(v) < 1990 || Number(v) > 2100)) {
        errs.push({ code: 'INVALID_YEAR', field: yearField, message: `${yearField} must be a valid year 1990-2100` });
      }
    }

    const hasHierarchyFields =
      (r.college !== undefined && r.college !== null && r.college !== '') ||
      (r.department !== undefined && r.department !== null && r.department !== '') ||
      (r.program !== undefined && r.program !== null && r.program !== '') ||
      (r.level !== undefined && r.level !== null && r.level !== '') ||
      (r.academicSession !== undefined && r.academicSession !== null && r.academicSession !== '');
    if (hasHierarchyFields) {
      const hierarchyResult = await validateHierarchy({
        facultyName: r.college ? String(r.college) : undefined,
        departmentName: r.department ? String(r.department) : undefined,
        programmeName: r.program ? String(r.program) : undefined,
        levelName: r.level !== undefined && r.level !== null && r.level !== '' ? String(r.level) : undefined,
        sessionName: r.academicSession ? String(r.academicSession) : undefined,
      });
      if (!hierarchyResult.valid) {
        for (const herr of hierarchyResult.errors) {
          errs.push({
            code: 'HIERARCHY_MISMATCH',
            field: herr.field,
            message: herr.message,
          });
        }
      }
    }

    // Track within-file dup keys
    if (typeof r.email === 'string' && r.email) {
      const k: FileDupKey = `email::${r.email.toLowerCase()}`;
      withinFileMap.set(k, [...(withinFileMap.get(k) ?? []), rowNum]);
      emails.add(r.email.toLowerCase());
    }
    if (typeof r.matricNumber === 'string' && r.matricNumber) {
      const k: FileDupKey = `matric::${r.matricNumber}`;
      withinFileMap.set(k, [...(withinFileMap.get(k) ?? []), rowNum]);
      matrics.add(r.matricNumber);
    }

    if (errs.length === 0) {
      validRows.push({ row: rowNum, record: r });
    } else {
      problemRows.push({ row: rowNum, record: r, errors: errs });
    }
  }

  // Within-file duplications: any key with count > 1 → mark all but first occurrence as problem rows.
  const withinFileDupes: UploadStage['withinFileDuplicates'] = [];
  for (const [key, rowNums] of withinFileMap) {
    if (rowNums.length > 1) {
      const rows1 = [...rowNums].sort((a, b) => a - b);
      withinFileDupes.push({
        keys: [key],
        rows: rows1,
        record: rows[rows1[0] - 2] ?? rows[0] ?? {},
      });
      for (const badRow of rows1.slice(1)) {
        const pr = problemRows.find((p) => p.row === badRow) ??
          (() => {
            const vr = validRows.find((v) => v.row === badRow)!;
            const p: ProblemRow = { row: vr.row, record: vr.record, errors: [] };
            problemRows.push(p);
            // remove from validRows
            const idx = validRows.indexOf(vr);
            if (idx >= 0) validRows.splice(idx, 1);
            return p;
          })();
        pr.errors.push({ code: 'DUP_WITHIN_FILE', field: key.startsWith('email') ? 'email' : 'matricNumber', message: `duplicate within file on row ${rows1[0]}` });
      }
    }
  }

  // DB duplicates: single query (select {id, email, matricNumber} where OR email IN or matricNumber IN)
  const dbDupes: UploadStage['dbDuplicates'] = [];
  if (emails.size || matrics.size) {
    const existing = await prisma.user.findMany({
      where: {
        OR: [
          emails.size ? { email: { in: [...emails], mode: 'insensitive' } } : undefined,
          matrics.size ? { matricNumber: { in: [...matrics] } } : undefined,
        ].filter(Boolean) as any[],
      },
      select: { id: true, email: true, matricNumber: true, role: true },
    });
    const existingByEmail = new Map<string, number>();
    const existingByMatric = new Map<string, number>();
    for (const u of existing) {
      if (u.email) existingByEmail.set(u.email.toLowerCase(), u.id);
      if (u.matricNumber) existingByMatric.set(u.matricNumber, u.id);
    }
    // Now mark dup validRows
    for (let i = validRows.length - 1; i >= 0; i--) {
      const vr = validRows[i];
      const r = vr.record;
      const hitEmail = r.email ? existingByEmail.get(String(r.email).toLowerCase()) : undefined;
      const hitMatric = r.matricNumber ? existingByMatric.get(String(r.matricNumber)) : undefined;
      const hit = hitEmail ?? hitMatric;
      if (hit) {
        dbDupes.push({
          row: vr.row, keys: [(hitEmail ? `email::${r.email}` : ''), (hitMatric ? `matric::${r.matricNumber}` : '')].filter(Boolean),
          existingUserId: hit, record: r,
        });
        // Move to problemRows
        problemRows.push({
          row: vr.row, record: r,
          errors: [{ code: 'DUP_EXISTING_DB', field: hitEmail ? 'email' : 'matricNumber', message: `${hitEmail ? 'email' : 'matric number'} already exists (user id=${hit})` }],
        });
        validRows.splice(i, 1);
      }
    }
  }

  return { validRows, problemRows, withinFileDupes, dbDupes, missingHeaders, rows };
}

function writeErrorCsv(_fileName: string, stage: UploadStage): string {
  const rows = [['row', 'error_codes', 'error_messages', ...Object.keys(stage.problemRows[0]?.record ?? {})]];
  for (const pr of stage.problemRows) {
    rows.push([
      String(pr.row),
      pr.errors.map((e) => e.code).join(' | '),
      pr.errors.map((e) => `${e.field}:${e.message}`).join(' | '),
      ...Object.values(pr.record).map((v) => (v === null || v === undefined ? '' : String(v))),
    ]);
  }
  const csv = Papa.unparse(rows);
  const outDir = path.join(process.cwd(), 'tmp', 'uploads');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${stage.uploadId}-errors.csv`);
  fs.writeFileSync(outPath, csv, 'utf-8');
  return outPath;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export class BulkStudentUploadService {
  static async stageUpload(opts: { filePath: string; fileName: string; actorId: number }): Promise<{
    summary: UploadSummary;
    preview: { validSample: ValidRow[]; problemSample: ProblemRow[]; errorPreviewPath: string | null };
  }> {
    const raw = await parseCsvOrXlsx(opts.filePath, opts.fileName);
    const validated = await validateRows(raw);
    const uploadId = generateImportReference();
    const stage: UploadStage = {
      uploadId,
      fileName: opts.fileName,
      actorId: opts.actorId,
      createdAt: new Date(),
      rawRecords: raw,
      validRows: validated.validRows,
      problemRows: validated.problemRows,
      withinFileDuplicates: validated.withinFileDupes,
      dbDuplicates: validated.dbDupes,
      missingColumns: validated.missingHeaders,
    };
    if (stage.problemRows.length) {
      stage.errorCsvPath = writeErrorCsv(opts.fileName, stage);
    }
    touchStage(stage);

    const summary: UploadSummary = {
      uploadId,
      fileName: stage.fileName,
      createdAt: stage.createdAt.toISOString(),
      totalRecords: raw.length,
      validRecords: stage.validRows.length,
      invalidRecords: stage.problemRows.length,
      missingColumns: stage.missingColumns,
      duplicateWithinFile: stage.withinFileDuplicates.length,
      duplicateExistingDb: stage.dbDuplicates.length,
    };

    return {
      summary,
      preview: {
        validSample: stage.validRows.slice(0, 50),
        problemSample: stage.problemRows.slice(0, 50),
        errorPreviewPath: stage.errorCsvPath ?? null,
      },
    };
  }

  static async preview(uploadId: string, actorId: number) {
    const stage = getStage(uploadId);
    if (!stage) throw new AppError('Upload session expired or not found. Re-upload the file.', 404);
    if (stage.actorId !== actorId) throw new AppError('You did not start this upload', 403);
    const summary: UploadSummary = {
      uploadId,
      fileName: stage.fileName,
      createdAt: stage.createdAt.toISOString(),
      totalRecords: stage.rawRecords.length,
      validRecords: stage.validRows.length,
      invalidRecords: stage.problemRows.length,
      missingColumns: stage.missingColumns,
      duplicateWithinFile: stage.withinFileDuplicates.length,
      duplicateExistingDb: stage.dbDuplicates.length,
    };
    return {
      summary,
      validRecords: stage.validRows,
      problemRecords: stage.problemRows,
      dbDuplicates: stage.dbDuplicates,
      withinFileDuplicates: stage.withinFileDuplicates,
      errorCsvPath: stage.errorCsvPath ?? null,
    };
  }

  static async confirmImport(opts: {
    uploadId: string;
    actorId: number;
    strategy: DuplicateStrategy;
    ip?: string;
    userAgent?: string;
  }) {
    const stage = getStage(opts.uploadId);
    if (!stage) throw new AppError('Upload session expired or not found. Re-upload the file.', 404);
    if (stage.actorId !== opts.actorId) throw new AppError('You did not start this upload', 403);
    if (!['SKIP', 'UPDATE', 'CANCEL'].includes(opts.strategy)) {
      throw new AppError('Invalid duplicateStrategy. Use SKIP | UPDATE | CANCEL.', 400);
    }

    if (opts.strategy === 'CANCEL') {
      _stages.delete(opts.uploadId);
      return {
        cancelled: true,
        strategy: 'CANCEL',
        summary: { cancelledRecords: stage.rawRecords.length },
      };
    }

    const strategy: DuplicateStrategy = opts.strategy;
    // Only process the rows that passed validation + didn't hit DB dups.
    // For DB-dup rows, honor the strategy instead.
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const perRowErrors: Array<{ row: number; message: string }> = [];

    const importBatch = await prisma.studentImport.create({
      data: {
        importNumber: opts.uploadId,
        uploadedById: opts.actorId,
        fileName: stage.fileName,
        totalRecords: stage.rawRecords.length,
        duplicateStrategy: strategy,
        errorReport: { missingHeaders: stage.missingColumns } as any,
      },
      select: { id: true, importNumber: true },
    });

    // Pass 1: DB-dup rows — honor strategy.
    for (const dup of stage.dbDuplicates) {
      if (strategy === 'SKIP') {
        skippedCount++;
        continue;
      }
      if (!dup.existingUserId) { skippedCount++; continue; }
      try {
        // UPDATE: reuse student update without touching password unless present
        const payload: Record<string, any> = { ...dup.record };
        delete payload.password;
        await StudentService.update(dup.existingUserId, payload, opts.actorId, {
          ip: opts.ip, userAgent: opts.userAgent,
        });
        updatedCount++;
      } catch (err) {
        failedCount++;
        perRowErrors.push({ row: dup.row, message: (err as Error).message });
      }
    }

    // Pass 2: valid rows → create
    for (const vr of stage.validRows) {
      try {
        const payload = vr.record as any;
        if (payload.password === undefined || payload.password === '') delete payload.password;
        await StudentService.create({ ...payload }, opts.actorId, {
          ip: opts.ip, userAgent: opts.userAgent, importId: importBatch.id,
        });
        createdCount++;
      } catch (err) {
        failedCount++;
        perRowErrors.push({ row: vr.row, message: (err as Error).message });
      }
    }

    // Update batch summary + audit
    await prisma.studentImport.update({
      where: { id: importBatch.id },
      data: {
        successfulRecords: createdCount + updatedCount,
        failedRecords: failedCount,
        duplicateRecords: strategy === 'SKIP' ? stage.dbDuplicates.length : 0,
        errorReport: {
          missingHeaders: stage.missingColumns,
          failedRows: perRowErrors,
        } as any,
      },
    });
    await prisma.auditLog.create({
      data: {
        action: i18n.auditActions.studentBulkImported,
        entityType: 'STUDENT_IMPORT',
        entityId: String(importBatch.id),
        userId: opts.actorId,
        oldValue: JSON_DB_NULL,
          newValue: { importNumber: importBatch.importNumber, strategy, created: createdCount, updated: updatedCount, skipped: skippedCount, failed: failedCount, file: stage.fileName } as Prisma.InputJsonValue,
        ipAddress: opts.ip, userAgent: opts.userAgent,
      },
    });

    try {
      const problemRowCount = stage.problemRows.length;
      const totalErrors = problemRowCount + failedCount;
      const threshold = await SystemSettingsService.getImportErrorThreshold();
      void AdminNotificationService.emitImportErrors(importBatch.id, totalErrors, threshold);
    } catch (notifErr) {
      console.warn('[studentImport:confirmImport] emitImportErrors failed:', (notifErr as Error)?.message);
    }

    // Tidy stage (no further previews/confirms possible).
    _stages.delete(opts.uploadId);

    return {
      importNumber: importBatch.importNumber,
      strategy,
      summary: {
        total: stage.rawRecords.length,
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        failed: failedCount,
        dbDuplicatesResolved: stage.dbDuplicates.length,
        perRowErrors,
      },
    };
  }
}
