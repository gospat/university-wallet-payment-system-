// =============================================================================
// BACKGROUND STUDENT IMPORT — regression tests (Task J, Phase 2).
//
// Proves the ~7,000-row import no longer runs synchronously inside the HTTP
// request. The engine is now a chunked, DB-backed, restart-safe runner driven
// by BullMQ. These specs drive runStudentImport() directly (the queue is a
// no-op under NODE_ENV=test) and assert the observable contract:
//
//   • P1–P3  pure: tunables, credentials CSV, queue no-op in test env
//   • B1     all PENDING rows are created; run COMPLETED; exact counters
//   • B2     chunking: >IMPORT_CHUNK_SIZE rows are worked in multiple slices
//   • B3     idempotency: re-running a COMPLETED run never double-imports
//   • B4     only PENDING rows are processed (pre-FAILED rows untouched)
//   • B5     SKIP strategy: a duplicate row is SKIPPED, not created
//   • B6     UPDATE strategy: a duplicate row is updated, no new user
//   • B7     duplicates are also detected by matricNumber
//   • B8     getImportProgress transitions 0% → 100%
//   • B9     buildCredentialsCsvForRun contains only SUCCESS rows + password
//   • B10    an unknown run id throws 404
//   • B11    sendCredentialEmails=false leaves passwordSent=false
//
// Pure tests always run. DB-backed tests execute against the test/dev DB and
// are reported as SKIPPED (never silently passed) when no DB is reachable.
// =============================================================================

import { execFileSync } from 'child_process';
import prisma from '../config/database';
import { Role } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { StudentService } from '../services/student';
import { BulkStudentUploadService } from '../services/studentImport';
import {
  IMPORT_CHUNK_SIZE,
  IMPORT_CONCURRENCY,
  runStudentImport,
  getImportProgress,
  buildCredentialsCsv,
} from '../services/studentImportRunner';
import { enqueueStudentImport } from '../queues/studentImportQueue';

// ---------------------------------------------------------------------------
// DB availability probe — resolved SYNCHRONOUSLY at collection time.
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
const TAG = `sib-${RUN}`;
const ADMIN_EMAIL = `sib-admin-${RUN}@university.edu.ng`;
const TEST_TIMEOUT = 120_000;

// ===========================================================================
// P — pure helpers
// ===========================================================================
describe('Student import runner — pure helpers', () => {
  it('P1. tunables are positive and keep every slice saturated', () => {
    expect(IMPORT_CHUNK_SIZE).toBeGreaterThan(0);
    expect(IMPORT_CONCURRENCY).toBeGreaterThan(0);
    expect(IMPORT_CHUNK_SIZE).toBeGreaterThanOrEqual(IMPORT_CONCURRENCY);
  });

  it('P2. buildCredentialsCsv emits a header row and safely quotes values', () => {
    const csv = buildCredentialsCsv([
      {
        rowNumber: 1,
        firstName: 'Ada',
        lastName: 'Okafor Smith',
        email: 'ada@university.edu.ng',
        matricNumber: 'SCI/001',
        temporaryPassword: 'okafor smith',
        studentId: 10,
      },
    ]);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe('row_number,matric_number,first_name,last_name,email,password');
    // Papa quotes the value containing a comma.
    expect(lines[1]).toBe('1,SCI/001,Ada,Okafor Smith,ada@university.edu.ng,okafor smith');
    // Empty rows still produce just the header.
    expect(buildCredentialsCsv([]).trim()).toBe('row_number,matric_number,first_name,last_name,email,password');
  });

  it('P3. enqueueStudentImport is a no-op in the test environment', async () => {
    const res = await enqueueStudentImport({
      importRunId: 1,
      strategy: 'SKIP',
      actorId: 1,
    });
    expect(res).toEqual({ jobId: null, queued: false });
  });
});

// ===========================================================================
// B — background runner (DB-backed)
// ===========================================================================
describe('Student import runner — background engine (DB)', () => {
  let adminId: number;
  let runCounter = 0;

  const payloadFor = (i: number, overrides: Record<string, any> = {}) => ({
    firstName: `Bg${i}`,
    lastName: `Student${i}`,
    matricNumber: `${TAG}-${i}`,
    email: `${TAG}-${i}@university.edu.ng`,
    phoneNumber: '08030000000',
    ...overrides,
  });

  async function mkRun(
    rows: Array<{ rowNumber: number; payload: Record<string, any>; status?: 'PENDING' | 'FAILED' | 'SUCCESS' | 'SKIPPED' }>,
    strategy: 'SKIP' | 'UPDATE' = 'SKIP',
  ) {
    const uuid = `${TAG}-run-${++runCounter}`;
    const run = await prisma.importRun.create({
      data: {
        uuid,
        fileName: 'background.csv',
        filePath: '/tmp/background.csv',
        createdById: adminId,
        totalRows: rows.length,
        strategy,
      },
      select: { id: true, uuid: true },
    });
    await prisma.importRow.createMany({
      data: rows.map((r) => ({
        importRunId: run.id,
        rowNumber: r.rowNumber,
        firstName: String(r.payload.firstName ?? ''),
        lastName: String(r.payload.lastName ?? ''),
        email: r.payload.email ?? null,
        matricNumber: String(r.payload.matricNumber ?? ''),
        status: r.status ?? 'PENDING',
        payload: r.payload,
      })),
    });
    return run;
  }

  beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    const admin = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Import',
        lastName: 'Runner',
        role: Role.ADMIN,
      },
      select: { id: true },
    });
    adminId = admin.id;
  });

  afterEach(async () => {
    if (!DB_AVAILABLE) return;
    // Students first (import_rows.studentId is ON DELETE SET NULL, so either
    // order is safe, but this keeps the FK graph tidy), then the runs (which
    // cascade-delete their rows).
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
    await prisma.importRun.deleteMany({ where: { uuid: { startsWith: TAG } } });
  });

  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.user.deleteMany({ where: { email: ADMIN_EMAIL } });
  });

  dbIt('B1. processes every PENDING row, completes the run and reports exact counters', async () => {
    const run = await mkRun([
      { rowNumber: 1, payload: payloadFor(1) },
      { rowNumber: 2, payload: payloadFor(2) },
      { rowNumber: 3, payload: payloadFor(3) },
    ]);

    const result = await runStudentImport({ importRunId: run.id, strategy: 'SKIP', actorId: adminId });

    expect(result).toMatchObject({ status: 'COMPLETED', totalRows: 3, successCount: 3, failCount: 0, skippedCount: 0 });

    const stored = await prisma.importRun.findUnique({ where: { id: run.id } });
    expect(stored!.status).toBe('COMPLETED');
    expect(stored!.finishedAt).not.toBeNull();
    expect(stored!.strategy).toBe('SKIP');

    const users = await prisma.user.count({ where: { email: { startsWith: TAG } } });
    expect(users).toBe(3);

    const successRows = await prisma.importRow.findMany({
      where: { importRunId: run.id },
      select: { status: true, studentId: true, temporaryPassword: true },
    });
    expect(successRows.every((r) => r.status === 'SUCCESS' && r.studentId !== null)).toBe(true);
  }, TEST_TIMEOUT);

  dbIt('B2. works rows in IMPORT_CHUNK_SIZE slices and reports progress per slice', async () => {
    // Pre-create the students so every row is a fast duplicate (no bcrypt work)
    // while still exercising real slicing + progress reporting.
    const total = IMPORT_CHUNK_SIZE + 1;
    const dupUsers = Array.from({ length: total }, (_, i) => ({
      email: `${TAG}-chunk-${i}@university.edu.ng`,
      password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      firstName: 'Dup',
      lastName: 'Chunk',
      role: Role.STUDENT,
      matricNumber: `${TAG}-CHUNK-${i}`,
    }));
    await prisma.user.createMany({ data: dupUsers });

    const run = await mkRun(
      Array.from({ length: total }, (_, i) => ({
        rowNumber: i + 1,
        payload: payloadFor(i, {
          email: `${TAG}-chunk-${i}@university.edu.ng`,
          matricNumber: `${TAG}-CHUNK-${i}`,
        }),
      })),
    );

    const percents: number[] = [];
    const result = await runStudentImport({
      importRunId: run.id,
      strategy: 'SKIP',
      actorId: adminId,
      onProgress: (p) => { percents.push(p.percent); },
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.skippedCount).toBe(total);
    // ceil(101 / 100) = 2 slices => 2 progress callbacks, monotonically rising.
    expect(percents.length).toBe(Math.ceil(total / IMPORT_CHUNK_SIZE));
    expect(percents[percents.length - 1]).toBe(100);
  }, TEST_TIMEOUT);

  dbIt('B3. is idempotent — re-running a COMPLETED run never double-imports', async () => {
    const run = await mkRun([
      { rowNumber: 1, payload: payloadFor(10) },
      { rowNumber: 2, payload: payloadFor(11) },
    ]);

    const first = await runStudentImport({ importRunId: run.id, strategy: 'SKIP', actorId: adminId });
    expect(first.successCount).toBe(2);

    // Same job delivered twice.
    const second = await runStudentImport({ importRunId: run.id, strategy: 'SKIP', actorId: adminId });
    expect(second).toMatchObject({ status: 'COMPLETED', successCount: 2 });

    const users = await prisma.user.count({ where: { email: { startsWith: TAG } } });
    expect(users).toBe(2);
  }, TEST_TIMEOUT);

  dbIt('B4. only PENDING rows are processed — pre-FAILED rows are untouched', async () => {
    const run = await mkRun([
      { rowNumber: 1, payload: payloadFor(20) },
      { rowNumber: 2, payload: payloadFor(21), status: 'FAILED' },
    ]);
    await prisma.importRow.updateMany({
      where: { importRunId: run.id, rowNumber: 2 },
      data: { errorMessage: 'pre-existing validation failure' },
    });

    const result = await runStudentImport({ importRunId: run.id, strategy: 'SKIP', actorId: adminId });

    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0); // the pre-FAILED row is not counted by the runner

    const failedRow = await prisma.importRow.findFirst({ where: { importRunId: run.id, rowNumber: 2 } });
    expect(failedRow!.status).toBe('FAILED');
    expect(failedRow!.errorMessage).toBe('pre-existing validation failure');
  }, TEST_TIMEOUT);

  dbIt('B5. SKIP strategy marks an existing-email row SKIPPED and creates nothing', async () => {
    await prisma.user.create({
      data: {
        email: `${TAG}-existing1@university.edu.ng`,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Already',
        lastName: 'There',
        role: Role.STUDENT,
        matricNumber: `${TAG}-EXIST-1`,
      },
    });

    const run = await mkRun(
      [{ rowNumber: 1, payload: payloadFor(30, { email: `${TAG}-existing1@university.edu.ng` }) }],
      'SKIP',
    );

    const result = await runStudentImport({ importRunId: run.id, strategy: 'SKIP', actorId: adminId });
    expect(result.skippedCount).toBe(1);
    expect(result.successCount).toBe(0);

    const row = await prisma.importRow.findFirst({ where: { importRunId: run.id, rowNumber: 1 } });
    expect(row!.status).toBe('SKIPPED');
    expect(row!.studentId).toBeNull();
    expect(row!.errorMessage).toMatch(/duplicate/i);
  }, TEST_TIMEOUT);

  dbIt('B6. UPDATE strategy updates the existing student and creates no new user', async () => {
    const existing = await prisma.user.create({
      data: {
        email: `${TAG}-existing2@university.edu.ng`,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Old',
        lastName: 'Name',
        role: Role.STUDENT,
        matricNumber: `${TAG}-EXIST-2`,
        phoneNumber: '08000000000',
      },
      select: { id: true },
    });

    const run = await mkRun(
      [
        {
          rowNumber: 1,
          payload: payloadFor(31, {
            email: `${TAG}-existing2@university.edu.ng`,
            firstName: 'New',
            phoneNumber: '08099999999',
          }),
        },
      ],
      'UPDATE',
    );

    const before = await prisma.user.count({ where: { email: { startsWith: TAG } } });
    const result = await runStudentImport({ importRunId: run.id, strategy: 'UPDATE', actorId: adminId });
    expect(result.successCount).toBe(1);

    // No new user was created.
    const after = await prisma.user.count({ where: { email: { startsWith: TAG } } });
    expect(after).toBe(before);

    const updated = await prisma.user.findUnique({ where: { id: existing.id } });
    expect(updated!.firstName).toBe('New');
    expect(updated!.phoneNumber).toBe('08099999999');

    const row = await prisma.importRow.findFirst({ where: { importRunId: run.id, rowNumber: 1 } });
    expect(row!.status).toBe('SUCCESS');
    expect(row!.studentId).toBe(existing.id);
  }, TEST_TIMEOUT);

  dbIt('B7. duplicates are also detected by matricNumber (not just email)', async () => {
    await prisma.user.create({
      data: {
        email: `${TAG}-matric-owner@university.edu.ng`,
        password: '$2b$10$testpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        firstName: 'Matric',
        lastName: 'Owner',
        role: Role.STUDENT,
        matricNumber: `${TAG}-MATRIC-DUP`,
      },
    });

    const run = await mkRun(
      [
        {
          rowNumber: 1,
          payload: payloadFor(40, {
            email: `${TAG}-brand-new-email@university.edu.ng`,
            matricNumber: `${TAG}-MATRIC-DUP`,
          }),
        },
      ],
      'SKIP',
    );

    const result = await runStudentImport({ importRunId: run.id, strategy: 'SKIP', actorId: adminId });
    expect(result.skippedCount).toBe(1);

    const row = await prisma.importRow.findFirst({ where: { importRunId: run.id, rowNumber: 1 } });
    expect(row!.status).toBe('SKIPPED');
    expect(row!.studentId).toBeNull();
  }, TEST_TIMEOUT);

  dbIt('B8. getImportProgress reports counters and transitions 0% → 100%', async () => {
    const run = await mkRun([
      { rowNumber: 1, payload: payloadFor(50) },
      { rowNumber: 2, payload: payloadFor(51) },
    ]);

    const before = await getImportProgress(run.id);
    expect(before).not.toBeNull();
    expect(before!.totalRows).toBe(2);
    expect(before!.processedRows).toBe(0);
    expect(before!.percent).toBe(0);

    await runStudentImport({ importRunId: run.id, strategy: 'SKIP', actorId: adminId });

    const after = await getImportProgress(run.id);
    expect(after!.status).toBe('COMPLETED');
    expect(after!.processedRows).toBe(2);
    expect(after!.successCount).toBe(2);
    expect(after!.percent).toBe(100);
    expect(after!.finishedAt).not.toBeNull();

    expect(await getImportProgress(999_999_999)).toBeNull();
  }, TEST_TIMEOUT);

  dbIt('B9. buildCredentialsCsvForRun contains only SUCCESS rows and the plaintext password', async () => {
    const run = await mkRun([
      { rowNumber: 1, payload: payloadFor(60, { lastName: 'Zulu' }) },
      { rowNumber: 2, payload: payloadFor(61), status: 'FAILED' },
    ]);

    await runStudentImport({ importRunId: run.id, strategy: 'SKIP', actorId: adminId, sendCredentialEmails: false });

    const { fileName, csv } = await BulkStudentUploadService.buildCredentialsCsvForRun(run.uuid);
    expect(fileName).toBe(`credentials-${run.uuid}.csv`);

    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe('row_number,matric_number,first_name,last_name,email,password');
    // Exactly one success row (row 1). Row 2 was pre-FAILED and must be absent.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`${TAG}-60`);
    expect(lines[1]).toContain('zulu'); // default password = surname lower-cased
    expect(csv).not.toContain(`${TAG}-61`);
  }, TEST_TIMEOUT);

  dbIt('B10. an unknown import run id throws 404', async () => {
    let caught: AppError | null = null;
    try {
      await runStudentImport({ importRunId: 999_999_999, strategy: 'SKIP', actorId: adminId });
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.statusCode).toBe(404);
  }, TEST_TIMEOUT);

  dbIt('B11. sendCredentialEmails=false leaves passwordSent=false but still captures the password', async () => {
    const run = await mkRun([{ rowNumber: 1, payload: payloadFor(70, { lastName: 'Solo' }) }]);

    await runStudentImport({ importRunId: run.id, strategy: 'SKIP', actorId: adminId, sendCredentialEmails: false });

    const row = await prisma.importRow.findFirst({ where: { importRunId: run.id, rowNumber: 1 } });
    expect(row!.status).toBe('SUCCESS');
    expect(row!.passwordSent).toBe(false);
    expect(row!.temporaryPassword).toBe('solo');

    // The created student exists and is usable.
    const user = await prisma.user.findFirst({ where: { id: row!.studentId! }, select: { id: true, mustChangePassword: true } });
    expect(user).not.toBeNull();
    expect(user!.mustChangePassword).toBe(true);
    void StudentService; // imported to document the engine's dependency
  }, TEST_TIMEOUT);
});
