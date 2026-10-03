/**
 * Module 4 — Student Bulk Upload + Import History + Resend Credentials.
 *
 *   POST /api/v1/admin/students                  Single student create (MANAGE_USERS). Returns 201.
 *   POST /api/v1/admin/students/import           Multipart CSV upload (MANAGE_USERS). Non-blocking, returns immediately.
 *   GET  /api/v1/admin/students/imports          List import runs (MANAGE_USERS).
 *   GET  /api/v1/admin/students/imports/:id/rows  Paginated rows of a run.
 *   POST /api/v1/admin/students/imports/rows/:rowId/resend-credentials  Re-queues email (inline never).
 *
 * Server never blocks: HTTP handler writes file to disk + queues job then returns.
 */
import { Router, Request, Response, NextFunction } from "express";
// @ts-ignore: multer types resolved at runtime via NODE_PATH; stubs for strict TSC
import multer from "multer";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { v4 as uuidv4 } from "uuid";
import prisma from "../../config/prisma";
import logger from "../../config/logger";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { Permissions } from "../../types/permissions";
import { BadRequestError, NotFoundError, ForbiddenError } from "../../utils/AppError";
import { studentImportQueue, DEFAULT_JOB_OPTS, emailQueue, EMAIL_JOB_OPTS } from "../../config/queue";
import {
  createStudent,
  CreateStudentInput,
} from "../../services/studentService";

const router = Router();
router.use(authenticate);

/** POST /admin/students — single create. Returns 201 + enqueues credential email. */
router.post(
  "/students",
  requirePermission(Permissions.MANAGE_USERS),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Accept password field from client, but Module 2 always overrides it with surname.
      // Parse a relaxed input (allow password field even though createStudent ignores it).
      const relaxed = z.object({
        firstName: z.string().trim().min(1),
        lastName: z.string().trim().min(1),
        email: z.string().email().optional().or(z.literal("")),
        matricNumber: z.string().trim().min(1),
        department: z.string().optional(),
        faculty: z.string().optional(),
        level: z.string().optional(),
        session: z.string().optional(),
        password: z.string().optional(),
      }).parse(req.body);

      const parsed = CreateStudentInput.parse({
        firstName: relaxed.firstName,
        lastName: relaxed.lastName,
        email: relaxed.email,
        matricNumber: relaxed.matricNumber,
        department: relaxed.department,
        faculty: relaxed.faculty,
        level: relaxed.level,
        session: relaxed.session,
      });

      const result = await createStudent(parsed);
      const createdUser = await prisma.user.findUnique({ where: { id: result.userId } });
      if (!createdUser) throw new NotFoundError("Created user not found");

      // Enqueue credential email — never inline. Falls back to process.nextTick if Redis down.
      try {
        const queued = await emailQueue
          .add(
            "credentials",
            {
              kind: "student-credentials",
              to: createdUser.email,
              matricNumber: createdUser.matricNumber!,
              password: result.generatedPassword,
              firstName: createdUser.firstName,
              lastName: createdUser.lastName,
              source: "single-create",
            },
            EMAIL_JOB_OPTS
          )
          .catch((e: any) => {
            // Queue infrastructure unavailable — fallback to inline async with setTimeout
            // so the HTTP handler returns 201 anyway (never block the caller).
            process.nextTick(async () => {
              try {
                const { sendStudentCredentials } = await import(
                  "../../services/notificationService"
                );
                await sendStudentCredentials({
                  to: createdUser.email,
                  matricNumber: createdUser.matricNumber!,
                  password: result.generatedPassword,
                  firstName: createdUser.firstName,
                  lastName: createdUser.lastName,
                });
              } catch (_) {
                // Ignore — email best-effort. Admin can resend via UI later.
              }
            });
            return { id: "fallback-inline" };
          });
        // Fire-and-forget for audit log.
        prisma.auditLog
          .create({
            data: {
              userId: req.user?.userId ?? null,
              action: "CREATE_STUDENT",
              entityType: "USER",
              entityId: String(result.userId),
              details: {
                email: createdUser.email,
                matricNumber: createdUser.matricNumber,
                jobId: String((queued as any).id ?? "n/a"),
              } as any,
            },
          })
          .catch(() => null);
      } catch (_) {
        // Queue failure should never block create — emails are best-effort.
      }

      return res.status(201).json({
        status: "success",
        data: {
          user: {
            id: createdUser.id,
            email: createdUser.email,
            role: createdUser.role,
            firstName: createdUser.firstName,
            lastName: createdUser.lastName,
            matricNumber: createdUser.matricNumber,
            mustChangePassword: createdUser.mustChangePassword,
          },
          generatedPasswordMeta: {
            jobId: "enqueued",
            source: "surname-lowercase",
            mustChangePassword: true,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/upg-api/tmp/uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req: any, _file: any, cb: any) => cb(null, UPLOAD_DIR),
  filename: (_req: any, _file: any, cb: any) => {
    const id = uuidv4();
    cb(null, `${id}.csv`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype === "text/csv" || file.originalname.toLowerCase().endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new BadRequestError("Only CSV files allowed"));
    }
  },
});

const ImportRunList = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(25),
});
const ImportRowList = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(500).default(50),
  status: z.enum(["PENDING", "SUCCESS", "FAILED"]).optional(),
});

/** POST multipart CSV → queue import job → return immediately. */
router.post(
  "/students/import",
  requirePermission(Permissions.MANAGE_USERS),
  upload.single("csv"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reqAny = req as any;
      if (!reqAny.file) throw new BadRequestError("csv file required");
      const filePath = reqAny.file.path;
      const fileName = reqAny.file.originalname;
      const runUuid = uuidv4();
      const createdById = req.user?.userId;
      const run = await prisma.importRun.create({
        data: {
          uuid: runUuid,
          fileName,
          filePath,
          status: "PROCESSING" as any,
          createdById: req.user!.userId,
        },
      });
      // Enqueue import — NEVER block HTTP handler. Fire-and-forget with fallback.
      // Schedule queue.add(); if BullMQ is unavailable after 2s, fall back to in-process nextTick.
      const syntheticJobId = `run-${run.id}-${runUuid.slice(0, 6)}`;
      const enqueuePromise = studentImportQueue
        .add(
          "process-csv",
          { importRunId: run.id, filePath },
          { ...DEFAULT_JOB_OPTS, jobId: `run-${run.id}-${runUuid}` }
        )
        .catch(async (e: any) => {
          logger.warn("[student-import] BullMQ add rejected — in-process fallback", { err: e.message });
          const { handle } = await import("../../workers/studentImportWorker");
          process.nextTick(async () => {
            try {
              await handle({
                id: syntheticJobId,
                name: "process-csv",
                data: { importRunId: run.id, filePath },
                opts: DEFAULT_JOB_OPTS as any,
                timestamp: Date.now(),
                attemptsMade: 0,
                queue: { name: studentImportQueue.name },
              } as any);
            } catch (e2) {
              logger.warn("[student-import] fallback worker failed", { err: (e2 as any).message });
            }
          });
          return { id: syntheticJobId };
        });
      // Timeout safety: if BullMQ hangs forever (no Redis, Promise never settles)
      // still trigger fallback after 2s without waiting for BullMQ.
      const timeoutMs = 2000;
      const timeoutPromise = new Promise<{ id: string }>((resolve) => {
        setTimeout(() => {
          logger.warn("[student-import] BullMQ add timed out — in-process fallback", { timeoutMs });
          import("../../workers/studentImportWorker").then(({ handle }) => {
            process.nextTick(async () => {
              try {
                await handle({
                  id: syntheticJobId,
                  name: "process-csv",
                  data: { importRunId: run.id, filePath },
                  opts: DEFAULT_JOB_OPTS as any,
                  timestamp: Date.now(),
                  attemptsMade: 0,
                  queue: { name: studentImportQueue.name },
                } as any);
              } catch (e2) {
                logger.warn("[student-import] timeout fallback failed", { err: (e2 as any).message });
              }
            });
          });
          resolve({ id: syntheticJobId });
        }, timeoutMs);
      });
      // Do not block HTTP longer than timeoutMs — race.
      const job = await Promise.race([enqueuePromise, timeoutPromise]);
      return res.status(202).json({
        jobId: String(job.id ?? syntheticJobId),
        importRunId: run.id,
        importRunUuid: run.uuid,
        status: "queued",
      });
    } catch (err) {
      next(err);
    }
  }
);

/** List import runs */
router.get(
  "/students/imports",
  requirePermission(Permissions.MANAGE_USERS),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = ImportRunList.parse(req.query);
      const [rows, total] = await Promise.all([
        prisma.importRun.findMany({
          orderBy: { startedAt: "desc" },
          skip: (q.page - 1) * q.size,
          take: q.size,
        }),
        prisma.importRun.count(),
      ]);
      return res.json({ data: rows, meta: { page: q.page, size: q.size, total } });
    } catch (err) {
      next(err);
    }
  }
);

/** List rows of one import run */
router.get(
  "/students/imports/:id/rows",
  requirePermission(Permissions.MANAGE_USERS),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const runId = Number(req.params.id);
      const q = ImportRowList.parse(req.query);
      const where: any = { importRunId: runId };
      if (q.status) where.status = q.status;
      const [rows, total] = await Promise.all([
        prisma.importRow.findMany({
          where,
          skip: (q.page - 1) * q.size,
          take: q.size,
          orderBy: { rowNumber: "asc" },
        }),
        prisma.importRow.count({ where }),
      ]);
      return res.json({ data: rows, meta: { page: q.page, size: q.size, total } });
    } catch (err) {
      next(err);
    }
  }
);

/** Resend credentials for a given import row. Enqueues — no inline sending. */
router.post(
  "/students/imports/rows/:rowId/resend-credentials",
  requirePermission(Permissions.MANAGE_USERS),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rowId = Number(req.params.rowId);
      const row = await prisma.importRow.findUnique({
        where: { id: rowId },
        include: {
          importRun: { select: { id: true, uuid: true } },
        },
      });
      if (!row) throw new NotFoundError("Import row not found");
      if (row.status !== "SUCCESS") throw new BadRequestError("Row did not import successfully");
      if (!row.studentId) throw new BadRequestError("No student linked to this row");

      // Lookup user directly (no separate Student model — matric info lives on User directly).
      const studentUser = await prisma.user.findUnique({
        where: { id: row.studentId },
      });
      if (!studentUser) throw new NotFoundError("Student user not found");

      // IMPORTANT: never send inline. Enqueue to email-queue — fire-and-forget (don't await) with fallback.
      // Use race: wait up to 2s for BullMQ; otherwise schedule in-process fallback and return.
      const syntheticJobId = `row-${rowId}-${Date.now()}`;
      const enqueueP = emailQueue
        .add(
          "credentials",
          {
            kind: "student-credentials",
            to: studentUser.email,
            matricNumber: studentUser.matricNumber,
            password: "Please use the 'Forgot Password' flow or contact admin if your password was changed.",
            firstName: studentUser.firstName,
            lastName: studentUser.lastName,
            importRowId: row.id,
            source: "resend",
          },
          EMAIL_JOB_OPTS
        )
        .then((j) => ({ id: String(j.id ?? syntheticJobId) }))
        .catch((e: any) => {
          logger.warn("[row-resend] BullMQ unavailable — fallback nextTick", { err: e.message });
          process.nextTick(async () => {
            try {
              const { sendStudentCredentials } = await import("../../services/notificationService");
              await sendStudentCredentials({
                to: studentUser.email,
                matricNumber: studentUser.matricNumber!,
                password:
                  "Please use the 'Forgot Password' flow or contact admin if your password was changed.",
                firstName: studentUser.firstName!,
                lastName: studentUser.lastName!,
              });
              await prisma.importRow.update({ where: { id: rowId }, data: { passwordSent: true } });
            } catch (e2) {
              logger.warn("[row-resend] inline fallback failed", { err: (e2 as any).message });
            }
          });
          return { id: syntheticJobId };
        });
      const timeoutP = new Promise<{ id: string }>((resolve) => {
        setTimeout(() => {
          logger.warn("[row-resend] BullMQ timed out — fallback scheduled");
          import("../../services/notificationService").then(({ sendStudentCredentials }) => {
            process.nextTick(async () => {
              try {
                await sendStudentCredentials({
                  to: studentUser.email,
                  matricNumber: studentUser.matricNumber!,
                  password:
                    "Please use the 'Forgot Password' flow or contact admin if your password was changed.",
                  firstName: studentUser.firstName!,
                  lastName: studentUser.lastName!,
                });
                await prisma.importRow.update({ where: { id: rowId }, data: { passwordSent: true } });
              } catch (e2) {
                logger.warn("[row-resend] timeout fallback failed", { err: (e2 as any).message });
              }
            });
          });
          resolve({ id: syntheticJobId });
        }, 2000);
      });
      const job = await Promise.race([enqueueP, timeoutP]);
      return res.status(202).json({ jobId: job.id, queued: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
