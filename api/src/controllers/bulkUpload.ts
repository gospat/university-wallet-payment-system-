// =============================================================================
// Bulk Upload Controller (Admin) + file parser
// POST   /api/v1/admin/students/upload         → stage upload → preview
// GET    /api/v1/admin/students/upload/:id     → re-fetch preview/errors
// POST   /api/v1/admin/students/upload/:id/confirm → execute import with strategy
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import { IncomingMessage } from 'http';
import formidable, { Fields, Files, Part } from 'formidable';
import path from 'path';
import fs from 'fs';
import { BulkStudentUploadService } from '../services/studentImport';
import { AppError } from '../utils/AppError';
import { validateSpreadsheetBytes } from '../utils/security';
import { i18n } from '../i18n/en';
import { z } from 'zod';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { reqIp, reqUa } from '../utils/http';

const ALLOWED_EXT = new Set(['.csv', '.xlsx', '.xls']);
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB — plenty for 200k row Excel

function ensureTmpDir() {
  const dir = path.join(process.cwd(), 'tmp', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Best-effort removal of a multipart temp file. Never throws — cleanup must
 * not change (or mask) the handler's real outcome.
 */
function cleanupTempFile(filePath?: string | null): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already removed or inaccessible — ignore.
  }
}

const ConfirmSchema = z.object({
  duplicateStrategy: z.enum(['SKIP', 'UPDATE', 'CANCEL']).default('SKIP'),
  sendCredentialEmails: z.boolean().optional().default(false),
});

const IdParam = z.object({ id: z.string().min(3).max(100).trim() });

const RunRowIdParam = z.object({ id: z.coerce.number().int().positive() });

const ListRunsQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const ListRunRowsQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'SKIPPED']).optional(),
});

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
        // Formidable uses code 1016 (biggerThanMaxFileSize) for a single file
        // over maxFileSize and 1009 (biggerThanTotalMaxFileSize) for the total;
        // map BOTH to a clear 413 instead of a generic 400.
        const code = (err as any).code;
        if (code === 1009 || code === 1016) {
          return reject(new AppError(`File too large. Maximum size is ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413));
        }
        return reject(err);
      }
      resolve({ fields, files });
    });
  });
}

export const stageStudentUpload = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
  let parsed: { fields: Fields; files: Files } | null = null;
  try {
    parsed = await parseMultipartForm(req);
  } catch (err) {
    return next(err instanceof AppError ? err : new AppError(i18n.errors.upload.fileRequired, 400));
  }
  const file = Array.isArray(parsed.files.file) ? parsed.files.file[0] : parsed.files.file;
  if (!file || !file.originalFilename || !file.filepath) {
    return next(new AppError(i18n.errors.upload.fileRequired, 400));
  }
  // From here on the multipart temp file exists on disk. Guarantee it is
  // removed on EVERY exit path (success, validation error, parse error).
  try {
    const ext = path.extname(file.originalFilename).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return next(new AppError(i18n.errors.upload.unsupportedFormat, 400));
    const v = validateSpreadsheetBytes(file.filepath, ext);
    if (!v.ok) return next(new AppError(v.error!, 400));

    try {
      const result = await BulkStudentUploadService.stageUpload({
        filePath: file.filepath,
        fileName: file.originalFilename,
        actorId: req.user.id,
      });
      res.status(200).json({ status: 'success', data: result });
    } catch (e) {
      if (e instanceof AppError) return next(e);
      // Preserve the actual error message in the SERVER logs (critical for
      // operators debugging a bad XLSX import) but NEVER surface parser/library
      // internals (filesystem paths, stack traces) to the client.
      console.error(
        `[bulkUpload] stageStudentUpload unhandled error fileName=${JSON.stringify(file.originalFilename)} actorId=${req.user.id}:`,
        e,
      );
      return next(new AppError(i18n.errors.upload.importFailed, 400));
    }
  } finally {
    cleanupTempFile(file.filepath);
  }
});

export const previewStudentUpload = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    try {
      const data = await BulkStudentUploadService.preview(req.params.id, req.user.id);
      res.status(200).json({ status: 'success', data });
    } catch (e) {
      return next(e instanceof AppError ? e : new AppError(i18n.errors.upload.importFailed, 400));
    }
  }),
];

export const confirmStudentUpload = [
  validateParams(IdParam),
  validateBody(ConfirmSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    const { duplicateStrategy, sendCredentialEmails } = req.body as {
      duplicateStrategy: 'SKIP' | 'UPDATE' | 'CANCEL';
      sendCredentialEmails: boolean;
    };
    try {
      if (duplicateStrategy === 'CANCEL') {
        // CANCEL is a no-op: it never creates rows. It stays synchronous and
        // keeps the exact legacy 200 response shape.
        const data = await BulkStudentUploadService.confirmImport({
          uploadId: req.params.id,
          actorId: req.user.id,
          strategy: duplicateStrategy,
          ip: reqIp(req),
          userAgent: reqUa(req),
        });
        res.status(200).json({ status: 'success', data });
        return;
      }
      // SKIP / UPDATE now persist the run and hand row creation to the
      // background worker, so the request returns quickly (202 Accepted).
      const data = await BulkStudentUploadService.startImport({
        uploadId: req.params.id,
        actorId: req.user.id,
        strategy: duplicateStrategy,
        ip: reqIp(req),
        userAgent: reqUa(req),
        sendCredentialEmails,
      });
      res.status(202).json({ status: 'success', data });
    } catch (e) {
      return next(e instanceof AppError ? e : new AppError(i18n.errors.upload.importFailed, 400));
    }
  }),
];

/**
 * Download an error CSV for a given upload id. The admin clicks the
 * "Download error report" button and receives a CSV with the problematic
 * rows + error_code/error_message columns prepended.
 */
export const downloadErrorCsv = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    const preview = await BulkStudentUploadService.preview(req.params.id, req.user.id);
    if (!preview.errorCsvPath || !fs.existsSync(preview.errorCsvPath)) {
      return next(new AppError('No error report available for this upload.', 404));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="upload-${req.params.id}-errors.csv"`);
    fs.createReadStream(preview.errorCsvPath).pipe(res);
  }),
];

// =============================================================================
// Background student-import runs (paginated history, live progress, credentials)
// =============================================================================

/** GET /admin/students/imports — paginated list of background import runs. */
export const listImportRuns = [
  validateQuery(ListRunsQuery),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    const data = await BulkStudentUploadService.listRuns({
      page: Number(req.query.page),
      pageSize: Number(req.query.pageSize),
    });
    res.status(200).json({ status: 'success', data });
  }),
];

/** GET /admin/students/imports/:uuid — one run plus live progress counters. */
export const getImportRun = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    const data = await BulkStudentUploadService.getRun(req.params.id, req.user.id);
    res.status(200).json({ status: 'success', data });
  }),
];

/** GET /admin/students/imports/:uuid/rows — paginated per-row status. */
export const listImportRunRows = [
  validateParams(IdParam),
  validateQuery(ListRunRowsQuery),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    const data = await BulkStudentUploadService.listRunRows(req.params.id, {
      page: Number(req.query.page),
      pageSize: Number(req.query.pageSize),
      status: req.query.status as 'PENDING' | 'SUCCESS' | 'FAILED' | 'SKIPPED' | undefined,
    });
    res.status(200).json({ status: 'success', data });
  }),
];

/** GET /admin/students/imports/:uuid/credentials.csv — download generated credentials. */
export const downloadCredentialsCsv = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    const { fileName, csv } = await BulkStudentUploadService.buildCredentialsCsvForRun(req.params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.status(200).send(csv);
  }),
];

/** POST /admin/students/imports/rows/:id/resend-credentials — resend one row's login. */
export const resendImportRowCredentials = [
  validateParams(RunRowIdParam),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    const data = await BulkStudentUploadService.resendCredentialsForRow(Number(req.params.id), req.user.id);
    res.status(202).json({ status: 'success', data });
  }),
];
