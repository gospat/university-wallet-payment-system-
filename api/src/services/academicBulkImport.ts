import Papa from 'papaparse';
import * as XLSX from '../utils/xlsxAdapter';
import path from 'path';
import fs from 'fs';
import prisma from '../config/database';
import { FacultyService, DepartmentService, ProgrammeService } from './academic';
import { AppError } from '../utils/AppError';
import type { Request } from 'express';
import { buildTwoSheetWorkbook, TwoSheetTemplate } from '../utils/xlsxTemplate';
import { csvLineSafe, csvCellSafe } from '../utils/security';

export type BulkKind = 'college' | 'department' | 'programme';

export interface BulkRowError {
  row: number;
  record: string;
  message: string;
}

export interface BulkResult {
  created: number;
  skipped: number;
  errors: BulkRowError[];
  ids: number[];
  createdItems: Array<{ id: number; code: string; name: string }>;
}

const ALLOWED_EXT = new Set(['.csv', '.xlsx', '.xls']);
const UTF8_BOM = '\uFEFF';

function normalizeKey(raw: string): string {
  let s = String(raw ?? '').trim();
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.toLowerCase().replace(/[-\s_.,;:!?/\\|]+/g, '');
  const aliases: Record<string, string> = {
    collegecode: 'collegeCode', 'collegid': 'collegeId', 'collegeid': 'collegeId',
    facultycode: 'collegeCode', 'facultyid': 'collegeId',
    departmentcode: 'departmentCode', 'departmentid': 'departmentId', 'deptcode': 'departmentCode', 'deptid': 'departmentId',
    code: 'code', 'name': 'name', 'title': 'name',
    description: 'description', 'desc': 'description',
    isactive: 'isActive', 'active': 'isActive', 'status': 'isActive',
    deanemail: 'deanEmail', 'dean': 'deanEmail',
    heademail: 'headEmail', 'hodemail': 'headEmail', 'hod': 'headEmail',
    coordinatoremail: 'coordinatorEmail', 'coordinator': 'coordinatorEmail',
    durationyears: 'durationYears', 'duration': 'durationYears', 'years': 'durationYears',
  };
  if (aliases[s]) return aliases[s];
  if (s.includes('college') && s.includes('code') && !s.includes('department')) return 'collegeCode';
  if (s.includes('college') && s.includes('id') && !s.includes('department')) return 'collegeId';
  if ((s.includes('department') || s.includes('dept')) && s.includes('code')) return 'departmentCode';
  if ((s.includes('department') || s.includes('dept')) && s.includes('id')) return 'departmentId';
  if (s.includes('active') || s.includes('isactive') || s.includes('enabled')) return 'isActive';
  if ((s.includes('dean') || s.includes('facultyhead')) && s.includes('email')) return 'deanEmail';
  if ((s.includes('hod') || s.includes('head') || s.includes('depthead')) && s.includes('email') && !s.includes('dean') && !s.includes('coordinator')) return 'headEmail';
  if (s.includes('coordinator') && s.includes('email')) return 'coordinatorEmail';
  if (s.includes('duration') || (s.includes('year') && !s.includes('email') && !s.includes('name'))) return 'durationYears';
  return s;
}

function normalizeRow(rawRow: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(rawRow ?? {})) {
    const key = normalizeKey(k);
    if (!key) continue;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '') { out[key] = ''; continue; }
      out[key] = trimmed;
    } else if (v === null || v === undefined) {
      out[key] = '';
    } else {
      out[key] = v;
    }
  }
  return out;
}

function parseIsActive(v: any): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return true;
  if (['1', 'true', 'yes', 'y', 't', 'active', 'enabled'].includes(s)) return true;
  return false;
}

export async function parseCsvOrXlsx(filePath: string, fileName: string): Promise<Record<string, any>[]> {
  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new AppError('Unsupported file format. Please upload CSV, XLSX, or XLS.', 400);

  if (ext === '.csv') {
    return new Promise<Record<string, any>[]>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, 'utf-8');
      Papa.parse<Record<string, any>>(stream, {
        header: true,
        skipEmptyLines: 'greedy' as any,
        worker: false,
        transformHeader: (h) => h,
        complete: (result) => {
          const rawRows = (result.data as any[]) ?? [];
          resolve(rawRows.map(normalizeRow));
        },
        error: (err) => reject(err),
      });
    });
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const buf = await fs.promises.readFile(filePath);
    const wb = await XLSX.read(buf, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true }) as any[];
    return rawRows.map(normalizeRow);
  }

  throw new AppError('Unsupported file format. Please upload CSV, XLSX, or XLS.', 400);
}

// -----------------------------------------------------------------------------
// Template CSV generators — uses centralized csvLineSafe for OWASP formula
// injection neutralization.
// -----------------------------------------------------------------------------

export function downloadTemplateCsv(kind: BulkKind): {
  filename: string;
  content: string;
  mimeType: string;
} {
  let header: string[] = [];
  let exampleRow: string[] = [];

  if (kind === 'college') {
    header = ['code', 'name', 'deanEmail (optional)', 'isActive (TRUE/FALSE)'];
    exampleRow = ['COS', 'College of Science', 'sci-dean@university.edu.ng', 'TRUE'];
  } else if (kind === 'department') {
    header = ['collegeCode (or collegeId)', 'collegeId (or collegeCode)', 'code', 'name', 'headEmail (optional)', 'isActive (TRUE/FALSE)'];
    exampleRow = ['COS', '', 'CSC', 'Department of Computer Science', 'cs-hod@university.edu.ng', 'TRUE'];
  } else {
    header = ['departmentCode (or departmentId)', 'departmentId (or departmentCode)', 'collegeCode (optional cross-check)', 'code', 'name', 'durationYears (optional, default 4)', 'coordinatorEmail (optional)', 'isActive (TRUE/FALSE)'];
    exampleRow = ['CSC', '', 'COS', 'BScCS', 'Bachelor of Computer Science', '4', 'cs-coord@university.edu.ng', 'TRUE'];
  }

  const commentLine = `# Instructions: Upload Colleges first. Then use the collegeCode values in Departments CSV. Then use departmentCode values in Programmes CSV.`;
  const header2Line = `# Required fields marked with *; TRUE/FALSE default is TRUE if blank.`;

  let content = UTF8_BOM;
  content += commentLine + '\r\n';
  content += header2Line + '\r\n';
  content += csvLineSafe(header);
  content += csvLineSafe(exampleRow);

  const kindNames: Record<BulkKind, string> = {
    college: 'colleges',
    department: 'departments',
    programme: 'programmes',
  };

  return {
    filename: `${kindNames[kind]}-template.csv`,
    content,
    mimeType: 'text/csv; charset=utf-8',
  };
}

export async function downloadTemplateXlsx(kind: BulkKind): Promise<TwoSheetTemplate & { filename: string }> {
  let templateHeader: string[] = [];
  let templateSamples: string[][] = [];
  let colWidths: number[] = [];
  let title = '';
  let instructionRows: string[][] = [];
  let columnNotes: Array<{ header: string; required?: boolean; note: string }> = [];

  if (kind === 'college') {
    title = 'Colleges (Faculties) — Bulk Import Template';
    templateHeader = ['code', 'name', 'deanEmail', 'isActive'];
    templateSamples = [['COS', 'College of Science', 'sci-dean@university.edu.ng', 'TRUE']];
    colWidths = [14, 42, 38, 12];
    instructionRows = [
      ['#', 'Topic', 'Rule / Description', 'Example'],
      ['1', 'Upload First', 'Upload Colleges BEFORE Departments and Programmes — their codes are referenced by child records.', 'Colleges → Depts → Programmes'],
      ['2', 'Required Fields', 'code and name are always required.', 'COS / College of Science'],
      ['3', 'Code Uniqueness', 'code must be unique across all Colleges, uppercase recommended, max 30 chars.', 'COS'],
      ['4', 'deanEmail', 'Optional, must be valid email format if provided.', 'sci-dean@university.edu.ng'],
      ['5', 'isActive', 'TRUE or FALSE (any case). Default TRUE if blank. Use FALSE to disable on create.', 'TRUE'],
      ['6', 'Name Limit', 'Max 150 characters for name field.', 'College of Science'],
    ];
    columnNotes = [
      { header: 'code', required: true, note: 'Unique short code, uppercase, max 30 chars (e.g. COS, ENG, MED).' },
      { header: 'name', required: true, note: 'Full college/faculty name, max 150 chars.' },
      { header: 'deanEmail', required: false, note: 'Valid email for Dean/Head of college. Optional.' },
      { header: 'isActive', required: false, note: 'TRUE/FALSE. Default TRUE if blank.' },
    ];
  } else if (kind === 'department') {
    title = 'Departments — Bulk Import Template';
    templateHeader = ['collegeCode', 'collegeId', 'code', 'name', 'headEmail', 'isActive'];
    templateSamples = [['COS', '', 'CSC', 'Department of Computer Science', 'cs-hod@university.edu.ng', 'TRUE']];
    colWidths = [14, 12, 14, 44, 38, 12];
    instructionRows = [
      ['#', 'Topic', 'Rule / Description', 'Example'],
      ['1', 'Prerequisite', 'Upload Colleges (Faculties) BEFORE Departments. Each Department must reference a parent College.', 'COS (parent college)'],
      ['2', 'Parent Reference', 'Provide EITHER collegeCode (preferred) OR collegeId (numeric). Code takes precedence if both filled.', 'COS'],
      ['3', 'Required Fields', 'Parent (collegeCode or collegeId) + code + name are all required.', 'COS + CSC + Department of CS'],
      ['4', 'Code Uniqueness', 'code must be unique WITHIN the same parent College (different colleges may share codes).', 'CSC'],
      ['5', 'headEmail', 'Optional HOD email address; valid email format if provided.', 'cs-hod@university.edu.ng'],
      ['6', 'isActive', 'TRUE or FALSE (any case). Default TRUE if blank.', 'TRUE'],
    ];
    columnNotes = [
      { header: 'collegeCode', required: true, note: 'Code of parent College (from Colleges page). Prefer over collegeId.' },
      { header: 'collegeId', required: false, note: 'Alternative: numeric DB id of parent College (ignored if collegeCode filled).' },
      { header: 'code', required: true, note: 'Short department code, max 30 chars, unique within parent College.' },
      { header: 'name', required: true, note: 'Full department name, max 150 chars.' },
      { header: 'headEmail', required: false, note: 'Valid HOD email. Optional.' },
      { header: 'isActive', required: false, note: 'TRUE/FALSE. Default TRUE if blank.' },
    ];
  } else {
    title = 'Programmes — Bulk Import Template';
    templateHeader = ['departmentCode', 'departmentId', 'collegeCode', 'code', 'name', 'durationYears', 'coordinatorEmail', 'isActive'];
    templateSamples = [['CSC', '', 'COS', 'BScCS', 'Bachelor of Computer Science', '4', 'cs-coord@university.edu.ng', 'TRUE']];
    colWidths = [16, 14, 14, 14, 44, 14, 38, 12];
    instructionRows = [
      ['#', 'Topic', 'Rule / Description', 'Example'],
      ['1', 'Prerequisites', 'Upload Colleges → then Departments → then Programmes. Each Programme needs a parent Department.', 'CSC (parent dept)'],
      ['2', 'Dept Reference', 'Provide EITHER departmentCode (preferred) OR departmentId (numeric). Code takes precedence if both filled.', 'CSC'],
      ['3', 'College Cross-check', 'collegeCode is OPTIONAL. If filled, it will be validated against the Department\'s parent College (mismatch = error).', 'COS'],
      ['4', 'Required Fields', 'Parent Dept (departmentCode or departmentId) + code + name are required.', 'CSC + BScCS + BSc Comp Sci'],
      ['5', 'Code Uniqueness', 'code must be unique WITHIN the same parent Department.', 'BScCS'],
      ['6', 'durationYears', 'Integer 1–20. Optional, default 4 if blank.', '4'],
      ['7', 'coordinatorEmail', 'Optional programme-coordinator email; valid format if provided.', 'cs-coord@university.edu.ng'],
      ['8', 'isActive', 'TRUE or FALSE (any case). Default TRUE if blank.', 'TRUE'],
    ];
    columnNotes = [
      { header: 'departmentCode', required: true, note: 'Code of parent Department (from Departments page). Prefer over departmentId.' },
      { header: 'departmentId', required: false, note: 'Alternative: numeric DB id of parent Dept (ignored if departmentCode filled).' },
      { header: 'collegeCode', required: false, note: 'Optional cross-check; if filled must match Dept\'s parent College code.' },
      { header: 'code', required: true, note: 'Short programme code, max 30 chars, unique within parent Department.' },
      { header: 'name', required: true, note: 'Full programme name, max 150 chars (e.g. Bachelor of Computer Science).' },
      { header: 'durationYears', required: false, note: 'Integer 1–20. Default 4 if blank.' },
      { header: 'coordinatorEmail', required: false, note: 'Valid programme coordinator email. Optional.' },
      { header: 'isActive', required: false, note: 'TRUE/FALSE. Default TRUE if blank.' },
    ];
  }

  const result = await buildTwoSheetWorkbook({
    title,
    instructionRows,
    templateHeader,
    templateSamples,
    colWidths,
    columnNotes,
  });

  const kindNames: Record<BulkKind, string> = {
    college: 'colleges',
    department: 'departments',
    programme: 'programmes',
  };

  return {
    ...result,
    filename: `${kindNames[kind]}-import-template.xlsx`,
  };
}

// -----------------------------------------------------------------------------
// College Importer
// -----------------------------------------------------------------------------
export async function importColleges(filePath: string, fileName: string, req: Request): Promise<BulkResult> {
  const rows = await parseCsvOrXlsx(filePath, fileName);
  const errors: BulkRowError[] = [];
  const ids: number[] = [];
  const createdItems: Array<{ id: number; code: string; name: string }> = [];
  const seenCodes = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;
    const r = rows[i];
    const rawCode = String(r.code ?? '').trim().toUpperCase();
    const rawName = String(r.name ?? '').trim();

    if (!rawCode || !rawName) {
      errors.push({
        row: rowNum,
        record: `${rawCode || '(no code)'} / ${rawName || '(no name)'}`,
        message: 'Missing required fields: code and name are both required.',
      });
      continue;
    }

    if (rawCode.length > 30) {
      errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: `code "${rawCode}" exceeds 30-character limit.` });
      continue;
    }
    if (rawName.length > 150) {
      errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: 'name exceeds 150-character limit.' });
      continue;
    }

    if (seenCodes.has(rawCode)) {
      errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: `Duplicate code "${rawCode}" within uploaded file.` });
      continue;
    }
    seenCodes.add(rawCode);

    const deanEmailRaw = String(r.deanEmail ?? '').trim();
    let deanEmail: string | undefined = undefined;
    if (deanEmailRaw) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(deanEmailRaw)) {
        errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: `deanEmail "${deanEmailRaw}" is not a valid email address.` });
        continue;
      }
      deanEmail = deanEmailRaw;
    }

    const isActive = parseIsActive(r.isActive);

    try {
      const created = await FacultyService.create({
        code: rawCode,
        name: rawName,
        deanEmail,
        isActive,
      }, req);
      ids.push(created.id);
      createdItems.push({ id: created.id, code: created.code ?? rawCode, name: created.name });
    } catch (e: any) {
      errors.push({
        row: rowNum,
        record: `${rawCode} / ${rawName}`,
        message: e?.message ?? String(e ?? 'Unknown server error during create'),
      });
    }
  }

  return {
    created: createdItems.length,
    skipped: errors.length,
    errors,
    ids,
    createdItems,
  };
}

// -----------------------------------------------------------------------------
// Department Importer
// -----------------------------------------------------------------------------
export async function importDepartments(filePath: string, fileName: string, req: Request): Promise<BulkResult> {
  const rows = await parseCsvOrXlsx(filePath, fileName);
  const errors: BulkRowError[] = [];
  const ids: number[] = [];
  const createdItems: Array<{ id: number; code: string; name: string }> = [];
  const seenWithinFile = new Set<string>();

  const uniqueCollegeCodes = new Set<string>();
  const uniqueCollegeIds = new Set<number>();
  for (const r of rows) {
    const cc = String(r.collegeCode ?? '').trim().toUpperCase();
    if (cc) uniqueCollegeCodes.add(cc);
    const cidRaw = String(r.collegeId ?? '').trim();
    const cid = cidRaw ? Number(cidRaw) : NaN;
    if (!isNaN(cid) && cid > 0) uniqueCollegeIds.add(cid);
  }

  const [facultiesByCode, facultiesById] = await Promise.all([
    uniqueCollegeCodes.size > 0
      ? prisma.faculty.findMany({ where: { code: { in: Array.from(uniqueCollegeCodes) } }, select: { id: true, code: true, name: true } })
      : Promise.resolve([]),
    uniqueCollegeIds.size > 0
      ? prisma.faculty.findMany({ where: { id: { in: Array.from(uniqueCollegeIds) } }, select: { id: true, code: true, name: true } })
      : Promise.resolve([]),
  ]);
  const codeToFaculty = new Map<string, any>();
  const idToFaculty = new Map<number, any>();
  for (const f of facultiesByCode) if (f.code) codeToFaculty.set(f.code.toUpperCase(), f);
  for (const f of facultiesById) idToFaculty.set(f.id, f);

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;
    const r = rows[i];
    const rawCode = String(r.code ?? '').trim().toUpperCase();
    const rawName = String(r.name ?? '').trim();

    if (!rawCode || !rawName) {
      errors.push({
        row: rowNum,
        record: `${rawCode || '(no code)'} / ${rawName || '(no name)'}`,
        message: 'Missing required fields: code and name are both required.',
      });
      continue;
    }

    let faculty: any = null;
    const ccRaw = String(r.collegeCode ?? '').trim().toUpperCase();
    const cidRaw = String(r.collegeId ?? '').trim();
    const cidNum = cidRaw ? Number(cidRaw) : NaN;

    if (ccRaw) {
      faculty = codeToFaculty.get(ccRaw) ?? null;
      if (!faculty) {
        errors.push({
          row: rowNum,
          record: `${rawCode} / ${rawName}`,
          message: `collegeCode "${ccRaw}" was not found in the database. Upload the Colleges CSV first, then verify this code exists on the Colleges page.`,
        });
        continue;
      }
    } else if (!isNaN(cidNum) && cidNum > 0) {
      faculty = idToFaculty.get(cidNum) ?? null;
      if (!faculty) {
        errors.push({
          row: rowNum,
          record: `${rawCode} / ${rawName}`,
          message: `collegeId "${cidRaw}" was not found in the database. Upload the Colleges CSV first.`,
        });
        continue;
      }
    } else {
      errors.push({
        row: rowNum,
        record: `${rawCode} / ${rawName}`,
        message: 'Missing parent reference: fill either collegeCode (recommended) OR collegeId column.',
      });
      continue;
    }

    if (rawCode.length > 30) {
      errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: `code "${rawCode}" exceeds 30-character limit.` });
      continue;
    }
    if (rawName.length > 150) {
      errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: 'name exceeds 150-character limit.' });
      continue;
    }

    const dupKey = `${faculty.id}::${rawCode}`;
    if (seenWithinFile.has(dupKey)) {
      errors.push({
        row: rowNum,
        record: `${rawCode} / ${rawName}`,
        message: `Duplicate code "${rawCode}" under the same college within uploaded file.`,
      });
      continue;
    }
    seenWithinFile.add(dupKey);

    const headEmailRaw = String(r.headEmail ?? '').trim();
    let headEmail: string | undefined = undefined;
    if (headEmailRaw) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(headEmailRaw)) {
        errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: `headEmail "${headEmailRaw}" is not a valid email address.` });
        continue;
      }
      headEmail = headEmailRaw;
    }

    const isActive = parseIsActive(r.isActive);

    try {
      const created = await DepartmentService.create({
        code: rawCode,
        name: rawName,
        facultyId: faculty.id,
        headEmail,
        isActive,
      }, req);
      ids.push(created.id);
      createdItems.push({ id: created.id, code: created.code ?? rawCode, name: created.name });
    } catch (e: any) {
      errors.push({
        row: rowNum,
        record: `${rawCode} / ${rawName}`,
        message: e?.message ?? String(e ?? 'Unknown server error during create'),
      });
    }
  }

  return {
    created: createdItems.length,
    skipped: errors.length,
    errors,
    ids,
    createdItems,
  };
}

// -----------------------------------------------------------------------------
// Programme Importer
// -----------------------------------------------------------------------------
export async function importProgrammes(filePath: string, fileName: string, req: Request): Promise<BulkResult> {
  const rows = await parseCsvOrXlsx(filePath, fileName);
  const errors: BulkRowError[] = [];
  const ids: number[] = [];
  const createdItems: Array<{ id: number; code: string; name: string }> = [];
  const seenWithinFile = new Set<string>();

  const uniqueDeptCodes = new Set<string>();
  const uniqueDeptIds = new Set<number>();
  const uniqueCollegeCodesForCheck = new Set<string>();

  for (const r of rows) {
    const dc = String(r.departmentCode ?? '').trim().toUpperCase();
    if (dc) uniqueDeptCodes.add(dc);
    const didRaw = String(r.departmentId ?? '').trim();
    const did = didRaw ? Number(didRaw) : NaN;
    if (!isNaN(did) && did > 0) uniqueDeptIds.add(did);
    const cc = String(r.collegeCode ?? '').trim().toUpperCase();
    if (cc) uniqueCollegeCodesForCheck.add(cc);
  }

  const [deptsByCode, deptsById, collegeLookup] = await Promise.all([
    uniqueDeptCodes.size > 0
      ? prisma.department.findMany({
          where: { code: { in: Array.from(uniqueDeptCodes) } },
          select: { id: true, code: true, name: true, facultyId: true, faculty: { select: { id: true, code: true, name: true } } },
        })
      : Promise.resolve([]),
    uniqueDeptIds.size > 0
      ? prisma.department.findMany({
          where: { id: { in: Array.from(uniqueDeptIds) } },
          select: { id: true, code: true, name: true, facultyId: true, faculty: { select: { id: true, code: true, name: true } } },
        })
      : Promise.resolve([]),
    uniqueCollegeCodesForCheck.size > 0
      ? prisma.faculty.findMany({ where: { code: { in: Array.from(uniqueCollegeCodesForCheck) } }, select: { id: true, code: true } })
      : Promise.resolve([]),
  ]);
  const codeToDept = new Map<string, any>();
  const idToDept = new Map<number, any>();
  const collegeCodeToId = new Map<string, number>();
  for (const d of deptsByCode) if (d.code) codeToDept.set(d.code.toUpperCase(), d);
  for (const d of deptsById) idToDept.set(d.id, d);
  for (const c of collegeLookup) if (c.code) collegeCodeToId.set(c.code.toUpperCase(), c.id);

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;
    const r = rows[i];
    const rawCode = String(r.code ?? '').trim().toUpperCase();
    const rawName = String(r.name ?? '').trim();

    if (!rawCode || !rawName) {
      errors.push({
        row: rowNum,
        record: `${rawCode || '(no code)'} / ${rawName || '(no name)'}`,
        message: 'Missing required fields: code and name are both required.',
      });
      continue;
    }

    let department: any = null;
    const dcRaw = String(r.departmentCode ?? '').trim().toUpperCase();
    const didRaw = String(r.departmentId ?? '').trim();
    const didNum = didRaw ? Number(didRaw) : NaN;

    if (dcRaw) {
      department = codeToDept.get(dcRaw) ?? null;
      if (!department) {
        errors.push({
          row: rowNum,
          record: `${rawCode} / ${rawName}`,
          message: `departmentCode "${dcRaw}" was not found in the database. Upload the Departments CSV first, then verify this code exists on the Departments page.`,
        });
        continue;
      }
    } else if (!isNaN(didNum) && didNum > 0) {
      department = idToDept.get(didNum) ?? null;
      if (!department) {
        errors.push({
          row: rowNum,
          record: `${rawCode} / ${rawName}`,
          message: `departmentId "${didRaw}" was not found in the database. Upload the Departments CSV first.`,
        });
        continue;
      }
    } else {
      errors.push({
        row: rowNum,
        record: `${rawCode} / ${rawName}`,
        message: 'Missing parent reference: fill either departmentCode (recommended) OR departmentId column.',
      });
      continue;
    }

    const ccCrossCheck = String(r.collegeCode ?? '').trim().toUpperCase();
    if (ccCrossCheck) {
      const deptFacultyCode = department.faculty?.code?.toUpperCase() ?? '';
      if (deptFacultyCode && deptFacultyCode !== ccCrossCheck) {
        errors.push({
          row: rowNum,
          record: `${rawCode} / ${rawName}`,
          message: `Cross-check mismatch: departmentCode "${department.code}" belongs to collegeCode "${deptFacultyCode}", not "${ccCrossCheck}" as provided.`,
        });
        continue;
      }
    }

    if (rawCode.length > 30) {
      errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: `code "${rawCode}" exceeds 30-character limit.` });
      continue;
    }
    if (rawName.length > 150) {
      errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: 'name exceeds 150-character limit.' });
      continue;
    }

    const dupKey = `${department.id}::${rawCode}`;
    if (seenWithinFile.has(dupKey)) {
      errors.push({
        row: rowNum,
        record: `${rawCode} / ${rawName}`,
        message: `Duplicate code "${rawCode}" under the same department within uploaded file.`,
      });
      continue;
    }
    seenWithinFile.add(dupKey);

    let durationYears: number | undefined = undefined;
    const durRaw = String(r.durationYears ?? '').trim();
    if (durRaw) {
      const n = Number(durRaw);
      if (isNaN(n) || !Number.isInteger(n) || n <= 0 || n > 20) {
        errors.push({
          row: rowNum,
          record: `${rawCode} / ${rawName}`,
          message: `durationYears "${durRaw}" is invalid. Use an integer between 1 and 20.`,
        });
        continue;
      }
      durationYears = n;
    }

    const coordEmailRaw = String(r.coordinatorEmail ?? '').trim();
    let coordinatorEmail: string | undefined = undefined;
    if (coordEmailRaw) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(coordEmailRaw)) {
        errors.push({ row: rowNum, record: `${rawCode} / ${rawName}`, message: `coordinatorEmail "${coordEmailRaw}" is not a valid email address.` });
        continue;
      }
      coordinatorEmail = coordEmailRaw;
    }

    const isActive = parseIsActive(r.isActive);

    try {
      const created = await ProgrammeService.create({
        code: rawCode,
        name: rawName,
        departmentId: department.id,
        durationYears,
        coordinatorEmail,
        isActive,
      }, req);
      ids.push(created.id);
      createdItems.push({ id: created.id, code: created.code ?? rawCode, name: created.name });
    } catch (e: any) {
      errors.push({
        row: rowNum,
        record: `${rawCode} / ${rawName}`,
        message: e?.message ?? String(e ?? 'Unknown server error during create'),
      });
    }
  }

  return {
    created: createdItems.length,
    skipped: errors.length,
    errors,
    ids,
    createdItems,
  };
}

export function buildErrorsCsv(errors: BulkRowError[], kind: BulkKind): string {
  let content = UTF8_BOM;
  content += csvLineSafe(['#', `${kind} Code / Name`, 'Error Message']);
  for (const e of errors) {
    content += csvLineSafe([String(e.row), e.record, e.message]);
  }
  return content;
}
