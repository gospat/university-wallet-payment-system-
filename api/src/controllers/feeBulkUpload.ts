import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import { IncomingMessage } from 'http';
import formidable, { Fields, Files, Part } from 'formidable';
import path from 'path';
import fs from 'fs';
import { stageFeeUpload, previewFeeUpload, confirmFeeImport, getErrorCsvPath } from '../services/feeBulkUpload';
import { AppError } from '../utils/AppError';
import { validateSpreadsheetBytes } from '../utils/security';
import { i18n } from '../i18n/en';
import { z } from 'zod';
import { validateBody, validateParams } from '../middlewares/validate';
import { reqIp, reqUa } from '../utils/http';

const ALLOWED_EXT = new Set(['.csv', '.xlsx', '.xls']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function ensureTmpDir() {
  const dir = path.join(process.cwd(), 'tmp', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const FeeConfirmSchema = z.object({
  duplicateStrategy: z.enum(['SKIP', 'UPDATE', 'ERROR']).default('SKIP'),
});

const IdParam = z.object({ id: z.string().min(3).max(100).trim() });

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

export const stageFeeBulkUpload = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
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
  const ext = path.extname(file.originalFilename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return next(new AppError(i18n.errors.upload.unsupportedFormat, 400));
  const v = validateSpreadsheetBytes(file.filepath, ext);
  if (!v.ok) return next(new AppError(v.error!, 400));

  try {
    const result = await stageFeeUpload({
      filePath: file.filepath,
      fileName: file.originalFilename,
      actorId: req.user.id,
    });
    res.status(200).json({ status: 'success', data: result });
  } catch (e) {
    return next(e instanceof AppError ? e : new AppError(i18n.errors.upload.importFailed, 400));
  }
});

export const previewFeeBulkUpload = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    try {
      const data = await previewFeeUpload(req.params.id, req.user.id);
      res.status(200).json({ status: 'success', data });
    } catch (e) {
      return next(e instanceof AppError ? e : new AppError(i18n.errors.upload.importFailed, 400));
    }
  }),
];

export const confirmFeeBulkUpload = [
  validateParams(IdParam),
  validateBody(FeeConfirmSchema),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    try {
      const data = await confirmFeeImport({
        uploadId: req.params.id,
        actorId: req.user.id,
        strategy: req.body.duplicateStrategy,
        ip: reqIp(req),
        userAgent: reqUa(req),
      });
      res.status(200).json({ status: 'success', data });
    } catch (e) {
      return next(e instanceof AppError ? e : new AppError(i18n.errors.upload.importFailed, 400));
    }
  }),
];

export const downloadFeeErrorCsv = [
  validateParams(IdParam),
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(i18n.errors.auth.notLoggedIn, 401));
    const filePath = getErrorCsvPath(req.params.id, req.user.id);
    if (!filePath || !fs.existsSync(filePath)) {
      return next(new AppError('No error report available for this upload.', 404));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fee-upload-${req.params.id}-errors.csv"`);
    fs.createReadStream(filePath).pipe(res);
  }),
];

export default {
  stageFeeBulkUpload,
  previewFeeBulkUpload,
  confirmFeeBulkUpload,
  downloadFeeErrorCsv,
};
