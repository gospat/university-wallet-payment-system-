/**
 * Module 4 — Email Worker.
 *
 * Picks jobs from email-queue with:
 *   attempts: 3, exponential backoff (2000ms, 4000ms, 8000ms)
 *   rate limit: 120 emails/minute
 *   removeOnComplete: true, removeOnFail count=100 (Module 5 hygiene)
 *
 * Only this file calls notificationService.sendStudentCredentials inline.
 */
import { Job, Worker } from "bullmq";
import { getEmailWorkerOptions } from "../config/queue";
import logger from "../config/logger";
import { sendStudentCredentials } from "../services/notificationService";
import prisma from "../config/prisma";

export interface StudentCredentialsJobData {
  kind: "student-credentials";
  to: string;
  matricNumber: string;
  password: string;
  firstName?: string;
  lastName?: string;
  importRowId?: number;
  source: "create-single" | "bulk-import" | "resend";
}

async function handle(job: Job): Promise<void> {
  const d = job.data as StudentCredentialsJobData;
  if (d.kind !== "student-credentials") {
    logger.warn("[email-worker] unknown job kind", { kind: d.kind });
    return;
  }
  if (!d.to || !d.matricNumber || !d.password) {
    throw new Error("[email-worker] payload missing required fields");
  }
  await sendStudentCredentials({
    to: d.to,
    matricNumber: d.matricNumber,
    password: d.password,
    firstName: d.firstName,
    lastName: d.lastName,
  });
  if (d.importRowId) {
    await prisma.importRow
      .update({
        where: { id: d.importRowId },
        data: { passwordSent: true },
      })
      .catch((err: any) => logger.warn("[email-worker] importRow update failed", { err }));
  }
}

export const emailWorker = new Worker("email-queue", handle, getEmailWorkerOptions());

emailWorker.on("failed", (job, err) => {
  logger.error("[email-worker] job failed", {
    jobId: job?.id,
    name: job?.name,
    reason: err?.message,
    attemptsMade: job?.attemptsMade,
  });
});

emailWorker.on("completed", (job) => {
  logger.verbose("[email-worker] job completed", { jobId: job.id, name: job.name });
});

logger.info("[email-worker] started email-queue worker");
