import { NextFunction, Request, Response } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { AppError } from '../utils/AppError';

const formatZodError = (err: ZodError) => {
  return err.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
};

export const validateBody =
  <T>(schema: ZodSchema<T>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new AppError('Invalid request body', 400, formatZodError(result.error)));
    }
    req.body = result.data as any;
    next();
  };

export const validateParams =
  <T>(schema: ZodSchema<T>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return next(new AppError('Invalid request params', 400, formatZodError(result.error)));
    }
    req.params = result.data as any;
    next();
  };

export const validateQuery =
  <T>(schema: ZodSchema<T>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(new AppError('Invalid request query', 400, formatZodError(result.error)));
    }
    req.query = result.data as any;
    next();
  };

export const requireIdempotencyKey = (req: Request, res: Response, next: NextFunction) => {
  const key = req.header('Idempotency-Key');
  if (!key || key.trim().length < 12) {
    return next(new AppError('Idempotency-Key header is required', 400));
  }
  next();
};

