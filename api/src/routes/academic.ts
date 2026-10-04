import express, { Request, Response } from 'express';
import { z } from 'zod';
import { IncomingMessage } from 'http';
import path from 'path';
import fs from 'fs';
import formidable, { Fields, Files, Part } from 'formidable';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import { validateSpreadsheetBytes } from '../utils/security';
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
import {
  downloadTemplateCsv,
  downloadTemplateXlsx,
  importColleges,
  importDepartments,
  importProgrammes,
  buildErrorsCsv,
  BulkKind,
} from '../services/academicBulkImport';
import { assertCanManageTemplates } from '../utils/templateAuth';

const router = express.Router();

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const ALLOWED_EXT = new Set(['.csv', '.xlsx', '.xls']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function ensureTmpDir() {
  const dir = path.join(process.cwd(), 'tmp', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseMultipartForm(req: IncomingMessage): Promise<{ fields: Fields; files: Files }> {
  const uploadDir = ensureTmpDir();
  const form = formidable({
    uploadDir,
    keepExtensions: true,
    maxFileSize: MAX_FILE_BYTES,
    filter: ({ originalFilename }: Part) => {
      if (!originalFilename) return false;
      const ext = path.extname(originalFilename).toLowerCase();
      return ALLOWED_EXT.has(ext);
    },
  });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) {
        if ((err as any).code === 1009) {
          return reject(new AppError(`File too large. Maximum size is ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413));
        }
        return reject(err);
      }
      resolve({ fields, files });
    });
  });
}

async function runBulkImport(
  kind: BulkKind,
  req: Request,
  res: Response,
  next: express.NextFunction
) {
  if (!req.user) return next(new AppError('Not logged in', 401));
  let parsed: { fields: Fields; files: Files } | null = null;
  try {
    parsed = await parseMultipartForm(req);
  } catch (err) {
    return next(err instanceof AppError ? err : new AppError('Please upload a CSV, XLSX, or XLS file.', 400));
  }
  const file = Array.isArray(parsed.files.file) ? parsed.files.file[0] : parsed.files.file;
  if (!file || !file.originalFilename || !file.filepath) {
    return next(new AppError('No file uploaded. Please attach a CSV, XLSX, or XLS file to the "file" field.', 400));
  }
  const ext = path.extname(file.originalFilename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return next(new AppError('Unsupported file format. Please use CSV, XLSX, or XLS.', 400));
  const v = validateSpreadsheetBytes(file.filepath, ext);
  if (!v.ok) return next(new AppError(v.error!, 400));

  try {
    let result;
    if (kind === 'college') result = await importColleges(file.filepath, file.originalFilename, req);
    else if (kind === 'department') result = await importDepartments(file.filepath, file.originalFilename, req);
    else result = await importProgrammes(file.filepath, file.originalFilename, req);

    let errorsCsvUrl: string | null = null;
    if (result.errors.length > 0) {
      const outDir = path.join(process.cwd(), 'tmp', 'uploads');
      fs.mkdirSync(outDir, { recursive: true });
      const fname = `${kind}-import-errors-${Date.now()}.csv`;
      const fpath = path.join(outDir, fname);
      fs.writeFileSync(fpath, buildErrorsCsv(result.errors, kind), 'utf-8');
      errorsCsvUrl = `/api/v1/academic/_errors/${fname}`;
    }

    try { fs.unlinkSync(file.filepath); } catch {}

    res.status(200).json({
      status: 'success',
      data: {
        created: result.created,
        skipped: result.skipped,
        errors: result.errors,
        ids: result.ids,
        createdItems: result.createdItems,
        errorsCsvUrl,
      },
    });
  } catch (e) {
    return next(e instanceof AppError ? e : new AppError('Bulk import failed. Please check the file format and try again.', 400));
  }
}

// ============ TEMPLATE ROUTES (mounted BEFORE protect — inline auth with HTML fallback) ============

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// --- Faculties templates (ADMIN | BURSARY) ---
router.get(
  '/faculties/template.csv',
  catchAsync(async (req: Request, res: Response) => {
    const auth = await assertCanManageTemplates(req, ['ADMIN', 'BURSARY'], { frontendUrl: FRONTEND_URL });
    if (!auth.ok) {
      return res.status(401).type('text/html').send(auth.html!);
    }
    const t = downloadTemplateCsv('college');
    res.attachment(t.filename);
    res.setHeader('Content-Type', t.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(t.content);
  })
);

router.get(
  '/faculties/template.xlsx',
  catchAsync(async (req: Request, res: Response) => {
    const auth = await assertCanManageTemplates(req, ['ADMIN', 'BURSARY'], { frontendUrl: FRONTEND_URL });
    if (!auth.ok) {
      return res.status(401).type('text/html').send(auth.html!);
    }
    const t = await downloadTemplateXlsx('college');
    res.attachment(t.filename);
    res.setHeader('Content-Type', t.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(t.buffer);
  })
);

// --- Departments templates (ADMIN | BURSARY) ---
router.get(
  '/departments/template.csv',
  catchAsync(async (req: Request, res: Response) => {
    const auth = await assertCanManageTemplates(req, ['ADMIN', 'BURSARY'], { frontendUrl: FRONTEND_URL });
    if (!auth.ok) {
      return res.status(401).type('text/html').send(auth.html!);
    }
    const t = downloadTemplateCsv('department');
    res.attachment(t.filename);
    res.setHeader('Content-Type', t.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(t.content);
  })
);

router.get(
  '/departments/template.xlsx',
  catchAsync(async (req: Request, res: Response) => {
    const auth = await assertCanManageTemplates(req, ['ADMIN', 'BURSARY'], { frontendUrl: FRONTEND_URL });
    if (!auth.ok) {
      return res.status(401).type('text/html').send(auth.html!);
    }
    const t = await downloadTemplateXlsx('department');
    res.attachment(t.filename);
    res.setHeader('Content-Type', t.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(t.buffer);
  })
);

// --- Programmes templates (ADMIN | BURSARY) ---
router.get(
  '/programmes/template.csv',
  catchAsync(async (req: Request, res: Response) => {
    const auth = await assertCanManageTemplates(req, ['ADMIN', 'BURSARY'], { frontendUrl: FRONTEND_URL });
    if (!auth.ok) {
      return res.status(401).type('text/html').send(auth.html!);
    }
    const t = downloadTemplateCsv('programme');
    res.attachment(t.filename);
    res.setHeader('Content-Type', t.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(t.content);
  })
);

router.get(
  '/programmes/template.xlsx',
  catchAsync(async (req: Request, res: Response) => {
    const auth = await assertCanManageTemplates(req, ['ADMIN', 'BURSARY'], { frontendUrl: FRONTEND_URL });
    if (!auth.ok) {
      return res.status(401).type('text/html').send(auth.html!);
    }
    const t = await downloadTemplateXlsx('programme');
    res.attachment(t.filename);
    res.setHeader('Content-Type', t.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(t.buffer);
  })
);

router.use(protect);

// ============ FACULTY ============
router.get(
  '/faculties',
  restrictTo('ADMIN', 'BURSARY'),
  requirePermission('VIEW_COLLEGES'),
  validateQuery(ListQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await FacultyService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  })
);

router.get(
  '/faculties/:id',
  restrictTo('ADMIN', 'BURSARY'),
  requirePermission('VIEW_COLLEGES'),
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

router.post(
  '/faculties/bulk-import',
  restrictTo('ADMIN'),
  catchAsync((req: Request, res: Response, next: express.NextFunction) => runBulkImport('college', req, res, next))
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

router.delete(
  '/faculties/:id',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const removed = await FacultyService.remove(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: removed });
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
  requirePermission('VIEW_DEPARTMENTS'),
  validateQuery(ListQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await DepartmentService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  })
);

router.get(
  '/departments/:id',
  restrictTo('ADMIN', 'BURSARY'),
  requirePermission('VIEW_DEPARTMENTS'),
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

router.post(
  '/departments/bulk-import',
  restrictTo('ADMIN'),
  catchAsync((req: Request, res: Response, next: express.NextFunction) => runBulkImport('department', req, res, next))
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

router.delete(
  '/departments/:id',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const removed = await DepartmentService.remove(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: removed });
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
  requirePermission('VIEW_PROGRAMMES'),
  validateQuery(ListQuerySchema),
  catchAsync(async (req: Request, res: Response) => {
    const data = await ProgrammeService.list(req.query as any);
    res.status(200).json({ status: 'success', data });
  })
);

router.get(
  '/programmes/:id',
  restrictTo('ADMIN', 'BURSARY'),
  requirePermission('VIEW_PROGRAMMES'),
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

router.post(
  '/programmes/bulk-import',
  restrictTo('ADMIN'),
  catchAsync((req: Request, res: Response, next: express.NextFunction) => runBulkImport('programme', req, res, next))
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

router.delete(
  '/programmes/:id',
  restrictTo('ADMIN'),
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response) => {
    const removed = await ProgrammeService.remove(Number(req.params.id), req);
    res.status(200).json({ status: 'success', data: removed });
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

router.get(
  '/_errors/:filename',
  restrictTo('ADMIN'),
  catchAsync(async (req: Request, res: Response, next: express.NextFunction) => {
    const fname = String(req.params.filename ?? '');
    if (!/^[a-z0-9-]+\.csv$/i.test(fname)) return next(new AppError('Invalid filename', 400));
    const fpath = path.join(process.cwd(), 'tmp', 'uploads', fname);
    if (!fs.existsSync(fpath)) return next(new AppError('Errors file not found — it may have expired.', 404));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(fname);
    res.status(200).send(fs.readFileSync(fpath, 'utf-8'));
  })
);

// ============ LEVEL ============
// TODO: Add VIEW_LEVELS permission key to permissionSeed.ts and requirePermission('VIEW_LEVELS')
// to GET /levels and GET /levels/:id routes once the perm key exists.
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
// TODO: Add VIEW_SESSIONS permission key to permissionSeed.ts and requirePermission('VIEW_SESSIONS')
// to GET /sessions and GET /sessions/:id routes once the perm key exists.
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
