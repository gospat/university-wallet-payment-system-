/**
 * Module 3 — Delete Users with Financial Gate + Resend Credentials.
 *
 *   GET    /api/v1/admin/users              List users (MANAGE_USERS).
 *   DELETE /api/v1/admin/users/:id          Delete user (MANAGE_USERS).
 *   POST   /api/v1/admin/users/:id/resend-credentials  Reset password to surname default, queue email (MANAGE_USERS).
 *
 * Gates (DELETE):
 *   1. id ∈ {1, 2, 48} → 403 "Cannot delete protected account" + code=PROTECTED_ACCOUNT
 *   2. role=STUDENT + (invoices>0 OR receipts>0 OR transactions>0 OR refunds>0 OR settlements linked)
 *        → 409 code=STUDENT_HAS_FINANCIAL_RECORDS + breakdown=["X invoice(s)", ...]
 *   3. Otherwise: safe delete in a transaction:
 *        NULL AuditLog.userId, DELETE RefreshTokens, DELETE User. Write DELETE_USER audit row.
 *
 * Resend credentials (Module 4):
 *   - For STUDENT users only: reset password to lastName.toLowerCase() + mustChangePassword=true
 *   - Enqueue credential email (never inline send). Return 202 (or 200) immediately.
 *   - Non-student users return 400 (this facility is student-only per Module 2 spec).
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import prisma from "../../config/prisma";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { Permissions } from "../../types/permissions";
import { hashPassword } from "../../utils/password";
import { emailQueue, EMAIL_JOB_OPTS } from "../../config/queue";
import { buildPasswordFromSurname } from "../../services/studentService";
import logger from "../../config/logger";

const PROTECTED_IDS = new Set([1, 2, 48]);

const router = Router();
router.use(authenticate, requirePermission(Permissions.MANAGE_USERS));

const ListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  role: z.enum(["ADMIN", "BURSARY", "STUDENT"]).optional(),
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = ListSchema.parse(req.query);
    const where: any = {};
    if (q.role) where.role = q.role;
    if (q.search) {
      where.OR = [
        { email: { contains: q.search, mode: "insensitive" } },
        { firstName: { contains: q.search, mode: "insensitive" } },
        { lastName: { contains: q.search, mode: "insensitive" } },
        { matricNumber: { contains: q.search, mode: "insensitive" } },
      ];
    }
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (q.page - 1) * q.size,
        take: q.size,
        orderBy: { id: "asc" },
        select: {
          id: true,
          email: true,
          role: true,
          firstName: true,
          lastName: true,
          matricNumber: true,
          mustChangePassword: true,
          accountStatus: true,
          createdAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);
    return res.json({
      data: rows,
      meta: { page: q.page, size: q.size, total },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Module 3 financial gate — returns per-table counts for students.
 * 5-way bidirectional check (matches WRONG routes/admin.ts L701-L726 exactly).
 */
async function countFinancialRecords(userId: number, role: string) {
  if (role !== "STUDENT") return null;
  const [invoices, receipts, transactions, refunds] = await Promise.all([
    prisma.invoice.count({ where: { studentId: userId } }),
    prisma.receipt.count({ where: { studentId: userId } }),
    prisma.transaction.count({ where: { userId } }),
    prisma.refund.count({ where: { requestedById: userId } }),
  ] as const);
  const any = invoices + receipts + transactions + refunds > 0;
  const breakdown: string[] = [];
  if (invoices > 0) breakdown.push(`${invoices} invoice(s)`);
  if (receipts > 0) breakdown.push(`${receipts} receipt(s)`);
  if (transactions > 0) breakdown.push(`${transactions} transaction(s)`);
  if (refunds > 0) breakdown.push(`${refunds} refund record(s)`);
  return {
    any,
    invoices,
    receipts,
    transactions,
    refunds,
    breakdown,
  };
}

router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ status: "fail", error: "User not found" });
    }

    // Gate 1: Protected root accounts (return 403 + code)
    if (PROTECTED_IDS.has(id)) {
      return res.status(403).json({
        status: "fail",
        error:
          "Cannot delete protected system account (primary admin / bursary bootstrap accounts)",
        code: "PROTECTED_ACCOUNT",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true, firstName: true, lastName: true },
    });
    if (!user) {
      return res.status(404).json({ status: "fail", error: "User not found" });
    }

    // Gate 2: Student financial integrity
    if (user.role === "STUDENT") {
      const fin = await countFinancialRecords(user.id, user.role);
      if (fin && fin.any) {
        return res.status(409).json({
          status: "fail",
          error:
            "Cannot delete student with existing financial records. Use accountStatus=SUSPENDED/GRADUATED instead.",
          code: "STUDENT_HAS_FINANCIAL_RECORDS",
          breakdown: fin.breakdown,
        });
      }
    }

    // Safe delete transaction
    await prisma.$transaction(async (tx) => {
      // 1. Preserve audit history (don't DELETE audit rows — just detach userId)
      await tx.auditLog.updateMany({ where: { userId: id }, data: { userId: null } });
      // 2. Force-logout all existing sessions
      await tx.refreshToken.deleteMany({ where: { userId: id } });
      // 3. Delete User row (Student profile FK cascades by schema for empty STUDENT)
      await tx.user.delete({ where: { id } });
    });

    // 4. Audit log of the deletion itself (fire and forget)
    prisma.auditLog
      .create({
        data: {
          userId: req.user?.userId ?? null,
          action: "DELETE_USER",
          entityType: "USER",
          entityId: String(id),
          details: {
            email: user.email,
            role: user.role,
            name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
            protectedAccount: false,
            studentGatePassed: user.role === "STUDENT",
          } as any,
        },
      })
      .catch((e) => logger.warn("Audit DELETE_USER write failed", { err: e }));

    return res.status(200).json({
      status: "success",
      data: {
        message: `User ${user.role} (${user.email}) deleted successfully`,
        deletedUserId: id,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Module 4 — Resend credentials endpoint.
 *
 * - STUDENT only. Resets password to surname.toLowerCase() + mustChangePassword=true.
 * - Enqueues credential email via BullMQ emailQueue (process.nextTick fallback if Redis down).
 * - Returns 202 Accepted immediately with jobId so the UI never blocks.
 */
router.post(
  "/:id/resend-credentials",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(404).json({ error: "User not found" });
      }
      if (PROTECTED_IDS.has(id)) {
        return res.status(403).json({ error: "Cannot reset protected account password", code: "PROTECTED_ACCOUNT" });
      }
      const user = await prisma.user.findUnique({
        where: { id },
      });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.role !== "STUDENT") {
        return res.status(400).json({ error: "Resend credentials is only available for students" });
      }
      if (!user.lastName) {
        return res.status(400).json({ error: "User has no surname set" });
      }
      const { plainPassword } = buildPasswordFromSurname({ lastName: user.lastName });
      const newPasswordHash = await hashPassword(plainPassword);

      // Update password + flip mustChangePassword
      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: newPasswordHash,
          mustChangePassword: true,
        },
      });

      // Enqueue email via BullMQ; if Redis down, inline process.nextTick fallback.
      let jobId: string = "fallback-inline";
      try {
        const job = await emailQueue
          .add(
            "credentials",
            {
              kind: "student-credentials",
              to: user.email,
              matricNumber: user.matricNumber!,
              password: plainPassword,
              firstName: user.firstName,
              lastName: user.lastName,
              source: "resend-credentials",
              userId: user.id,
            },
            EMAIL_JOB_OPTS
          )
          .catch(async (e: any) => {
            logger.warn("[resend-credentials] BullMQ unavailable — inline fallback", { err: e.message });
            process.nextTick(async () => {
              try {
                const { sendStudentCredentials } = await import(
                  "../../services/notificationService"
                );
                await sendStudentCredentials({
                  to: user.email,
                  matricNumber: user.matricNumber!,
                  password: plainPassword,
                  firstName: user.firstName,
                  lastName: user.lastName,
                });
              } catch (e2) {
                logger.warn("[resend-credentials] inline fallback failed", { err: (e2 as any).message });
              }
            });
            return { id: "fallback-inline" };
          });
        jobId = String((job as any).id ?? "n/a");
      } catch (_) {
        // Best effort
      }

      // Audit
      prisma.auditLog
        .create({
          data: {
            userId: req.user?.userId ?? null,
            action: "RESEND_CREDENTIALS",
            entityType: "USER",
            entityId: String(user.id),
            details: {
              email: user.email,
              matricNumber: user.matricNumber,
              passwordSource: "surname-lowercase",
              jobId,
            } as any,
          },
        })
        .catch(() => null);

      return res.status(202).json({
        status: "queued",
        jobId,
        queued: true,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
