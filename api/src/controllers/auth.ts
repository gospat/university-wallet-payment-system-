import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth';
import { catchAsync } from '../utils/catchAsync';

export const signup = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token } = await AuthService.signup(req.body);

  res.status(201).json({
    status: 'success',
    token,
    data: { user },
  });
});

export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token } = await AuthService.login(req.body);

  res.status(200).json({
    status: 'success',
    token,
    data: { user },
  });
});
