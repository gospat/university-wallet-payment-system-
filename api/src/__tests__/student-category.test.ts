// =============================================================================
// DYNAMIC STUDENT CATEGORIES — regression tests (Task J, Phase 1).
//
// Proves the bulk-import category requirement is met:
//   • S1–S3  pure: enum mirroring, key normalisation, index resolution
//   • S4     pure: category input schema (auto-derived / slugified code)
//   • C1     the canonical categories are seeded (UNDERGRADUATE … TOP_UP, OTHER)
//   • C2–C3  admins can ADD categories (not hard-coded); duplicates rejected
//   • C4     a category with NO students can be hard-deleted
//   • C5     a category WITH students CANNOT be hard-deleted (409 + count)
//   • C6     deactivate is ALWAYS allowed and existing students keep the category
//   • C7     the code (legacy enum mirror key) is frozen once students reference it
//   • I1–I3  bulk import: unknown/deactivated category => row error (never a
//            silent OTHER); a valid category is stamped as studentCategoryId;
//            the legacy `studentType` column resolves to the same category
//   • M1–M3  student create mirrors the dynamic category into the legacy enum
//
// Pure-function tests always run. DB-backed tests execute against the
// development/test DB and are reported as SKIPPED (never silently passed) when
// no database is reachable.
// =============================================================================

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import prisma from '../config/database';
import { Role } from '@prisma/client';
import {
  StudentCategoryService,
  CreateStudentCategorySchema,
  mirrorStudentTypeForCategory,
  normalizeCategoryKey,
  resolveFromIndex,
  type CategoryLookup,
} from '../services/studentCategory';
import { StudentService } from '../services/student';
import { BulkStudentUploadService } from '../services/studentImport';
import { AppError } from '../utils/AppError';

// ---------------------------------------------------------------------------
// DB availability probe — resolved SYNCHRONOUSLY at collection time so the
// DB-backed specs can be registered with `it.skip` when no database is
// reachable (a body-level early return would be recorded as PASSED by Jest).
// ---------------------------------------------------------------------------
function probeDbSync(): boolean {
  if (!process.env.DATABASE_URL) return false;
  const script =
    "const {PrismaClient}=require('@prisma/client');" +
    "const p=new PrismaClient();" +
    "p.$queryRawUnsafe('SELECT 1').then(()=>p.$disconnect())" +
    ".then(()=>process.exit(0)).catch(()=>process.exit(1));";
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: 'ignore', env: process.env, timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}
const DB_AVAILABLE = probeDbSync();
const dbIt: jest.It = DB_AVAILABLE ? it : it.skip;

const RUN = Date.now();

// ===========================================================================
// S — pure helpers
// ===========================================================================
describe('Student categories — pure helpers', () => {
  it('S1. mirrorStudentTypeForCategory maps known codes and falls back to OTHER', () => {
    expect(mirrorStudentTypeForCategory('UNDERGRADUATE')).toBe('UNDERGRADUATE');
    expect(mirrorStudentTypeForCategory('Postgraduate')).toBe('POSTGRADUATE');
    expect(mirrorStudentTypeForCategory('top_up')).toBe('TOP_UP');
    expect(mirrorStudentTypeForCategory('part-time')).toBe('OTHER'); // not an enum member
    expect(mirrorStudentTypeForCategory('PART_TIME')).toBe('PART_TIME');
    expect(mirrorStudentTypeForCategory('JUPEB')).toBe('JUPEB');
    expect(mirrorStudentTypeForCategory('A brand new category')).toBe('OTHER');
    expect(mirrorStudentTypeForCategory(null)).toBe('OTHER');
    expect(mirrorStudentTypeForCategory(undefined)).toBe('OTHER');
  });

  it('S2. normalizeCategoryKey is case / space / punctuation insensitive', () => {
    expect(normalizeCategoryKey('Top-Up')).toBe('TOPUP');
    expect(normalizeCategoryKey(' top up ')).toBe('TOPUP');
    expect(normalizeCategoryKey('TOP_UP')).toBe('TOPUP');
    expect(normalizeCategoryKey('part_time')).toBe('PARTTIME');
    expect(normalizeCategoryKey('Part-Time')).toBe('PARTTIME');
    expect(normalizeCategoryKey('Postgraduate')).toBe('POSTGRADUATE');
    expect(normalizeCategoryKey('')).toBe('');
  });

  it('S3. resolveFromIndex resolves by code, by display name and by id', () => {
    const rows: CategoryLookup[] = [
      { id: 1, code: 'UNDERGRADUATE', name: 'Undergraduate', isActive: true },
      { id: 3, code: 'TOP_UP', name: 'Top-Up', isActive: true },
      { id: 4, code: 'PART_TIME', name: 'Part-Time', isActive: true },
    ];
    const index = new Map<string, CategoryLookup>();
    for (const r of rows) {
      index.set(normalizeCategoryKey(r.code), r);
      index.set(normalizeCategoryKey(r.name), r);
      index.set(String(r.id), r);
    }

    expect(resolveFromIndex(index, 'undergraduate')?.code).toBe('UNDERGRADUATE');
    expect(resolveFromIndex(index, 'UNDERGRADUATE')?.code).toBe('UNDERGRADUATE');
    expect(resolveFromIndex(index, 'Top Up')?.code).toBe('TOP_UP');
    expect(resolveFromIndex(index, 'TOP-UP')?.code).toBe('TOP_UP');
    expect(resolveFromIndex(index, 'part time')?.code).toBe('PART_TIME');
    expect(resolveFromIndex(index, 3)?.code).toBe('TOP_UP');
    // Unknown / empty values resolve to null (the caller turns that into an error).
    expect(resolveFromIndex(index, 'Diploma')).toBeNull();
    expect(resolveFromIndex(index, '')).toBeNull();
    expect(resolveFromIndex(index, null)).toBeNull();
  });

  it('S4. CreateStudentCategorySchema requires a name and slugifies an optional code', () => {
    const ok = CreateStudentCategorySchema.parse({ name: 'Cyber Security', code: 'cyber security!' });
    expect(ok.name).toBe('Cyber Security');
    expect(ok.code).toBe('CYBER_SECURITY');

    const nameOnly = CreateStudentCategorySchema.parse({ name: 'Diploma' });
    expect(nameOnly.code).toBeUndefined(); // derived from the name at create time
    expect(nameOnly.isActive).toBeUndefined();

    expect(() => CreateStudentCategorySchema.parse({ name: 'A' })).toThrow();
    expect(() => CreateStudentCategorySchema.parse({})).toThrow();
  });
});

// ===========================================================================
// C — category CRUD + the delete guard (DB-backed)
// ===========================================================================
describe('Student categories — admin-managed CRUD (DB)', () => {
  let adminId: number;
  let categoryIds: number[] = [];
  let extraStudentIds: number[] = [];

  const asAdmin = () => ({ user: { id: adminId } } as any);

  beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    const admin = await prisma.user.create({
      data: {
        email: `cat-admin-${RUN}@university.edu.ng`,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Category',
        lastName: 'Admin',
        role: Role.ADMIN,
      },
      select: { id: true },
    });
    adminId = admin.id;
  });

  afterEach(async () => {
    if (!DB_AVAILABLE) return;
    // Students first — users.studentCategoryId is ON DELETE RESTRICT.
    const students = await prisma.user.findMany({
      where: { email: { startsWith: `cat-stu-${RUN}` } },
      select: { id: true },
    });
    if (students.length) await prisma.user.deleteMany({ where: { id: { in: students.map((s) => s.id) } } });
    if (extraStudentIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: extraStudentIds } } });
      extraStudentIds = [];
    }
    if (categoryIds.length) {
      await prisma.studentCategory.deleteMany({ where: { id: { in: categoryIds } } });
      categoryIds = [];
    }
  });

  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.user.deleteMany({ where: { email: `cat-admin-${RUN}@university.edu.ng` } });
  });

  dbIt('C1. the canonical categories are seeded (Undergraduate … Top-Up, Other)', async () => {
    const rows = await prisma.studentCategory.findMany({
      where: { code: { in: ['UNDERGRADUATE', 'POSTGRADUATE', 'TOP_UP', 'PART_TIME', 'JUPEB', 'OTHER'] } },
      select: { code: true, isActive: true },
    });
    const codes = rows.map((r) => r.code);
    for (const expected of ['UNDERGRADUATE', 'POSTGRADUATE', 'TOP_UP', 'PART_TIME', 'JUPEB', 'OTHER']) {
      expect(codes).toContain(expected);
    }
    expect(rows.every((r) => r.isActive)).toBe(true);
  });

  dbIt('C2. an admin can ADD a new category (categories are not hard-coded)', async () => {
    const created = await StudentCategoryService.create(
      { name: `Diploma ${RUN}`, code: `DIPLOMA_${RUN}`, description: 'Diploma programme students' },
      asAdmin(),
    );
    categoryIds.push(created.id);
    expect(created.code).toBe(`DIPLOMA_${RUN}`);
    expect(created.isActive).toBe(true);

    const listed = await StudentCategoryService.list({ search: `Diploma ${RUN}` });
    expect(listed.rows.map((r: any) => r.id)).toContain(created.id);
  });

  dbIt('C3. a duplicate name is rejected with 400', async () => {
    const first = await StudentCategoryService.create({ name: `Duplicate ${RUN}`, code: `DUP_${RUN}` }, asAdmin());
    categoryIds.push(first.id);

    await expect(
      StudentCategoryService.create({ name: `Duplicate ${RUN}`, code: `DUP2_${RUN}` }, asAdmin()),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  dbIt('C4. a category with NO students can be hard-deleted', async () => {
    const created = await StudentCategoryService.create({ name: `Temp ${RUN}`, code: `TEMP_${RUN}` }, asAdmin());
    const res = await StudentCategoryService.remove(created.id, asAdmin());
    expect(res.deleted.id).toBe(created.id);
    await expect(StudentCategoryService.get(created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  dbIt('C5. a category WITH students CANNOT be hard-deleted (409 + reference count)', async () => {
    const created = await StudentCategoryService.create({ name: `Referenced ${RUN}`, code: `REF_${RUN}` }, asAdmin());
    categoryIds.push(created.id);

    const student = await prisma.user.create({
      data: {
        email: `cat-stu-${RUN}-1@university.edu.ng`,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Ref',
        lastName: 'Student',
        role: Role.STUDENT,
        matricNumber: `REF-${RUN}-1`,
        studentCategoryId: created.id,
      },
      select: { id: true },
    });
    extraStudentIds.push(student.id);

    // Service-level guard: 409 + the exact count in the message.
    let caught: AppError | null = null;
    try {
      await StudentCategoryService.remove(created.id, asAdmin());
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.statusCode).toBe(409);
    expect(caught!.message).toContain('1 student(s)');
    expect(caught!.message.toLowerCase()).toContain('deactivate');

    // Still there, and the student still points at it.
    const still = await prisma.studentCategory.findUnique({ where: { id: created.id } });
    expect(still).not.toBeNull();
    const linked = await prisma.user.findUnique({ where: { id: student.id }, select: { studentCategoryId: true } });
    expect(linked!.studentCategoryId).toBe(created.id);
  });

  dbIt('C6. deactivate is ALWAYS allowed and existing students keep the category', async () => {
    const created = await StudentCategoryService.create({ name: `Retire ${RUN}`, code: `RETIRE_${RUN}` }, asAdmin());
    categoryIds.push(created.id);

    const student = await prisma.user.create({
      data: {
        email: `cat-stu-${RUN}-2@university.edu.ng`,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Retire',
        lastName: 'Student',
        role: Role.STUDENT,
        matricNumber: `REF-${RUN}-2`,
        studentCategoryId: created.id,
      },
      select: { id: true },
    });
    extraStudentIds.push(student.id);

    const out = await StudentCategoryService.deactivate(created.id, asAdmin());
    expect(out.isActive).toBe(false);

    const linked = await prisma.user.findUnique({ where: { id: student.id }, select: { studentCategoryId: true } });
    expect(linked!.studentCategoryId).toBe(created.id);
  });

  dbIt('C7. the code (legacy enum mirror key) is frozen once students reference the category', async () => {
    const created = await StudentCategoryService.create({ name: `Frozen ${RUN}`, code: `FROZEN_${RUN}` }, asAdmin());
    categoryIds.push(created.id);

    const student = await prisma.user.create({
      data: {
        email: `cat-stu-${RUN}-3@university.edu.ng`,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Frozen',
        lastName: 'Student',
        role: Role.STUDENT,
        matricNumber: `REF-${RUN}-3`,
        studentCategoryId: created.id,
      },
      select: { id: true },
    });
    extraStudentIds.push(student.id);

    // A rename is fine …
    const renamed = await StudentCategoryService.update(created.id, { name: `Frozen Renamed ${RUN}` }, asAdmin());
    expect(renamed.name).toBe(`Frozen Renamed ${RUN}`);

    // … but changing the code would desync the mirror, so it is refused.
    await expect(
      StudentCategoryService.update(created.id, { code: `SOMETHING_ELSE_${RUN}` }, asAdmin()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ===========================================================================
// I — bulk import category handling (DB-backed)
// ===========================================================================
describe('Bulk import — categories are caught, never silently OTHER (DB)', () => {
  const tmpFiles: string[] = [];
  let adminId: number;
  let newCategoryId: number | null = null;

  function writeCsv(content: string): string {
    const p = path.join(os.tmpdir(), `cat-import-${RUN}-${tmpFiles.length}.csv`);
    fs.writeFileSync(p, content, 'utf-8');
    tmpFiles.push(p);
    return p;
  }

  beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    const admin = await prisma.user.create({
      data: {
        email: `cat-imp-admin-${RUN}@university.edu.ng`,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Import',
        lastName: 'Admin',
        role: Role.ADMIN,
      },
      select: { id: true },
    });
    adminId = admin.id;

    const cat = await StudentCategoryService.create(
      { name: `Import Test ${RUN}`, code: `IMP_${RUN}` },
      { user: { id: adminId } } as any,
    );
    newCategoryId = cat.id;
  });

  afterAll(async () => {
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    if (!DB_AVAILABLE) return;
    await prisma.user.deleteMany({ where: { email: `cat-imp-admin-${RUN}@university.edu.ng` } });
    if (newCategoryId) {
      await prisma.user.updateMany({ where: { studentCategoryId: newCategoryId }, data: { studentCategoryId: null } });
      await prisma.studentCategory.deleteMany({ where: { id: newCategoryId } });
    }
  });

  dbIt('I1. unknown category => INVALID_STUDENT_CATEGORY row; valid ones are stamped with studentCategoryId', async () => {
    const file = writeCsv(
      [
        'firstName,lastName,matricNumber,email,phoneNumber,studentCategory',
        `Ada,Okoro,CI-${RUN}-1001,ada.ci${RUN}1001@university.edu.ng,08030000001,Undergraduate`,
        `Bola,Eze,CI-${RUN}-1002,bola.ci${RUN}1002@university.edu.ng,08030000002,Top-Up`,
        `Chidi,Nwa,CI-${RUN}-1003,chidi.ci${RUN}1003@university.edu.ng,08030000003,Diploma in Nothing`,
        '',
      ].join('\n'),
    );

    const { summary, preview } = await BulkStudentUploadService.stageUpload({
      filePath: file, fileName: 'cats.csv', actorId: adminId,
    });

    expect(summary.totalRecords).toBe(3);
    expect(summary.validRecords).toBe(2);
    expect(summary.invalidRecords).toBe(1);

    const bad = preview.problemSample[0];
    expect(bad.record.matricNumber).toBe(`CI-${RUN}-1003`);
    expect(bad.errors.map((e) => e.code)).toContain('INVALID_STUDENT_CATEGORY');

    const ug = await prisma.studentCategory.findUnique({ where: { code: 'UNDERGRADUATE' }, select: { id: true } });
    const tu = await prisma.studentCategory.findUnique({ where: { code: 'TOP_UP' }, select: { id: true } });
    const byMatric = new Map(preview.validSample.map((v) => [v.record.matricNumber, v.record]));
    expect(byMatric.get(`CI-${RUN}-1001`)!.studentCategoryId).toBe(ug!.id);
    expect(byMatric.get(`CI-${RUN}-1002`)!.studentCategoryId).toBe(tu!.id);
  });

  dbIt('I2. the legacy studentType column resolves to the same dynamic category', async () => {
    const file = writeCsv(
      [
        'firstName,lastName,matricNumber,email,phoneNumber,studentType',
        `Dara,Imo,CI-${RUN}-1004,dara.ci${RUN}1004@university.edu.ng,08030000004,Postgraduate`,
        '',
      ].join('\n'),
    );

    const { summary, preview } = await BulkStudentUploadService.stageUpload({
      filePath: file, fileName: 'legacy.csv', actorId: adminId,
    });
    expect(summary.validRecords).toBe(1);

    const pg = await prisma.studentCategory.findUnique({ where: { code: 'POSTGRADUATE' }, select: { id: true } });
    expect(preview.validSample[0].record.studentCategoryId).toBe(pg!.id);
  });

  dbIt('I3. a DEACTIVATED category cannot be used for new uploads', async () => {
    await StudentCategoryService.deactivate(newCategoryId!, { user: { id: adminId } } as any);

    const file = writeCsv(
      [
        'firstName,lastName,matricNumber,email,phoneNumber,studentCategory',
        `Efe,Udo,CI-${RUN}-1005,efe.ci${RUN}1005@university.edu.ng,08030000005,Import Test ${RUN}`,
        '',
      ].join('\n'),
    );

    const { summary, preview } = await BulkStudentUploadService.stageUpload({
      filePath: file, fileName: 'deactivated.csv', actorId: adminId,
    });
    expect(summary.validRecords).toBe(0);
    expect(summary.invalidRecords).toBe(1);
    expect(preview.problemSample[0].errors.map((e) => e.code)).toContain('INVALID_STUDENT_CATEGORY');
    expect(preview.problemSample[0].errors[0].message.toLowerCase()).toContain('deactivated');
  });
});

// ===========================================================================
// M — create mirrors the category into the legacy enum (DB-backed)
// ===========================================================================
describe('Student create — dynamic category drives the legacy enum mirror (DB)', () => {
  let adminId: number;

  beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    const admin = await prisma.user.create({
      data: {
        email: `cat-mirror-admin-${RUN}@university.edu.ng`,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Mirror',
        lastName: 'Admin',
        role: Role.ADMIN,
      },
      select: { id: true },
    });
    adminId = admin.id;
  });

  afterEach(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.user.deleteMany({ where: { email: { startsWith: `cat-mirror-${RUN}` } } });
  });

  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.user.deleteMany({ where: { email: `cat-mirror-admin-${RUN}@university.edu.ng` } });
  });

  dbIt('M1. studentCategoryId sets the FK and mirrors TOP_UP into studentType', async () => {
    const topUp = await prisma.studentCategory.findUnique({ where: { code: 'TOP_UP' }, select: { id: true } });
    const created: any = await StudentService.create(
      {
        email: `cat-mirror-${RUN}-1@university.edu.ng`,
        firstName: 'Top',
        lastName: 'Upper',
        matricNumber: `MIR-${RUN}-1`,
        studentCategoryId: topUp!.id,
      } as any,
      adminId,
      { sendCredentialEmail: false },
    );
    expect(created.studentCategoryId).toBe(topUp!.id);
    expect(created.studentType).toBe('TOP_UP');
    expect(created.studentCategory?.code).toBe('TOP_UP');
  });

  dbIt('M2. a raw category NAME (as typed in a spreadsheet) resolves the same way', async () => {
    const created: any = await StudentService.create(
      {
        email: `cat-mirror-${RUN}-2@university.edu.ng`,
        firstName: 'Post',
        lastName: 'Grad',
        matricNumber: `MIR-${RUN}-2`,
        studentCategory: 'Postgraduate',
      } as any,
      adminId,
      { sendCredentialEmail: false },
    );
    expect(created.studentType).toBe('POSTGRADUATE');
    expect(created.studentCategory?.code).toBe('POSTGRADUATE');
  });

  dbIt('M3. an unknown category is REJECTED (400) instead of being silently stored as OTHER', async () => {
    await expect(
      StudentService.create(
        {
          email: `cat-mirror-${RUN}-3@university.edu.ng`,
          firstName: 'Bad',
          lastName: 'Category',
          matricNumber: `MIR-${RUN}-3`,
          studentCategory: 'Nonexistent Category Xyz',
        } as any,
        adminId,
        { sendCredentialEmail: false },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Nothing was written.
    const count = await prisma.user.count({ where: { email: `cat-mirror-${RUN}-3@university.edu.ng` } });
    expect(count).toBe(0);
  });
});
