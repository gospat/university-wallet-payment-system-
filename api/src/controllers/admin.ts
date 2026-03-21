import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import bcrypt from 'bcrypt';
import { Role } from '@prisma/client';

export const getDashboardStats = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  // 1. Total Students
  const totalStudents = await prisma.user.count({
    where: { role: 'STUDENT' },
  });

  // 2. Total Deposits (Sum of successful deposit transactions)
  const totalDepositsResult = await prisma.transaction.aggregate({
    where: {
      type: 'DEPOSIT',
      status: 'SUCCESS',
    },
    _sum: {
      amount: true,
    },
  });
  const totalDeposits = totalDepositsResult._sum.amount || 0;

  // 3. Active Wallets (Count of wallets with status ACTIVE)
  const activeWallets = await prisma.wallet.count({
    where: { status: 'ACTIVE' },
  });

  // 4. Pending Requests (Count of pending withdrawals)
  const pendingRequests = await prisma.transaction.count({
    where: {
      type: 'WITHDRAWAL',
      status: 'PENDING',
    },
  });

  // 5. Recent Audit Logs
  const auditLogs = await prisma.auditLog.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { firstName: true, lastName: true } } }, // Include user details
  });

  res.status(200).json({
    status: 'success',
    data: {
      stats: {
        totalStudents,
        totalDeposits,
        activeWallets,
        pendingRequests,
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

    await tx.wallet.create({
      data: {
        userId: newUser.id,
        balance: 0,
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
