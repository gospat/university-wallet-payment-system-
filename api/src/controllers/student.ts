// =============================================================================
// Student Controller (Admin/Bursary) + student self-service endpoints
// REST endpoints for CRUD/search/lifecycle wired in routes/students.ts
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import {
  CreateStudentSchema,
  StudentQuerySchema,
  StudentSelfUpdateSchema,
  StudentService,
  UpdateStudentSchema,
} from '../services/student';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { z } from 'zod';
import { AppError } from '../utils/AppError';
import { i18n } from '../i18n/en';
import { reqIp, reqUa } from '../utils/http';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const StatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN']) });
const PasswordResetSchema = z.object({ newPassword: z.string().min(8).max(128).trim().optional() });

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------
export const listStudents = [
  validateQuery(StudentQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const result = await StudentService.search(req.query as any);
    res.status(200).json({ status: 'success', data: result });
  }),
];

export const getStudent = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const user = await StudentService.getById(Number(req.params.id));
    res.status(200).json({ status: 'success', data: { user } });
  }),
];

export const getStudentByMatric = [
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const m = String(req.params.matric || '').trim();
    if (!m) return next(new AppError('matric number required', 400));
    const user = await StudentService.getByMatric(m);
    const preview = {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      matricNumber: user.matricNumber,
      email: user.email,
      college: user.college,
      department: user.department,
      programme: user.program,
      level: user.level,
      accountStatus: user.accountStatus,
    };
    res.status(200).json({ status: 'success', data: { student: preview } });
  }),
];

export const createStudent = [
  validateBody(CreateStudentSchema),
  catchAsync(async (req: Request, res: Response) => {
    if (!req.user) return;
    const user = await StudentService.create(req.body, req.user.id, {
      ip: reqIp(req), userAgent: reqUa(req),
    });
    res.status(201).json({ status: 'success', data: { user } });
  }),
];

export const updateStudent = [
  validateParams(IdParam),
  validateBody(UpdateStudentSchema),
  catchAsync(async (req: Request, res: Response) => {
    if (!req.user) return;
    const user = await StudentService.update(Number(req.params.id), req.body, req.user.id, {
      ip: reqIp(req), userAgent: reqUa(req),
    });
    res.status(200).json({ status: 'success', data: { user } });
  }),
];

export const setStudentStatus = [
  validateParams(IdParam),
  validateBody(StatusSchema),
  catchAsync(async (req: Request, res: Response) => {
    if (!req.user) return;
    const user = await StudentService.setAccountStatus(
      Number(req.params.id),
      req.body.status,
      req.user.id,
      { ip: reqIp(req), userAgent: reqUa(req) },
    );
    res.status(200).json({ status: 'success', data: { user } });
  }),
];

export const resetStudentPassword = [
  validateParams(IdParam),
  validateBody(PasswordResetSchema.partial().passthrough()),
  catchAsync(async (req: Request, res: Response) => {
    if (!req.user) return;
    const { temporaryPassword } = await StudentService.resetPassword(
      Number(req.params.id),
      req.user.id,
      { ip: reqIp(req), userAgent: reqUa(req), newPassword: req.body?.newPassword },
    );
    res.status(200).json({ status: 'success', data: { temporaryPassword } });
  }),
];

// -----------------------------------------------------------------------------
// Student self-service (the currently authenticated student)
// GET    /me       → own profile
// PATCH  /me       → edit contact info (first/last/phone/email/address only)
// -----------------------------------------------------------------------------
export const getMe = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
  const user = await StudentService.getById(req.user.id);
  res.status(200).json({ status: 'success', data: { user } });
});

export const updateMe = [
  validateBody(StudentSelfUpdateSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    const user = await StudentService.selfUpdate(req.user.id, req.body, {
      ip: reqIp(req), userAgent: reqUa(req),
    });
    res.status(200).json({ status: 'success', data: { user } });
  }),
];
