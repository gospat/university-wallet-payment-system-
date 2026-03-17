import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth';
import { catchAsync } from '../utils/catchAsync';

export const signup = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token } = await AuthService.signup(req.body);

  res.status(201).json({
    status: 'success',
    token,
    data: {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        matricNumber: user.matricNumber,
        college: user.college,
        department: user.department,
        program: user.program
      },
    },
  });
});

export const login = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const { user, token } = await AuthService.login(req.body);

  res.status(200).json({
    status: 'success',
    token,
    data: {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        matricNumber: user.matricNumber,
        college: user.college,
        department: user.department,
        program: user.program
      },
    },
  });
});
