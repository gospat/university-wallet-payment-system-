import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';

export const globalErrorHandler = (
  err: AppError | any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  const sendJson = (payload: Record<string, unknown>) => {
    try {
      if (res && typeof res.status === 'function' && !res.headersSent) {
        res.status(err.statusCode).json(payload);
        return;
      }
    } catch {
      // fallthrough to raw write
    }
    try {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify(payload));
    } catch {
      // ultimate fallback — nothing else we can do
    }
  };

  if (process.env.NODE_ENV === 'development') {
    sendJson({
      status: err.status,
      message: err.message,
      details: err.details,
      stack: err.stack,
    });
  } else {
    // Production
    if (err.isOperational) {
      sendJson({
        status: err.status,
        message: err.message,
        details: err.details,
      });
    } else {
      console.error('ERROR 💥', err);
      sendJson({
        status: 'error',
        message: 'Something went very wrong!',
      });
    }
  }
};
