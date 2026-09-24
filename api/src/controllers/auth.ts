import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth';
import { catchAsync } from '../utils/catchAsync';
import { z } from 'zod';
import { validateBody } from '../middlewares/validate';
import { reqIp, reqUa } from '../utils/http';

export const signup = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token } = await AuthService.signup(req.body);

  res.status(201).json({
    status: 'success',
    token,
    data: { user },
  });
});

export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token } = await AuthService.login(req.body, reqIp(req), reqUa(req));

  res.status(200).json({
    status: 'success',
    token,
    data: { user },
  });
});

export const me = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next();
  const user = await AuthService.me(req.user.id);
  res.status(200).json({
    status: 'success',
    data: { user },
  });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

export const changePassword = [
  validateBody(changePasswordSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next();
    await AuthService.changePassword(
      req.user.id,
      req.body.currentPassword,
      req.body.newPassword
    );
    res.status(200).json({
      status: 'success',
      message: 'Password changed successfully.',
    });
  }),
];
