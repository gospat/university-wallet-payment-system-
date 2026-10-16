// =============================================================================
// Student Import Runner — chunked, DB-backed, restart-safe bulk import engine.
//
// This module performs the actual per-row student creation. It is deliberately
// decoupled from the queue module (the queue imports THIS module, never the
// other way round) so it can also be driven directly by tests or by the
// inline Redis-down fallback in queues/studentImportQueue.ts.
//
// Design:
//   * Only PENDING rows are processed, so a duplicate job or a retried job can
//     never double-import — the database status is the source of truth.
//   * Rows are handled in slices of IMPORT_CHUNK_SIZE with at most
//     IMPORT_CONCURRENCY in flight at once.
//   * Results are persisted per slice in a single transaction and the run
//     counters are incremented atomically, which keeps live progress exact.
// =============================================================================

import Papa from 'papaparse';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { i18n } from '../i18n/en';
import { StudentService } from './student';

// -----------------------------------------------------------------------------
// Tunables. IMPORT_CHUNK_SIZE is >= IMPORT_CONCURRENCY so every slice can keep
// the worker pool saturated.
// -----------------------------------------------------------------------------
export const IMPORT_CHUNK_SIZE = 100;
export const IMPORT_CONCURRENCY = 5;

export interface ImportProgress {
  importRunId: number;
  uuid: string;
  status: string;
  totalRows: number;
  processedRows: number;
  successCount: number;
  failCount: number;
  skippedCount: number;
  percent: number;
  finishedAt: string | null;
}

export interface RunStudentImportOpts {
  importRunId: number;
  strategy: 'SKIP' | 'UPDATE' | 'CANCEL';
  actorId: number;
  ip?: string;
  userAgent?: string;
  sendCredentialEmails?: boolean;
  studentImportId?: number | null;
  onProgress?: (p: ImportProgress) => void | Promise<void>;
}

type RowOutcomeStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED';

interface RowOutcome {
  rowId: number;
  status: RowOutcomeStatus;
  errorMessage: string | null;
  studentId: number | null;
  temporaryPassword: string | null;
  passwordSent: boolean;
}

const DUPLICATE_MESSAGE = 'Duplicate: email or matric number already exists';

function truncateError(message: string | undefined | null): string {
  return String(message ?? '').slice(0, 2000);
}

function toProgress(run: {
  id: number;
  uuid: string;
  status: string;
  totalRows: number;
  successCount: number;
  failCount: number;
  skippedCount: number;
  finishedAt: Date | null;
}): ImportProgress {
  const processedRows = run.successCount + run.failCount + run.skippedCount;
  const percent = run.totalRows > 0 ? Math.min(100, Math.round((processedRows / run.totalRows) * 100)) : 100;
  return {
    importRunId: run.id,
    uuid: run.uuid,
    status: run.status,
    totalRows: run.totalRows,
    processedRows,
    successCount: run.successCount,
    failCount: run.failCount,
    skippedCount: run.skippedCount,
    percent,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

/**
 * Run an array of async tasks with a bounded number in flight at once.
 * Implemented inline so no extra dependency is required.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Work a single row: create the student, honouring the duplicate strategy when
 * StudentService.create rejects an existing email/matricNumber.
 */
async function processRow(
  row: { id: number; payload: unknown },
  strategy: RunStudentImportOpts['strategy'],
  opts: RunStudentImportOpts,
): Promise<RowOutcome> {
  const payload = (row.payload ?? {}) as Record<string, any>;
  const sendCredentialEmails = Boolean(opts.sendCredentialEmails);

  try {
    // IMPORTANT: bcrypt.hash runs on the libuv threadpool, so the bounded
    // concurrency at the slice level (IMPORT_CONCURRENCY) is what lets ~7,000
    // rows finish in minutes instead of ~30 minutes sequentially.
    const created: any = await StudentService.create(payload as any, opts.actorId, {
      ip: opts.ip,
      userAgent: opts.userAgent,
      importId: opts.studentImportId ?? undefined,
      sendCredentialEmail: sendCredentialEmails,
      returnPlaintextPassword: true,
    });
    return {
      rowId: row.id,
      status: 'SUCCESS',
      errorMessage: null,
      studentId: created?.user?.id ?? null,
      temporaryPassword: created?.temporaryPasswordPlaintext ?? null,
      passwordSent: sendCredentialEmails,
    };
  } catch (err) {
    const message = (err as Error)?.message;
    const isDuplicate = message === i18n.errors.auth.emailExists || message === i18n.errors.auth.matricExists;

    if (!isDuplicate) {
      return {
        rowId: row.id,
        status: 'FAILED',
        errorMessage: truncateError(message),
        studentId: null,
        temporaryPassword: null,
        passwordSent: false,
      };
    }

    if (strategy === 'UPDATE') {
      const existing = await prisma.user.findFirst({
        where: { OR: [{ email: payload.email }, { matricNumber: payload.matricNumber }] },
        select: { id: true },
      });
      if (existing) {
        try {
          const updatePayload: Record<string, any> = { ...payload };
          // StudentService.update must never be handed a password.
          delete updatePayload.password;
          await StudentService.update(existing.id, updatePayload as any, opts.actorId, {
            ip: opts.ip,
            userAgent: opts.userAgent,
          });
          return {
            rowId: row.id,
            status: 'SUCCESS',
            errorMessage: null,
            studentId: existing.id,
            temporaryPassword: null,
            passwordSent: false,
          };
        } catch (updateErr) {
          return {
            rowId: row.id,
            status: 'FAILED',
            errorMessage: truncateError((updateErr as Error)?.message),
            studentId: null,
            temporaryPassword: null,
            passwordSent: false,
          };
        }
      }
    }

    // SKIP (and anything else) → the row is intentionally not imported.
    return {
      rowId: row.id,
      status: 'SKIPPED',
      errorMessage: DUPLICATE_MESSAGE,
      studentId: null,
      temporaryPassword: null,
      passwordSent: false,
    };
  }
}

/**
 * Chunked, restart-safe, background import engine.
 *
 * Idempotent: a run that is already COMPLETED returns its counters without
 * reprocessing anything, and only PENDING rows are ever worked.
 */
export async function runStudentImport(
  opts: RunStudentImportOpts,
): Promise<{ totalRows: number; successCount: number; failCount: number; skippedCount: number; status: 'COMPLETED' | 'FAILED' }> {
  const run = await prisma.importRun.findUnique({ where: { id: opts.importRunId } });
  if (!run) throw new AppError('Import run not found', 404);

  // Idempotency guard: a duplicate job must not re-import a finished run.
  if (run.status === 'COMPLETED') {
    return {
      totalRows: run.totalRows,
      successCount: run.successCount,
      failCount: run.failCount,
      skippedCount: run.skippedCount,
      status: 'COMPLETED',
    };
  }

  await prisma.importRun.update({
    where: { id: run.id },
    data: { status: 'PROCESSING', startedAt: new Date() },
  });

  try {
    const rows = await prisma.importRow.findMany({
      where: { importRunId: run.id, status: 'PENDING' },
      orderBy: { rowNumber: 'asc' },
      select: { id: true, payload: true },
    });

    for (let start = 0; start < rows.length; start += IMPORT_CHUNK_SIZE) {
      const slice = rows.slice(start, start + IMPORT_CHUNK_SIZE);
      const outcomes = await mapWithConcurrency(slice, IMPORT_CONCURRENCY, (row) =>
        processRow(row, opts.strategy, opts),
      );

      let successDelta = 0;
      let failDelta = 0;
      let skipDelta = 0;
      for (const outcome of outcomes) {
        if (outcome.status === 'SUCCESS') successDelta++;
        else if (outcome.status === 'FAILED') failDelta++;
        else skipDelta++;
      }

      // Persist the whole slice atomically, then bump the run counters.
      await prisma.$transaction(
        outcomes.map((outcome) =>
          prisma.importRow.update({
            where: { id: outcome.rowId },
            data: {
              status: outcome.status,
              errorMessage: outcome.errorMessage,
              studentId: outcome.studentId,
              temporaryPassword: outcome.temporaryPassword,
              passwordSent: outcome.passwordSent,
            },
          }),
        ),
      );

      const updated = await prisma.importRun.update({
        where: { id: run.id },
        data: {
          successCount: { increment: successDelta },
          failCount: { increment: failDelta },
          skippedCount: { increment: skipDelta },
        },
      });

      if (opts.onProgress) {
        try {
          await opts.onProgress(toProgress(updated));
        } catch {
          /* progress reporting must never break the import */
        }
      }
    }

    const finished = await prisma.importRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', finishedAt: new Date() },
    });

    return {
      totalRows: finished.totalRows,
      successCount: finished.successCount,
      failCount: finished.failCount,
      skippedCount: finished.skippedCount,
      status: 'COMPLETED',
    };
  } catch (fatal) {
    await prisma.importRun
      .update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date() } })
      .catch(() => { /* best-effort failure marking */ });
    throw fatal;
  }
}

/**
 * Read-only progress shape used by the polling endpoint.
 */
export async function getImportProgress(importRunId: number): Promise<ImportProgress | null> {
  const run = await prisma.importRun.findUnique({
    where: { id: importRunId },
    select: {
      id: true,
      uuid: true,
      status: true,
      totalRows: true,
      successCount: true,
      failCount: true,
      skippedCount: true,
      finishedAt: true,
    },
  });
  if (!run) return null;
  return toProgress(run);
}

/**
 * Build a downloadable credentials CSV for the SUCCESS rows of a run.
 * Delegates all quoting/escaping to Papa.unparse.
 */
export function buildCredentialsCsv(
  rows: Array<{
    rowNumber: number;
    firstName: string;
    lastName: string;
    email: string | null;
    matricNumber: string;
    temporaryPassword: string | null;
    studentId: number | null;
  }>,
): string {
  const data: string[][] = [['row_number', 'matric_number', 'first_name', 'last_name', 'email', 'password']];
  for (const r of rows) {
    data.push([
      String(r.rowNumber),
      r.matricNumber ?? '',
      r.firstName ?? '',
      r.lastName ?? '',
      r.email ?? '',
      r.temporaryPassword ?? '',
    ]);
  }
  return Papa.unparse(data);
}
