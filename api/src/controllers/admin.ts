import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { StudentService } from '../services/student';
import { reqIp, reqUa } from '../utils/http';

export const getDashboardStats = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const totalStudents = await prisma.user.count({
    where: { role: 'STUDENT' },
  });

  const totalPaidResult = await prisma.transaction.aggregate({
    where: {
      type: 'FEE_PAYMENT',
      status: 'SUCCESS',
    },
    _sum: {
      amount: true,
    },
  });
  const totalCollected = totalPaidResult._sum.amount || 0;

  const totalBills = await prisma.fee.count({
    where: { isActive: true },
  });

  const receiptsIssued = await prisma.receipt.count({
    where: { isVoided: false },
  });

  const auditLogs = await prisma.auditLog.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { firstName: true, lastName: true } } },
  });

  res.status(200).json({
    status: 'success',
    data: {
      stats: {
        totalStudents,
        totalCollected,
        totalFeesConfigured: totalBills,
        totalBills,
        receiptsIssued,
      },
      auditLogs,
    },
  });
});

export const addStudent = catchAsync(async (req: Request, res: Response) => {
  if (!req.user) return;
  const user = await StudentService.create(req.body, req.user.id, {
    ip: reqIp(req), userAgent: reqUa(req),
  });
  res.status(201).json({ status: 'success', data: { user } });
});
