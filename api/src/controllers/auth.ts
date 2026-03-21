import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth';
import { catchAsync } from '../utils/catchAsync';
import prisma from '../config/database';

export const signup = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token } = await AuthService.signup(req.body);

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'SIGNUP',
      details: { email: user.email, role: user.role },
      ipAddress: req.ip,
    },
  });

  res.status(201).json({
    status: 'success',
    token,
    data: { user },
  });
});

export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token } = await AuthService.login(req.body);

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'LOGIN',
      details: { email: user.email, role: user.role },
      ipAddress: req.ip,
    },
  });

  res.status(200).json({
    status: 'success',
    token,
    data: { user },
  });
});
