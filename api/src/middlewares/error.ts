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
    // Production — NEVER expose stack, SQL, Prisma internals, env, secrets, paths
    console.error('ERROR 💥', err);
    if (err.isOperational) {
      sendJson({
        status: err.status,
        message: err.message,
        details: err.details,
      });
    } else {
      // Classify common server errors into safe user-facing messages.
      // The actual detailed error has already been logged above (console.error).
      let safeMessage = 'Something went very wrong!';
      const code = err?.code;
      const errName = String(err?.name ?? '').toLowerCase();
      const errMsg = String(err?.message ?? '').toLowerCase();
      if (code === 'P2002' || errName.includes('unique') || errMsg.includes('unique constraint')) {
        safeMessage = 'Unable to complete your request. Please retry.';
      } else if (code === 'P2025' || errMsg.includes('record to update was not found')) {
        safeMessage = 'The requested record could not be found.';
      } else if (code && typeof code === 'string' && code.startsWith('P20')) {
        // All Prisma-known operational classes produce the same safe message.
        safeMessage = 'Unable to complete your request. Please retry.';
      } else if (err.isAxiosError || errName.includes('axios') || errMsg.includes('network')) {
        safeMessage = 'Unable to reach the payment provider. Please retry in a moment.';
      }
      sendJson({
        status: 'error',
        message: safeMessage,
      });
    }
  }
};
