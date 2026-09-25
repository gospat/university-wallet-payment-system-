import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/AppError';
import prisma from '../config/database';
import { Role, AccountStatus } from '@prisma/client';
import { catchAsync } from '../utils/catchAsync';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        role: Role;
        permissions?: string[];
      };
    }
  }
}

export const protect = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer')) {
      token = authHeader.split(' ')[1];
    }
    if (!token && typeof (req.query as any).access_token === 'string') {
      token = (req.query as any).access_token;
    }

    if (!token) {
      return next(new AppError('You are not logged in! Please log in to get access.', 401));
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET as string);
    } catch (err) {
      return next(new AppError('Invalid token. Please log in again.', 401));
    }

    if (typeof decoded !== 'object' || !decoded || typeof decoded.id !== 'number') {
      return next(new AppError('Invalid token. Please log in again.', 401));
    }

    if (decoded.type && decoded.type !== 'access') {
      return next(new AppError('Invalid token type. Please use an access token.', 401));
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, role: true, accountStatus: true },
    });

    if (!currentUser) {
      return next(new AppError('The user belonging to this token no longer exists.', 401));
    }

    if (currentUser.accountStatus !== AccountStatus.ACTIVE) {
      return next(
        new AppError(
          'This account is no longer active. Please contact the administrator.',
          403
        )
      );
    }

    const decodedPermissions = Array.isArray((decoded as any).permissions)
      ? ((decoded as any).permissions as string[])
      : [];

    req.user = {
      id: currentUser.id,
      role: currentUser.role as Role,
      permissions: decodedPermissions,
    };
    next();
  }
);

export const restrictTo = (...roles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    next();
  };
};

export const requirePermission = (permKey: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied.',
      });
    }
    if (user.role === 'ADMIN') {
      return next();
    }
    if (user.role === 'BURSARY' && (permKey === 'VIEW_PAYMENTS' || permKey === 'VIEW_RECEIPTS' || permKey === 'GENERATE_RECEIPT' || permKey === 'MANAGE_PAYMENTS')) {
      return next();
    }
    const perms = user.permissions;
    if (!Array.isArray(perms) || !perms.includes(permKey)) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied.',
      });
    }
    next();
  };
};
