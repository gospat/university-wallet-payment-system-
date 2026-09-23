import express, { Request, Response } from 'express';
import { z } from 'zod';
import { protect, restrictTo } from '../middlewares/auth';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { catchAsync } from '../utils/catchAsync';
import {
  FacultyService,
  DepartmentService,
  ProgrammeService,
  LevelService,
  AcademicSessionService,
  CreateFacultySchema,
  UpdateFacultySchema,
  CreateDepartmentSchema,
  UpdateDepartmentSchema,
  CreateProgrammeSchema,
  UpdateProgrammeSchema,
  CreateLevelSchema,
  UpdateLevelSchema,
  CreateAcademicSessionSchema,
  UpdateAcademicSessionSchema,
  ListQuerySchema,
} from '../services/academic';

const router = express.Router();

const IdParam = z.object({ id: z.coerce.number().int().positive() });

router.use(protect);

// ============ FACULTY ============
router.get(
  '/faculties',
  restrictTo('ADMIN', 'BURSARY'),
  validateQuery(ListQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await FacultyService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  })
);

router.get(
  '/faculties/:id',
  restrictTo('ADMIN', 'BURSARY'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const faculty = await FacultyService.get(Number(req.params.id));
    res.status(200).json({ status: 'success', data: { faculty } });
  })
);

router.post(
  '/faculties',
  restrictTo('ADMIN'),
  validateBody(CreateFacultySchema),
  catchAsync(async (req: Request, res: Response) => {
    const created = await FacultyService.create(req.body, req);
    res.status(201).json({ status: 'success', data: { faculty: created } });
  })
);

router.patch(
  '/faculties/:id',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  validateBody(UpdateFacultySchema),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await FacultyService.update(Number(req.params.id), req.body, req);
    res.status(200).json({ status: 'success', data: { faculty: updated } });
  })
);

router.post(
  '/faculties/:id/deactivate',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await FacultyService.deactivate(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: { faculty: updated } });
  })
);

// ============ DEPARTMENT ============
router.get(
  '/departments',
  restrictTo('ADMIN', 'BURSARY'),
  validateQuery(ListQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await DepartmentService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  })
);

router.get(
  '/departments/:id',
  restrictTo('ADMIN', 'BURSARY'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const department = await DepartmentService.get(Number(req.params.id));
    res.status(200).json({ status: 'success', data: { department } });
  })
);

router.post(
  '/departments',
  restrictTo('ADMIN'),
  validateBody(CreateDepartmentSchema),
  catchAsync(async (req: Request, res: Response) => {
    const created = await DepartmentService.create(req.body, req);
    res.status(201).json({ status: 'success', data: { department: created } });
  })
);

router.patch(
  '/departments/:id',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  validateBody(UpdateDepartmentSchema),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await DepartmentService.update(Number(req.params.id), req.body, req);
    res.status(200).json({ status: 'success', data: { department: updated } });
  })
);

router.post(
  '/departments/:id/deactivate',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await DepartmentService.deactivate(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: { department: updated } });
  })
);

// ============ PROGRAMME ============
router.get(
  '/programmes',
  restrictTo('ADMIN', 'BURSARY'),
  validateQuery(ListQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await ProgrammeService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  })
);

router.get(
  '/programmes/:id',
  restrictTo('ADMIN', 'BURSARY'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const programme = await ProgrammeService.get(Number(req.params.id));
    res.status(200).json({ status: 'success', data: { programme } });
  })
);

router.post(
  '/programmes',
  restrictTo('ADMIN'),
  validateBody(CreateProgrammeSchema),
  catchAsync(async (req: Request, res: Response) => {
    const created = await ProgrammeService.create(req.body, req);
    res.status(201).json({ status: 'success', data: { programme: created } });
  })
);

router.patch(
  '/programmes/:id',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  validateBody(UpdateProgrammeSchema),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await ProgrammeService.update(Number(req.params.id), req.body, req);
    res.status(200).json({ status: 'success', data: { programme: updated } });
  })
);

router.post(
  '/programmes/:id/deactivate',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await ProgrammeService.deactivate(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: { programme: updated } });
  })
);

// ============ LEVEL ============
router.get(
  '/levels',
  restrictTo('ADMIN', 'BURSARY'),
  validateQuery(ListQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await LevelService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  })
);

router.get(
  '/levels/:id',
  restrictTo('ADMIN', 'BURSARY'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const level = await LevelService.get(Number(req.params.id));
    res.status(200).json({ status: 'success', data: { level } });
  })
);

router.post(
  '/levels',
  restrictTo('ADMIN'),
  validateBody(CreateLevelSchema),
  catchAsync(async (req: Request, res: Response) => {
    const created = await LevelService.create(req.body, req);
    res.status(201).json({ status: 'success', data: { level: created } });
  })
);

router.patch(
  '/levels/:id',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  validateBody(UpdateLevelSchema),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await LevelService.update(Number(req.params.id), req.body, req);
    res.status(200).json({ status: 'success', data: { level: updated } });
  })
);

router.post(
  '/levels/:id/deactivate',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await LevelService.deactivate(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: { level: updated } });
  })
);

// ============ ACADEMIC SESSION ============
router.get(
  '/sessions',
  restrictTo('ADMIN', 'BURSARY'),
  validateQuery(ListQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await AcademicSessionService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  })
);

router.get(
  '/sessions/:id',
  restrictTo('ADMIN', 'BURSARY'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const session = await AcademicSessionService.get(Number(req.params.id));
    res.status(200).json({ status: 'success', data: { session } });
  })
);

router.post(
  '/sessions',
  restrictTo('ADMIN'),
  validateBody(CreateAcademicSessionSchema),
  catchAsync(async (req: Request, res: Response) => {
    const created = await AcademicSessionService.create(req.body, req);
    res.status(201).json({ status: 'success', data: { session: created } });
  })
);

router.patch(
  '/sessions/:id',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  validateBody(UpdateAcademicSessionSchema),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await AcademicSessionService.update(Number(req.params.id), req.body, req);
    res.status(200).json({ status: 'success', data: { session: updated } });
  })
);

router.post(
  '/sessions/:id/deactivate',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const updated = await AcademicSessionService.deactivate(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: { session: updated } });
  })
);

export default router;
