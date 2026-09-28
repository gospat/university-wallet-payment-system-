// =============================================================================
// Bulk Bills (Fee) Upload Service — CSV/XLSX import
// 3-step workflow matching StudentImport pattern:
//   1. POST /fees/bulk-upload              → stage: parse + validate + preview
//   2. GET  /fees/bulk-upload/:id          → re-fetch preview / summary
//   3. POST /fees/bulk-upload/:id/confirm  → commit (SKIP | UPDATE | ERROR)
//   4. GET  /fees/bulk-upload/:id/errors.csv → download problem-rows CSV
//
// Dedup composite key matches Prisma schema Fee.@@unique:
//   [feeCode, academicSession, program, level]
// =============================================================================
import path from 'path';
import fs from 'fs';
import Papa from 'papaparse';
import * as XLSX from '../utils/xlsxAdapter';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { i18n } from '../i18n/en';
import { generateImportReference } from '../utils/paystack';
import { Prisma } from '@prisma/client';

const JSON_DB_NULL = Prisma.JsonNull;

export type DuplicateStrategy = 'SKIP' | 'UPDATE' | 'ERROR';

export type FeeRowErrorCode =
  | 'MISSING_REQUIRED'
  | 'INVALID_AMOUNT'
  | 'INVALID_DEADLINE'
  | 'CATEGORY_NOT_FOUND'
  | 'DUP_WITHIN_FILE'
  | 'DUP_EXISTING_DB'
  | 'INVALID_LEVEL'
  | 'INVALID_STUDENT_TYPE'
  | 'INVALID_SEMESTER';

export interface ProblemRow {
  row: number;
  record: Record<string, any>;
  errors: Array<{ code: FeeRowErrorCode; field: string; message: string }>;
}

export interface ValidRow {
  row: number;
  record: Record<string, any>;
  compositeKey: string;
  resolvedCategoryId?: number;
}

export interface FeeUploadStage {
  uploadId: string;
  fileName: string;
  actorId: number;
  createdAt: Date;
  rawRecords: Record<string, any>[];
  validRows: ValidRow[];
  problemRows: ProblemRow[];
  withinFileDuplicates: Array<{ compositeKey: string; rows: number[]; record: Record<string, any> }>;
  dbDuplicates: Array<{ row: number; compositeKey: string; existingFeeId?: number; record: Record<string, any> }>;
  missingColumns: string[];
  errorCsvPath?: string;
}

export interface FeeUploadSummary {
  uploadId: string;
  fileName: string;
  createdAt: string;
  totalRecords: number;
  validRecords: number;
  invalidRecords: number;
  missingColumns: string[];
  duplicateWithinFile: number;
  duplicateExistingDb: number;
  previewSample: Array<{ row: number; record: Record<string, any> }>;
  categoryResolutions: Record<string, { status: 'RESOLVED' | 'UNRESOLVED'; categoryId?: number; matches: number }>;
}

// ---------------------------------------------------------------------------
// Column aliases (Nigerian university spreadsheet conventions)
// ---------------------------------------------------------------------------
const COLUMN_ALIASES: Record<string, string> = {
  feecode: 'feeCode', fee_code: 'feeCode', feeno: 'feeCode', feeid: 'feeCode',
  billcode: 'feeCode', bill_code: 'feeCode', billid: 'feeCode', billno: 'feeCode',
  code: 'feeCode', referenceno: 'feeCode', referencenumber: 'feeCode',
  name: 'name', feename: 'name', fee_name: 'name', billname: 'name', bill_name: 'name',
  title: 'name', description: 'description', details: 'description', notes: 'description',
  category: 'category', categorycode: 'category', catcode: 'category',
  categoryname: 'category', catname: 'category', feecategory: 'category',
  billcategory: 'category', category_id: 'category', categoryId: 'category',
  amount: 'amount', feeamount: 'amount', price: 'amount', cost: 'amount',
  total: 'amount', amountngn: 'amount', naira: 'amount',
  session: 'academicSession', academicsession: 'academicSession',
  academicyear: 'academicSession', academicyr: 'academicSession',
  sessionyear: 'academicSession', year: 'academicSession', term: 'academicSession',
  program: 'program', programme: 'program', course: 'program',
  courseofstudy: 'program', course_code: 'program', programcode: 'program',
  programmeCode: 'program', programme_code: 'program',
  level: 'level', class: 'level', grade: 'level', gradelevel: 'level',
  academiclevel: 'academicLevel', academicyearlevel: 'level',
  department: 'department', dept: 'department', deptcode: 'department',
  faculty: 'faculty', college: 'faculty', school: 'faculty',
  studenttype: 'studentType', typeofstudent: 'studentType',
  ismandatory: 'isMandatory', mandatory: 'isMandatory', required: 'isMandatory',
  compulsory: 'isMandatory',
  deadline: 'paymentDeadline', paymentdeadline: 'paymentDeadline',
  dueDate: 'paymentDeadline', due_date: 'paymentDeadline', lastdate: 'paymentDeadline',
  expirydate: 'paymentDeadline',
  semester: 'semester', sem: 'semester', termtype: 'semester',
  currency: 'currency', isactive: 'isActive', active: 'isActive',
};

const REQUIRED_KEYS = ['feeCode', 'name', 'category', 'amount', 'academicSession'] as const;

// ---------------------------------------------------------------------------
// In-memory stage LRU. Cap = 50 pending batches, TTL = 60 min.
// ---------------------------------------------------------------------------
const MAX_PENDING = 50;
const STAGE_TTL_MS = 60 * 60 * 1000;
const _stages = new Map<string, FeeUploadStage>();

function touchStage(stage: FeeUploadStage) {
  stage.createdAt = new Date();
  _stages.delete(stage.uploadId);
  _stages.set(stage.uploadId, stage);
  if (_stages.size > MAX_PENDING) {
    const oldest = _stages.keys().next().value;
    if (oldest) _stages.delete(oldest);
  }
}

export function getFeeStage(uploadId: string): FeeUploadStage | undefined {
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
  return COLUMN_ALIASES[k] ?? raw.trim().replace(/\s+/g, '');
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

// ---------------------------------------------------------------------------
// Parse CSV or XLSX
// ---------------------------------------------------------------------------
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
        complete: (result) => {
          rows = rows.concat(result.data as any[]);
          resolve(rows);
        },
        error: (err) => reject(err),
      });
    });
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const buf = await fs.promises.readFile(filePath);
    const wb = await XLSX.read(buf, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }) as any[];
  }
  throw new AppError(i18n.errors.upload.unsupportedFormat, 400);
}

function compositeKeyOf(r: { feeCode: string; academicSession: string; program?: string | null | number; level?: string | null | number }): string {
  const code = String(r.feeCode ?? '').trim();
  const sess = String(r.academicSession ?? '').trim();
  const prog = (r.program === undefined || r.program === null) ? '' : String(r.program).trim();
  const lvl = (r.level === undefined || r.level === null) ? '' : String(r.level).trim();
  return `${code}__${sess}__${prog}__${lvl}`;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------
const VALID_LEVELS = new Set(['100', '200', '300', '400', '500', '600', '700', '1', '2', '3', '4', '5', '6', '7']);
const VALID_STUDENT_TYPES = new Set(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']);
const VALID_SEMESTERS = new Set(['FIRST', 'SECOND', '1', '2', '1ST', '2ND', 'FIRST SEMESTER', 'SECOND SEMESTER', 'HARMATTAN', 'RAIN']);

function coerceBool(v: any): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 't', 'on', 'active', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'f', 'off', 'inactive', 'disabled'].includes(s)) return false;
  return undefined;
}

function coerceLevel(v: any): string | undefined | number {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  const num = Number(s);
  if (!Number.isNaN(num) && Number.isFinite(num) && num > 0 && num <= 700) {
    if (num <= 7) return num;
    return num;
  }
  const digits = s.replace(/\D/g, '');
  if (digits) return coerceLevel(digits);
  return s;
}

function coerceStudentType(v: any): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim().toUpperCase().replace(/[-\s_]/g, '');
  const map: Record<string, string> = {
    UNDERGRAD: 'UNDERGRADUATE', UG: 'UNDERGRADUATE',
    POSTGRAD: 'POSTGRADUATE', PG: 'POSTGRADUATE', GRAD: 'POSTGRADUATE',
    PARTTIME: 'PART_TIME', PT: 'PART_TIME',
    JUPEB: 'JUPEB', IJMB: 'JUPEB',
    OTHER: 'OTHER',
  };
  return map[s] ?? (VALID_STUDENT_TYPES.has(s) ? s : undefined);
}

function coerceSemester(v: any): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim().toUpperCase().replace(/\s+/g, ' ');
  if (['FIRST', '1', '1ST', 'FIRST SEMESTER', 'HARMATTAN'].includes(s)) return 'FIRST';
  if (['SECOND', '2', '2ND', 'SECOND SEMESTER', 'RAIN'].includes(s)) return 'SECOND';
  return undefined;
}

function coerceDeadline(v: any): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  const n = Number(v);
  if (!Number.isNaN(n) && n > 1e10) return new Date(n);
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d;
  return undefined;
}

function amountToNumber(v: any): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(Number(v.toFixed(2)) * 100) / 100;
  const s = String(v).replace(/[₦$,\s]/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isNaN(n) || !Number.isFinite(n)) return null;
  return Math.round(Number(n.toFixed(2)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Category resolver: fuzzy match FeeCategory by code or name
// ---------------------------------------------------------------------------
async function resolveCategoryHints(records: ValidRow[]): Promise<Record<string, { status: 'RESOLVED' | 'UNRESOLVED'; categoryId?: number; matches: number; rows: number[] }>> {
  const tokens = new Map<string, number[]>();
  for (const r of records) {
    const t = String(r.record.category ?? '').trim();
    if (!t) continue;
    const arr = tokens.get(t);
    if (arr) arr.push(r.row);
    else tokens.set(t, [r.row]);
  }
  if (tokens.size === 0) return {};
  const allTokens = Array.from(tokens.keys());
  const categories = await prisma.feeCategory.findMany({
    where: {
      OR: [
        { code: { in: allTokens } },
        { name: { in: allTokens } },
      ],
    },
    select: { id: true, code: true, name: true },
  });
  const out: Record<string, { status: 'RESOLVED' | 'UNRESOLVED'; categoryId?: number; matches: number; rows: number[] }> = {};
  for (const token of allTokens) {
    const rows = tokens.get(token) ?? [];
    const tNorm = token.trim();
    const match = categories.find((c) =>
      (c.code && c.code.toLowerCase() === tNorm.toLowerCase()) ||
      (c.name && c.name.toLowerCase() === tNorm.toLowerCase()),
    );
    if (!match) {
      const loose = categories.find((c) =>
        (c.code && c.code.toLowerCase().includes(tNorm.toLowerCase())) ||
        (c.name && c.name.toLowerCase().includes(tNorm.toLowerCase())),
      );
      if (!loose) out[token] = { status: 'UNRESOLVED', matches: 0, rows };
      else out[token] = { status: 'RESOLVED', categoryId: loose.id, matches: 1, rows };
    } else {
      out[token] = { status: 'RESOLVED', categoryId: match.id, matches: 1, rows };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 1: Parse + validate → preview
// ---------------------------------------------------------------------------
export async function stageFeeUpload(opts: { filePath: string; fileName: string; actorId: number }) {
  const raw = await parseCsvOrXlsx(opts.filePath, opts.fileName);
  const base = generateImportReference();
  const uploadId = base.replace(/^IMP-/, 'FEE-');

  const missingRequired = new Set<string>();
  const problemRows: ProblemRow[] = [];
  const validRows: ValidRow[] = [];
  const withinFileMap = new Map<string, { rows: number[]; record: Record<string, any> }>();
  const withinFileDuplicates: FeeUploadStage['withinFileDuplicates'] = [];

  raw.forEach((rawRow, i) => {
    const record = normalize(rawRow);
    const rowNum = i + 2;
    const errors: ProblemRow['errors'] = [];

    for (const reqKey of REQUIRED_KEYS) {
      const val = record[reqKey];
      if (val === undefined || val === null || (typeof val === 'string' && !val.trim())) {
        errors.push({ code: 'MISSING_REQUIRED', field: reqKey, message: `Missing required column "${reqKey}"` });
        missingRequired.add(reqKey);
      }
    }

    const amount = amountToNumber(record.amount);
    if (amount === null) {
      errors.push({ code: 'INVALID_AMOUNT', field: 'amount', message: 'Amount must be a positive number' });
    } else if (amount <= 0) {
      errors.push({ code: 'INVALID_AMOUNT', field: 'amount', message: 'Amount must be greater than 0' });
    }

    const lvl = record.level !== undefined && record.level !== null && record.level !== '' ? coerceLevel(record.level) : undefined;
    if (record.level !== undefined && record.level !== null && record.level !== '' && lvl === undefined) {
      errors.push({ code: 'INVALID_LEVEL', field: 'level', message: 'Level not recognized' });
    }

    if (record.studentType !== undefined && record.studentType !== null && String(record.studentType).trim() !== '') {
      const st = coerceStudentType(record.studentType);
      if (!st) errors.push({ code: 'INVALID_STUDENT_TYPE', field: 'studentType', message: 'Student type not valid' });
    }
    if (record.semester !== undefined && record.semester !== null && String(record.semester).trim() !== '') {
      const sem = coerceSemester(record.semester);
      if (!sem) errors.push({ code: 'INVALID_SEMESTER', field: 'semester', message: 'Semester must be FIRST or SECOND' });
    }

    if (record.paymentDeadline !== undefined && record.paymentDeadline !== null && String(record.paymentDeadline).trim() !== '') {
      const d = coerceDeadline(record.paymentDeadline);
      if (!d) errors.push({ code: 'INVALID_DEADLINE', field: 'paymentDeadline', message: 'Deadline is not a valid date' });
    }

    const normalizedForDedup: any = {
      feeCode: String(record.feeCode ?? '').trim(),
      academicSession: String(record.academicSession ?? '').trim(),
      program: record.program,
      level: lvl,
    };

    const compositeKey = compositeKeyOf(normalizedForDedup);
    const seen = withinFileMap.get(compositeKey);
    if (seen) {
      seen.rows.push(rowNum);
      withinFileMap.set(compositeKey, seen);
      errors.push({ code: 'DUP_WITHIN_FILE', field: 'feeCode+session+program+level', message: 'Duplicate within uploaded file' });
    } else {
      withinFileMap.set(compositeKey, { rows: [rowNum], record: { ...record } });
    }

    if (errors.length > 0) {
      problemRows.push({ row: rowNum, record, errors });
    } else {
      validRows.push({
        row: rowNum,
        record: {
          ...record,
          amount: amount!,
          level: lvl ?? undefined,
          studentType: coerceStudentType(record.studentType) ?? undefined,
          semester: coerceSemester(record.semester) ?? undefined,
          paymentDeadline: coerceDeadline(record.paymentDeadline) ?? undefined,
          isMandatory: coerceBool(record.isMandatory) ?? true,
          isActive: coerceBool(record.isActive) ?? true,
          currency: record.currency ? String(record.currency).toUpperCase() : 'NGN',
        },
        compositeKey,
      });
    }
  });

  withinFileMap.forEach((v, k) => {
    if (v.rows.length > 1) withinFileDuplicates.push({ compositeKey: k, rows: v.rows, record: v.record });
  });

  const categoryRes = await resolveCategoryHints(validRows);
  for (const r of validRows) {
    const token = String(r.record.category ?? '').trim();
    const resolution = categoryRes[token];
    if (resolution?.status === 'RESOLVED' && resolution.categoryId) {
      r.resolvedCategoryId = resolution.categoryId;
    } else {
      problemRows.push({
        row: r.row,
        record: r.record,
        errors: [{ code: 'CATEGORY_NOT_FOUND', field: 'category', message: `Category "${token}" not found. Create it first in Bill Categories.` }],
      });
      const idx = validRows.indexOf(r);
      if (idx >= 0) validRows.splice(idx, 1);
    }
  }

  const dbKeys = validRows.map((r) => r.compositeKey);
  const dbDuplicates: FeeUploadStage['dbDuplicates'] = [];
  if (dbKeys.length > 0) {
    const parts: Array<{ feeCode: string; academicSession: string; program: string | null; level: number | null }> = [];
    for (const k of dbKeys) {
      const [code, sess, prog, lvlStr] = k.split('__');
      const levelNum = lvlStr ? (Number.isNaN(Number(lvlStr)) ? null : Number(lvlStr)) : null;
      parts.push({
        feeCode: code,
        academicSession: sess,
        program: prog || null,
        level: levelNum,
      });
    }

    const ors: Prisma.FeeWhereInput[] = parts.map((p) => ({
      feeCode: p.feeCode,
      academicSession: p.academicSession,
      program: p.program === null ? { isSet: false } as any : p.program,
      ...(p.level === null ? {} : { level: p.level }),
    }));
    if (ors.length > 0) {
      const existing = await prisma.fee.findMany({
        where: { OR: ors },
        select: { id: true, feeCode: true, academicSession: true, program: true, level: true },
      });
      const existKeys = new Map(existing.map((e) => [compositeKeyOf(e), e.id]));

      for (const r of validRows) {
        const feeId = existKeys.get(r.compositeKey);
        if (feeId !== undefined) {
          dbDuplicates.push({ row: r.row, compositeKey: r.compositeKey, existingFeeId: feeId, record: r.record });
        }
      }
    }
  }

  const stage: FeeUploadStage = {
    uploadId,
    fileName: opts.fileName,
    actorId: opts.actorId,
    createdAt: new Date(),
    rawRecords: raw,
    validRows,
    problemRows,
    withinFileDuplicates,
    dbDuplicates,
    missingColumns: Array.from(missingRequired),
  };

  const errorCsvPath = buildErrorCsv(stage);
  stage.errorCsvPath = errorCsvPath;
  touchStage(stage);
  return buildSummary(stage);
}

// ---------------------------------------------------------------------------
// Stage 2: Re-fetch preview / summary
// ---------------------------------------------------------------------------
export async function previewFeeUpload(uploadId: string, actorId: number) {
  const stage = getFeeStage(uploadId);
  if (!stage) throw new AppError('Upload session not found or expired. Re-upload the file.', 404);
  if (stage.actorId !== actorId) throw new AppError(i18n.errors.auth.notPermitted, 403);
  touchStage(stage);
  return buildSummary(stage);
}

// ---------------------------------------------------------------------------
// Stage 3: Commit import
// ---------------------------------------------------------------------------
export async function confirmFeeImport(opts: { uploadId: string; actorId: number; strategy: DuplicateStrategy; ip?: string; userAgent?: string }) {
  const stage = getFeeStage(opts.uploadId);
  if (!stage) throw new AppError('Upload session not found or expired. Re-upload the file.', 404);
  if (stage.actorId !== opts.actorId) throw new AppError(i18n.errors.auth.notPermitted, 403);

  const dbDupRows = new Set(stage.dbDuplicates.map((d) => d.row));
  const insertable = stage.validRows.filter((r) => !dbDupRows.has(r.row));
  const updatable = stage.dbDuplicates;

  if (opts.strategy === 'ERROR' && (updatable.length > 0 || stage.withinFileDuplicates.length > 0)) {
    throw new AppError(
      `Canceled due to duplicates: ${updatable.length} DB duplicate(s) and ${stage.withinFileDuplicates.length} within-file duplicate(s). Use SKIP or UPDATE strategy instead.`,
      409,
    );
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errorRows = 0;
  const perRowErrors: ProblemRow[] = [];

  await prisma.$transaction(async (tx) => {
    for (const row of insertable) {
      try {
        const data: Prisma.FeeCreateInput = {
          feeCode: String(row.record.feeCode).trim(),
          name: String(row.record.name).trim(),
          description: row.record.description ? String(row.record.description).trim() : undefined,
          category: { connect: { id: row.resolvedCategoryId! } },
          amount: new Prisma.Decimal(row.record.amount),
          currency: String(row.record.currency || 'NGN').toUpperCase(),
          academicSession: String(row.record.academicSession).trim(),
          semester: row.record.semester ? (row.record.semester as any) : undefined,
          college: row.record.faculty ? String(row.record.faculty) : undefined,
          department: row.record.department ? String(row.record.department) : undefined,
          program: row.record.program ? String(row.record.program) : undefined,
          level: row.record.level !== undefined && row.record.level !== null ? (Number.isNaN(Number(row.record.level)) ? undefined : Number(row.record.level)) : undefined,
          studentType: row.record.studentType ? (row.record.studentType as any) : undefined,
          isMandatory: Boolean(row.record.isMandatory ?? true),
          paymentDeadline: row.record.paymentDeadline ? (row.record.paymentDeadline as Date) : undefined,
          isActive: Boolean(row.record.isActive ?? true),
          createdBy: { connect: { id: opts.actorId } },
        };
        await tx.fee.create({ data, select: { id: true } });
        created += 1;
      } catch (e: any) {
        perRowErrors.push({ row: row.row, record: row.record, errors: [{ code: 'MISSING_REQUIRED' as any, field: 'fee', message: String(e?.message ?? 'DB insert failed') }] });
        errorRows += 1;
      }
    }

    if (opts.strategy === 'UPDATE') {
      for (const dup of updatable) {
        const v = stage.validRows.find((r) => r.row === dup.row);
        if (!v || !dup.existingFeeId) { skipped += 1; continue; }
        try {
          const data: Prisma.FeeUpdateInput = {
            name: String(v.record.name).trim(),
            description: v.record.description ? String(v.record.description).trim() : null,
            amount: new Prisma.Decimal(v.record.amount),
            currency: String(v.record.currency || 'NGN').toUpperCase(),
            semester: v.record.semester ? (v.record.semester as any) : null,
            college: v.record.faculty ? String(v.record.faculty) : null,
            department: v.record.department ? String(v.record.department) : null,
            program: v.record.program ? String(v.record.program) : null,
            level: v.record.level !== undefined && v.record.level !== null ? (Number.isNaN(Number(v.record.level)) ? null : Number(v.record.level)) : null,
            studentType: v.record.studentType ? (v.record.studentType as any) : null,
            isMandatory: Boolean(v.record.isMandatory ?? true),
            paymentDeadline: v.record.paymentDeadline ? (v.record.paymentDeadline as Date) : null,
            isActive: Boolean(v.record.isActive ?? true),
            category: v.resolvedCategoryId ? { connect: { id: v.resolvedCategoryId } } : undefined,
          };
          await tx.fee.update({ where: { id: dup.existingFeeId }, data, select: { id: true } });
          updated += 1;
        } catch (e: any) {
          perRowErrors.push({ row: dup.row, record: dup.record, errors: [{ code: 'MISSING_REQUIRED' as any, field: 'fee', message: String(e?.message ?? 'DB update failed') }] });
          errorRows += 1;
        }
      }
    } else {
      skipped += updatable.length;
    }
  });

  await prisma.auditLog.create({
    data: {
      userId: opts.actorId,
      action: 'FEE_BULK_IMPORTED',
      entityType: 'FEE',
      entityId: opts.uploadId,
      details: {
        fileName: stage.fileName,
        created,
        updated,
        skipped,
        errorRows,
        strategy: opts.strategy,
        totalValid: stage.validRows.length,
        totalProblems: stage.problemRows.length,
      },
      ipAddress: opts.ip ? opts.ip.slice(0, 64) : null,
      userAgent: opts.userAgent ? opts.userAgent.slice(0, 512) : null,
    },
  }).catch(() => null);

  _stages.delete(opts.uploadId);

  return {
    uploadId: opts.uploadId,
    fileName: stage.fileName,
    summary: {
      created,
      updated,
      skipped,
      errorRows,
      strategy: opts.strategy,
    },
    problemRows: stage.problemRows.concat(perRowErrors).slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildSummary(stage: FeeUploadStage): FeeUploadSummary {
  const categoryRes: Record<string, { status: 'RESOLVED' | 'UNRESOLVED'; categoryId?: number; matches: number }> = {};
  const tokenMap = new Map<string, { status: 'RESOLVED' | 'UNRESOLVED'; categoryId?: number; matches: number }>();
  for (const r of stage.validRows) {
    const token = String(r.record.category ?? '').trim();
    const existing = tokenMap.get(token) ?? { status: 'RESOLVED' as const, categoryId: r.resolvedCategoryId, matches: 0 };
    existing.matches += 1;
    tokenMap.set(token, existing);
  }
  stage.problemRows.forEach((p) => {
    if (p.errors.some((e) => e.code === 'CATEGORY_NOT_FOUND')) {
      const token = String(p.record.category ?? '').trim();
      const existing = tokenMap.get(token) ?? { status: 'UNRESOLVED' as const, matches: 0 };
      existing.matches += 1;
      tokenMap.set(token, existing);
    }
  });
  tokenMap.forEach((v, k) => { categoryRes[k] = v; });

  const previewSample = stage.validRows.slice(0, 10).map((r) => ({ row: r.row, record: r.record }));
  return {
    uploadId: stage.uploadId,
    fileName: stage.fileName,
    createdAt: stage.createdAt.toISOString(),
    totalRecords: stage.rawRecords.length,
    validRecords: stage.validRows.length,
    invalidRecords: stage.problemRows.length,
    missingColumns: stage.missingColumns,
    duplicateWithinFile: stage.withinFileDuplicates.length,
    duplicateExistingDb: stage.dbDuplicates.length,
    previewSample,
    categoryResolutions: categoryRes,
  };
}

function buildErrorCsv(stage: FeeUploadStage): string | undefined {
  if (stage.problemRows.length === 0 && stage.withinFileDuplicates.length === 0) return undefined;
  const dir = path.join(process.cwd(), 'tmp', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `fee-upload-errors-${stage.uploadId}.csv`);
  const rows: string[][] = [];
  rows.push(['row_number', 'error_codes', 'error_fields', 'error_messages', ...Object.keys(stage.rawRecords[0] ?? {})]);
  for (const p of stage.problemRows) {
    rows.push([
      String(p.row),
      p.errors.map((e) => e.code).join('|'),
      p.errors.map((e) => e.field).join('|'),
      p.errors.map((e) => e.message).join(' | '),
      ...Object.keys(stage.rawRecords[0] ?? {}).map((k) => String(p.record[k] ?? '')),
    ]);
  }
  const csv = Papa.unparse(rows, { delimiter: ',' });
  fs.writeFileSync(filePath, '\uFEFF' + csv, 'utf-8');
  return filePath;
}

export function getErrorCsvPath(uploadId: string, actorId: number): string | undefined {
  const stage = getFeeStage(uploadId);
  if (!stage) return undefined;
  if (stage.actorId !== actorId) return undefined;
  return stage.errorCsvPath;
}

export default {
  stageFeeUpload,
  previewFeeUpload,
  confirmFeeImport,
  getFeeStage,
  getErrorCsvPath,
};
