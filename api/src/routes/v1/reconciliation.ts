/**
 * Module 1 — Reconciliation Dashboard backend endpoints.
 *
 *   GET /api/v1/bursary/reconciliation/summary      Stat cards + byDayLast7Days. Requires VIEW_RECONCILIATION.
 *   GET /api/v1/bursary/reconciliation/exceptions   Unmatched/exceptions rows. Requires VIEW_RECONCILIATION.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import prisma from "../../config/prisma";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { Permissions } from "../../types/permissions";

const router = Router();
router.use(authenticate, requirePermission(Permissions.VIEW_RECONCILIATION));

function pad7Days(today = new Date()): Array<{ date: string; amount: number }> {
  const out: Array<{ date: string; amount: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push({
      date: d.toISOString().slice(0, 10),
      amount: 0,
    });
  }
  return out;
}

router.get("/summary", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const startMonth = new Date(startToday.getFullYear(), startToday.getMonth(), 1);
    const start7DaysAgo = new Date(startToday);
    start7DaysAgo.setDate(startToday.getDate() - 6);
    start7DaysAgo.setHours(0, 0, 0, 0);

    const exceptionStatuses: any = ["UNDERPAID", "OVERPAID", "FAILED", "REVERSED"];

    const [
      totalCollectedAgg,
      totalSettledAgg,
      pendingCount,
      unmatchedWhCount,
      exceptionsCountAgg,
      byDayRaw,
    ] = await Promise.all([
      prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { status: "SUCCESS" as any },
      }),
      prisma.settlement.aggregate({
        _sum: { paymentAmount: true },
        where: { status: "SETTLED" as any },
      }),
      prisma.transaction.count({ where: { status: "PENDING" as any } }),
      prisma.webhookEvent.count({ where: { isProcessed: false } }),
      prisma.transaction.count({ where: { status: { in: exceptionStatuses } } }),
      prisma.$queryRawUnsafe<Array<{ date: string; amount: string }>>(`
        SELECT
          DATE(CONVERT_TZ(createdAt, @@session.time_zone, '+00:00')) AS date,
          SUM(amount) AS amount
        FROM transactions
        WHERE status = 'SUCCESS'
          AND createdAt >= ?
        GROUP BY DATE(CONVERT_TZ(createdAt, @@session.time_zone, '+00:00'))
        ORDER BY date ASC
      `, start7DaysAgo),
    ]);

    const totalCollected = Number((totalCollectedAgg._sum as any)?.amount ?? 0);
    const totalSettled = Number((totalSettledAgg._sum as any)?.paymentAmount ?? 0);
    const pendingSettlement = Math.max(0, totalCollected - totalSettled);
    const unmatchedCount = pendingCount + unmatchedWhCount;

    const byDay = pad7Days();
    for (const row of (byDayRaw ?? []) as any[]) {
      const dateStr = typeof row.date === "string" ? row.date : new Date(row.date as any).toISOString().slice(0, 10);
      const slot = byDay.find((d) => d.date === dateStr);
      if (slot) slot.amount = Number(row.amount ?? 0);
    }
    const exceptionsCount = exceptionsCountAgg;

    return res.status(200).json({
      data: {
        totalCollected,
        totalSettled,
        pendingSettlement,
        unmatchedCount,
        exceptionsCount,
        byDayLast7Days: byDay,
      },
      meta: {
        generatedAt: new Date().toISOString(),
        currentSession: process.env.CURRENT_SESSION ?? "2025/2026",
        period: {
          monthStart: startMonth.toISOString().slice(0, 10),
          today: startToday.toISOString().slice(0, 10),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

const ListExceptionQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(500).default(25),
});

router.get("/exceptions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = ListExceptionQuery.parse(req.query);
    const skip = (q.page - 1) * q.size;
    const exceptionStatuses: any = ["PENDING", "UNDERPAID", "OVERPAID", "FAILED", "REVERSED"];
    const excWhere = { status: { in: exceptionStatuses } } as any;
    const txPromise = prisma.transaction.findMany({
      where: excWhere,
      skip,
      take: q.size,
      orderBy: { createdAt: "desc" },
      include: {
        invoice: { select: { id: true, invoiceNumber: true, studentId: true } },
        receipts: { take: 1, select: { id: true, receiptNumber: true } },
      },
    });
    const totalPromise = prisma.transaction.count({ where: excWhere });
    const [txs, total] = await Promise.all([txPromise, totalPromise]);

    const excSet = new Set(["UNDERPAID", "OVERPAID", "FAILED", "REVERSED"]);
    const rows = (txs as any[]).map((t) => {
      const receipt = Array.isArray(t.receipts) && t.receipts.length > 0 ? t.receipts[0] : null;
      return {
        id: `${t.reference}`,
        type: excSet.has(t.status) ? "EXCEPTION" : `TX_${t.status}`,
        reference: t.reference,
        amount: Number(t.amount),
        date: t.createdAt.toISOString(),
        studentId: t.invoice?.studentId ?? null,
        receiptId: receipt?.id ?? null,
        resolveUrl: receipt?.id ? `/bursary/receipts/${receipt.id}` : null,
      };
    });

    return res.json({
      data: rows,
      meta: { page: q.page, size: q.size, total },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
