/**
 * Module 4 + Module 5 — BullMQ Queue Configuration.
 *
 * Two queues:
 *   email-queue           — credential emails; rate limited 120/min, exponential backoff, 3 attempts.
 *   student-import        — process uploaded CSVs; batches of 250, commit then enqueue emails.
 *
 * Module 5 hygiene (required by AC-15):
 *   defaultJobOptions = { removeOnComplete:true, removeOnFail:{count:100} }.
 */
import { Queue, QueueOptions, Worker, WorkerOptions } from "bullmq";
import IORedis from "ioredis";
import logger from "./logger";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

redisConnection.on("error", (err) => {
  logger.warn(`Redis connection error (BullMQ will retry): ${err.message}`);
});

/** Module 5 — shared default opts applied to all queues. */
export const DEFAULT_JOB_OPTS: NonNullable<QueueOptions["defaultJobOptions"]> = {
  removeOnComplete: true,
  removeOnFail: { count: 100 },
  attempts: 3,
};

export const EMAIL_JOB_OPTS = {
  ...DEFAULT_JOB_OPTS,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: true,
  // removeOnFail inherited above
};

export const emailQueue = new Queue("email-queue", {
  connection: redisConnection,
  defaultJobOptions: { ...DEFAULT_JOB_OPTS, ...EMAIL_JOB_OPTS },
});

export const studentImportQueue = new Queue("student-import", {
  connection: redisConnection,
  defaultJobOptions: DEFAULT_JOB_OPTS,
});

/**
 * Shared worker factory base opts: concurrency safe, limiter for email worker.
 */
export function getEmailWorkerOptions(): WorkerOptions {
  const ratePerMin = Number(process.env.SMTP_RATE_PER_MIN ?? 120);
  return {
    connection: redisConnection,
    concurrency: 10,
    limiter: {
      max: ratePerMin,
      duration: 60_000, // per minute (Module 4 — SMTP <120/min)
    },
  };
}

export function getImportWorkerOptions(): WorkerOptions {
  return {
    connection: redisConnection,
    concurrency: 2,
  };
}

// Export types used by worker files.
export type { Worker };
