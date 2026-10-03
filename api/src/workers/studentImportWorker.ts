/**
 * Module 4 — Student Import Worker.
 *
 * Reads uploaded CSV from disk (streaming), buffers rows in batches of 250,
 * then commits each batch inside a Prisma transaction.
 * ONLY AFTER the transaction commits does the worker enqueue 250 emails.
 * Never calls sendMail inline (always via emailQueue).
 */
import { Job, Worker } from "bullmq";
import fs from "node:fs";
import path from "node:path";
import csv from "csv-parser";
import prisma from "../config/prisma";
import { EMAIL_JOB_OPTS, emailQueue, getImportWorkerOptions } from "../config/queue";
import { createStudentBatch, CreateStudentInputT } from "../services/studentService";
import logger from "../config/logger";

export interface StudentImportJobData {
  importRunId: number;
  filePath: string;
  batchSize?: number;
}

interface CSVRow {
  rowNumber: number;
  firstName: string;
  lastName: string;
  email?: string;
  matricNumber: string;
  department?: string;
  faculty?: string;
  level?: string;
  session?: string;
  __raw: Record<string, string>;
}

const BATCH_SIZE = 250;

function toCreateInput(row: CSVRow): CreateStudentInputT & { __rowNumber: number } {
  return {
    firstName: (row.firstName ?? "").trim(),
    lastName: (row.lastName ?? "").trim(),
    email: (row.email ?? "").trim(),
    matricNumber: (row.matricNumber ?? "").trim(),
    department: row.department?.trim(),
    faculty: row.faculty?.trim(),
    level: row.level?.trim(),
    session: row.session?.trim(),
    role: "STUDENT",
    __rowNumber: row.rowNumber,
  };
}

export function streamCsv(
  filePath: string,
  onBatch: (rows: CSVRow[]) => Promise<void>
): Promise<{ total: number }> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error(`CSV missing: ${filePath}`));
    let rowNumber = 0;
    let buffer: CSVRow[] = [];
    const stream = fs.createReadStream(filePath).pipe(
      csv({
        mapHeaders: ({ header }) => header.trim().toLowerCase(),
      })
    );
    stream.on("data", (data: Record<string, string>) => {
      rowNumber += 1;
      const row: CSVRow = {
        rowNumber,
        firstName: data["firstname"] ?? data["first name"] ?? data["first_name"] ?? "",
        lastName: data["lastname"] ?? data["surname"] ?? data["last name"] ?? data["last_name"] ?? "",
        email: data["email"] ?? data["emailaddress"] ?? "",
        matricNumber:
          data["matricnumber"] ??
          data["matric number"] ??
          data["matric_no"] ??
          data["matric"] ??
          "",
        department: data["department"] ?? data["dept"] ?? undefined,
        faculty: data["faculty"] ?? undefined,
        level: data["level"] ?? undefined,
        session: data["session"] ?? undefined,
        __raw: data,
      };
      buffer.push(row);
      if (buffer.length >= BATCH_SIZE) {
        const batch = buffer;
        buffer = [];
        stream.pause();
        onBatch(batch)
          .then(() => stream.resume())
          .catch((err) => {
            stream.destroy();
            reject(err);
          });
      }
    });
    stream.on("end", async () => {
      try {
        if (buffer.length > 0) await onBatch(buffer);
        resolve({ total: rowNumber });
      } catch (err) {
        reject(err);
      }
    });
    stream.on("error", (err) => reject(err));
  });
}

async function commitBatch(
  importRunId: number,
  rows: CSVRow[]
): Promise<{ okCount: number; failCount: number; emailsToQueue: Array<{ name: string; data: any; opts: any }> }> {
  const emailsToQueue: Array<{ name: string; data: any; opts: any }> = [];
  let okCount = 0;
  let failCount = 0;

  await prisma.$transaction(async (tx) => {
    const results = await createStudentBatch(
      rows.map((r) => toCreateInput(r)),
      tx
    );
    const importRowInserts = results.map((r) => ({
      importRunId,
      rowNumber: r.rowNumber,
      firstName: r.firstName ?? "",
      lastName: r.lastName ?? "",
      email: r.email,
      matricNumber: r.matricNumber,
      status: (r.ok ? "SUCCESS" : "FAILED") as any,
      errorMessage: r.error ?? null,
      studentId: r.studentId ?? null,
    }));
    if (importRowInserts.length) {
      await (tx as any).importRow.createMany({ data: importRowInserts, skipDuplicates: true });
    }
    // Grab the newly inserted ImportRow ids using matric + run id (single query).
    const createdRows = await (tx as any).importRow.findMany({
      where: {
        importRunId,
        matricNumber: { in: results.filter((r) => r.ok).map((r) => r.matricNumber) },
      },
      select: { id: true, matricNumber: true },
    });
    const idByMatric = new Map(createdRows.map((r: any) => [r.matricNumber, r.id]));
    for (const r of results) {
      if (r.ok) {
        okCount += 1;
        const importRowId = idByMatric.get(r.matricNumber);
        emailsToQueue.push({
          name: "credentials",
          data: {
            kind: "student-credentials",
            to: r.email,
            matricNumber: r.matricNumber,
            password: r.password,
            firstName: r.firstName,
            lastName: r.lastName,
            importRowId,
            source: "bulk-import",
          },
          opts: EMAIL_JOB_OPTS,
        });
      } else {
        failCount += 1;
      }
    }
  });
  return { okCount, failCount, emailsToQueue };
}

export async function handle(job: Job<StudentImportJobData>): Promise<{ okCount: number; failCount: number; total: number }> {
  const { importRunId, filePath } = job.data;
  logger.info("[student-import-worker] start", { importRunId, filePath, jobId: job.id });
  await prisma.importRun.update({ where: { id: importRunId }, data: { status: "PROCESSING" as any } });

  let okCount = 0;
  let failCount = 0;
  let total = 0;

  try {
    const result = await streamCsv(filePath, async (rows) => {
      const commit = await commitBatch(importRunId, rows);
      okCount += commit.okCount;
      failCount += commit.failCount;
      if (commit.emailsToQueue.length > 0) {
        // Enqueue 250 emails AFTER transaction commit.
        await emailQueue.addBulk(commit.emailsToQueue);
      }
      await prisma.importRun.update({
        where: { id: importRunId },
        data: { successCount: okCount, failCount, totalRows: okCount + failCount },
      });
      logger.verbose("[student-import-worker] batch done", {
        importRunId,
        batchSize: rows.length,
        ok: commit.okCount,
        fail: commit.failCount,
      });
    });
    total = result.total;
    await prisma.importRun.update({
      where: { id: importRunId },
      data: { status: "COMPLETED" as any, totalRows: total, finishedAt: new Date() },
    });
    logger.info("[student-import-worker] completed", { importRunId, total, okCount, failCount });
    return { okCount, failCount, total };
  } catch (err: any) {
    logger.error("[student-import-worker] fatal", { importRunId, err });
    await prisma.importRun.update({
      where: { id: importRunId },
      data: { status: "FAILED" as any, finishedAt: new Date() },
    });
    throw err;
  } finally {
    // Best effort: remove CSV once done. Cleanup cron will handle leftovers.
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {
      /* noop */
    }
  }
}

export const studentImportWorker = new Worker(
  "student-import",
  (job) => handle(job as any),
  getImportWorkerOptions()
);

studentImportWorker.on("failed", (job, err) => {
  logger.error("[student-import-worker] failed", { jobId: job?.id, err: err?.message });
});
