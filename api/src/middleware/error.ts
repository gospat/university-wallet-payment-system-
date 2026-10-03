/**
 * Global error middleware — maps AppError, ZodError, Prisma errors to responses.
 */
import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import logger from "../config/logger";
import { AppError } from "../utils/AppError";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error(err.message, { stack: err.stack });
    return res.status(err.statusCode).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation error",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({
        error: "Unique constraint violation",
        target: (err.meta as any)?.target ?? "unknown",
      });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Record not found" });
    }
    logger.error("Prisma error", { code: err.code, message: err.message, meta: err.meta });
    return res.status(500).json({ error: "Database error" });
  }
  logger.error("Unhandled error", { err });
  return res.status(500).json({ error: "Internal server error" });
}
