/**
 * Module 5 — Prisma log hygiene.
 * In PRODUCTION, Prisma emits only "error" level; query-level event listener is skipped.
 * In development, "query" + "info" + "warn" + "error" events are emitted.
 */
import { PrismaClient } from "@prisma/client";
import logger from "./logger";

const isProd = process.env.NODE_ENV === "production";

export const prisma = new PrismaClient({
  log: isProd
    ? ["error"]
    : [
        { level: "query", emit: "event" },
        { level: "info", emit: "stdout" },
        { level: "warn", emit: "stdout" },
        { level: "error", emit: "stdout" },
      ],
});

// Module 5 gate: query listener ONLY in non-production.
if (!isProd) {
  type QueryEvent = { query: string; params: string; duration: number; timestamp: Date; target: string };
  (prisma as any).$on("query", (e: QueryEvent) => {
    logger.debug(`[prisma:query] ${e.duration}ms — ${e.query}`);
  });
}

export default prisma;
