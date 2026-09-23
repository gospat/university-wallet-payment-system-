import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import bcrypt from 'bcrypt';
import { Role } from '@prisma/client';

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

  const outstandingAgg = await prisma.invoice.aggregate({
    _sum: { amountDue: true, amountPaid: true },
  });
  const totalExpected = Number(outstandingAgg._sum.amountDue ?? 0);
  const totalReceivedOnInvoices = Number(outstandingAgg._sum.amountPaid ?? 0);
  const outstandingReceivables = Math.max(0, totalExpected - totalReceivedOnInvoices);

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
        totalBills,
        outstandingReceivables,
      },
      auditLogs,
    },
  });
});

export const addStudent = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { email, firstName, lastName, matricNumber, password, college, department, program } = req.body;

  if (!email || !firstName || !lastName || !matricNumber) {
    return next(new AppError('Please provide all required fields', 400));
  }

  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [
        { email },
        { matricNumber }
      ]
    }
  });

  if (existingUser) {
    return next(new AppError('User with this email or matric number already exists', 400));
  }

  const initialPassword = password || matricNumber;
  const hashedPassword = await bcrypt.hash(initialPassword, 12);

  await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email,
        firstName,
        lastName,
        matricNumber,
        password: hashedPassword,
          college,
          department,
          program,
        role: Role.STUDENT,
      }
    });

    await tx.auditLog.create({
      data: {
        action: 'STUDENT_CREATED',
        userId: req.user!.id,
        details: { newStudentEmail: email, matricNumber },
        ipAddress: req.ip
      }
    });
  });

  res.status(201).json({
    status: 'success',
    message: 'Student added successfully'
  });
});
