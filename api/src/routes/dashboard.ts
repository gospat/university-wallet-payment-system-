import express from 'express';
import { z } from 'zod';
import { protect } from '../middlewares/auth';
import { validateQuery } from '../middlewares/validate';
import { catchAsync } from '../utils/catchAsync';
import prisma from '../config/database';

const router = express.Router();

router.use(protect);

const NavCountersSchema = z.object({});

router.get(
  '/nav-counters',
  validateQuery(NavCountersSchema),
  catchAsync(async (req: any, res) => {
    const role = (req.user?.role as string) ?? 'STUDENT';

    if (role === 'STUDENT') {
      const userId = Number(req.user?.id ?? 0);
      let makePayment = 0;
      if (userId) {
        try {
          const rows = (await prisma.$queryRawUnsafe<[{ cnt: string | number }]>(`
            SELECT COUNT(*) AS cnt
            FROM invoices
            WHERE userId = ${userId}
              AND (amountDue - amountPaid) > 0
              AND status <> 'VOID'
          `)) as unknown as [{ cnt: string | number }];
          const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : { cnt: 0 };
          makePayment = Number(row.cnt ?? 0);
        } catch (e) {
          makePayment = 0;
        }
      }
      return res.status(200).json({
        status: 'success',
        data: { makePayment },
      });
    }

    const roleU = role.toUpperCase();
    if (roleU === 'ADMIN' || roleU === 'BURSARY') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const [refunds, failedWebhooks, pendingPayments] = await Promise.all([
        prisma.refund
          .count({ where: { status: 'REQUESTED' as any } })
          .catch(() => 0),
        prisma.adminNotification
          .count({
            where: {
              type: 'WEBHOOK_FAIL_3' as any,
              readAt: null,
            },
          })
          .catch(() => 0),
        prisma.transaction
          .count({
            where: {
              status: 'PENDING' as any,
              createdAt: { gte: todayStart, lte: todayEnd },
            },
          })
          .catch(() => 0),
      ]);

      return res.status(200).json({
        status: 'success',
        data: {
          refunds: Number(refunds ?? 0),
          failedWebhooks: Number(failedWebhooks ?? 0),
          pendingPayments: Number(pendingPayments ?? 0),
        },
      });
    }

    return res.status(200).json({
      status: 'success',
      data: {},
    });
  }),
);

export default router;
