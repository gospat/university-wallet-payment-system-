import { NextFunction, Request, Response } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { AppError } from '../utils/AppError';

export const formatZodError = (err: ZodError) => {
  return err.issues.map((i) => ({
    path: i.path.join('.') || '(root)',
    code: i.code,
    message: i.message,
    received: (i as any)?.received !== undefined ? String((i as any).received) : undefined,
    expected: (i as any)?.expected !== undefined ? String((i as any).expected) : undefined,
  }));
};

function summarizeFirst(err: ZodError, noun: string) {
  const first = err.issues[0];
  if (!first) return `Invalid ${noun}`;
  const path = first.path.join('.') || 'value';
  const msg = first.message || `Invalid ${path}`;
  const allCount = err.issues.length;
  return allCount <= 1
    ? `Invalid ${noun}: ${path} — ${msg}`
    : `Invalid ${noun}: ${path} — ${msg} (+${allCount - 1} more issue${allCount - 1 === 1 ? '' : 's'})`;
}

export const validateBody =
  <T>(schema: ZodSchema<T>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      return next(new AppError(summarizeFirst(result.error, 'request body'), 400, formatZodError(result.error)));
    }
    req.body = result.data as any;
    next();
  };

export const validateParams =
  <T>(schema: ZodSchema<T>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params ?? {});
    if (!result.success) {
      return next(new AppError(summarizeFirst(result.error, 'URL params'), 400, formatZodError(result.error)));
    }
    req.params = result.data as any;
    next();
  };

export const validateQuery =
  <T>(schema: ZodSchema<T>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      return next(new AppError(summarizeFirst(result.error, 'filters'), 400, formatZodError(result.error)));
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

