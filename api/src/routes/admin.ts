import express, { Request, Response, NextFunction } from 'express';
import { getDashboardStats, addStudent } from '../controllers/admin';
import { protect, restrictTo, requirePermission, requireSuperAdmin, bumpRolePermsVersion } from '../middlewares/auth';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { CreateStudentSchema, StudentService } from '../services/student';
import {
  confirmStudentUpload,
  downloadCredentialsCsv,
  downloadErrorCsv,
  getImportRun,
  listImportRunRows,
  listImportRuns,
  previewStudentUpload,
  resendImportRowCredentials,
  stageStudentUpload,
} from '../controllers/bulkUpload';
import { Role, Prisma, AccountStatus, PaymentGateway, EmailType, EmailDeliveryStatus, AccessMode } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { RefundService } from '../services/refund';
import { adminListRefunds, adminApproveRefund, adminRejectRefund } from '../controllers/refunds';
import { catchAsync } from '../utils/catchAsync';
import { AdminSearchService } from '../services/search';
import { SystemSettingsService } from '../services/systemSettings';
import { AdminNotificationService } from '../services/adminNotification';
import { PERMISSION_CATALOGUE, isAdminOnlyPermission, isSuperAdminOnlyPermission } from '../services/permissionSeed';
import {
  getUserAccess,
  getRolePermissions,
  isSuperAdmin,
  resolveEffectivePermissionsForUser,
  type UserAccessDescriptor,
} from '../services/permissionResolver';
import { buildBranding } from '../utils/branding';
import bcrypt from 'bcrypt';
import { reqIp, reqUa } from '../utils/http';
import { buildTwoSheetWorkbook } from '../utils/xlsxTemplate';
import { csvLineSafe, appendCsvIntegrityTrailer } from '../utils/security';
import rateLimit from 'express-rate-limit';
import {
  EmailTemplateService,
  EmailTemplateConfigPatchSchema,
} from '../services/emailTemplate';
import {
  CancelTransactionBodySchema,
  TransactionCancellationService,
} from '../services/transactionCancellation';
import {
  getTransactionForVerify,
  lookupTransactionForVerify,
  verifyPaymentByTransactionId,
} from '../controllers/payments';

const router = express.Router();

// ============ TEMPLATE ROUTES (mounted BEFORE protect — inline auth with HTML fallback) ============
//
// These download endpoints are registered before the router-level protect()
// because their frontend callers use a `?access_token=` query token (a
// browser-navigation download cannot send an Authorization header). The inline
// check therefore does the SAME work protect() would: authenticate, resolve the
// caller's LIVE effective permissions, and authorise on capability — never on
// the bare role. A normal (non-flagged) ADMIN without the capability is denied;
// only a FLAG-AWARE super administrator bypasses the capability floor.

const FRONTEND_URL_ADMIN = process.env.FRONTEND_URL || 'http://localhost:5173';

type TemplateAuthResult = { ok: boolean; html?: string; forbidden?: boolean };

async function templateAuthCheckAdmin(
  req: Request,
  allowedRoles: string[],
  requiredPermission: string,
): Promise<TemplateAuthResult> {
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
  if (!token && typeof (req.query as any).access_token === 'string') {
    token = (req.query as any).access_token as string;
  }
  let userId: number | null = null;
  let userRole: string | null = null;
  let userIsSuperAdmin = false;
  let effectivePermissions: string[] = [];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
      if (typeof decoded?.id === 'number') {
        const u = await prisma.user.findUnique({
          where: { id: decoded.id },
          select: { id: true, role: true, accountStatus: true, isSuperAdmin: true },
        });
        if (u && u.accountStatus === 'ACTIVE') {
          userId = u.id;
          userRole = u.role;
          userIsSuperAdmin = u.role === Role.ADMIN && (u as any).isSuperAdmin === true;
        }
      }
    } catch { /* ignore invalid token — fallback to html login link */ }
  }

  const loginHtml = () => {
    const redirect = encodeURIComponent(req.originalUrl);
    return `<html><head><title>Login Required</title></head><body style="font-family:system-ui,-apple-system,sans-serif;padding:40px;max-width:600px;margin:auto"><h2 style="color:#b91c1c">Login Required</h2><p>Your session expired. Please <a href="${FRONTEND_URL_ADMIN}/login?redirect=${redirect}" style="color:#2563eb;font-weight:600">click here to log in</a>.</p></body></html>`;
  };

  if (!userId || !userRole || !allowedRoles.includes(userRole)) {
    return { ok: false, html: loginHtml() };
  }

  // Resolve the caller's LIVE capability set. The super-admin bypass is the SAME
  // centralised rule used by requirePermission() — it is never duplicated as a
  // bare `role === 'ADMIN'` shortcut.
  if (!userIsSuperAdmin) {
    effectivePermissions = await resolveEffectivePermissionsForUser({
      id: userId,
      role: userRole as Role,
      isSuperAdmin: false,
    });
    if (!effectivePermissions.includes(requiredPermission)) {
      return { ok: false, forbidden: true };
    }
  }

  (req as any).user = {
    id: userId,
    role: userRole as Role,
    isSuperAdmin: userIsSuperAdmin,
    permissions: userIsSuperAdmin ? [] : effectivePermissions,
  };
  return { ok: true };
}

/**
 * Deny/redirect helper shared by the inline template routes. A permission
 * failure is a 403 (JSON) — NOT a login redirect, which would be misleading.
 */
function sendTemplateAuthFailure(res: Response, auth: TemplateAuthResult) {
  if (auth.forbidden) {
    return res.status(403).json({
      status: 'fail',
      message: 'You do not have permission to download this template.',
      code: 'PERMISSION_REQUIRED',
    });
  }
  return res.status(401).type('text/html').send(auth.html!);
}

// --- Students templates (ADMIN role + BULK_UPLOAD_STUDENTS capability) ---
router.get('/students/template.csv', catchAsync(async (req: Request, res: Response) => {
  const auth = await templateAuthCheckAdmin(req, ['ADMIN'], 'BULK_UPLOAD_STUDENTS');
  if (!auth.ok) {
    return sendTemplateAuthFailure(res, auth);
  }
  const UTF8_BOM = '\uFEFF';
  const header = [
    'firstName (required)',
    'lastName (required)',
    'matricNumber (required, unique)',
    'email (required, unique)',
    'phoneNumber (required)',
    'programmeCode (or programmeId) — BScCS / BScPH / etc',
    'programmeId (or programmeCode) — numeric id from database',
    'academicSession (required e.g. 2025/2026)',
    'academicSessionId (or academicSession)',
    'studentType (optional: UNDERGRADUATE / POSTGRADUATE / TOP_UP / PART_TIME / JUPEB / OTHER — see Students → Categories)',
    'collegeCode (optional, auto-populated from programme)',
    'departmentCode (optional, auto-populated from programme)',
    'middleName (optional)',
    'password (optional, autogenerated if blank)',
    'jambNumber (optional)',
    'address (optional)',
  ];
  const sample = [
    'Chiamaka',
    'Okoro',
    '2025/SCI/0001',
    'chiamaka.okoro@university.edu.ng',
    '+2348012345678',
    'BScCS',
    '',
    '2025/2026',
    '',
    'UNDERGRADUATE',
    '',
    '',
    'Ngozi',
    'StuPass2025!',
    '456789012',
    '123 University Drive, Abuja',
  ];
  const content =
    UTF8_BOM +
    '# Required columns: firstName, lastName, matricNumber, email, phoneNumber\r\n' +
    '# Match programme/session either by NAME/CODE (preferred) or by numeric ID. Programme is REQUIRED to create a student. Academic session is REQUIRED. College + Department optional — auto-populated from programme.\r\n' +
    csvLineSafe(header) +
    csvLineSafe(sample);
  res.attachment('students-import-template.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).send(content);
}));

router.get('/students/template.xlsx', catchAsync(async (req: Request, res: Response) => {
  const auth = await templateAuthCheckAdmin(req, ['ADMIN'], 'BULK_UPLOAD_STUDENTS');
  if (!auth.ok) {
    return sendTemplateAuthFailure(res, auth);
  }
  const templateHeader = [
    'firstName',
    'lastName',
    'matricNumber',
    'email',
    'phoneNumber',
    'programmeCode',
    'programmeId',
    'academicSession',
    'academicSessionId',
    'studentType',
    'collegeCode',
    'departmentCode',
    'middleName',
    'password',
    'jambNumber',
    'address',
  ];
  const templateSamples = [
    [
      'Chiamaka',
      'Okoro',
      '2025/SCI/0001',
      'chiamaka.okoro@university.edu.ng',
      '+2348012345678',
      'BScCS',
      '',
      '2025/2026',
      '',
      'UNDERGRADUATE',
      '',
      '',
      'Ngozi',
      'StuPass2025!',
      '456789012',
      '123 University Drive, Abuja',
    ],
  ];
  const colWidths = [14, 14, 18, 34, 18, 16, 14, 16, 18, 18, 14, 16, 14, 20, 16, 36];
  const instructionRows: string[][] = [
    ['#', 'Topic', 'Rule / Description', 'Example'],
    ['1', 'Required Fields', 'firstName, lastName, matricNumber, email, phoneNumber, programme, academicSession are all required', 'See Column Reference below'],
    ['2', 'Programme Matching', 'Provide EITHER programmeCode (preferred, e.g. BScCS) OR programmeId (numeric id from DB). Code takes precedence.', 'BScCS'],
    ['3', 'Session Matching', 'Provide EITHER academicSession label (e.g. 2025/2026) OR academicSessionId (numeric). Label takes precedence.', '2025/2026'],
    ['4', 'Auto-populated Fields', 'collegeCode and departmentCode are auto-populated from Programme — you may leave blank.', '(leave blank)'],
    ['5', 'Password', 'If blank, a strong random password is autogenerated. Min 8 chars if provided.', 'StuPass2025!'],
    ['6', 'studentType', 'UNDERGRADUATE / POSTGRADUATE / TOP_UP / PART_TIME / JUPEB / OTHER. Categories are admin-managed under Students → Categories.', 'UNDERGRADUATE'],
  ];
  const columnNotes = [
    { header: 'firstName', required: true, note: 'Given name. Max 80 chars.' },
    { header: 'lastName', required: true, note: 'Family name. Max 80 chars.' },
    { header: 'matricNumber', required: true, note: 'Unique matriculation/student ID. Max 50 chars.' },
    { header: 'email', required: true, note: 'Unique valid email address. Max 254 chars.' },
    { header: 'phoneNumber', required: true, note: 'Active phone contact. Max 30 chars.' },
    { header: 'programmeCode', required: true, note: 'Code from Programmes page (e.g. BScCS). Prefer over programmeId.' },
    { header: 'programmeId', required: false, note: 'Alternative: numeric DB id of programme (ignored if programmeCode filled).' },
    { header: 'academicSession', required: true, note: 'Session label e.g. 2025/2026. Prefer over academicSessionId.' },
    { header: 'academicSessionId', required: false, note: 'Alternative: numeric DB id of session (ignored if academicSession filled).' },
    { header: 'studentType', required: false, note: 'UNDERGRADUATE / POSTGRADUATE / TOP_UP / PART_TIME / JUPEB / OTHER. Admin-managed under Students → Categories.' },
    { header: 'collegeCode', required: false, note: 'Optional cross-check; auto-populated from programme if blank.' },
    { header: 'departmentCode', required: false, note: 'Optional cross-check; auto-populated from programme if blank.' },
    { header: 'middleName', required: false, note: 'Middle name(s). Max 80 chars.' },
    { header: 'password', required: false, note: 'Plaintext password (min 8 chars). Auto-generated if blank.' },
    { header: 'jambNumber', required: false, note: 'JAMB/UTME registration number if applicable.' },
    { header: 'address', required: false, note: 'Residential or contact address. Max 500 chars.' },
  ];
  const xlsx = await buildTwoSheetWorkbook({
    title: 'Student Directory — Bulk Import Template',
    instructionRows,
    templateHeader,
    templateSamples,
    colWidths,
    columnNotes,
  });
  res.attachment('students-import-template.xlsx');
  res.setHeader('Content-Type', xlsx.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).send(xlsx.buffer);
}));

router.use(protect);

// ---------------------------------------------------------------------------
// ROLE BOUNDARY for the ADMIN router.
//
// This is a role boundary ONLY — it is NOT authorization for a normal,
// non-flagged ADMIN. Every operational route below additionally enforces a
// granular canonical permission via requirePermission(), so:
//   · role=ADMIN && isSuperAdmin=true  → passes everything (centralised bypass)
//   · normal ADMIN                      → passes only with its LIVE effective
//                                         permission for that operation
//   · BURSARY                           → admitted ONLY on the two read-only
//                                         observability surfaces below, and still
//                                         governed by its effective permissions
//   · STUDENT                           → never admitted here
//
// Admission exceptions (still capability-checked per route):
//   · GET /audit-logs*           → ADMIN or BURSARY
//   · GET /email-delivery-logs*  → ADMIN or BURSARY (PII masked for non-ADMIN)
// ---------------------------------------------------------------------------
router.use((req, res, next) => {
  const isAuditLogsRead = req.method === 'GET' && /^\/audit-logs(\/|$)/.test(req.path);
  const isEmailDeliveryLogRead =
    req.method === 'GET' && /^\/email-delivery-logs(\/|$)/.test(req.path);
  if (isAuditLogsRead || isEmailDeliveryLogRead) {
    return restrictTo('ADMIN', 'BURSARY')(req, res, next);
  }
  return restrictTo('ADMIN')(req, res, next);
});

/**
 * Audit-log read capability. FULL capability for an ADMIN-role caller, LIMITED
 * capability for a BURSARY caller. The role boundary has already admitted
 * ADMIN/BURSARY, so this ONLY adds the capability floor.
 */
const requireAuditLogRead = (req: Request, res: Response, next: NextFunction) => {
  const role = String((req as any).user?.role || '');
  if (role === Role.ADMIN) return requirePermission('AUDIT_LOGS_VIEW_FULL')(req, res, next);
  if (role === Role.BURSARY) return requirePermission('AUDIT_LOGS_VIEW_LIMITED')(req, res, next);
  return restrictTo('ADMIN')(req, res, next);
};

const JSON_DB_NULL = Prisma.JsonNull;

type ReqLike = Partial<Pick<Request, 'headers' | 'ip'>> & { user?: Request['user'] };

async function writeAudit(
  req: ReqLike | undefined,
  data: {
    action: string;
    entityType: string;
    entityId: string | number;
    details?: any;
  }
) {
  const userId = (req as any)?.user?.id ?? null;
  const ipAddress = req ? reqIp(req as any) : null;
  const userAgent = req ? reqUa(req as any) : null;
  try {
    await prisma.auditLog.create({
      data: {
        action: data.action,
        entityType: data.entityType,
        entityId: String(data.entityId),
        userId,
        ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
        details: data.details === undefined || data.details === null ? JSON_DB_NULL : (data.details as Prisma.InputJsonValue),
      },
    });
  } catch {
  }
}

router.get('/stats', requirePermission('VIEW_DASHBOARD'), getDashboardStats);
router.post('/students', requirePermission('CREATE_STUDENT'), validateBody(CreateStudentSchema), addStudent);

router.post('/students/upload', requirePermission('BULK_UPLOAD_STUDENTS'), stageStudentUpload);
router.get('/students/upload/:id', requirePermission('BULK_UPLOAD_STUDENTS'), previewStudentUpload);
router.get('/students/upload/:id/errors.csv', requirePermission('BULK_UPLOAD_STUDENTS'), downloadErrorCsv);
router.post('/students/upload/:id/confirm', requirePermission('BULK_UPLOAD_STUDENTS'), requirePermission('CREATE_STUDENT'), confirmStudentUpload);

// --- Background student-import runs ---
// ORDERING: the more specific `imports/rows/:id/...` route MUST be registered
// before the generic `imports/:uuid` so it can never be shadowed by `:uuid`.
router.post(
  '/students/imports/rows/:id/resend-credentials',
  requirePermission('BULK_UPLOAD_STUDENTS'),
  requirePermission('CREATE_STUDENT'),
  resendImportRowCredentials,
);
router.get('/students/imports', requirePermission('BULK_UPLOAD_STUDENTS'), listImportRuns);
router.get('/students/imports/:uuid/rows', requirePermission('BULK_UPLOAD_STUDENTS'), listImportRunRows);
router.get('/students/imports/:uuid/credentials.csv', requirePermission('BULK_UPLOAD_STUDENTS'), downloadCredentialsCsv);
router.get('/students/imports/:uuid', requirePermission('BULK_UPLOAD_STUDENTS'), getImportRun);

router.get('/refunds', requirePermission('PROCESS_REFUND'), adminListRefunds);
const RefundIdParam = z.object({ id: z.coerce.number().int().positive() });
router.post('/refunds/:id/approve', requirePermission('PROCESS_REFUND'), validateParams(RefundIdParam), adminApproveRefund as any);
router.post('/refunds/:id/reject', requirePermission('PROCESS_REFUND'), validateParams(RefundIdParam), adminRejectRefund as any);

const AdminTxUpdatePatchBody = z.record(z.any());
router.patch('/transactions/:id', requirePermission('VERIFY_PAYMENT'),
  validateParams(RefundIdParam),
  validateBody(AdminTxUpdatePatchBody),
  catchAsync(async (req: any, res) => {
    const txId = Number(req.params.id);
    const tx = await prisma.transaction.findUnique({
      where: { id: txId },
      select: { id: true, status: true },
    });
    RefundService.assertTransactionMutable(tx, req.body ?? {});
    const allowed = new Set(['description', 'metadata']);
    const data: Record<string, any> = {};
    for (const k of Object.keys(req.body ?? {})) {
      if (allowed.has(k)) data[k] = (req.body as any)[k];
    }
    if (Object.keys(data).length === 0) {
      return res.status(200).json({ status: 'success', data: { id: txId, changed: false } });
    }
    const updated = await prisma.transaction.update({ where: { id: txId }, data });
    res.status(200).json({ status: 'success', data: updated });
  }),
);

const AuditLogsQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  action: z.string().optional(),
  entity: z.string().optional(),
  entityId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});
router.get('/audit-logs', requireAuditLogRead, validateQuery(AuditLogsQuery), catchAsync(async (req: any, res) => {
  const { page, limit, action, entity, entityId, userId, dateFrom, dateTo } = req.query as any;
  const where: any = {};
  if (action) where.action = action;
  if (entity) where.entityType = entity;
  if (entityId) where.entityId = String(entityId);
  if (userId) where.userId = userId;
  if (dateFrom || dateTo) {
    where.createdAt = {} as any;
    if (dateFrom) where.createdAt.gte = dateFrom;
    if (dateTo) where.createdAt.lte = dateTo;
  }
  const skip = (page - 1) * limit;
  const [rows, count] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true, role: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(count / limit));
  res.status(200).json({
    status: 'success',
    data: {
      items: rows,
      pagination: { page, limit, total: count, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
      filters: {
        action: action || null,
        entity: entity || null,
        entityId: entityId || null,
        userId: userId || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      },
    },
  });
}));

router.get('/audit-logs/export.csv', requireAuditLogRead, validateQuery(AuditLogsQuery), catchAsync(async (req: any, res) => {
  const { action, entity, entityId, userId, dateFrom, dateTo, format } = req.query as any;
  const where: any = {};
  if (action) where.action = action;
  if (entity) where.entityType = entity;
  if (entityId) where.entityId = String(entityId);
  if (userId) where.userId = userId;
  if (dateFrom || dateTo) {
    where.createdAt = {} as any;
    if (dateFrom) where.createdAt.gte = dateFrom;
    if (dateTo) where.createdAt.lte = dateTo;
  }
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 50000,
    include: { user: { select: { id: true, email: true, firstName: true, lastName: true, role: true } } },
  });
  const header = ['id', 'createdAt', 'action', 'entityType', 'entityId', 'userId', 'actorEmail', 'actorName', 'actorRole', 'ipAddress', 'userAgent', 'details'];
  let csv = '\uFEFF' + csvLineSafe(header);
  for (const r of rows) {
    const name = [r.user?.firstName, r.user?.lastName].filter(Boolean).join(' ');
    csv += csvLineSafe([r.id, r.createdAt?.toISOString() ?? '', r.action ?? '', r.entityType ?? '', r.entityId ?? '', r.userId ?? '', r.user?.email ?? '', name, r.user?.role ?? '', r.ipAddress ?? '', r.userAgent ?? '', r.details ?? '']);
  }
  const ts = (d: any) => (d ? new Date(d).toISOString().slice(0, 10).replace(/-/g, '') : 'all');
  const filename = `audit_logs_${ts(dateFrom)}_${ts(dateTo)}_${Date.now()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=audit_logs_${ts(dateFrom)}_${ts(dateTo)}.json`);
    return res.status(200).json({ status: 'success', data: { rows } });
  }
  const csvWithIntegrity = appendCsvIntegrityTrailer(csv);
  res.status(200).send(csvWithIntegrity);
}));

// ---------------------------------------------------------------------------
// Users CRUD (6 routes)
//   GET    /admin/users              list paginated/filtered
//   GET    /admin/users/:id          get one
//   POST   /admin/users              create (bcrypt hash)
//   PATCH  /admin/users/:id          update (email immutable)
//   POST   /admin/users/:id/deactivate  toggle accountStatus
//   POST   /admin/users/:id/reset-password
//   Permission: MANAGE_USERS
// ---------------------------------------------------------------------------

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  middleName: true,
  lastName: true,
  matricNumber: true,
  admissionNumber: true,
  jambNumber: true,
  college: true,
  department: true,
  program: true,
  level: true,
  academicSession: true,
  studentType: true,
  entryMode: true,
  admissionYear: true,
  graduationYear: true,
  phoneNumber: true,
  address: true,
  role: true,
  isSuperAdmin: true,
  accountStatus: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** USER_SELECT + the individual-access mode (used by the users list/access UI). */
const USER_LIST_SELECT = {
  ...USER_SELECT,
  permissionProfile: {
    select: {
      accessMode: true,
      permissions: { select: { permission: { select: { key: true } } } },
    },
  },
} as const;

const UserListQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).optional().default(25),
  search: z.string().max(200).trim().optional(),
  role: z.enum([Role.ADMIN, Role.BURSARY, Role.STUDENT]).optional(),
  accountStatus: z.enum([AccountStatus.ACTIVE, AccountStatus.SUSPENDED, AccountStatus.GRADUATED, AccountStatus.WITHDRAWN]).optional(),
});

router.get(
  '/users',
  requirePermission('MANAGE_USERS'),
  validateQuery(UserListQuery),
  catchAsync(async (req: any, res) => {
    const { page, pageSize, search, role, accountStatus } = req.query as z.infer<typeof UserListQuery>;
    const skip = (page - 1) * pageSize;

    const where: Prisma.UserWhereInput = {};
    if (role) {
      where.role = role;
    } else {
      // Default ADMIN/BURSARY only; never surface STUDENT in admin users page list
      where.role = { in: [Role.ADMIN, Role.BURSARY] };
    }
    if (search) {
      where.OR = [
        { email: { contains: search } },
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { matricNumber: { contains: search } },
      ];
    }
    if (accountStatus) where.accountStatus = accountStatus;

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: USER_LIST_SELECT as any,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    // Surface the individual-access mode + permission counts inline (§19/§20) and
    // drop the nested relation object. The role baseline is resolved LIVE (1s
    // cache) so "X of Y" always reflects the authoritative maximum for the role,
    // and a super admin is always reported at full registry width.
    const baselineCache = new Map<string, string[]>();
    const baselineFor = async (r: Role): Promise<string[]> => {
      if (!baselineCache.has(r)) baselineCache.set(r, await getRolePermissions(r));
      return baselineCache.get(r)!;
    };
    const itemsOut: any[] = [];
    for (const u of items as any[]) {
      const { permissionProfile, ...rest } = u;
      const accessMode: AccessMode = permissionProfile?.accessMode ?? AccessMode.INHERIT;
      const rolePerms = await baselineFor(rest.role as Role);
      const rolePermissionCount = rolePerms.length;
      let effectivePermissionCount: number;
      if (isSuperAdmin({ id: rest.id, role: rest.role, isSuperAdmin: rest.isSuperAdmin })) {
        effectivePermissionCount = PERMISSION_CATALOGUE.length;
      } else if (accessMode === AccessMode.CUSTOM) {
        const baseSet = new Set(rolePerms);
        const selected: string[] = ((permissionProfile?.permissions ?? []) as any[])
          .map((p) => p?.permission?.key)
          .filter((k: unknown): k is string => typeof k === 'string');
        effectivePermissionCount = selected.filter((k) => baseSet.has(k)).length;
      } else {
        effectivePermissionCount = rolePermissionCount;
      }
      itemsOut.push({ ...rest, accessMode, rolePermissionCount, effectivePermissionCount });
    }
    res.status(200).json({
      status: 'success',
      data: { items: itemsOut, total, page, pageSize, pageCount },
    });
  }),
);

const UserIdParam = z.object({ id: z.coerce.number().int().positive() });

router.get(
  '/users/:id',
  requirePermission('MANAGE_USERS'),
  validateParams(UserIdParam),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof UserIdParam>;
    const user = await prisma.user.findUnique({
      where: { id },
      select: USER_SELECT as any,
    });
    if (!user) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    res.status(200).json({ status: 'success', data: user });
  }),
);

const CreateUserSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(128),
    firstName: z.string().min(1).max(80),
    middleName: z.string().max(80).optional().nullable(),
    lastName: z.string().min(1).max(80),
    matricNumber: z.string().trim().min(3, 'Matric number must be at least 3 characters').max(50, 'Matric number must be 50 characters or fewer').regex(/^[A-Za-z0-9][A-Za-z0-9/\-. _]*$/, "Matric number must start with a letter or digit and contain only letters, digits, slash ( / ), hyphen ( - ), dot ( . ), underscore ( _ ), or space.").optional().nullable(),
    role: z.enum([Role.ADMIN, Role.BURSARY, Role.STUDENT]).default(Role.STUDENT),
    accountStatus: z.enum([AccountStatus.ACTIVE, AccountStatus.SUSPENDED]).default(AccountStatus.ACTIVE),
    phoneNumber: z.string().max(30).optional().nullable(),
  })
  .strict();

router.post(
  '/users',
  requirePermission('MANAGE_USERS'),
  validateBody(CreateUserSchema),
  catchAsync(async (req: any, res) => {
    const body = req.body as z.infer<typeof CreateUserSchema>;
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return res.status(400).json({ status: 'fail', message: 'A user with this email already exists' });
    }
    const hashedPassword = await bcrypt.hash(body.password, 12);
    const data: Prisma.UserCreateInput = {
      email: body.email,
      password: hashedPassword,
      firstName: body.firstName,
      middleName: body.middleName ?? undefined,
      lastName: body.lastName,
      matricNumber: body.matricNumber ?? undefined,
      role: body.role,
      accountStatus: body.accountStatus,
      phoneNumber: body.phoneNumber ?? undefined,
    };
    const created: any = await prisma.user.create({
      data,
      select: USER_SELECT as any,
    });
    await writeAudit(req, {
      action: 'CREATE_USER',
      entityType: 'USER',
      entityId: created.id as number,
      details: { email: created.email, role: created.role },
    });
    res.status(201).json({ status: 'success', data: created });
  }),
);

const UpdateUserSchema = z
  .object({
    firstName: z.string().min(1).max(80).optional(),
    middleName: z.string().max(80).optional().nullable(),
    lastName: z.string().min(1).max(80).optional(),
    matricNumber: z.string().trim().min(3, 'Matric number must be at least 3 characters').max(50, 'Matric number must be 50 characters or fewer').regex(/^[A-Za-z0-9][A-Za-z0-9/\-. _]*$/, "Matric number must start with a letter or digit and contain only letters, digits, slash ( / ), hyphen ( - ), dot ( . ), underscore ( _ ), or space.").optional().nullable(),
    role: z.enum([Role.ADMIN, Role.BURSARY, Role.STUDENT]).optional(),
    accountStatus: z.enum([AccountStatus.ACTIVE, AccountStatus.SUSPENDED, AccountStatus.GRADUATED, AccountStatus.WITHDRAWN]).optional(),
    phoneNumber: z.string().max(30).optional().nullable(),
  })
  .strict();

router.patch(
  '/users/:id',
  requirePermission('MANAGE_USERS'),
  validateParams(UserIdParam),
  validateBody(UpdateUserSchema),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof UserIdParam>;
    const body = req.body as z.infer<typeof UpdateUserSchema>;

    // D10 — the read → validate → write sequence runs in ONE transaction so a
    // concurrent demotion cannot slip past the final-super-admin invariant.
    const outcome = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true, isSuperAdmin: true, accountStatus: true },
      });
      if (!existing) return { kind: 'notFound' as const };

      const updateData: Prisma.UserUpdateInput = {};
      if (body.firstName !== undefined) updateData.firstName = body.firstName;
      if (body.middleName !== undefined) updateData.middleName = body.middleName ?? undefined;
      if (body.lastName !== undefined) updateData.lastName = body.lastName;
      if (body.matricNumber !== undefined) updateData.matricNumber = body.matricNumber ?? undefined;
      if (body.role !== undefined) updateData.role = body.role;
      if (body.accountStatus !== undefined) updateData.accountStatus = body.accountStatus;
      if (body.phoneNumber !== undefined) updateData.phoneNumber = body.phoneNumber ?? undefined;

      // D1 — a non-ADMIN role can never retain the protected super-admin flag.
      // If the role moves away from ADMIN, clear isSuperAdmin in the SAME write.
      const resultingRole = body.role ?? existing.role;
      const forcedSuperAdminOff = resultingRole !== Role.ADMIN && existing.isSuperAdmin === true;
      if (forcedSuperAdminOff) updateData.isSuperAdmin = false;

      if (Object.keys(updateData).length === 0) return { kind: 'unchanged' as const };

      // D7 — the FINAL active super administrator must never be demoted,
      // suspended or converted away from ADMIN.
      const wasActiveSuperAdmin =
        existing.role === Role.ADMIN &&
        existing.isSuperAdmin === true &&
        existing.accountStatus === AccountStatus.ACTIVE;
      const resultingAccountStatus = body.accountStatus ?? existing.accountStatus;
      const stillActiveSuperAdmin =
        resultingRole === Role.ADMIN &&
        !forcedSuperAdminOff &&
        existing.isSuperAdmin === true &&
        resultingAccountStatus === AccountStatus.ACTIVE;
      if (wasActiveSuperAdmin && !stillActiveSuperAdmin) {
        const invariant = await assertSuperAdminInvariant(tx, id);
        if (invariant === 'finalSuperAdmin') return { kind: 'finalSuperAdmin' as const };
      }

      const updated = await tx.user.update({
        where: { id },
        data: updateData,
        select: USER_SELECT as any,
      });
      return { kind: 'updated' as const, updated, changedFields: Object.keys(updateData) };
    });

    if (outcome.kind === 'notFound') {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    if (outcome.kind === 'finalSuperAdmin') {
      return res.status(409).json({
        status: 'fail',
        code: 'FINAL_SUPER_ADMIN',
        error: 'Cannot demote, suspend or change the role of the final active Super Administrator. Grant the flag to another active administrator first.',
      });
    }
    if (outcome.kind === 'unchanged') {
      const user = await prisma.user.findUnique({ where: { id }, select: USER_SELECT as any });
      return res.status(200).json({ status: 'success', data: user });
    }

    await writeAudit(req, {
      action: 'UPDATE_USER',
      entityType: 'USER',
      entityId: id,
      details: { changedFields: outcome.changedFields },
    });
    res.status(200).json({ status: 'success', data: outcome.updated });
  }),
);

router.post(
  '/users/:id/deactivate',
  requirePermission('MANAGE_USERS'),
  validateParams(UserIdParam),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof UserIdParam>;

    // D10/D7 — the read → invariant check → write sequence runs in ONE
    // transaction so a concurrent demotion/suspension cannot slip past the
    // final-active-super-admin invariant.
    const outcome = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true, isSuperAdmin: true, accountStatus: true },
      });
      if (!existing) return { kind: 'notFound' as const };

      const newStatus =
        existing.accountStatus === AccountStatus.ACTIVE
          ? AccountStatus.SUSPENDED
          : AccountStatus.ACTIVE;

      // The final ACTIVE super administrator must never be suspended.
      const isActiveSuperAdmin =
        existing.role === Role.ADMIN &&
        existing.isSuperAdmin === true &&
        existing.accountStatus === AccountStatus.ACTIVE;
      if (isActiveSuperAdmin && newStatus !== AccountStatus.ACTIVE) {
        const invariant = await assertSuperAdminInvariant(tx, id);
        if (invariant === 'finalSuperAdmin') return { kind: 'finalSuperAdmin' as const };
      }

      const updated = await tx.user.update({
        where: { id },
        data: { accountStatus: newStatus },
        select: USER_SELECT as any,
      });
      return { kind: 'updated' as const, updated, oldStatus: existing.accountStatus, newStatus };
    });

    if (outcome.kind === 'notFound') {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    if (outcome.kind === 'finalSuperAdmin') {
      return res.status(409).json({
        status: 'fail',
        code: 'FINAL_SUPER_ADMIN',
        error: 'Cannot suspend the final active Super Administrator. Grant the flag to another active administrator first.',
      });
    }

    await writeAudit(req, {
      action: 'ACCOUNT_STATUS_CHANGE',
      entityType: 'USER',
      entityId: id,
      details: { oldStatus: outcome.oldStatus, newStatus: outcome.newStatus },
    });
    res.status(200).json({ status: 'success', data: outcome.updated });
  }),
);

const ResetPasswordSchema = z
  .object({
    newPassword: z.string().min(8).max(128),
  })
  .strict();

router.post(
  '/users/:id/reset-password',
  requirePermission('MANAGE_USERS'),
  validateParams(UserIdParam),
  validateBody(ResetPasswordSchema),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof UserIdParam>;
    const { newPassword } = req.body as z.infer<typeof ResetPasswordSchema>;
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id },
      data: { password: hashedPassword },
    });
    await writeAudit(req, {
      action: 'PASSWORD_RESET',
      entityType: 'USER',
      entityId: id,
      details: { email: existing.email },
    });
    res.status(200).json({ status: 'success', data: { message: 'Password reset successful' } });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /admin/users/:id  —  Delete a user with strict business gates.
// Permission: MANAGE_USERS (ADMIN only, Bursary does NOT have this perms).
// ---------------------------------------------------------------------------
// Gates (checked in this order, any failure returns non-200):
//   1. 404 if user doesn't exist.
//   2. 409 (Conflict) if the user is the FINAL ACTIVE Super Administrator
//      (role=ADMIN ∧ isSuperAdmin=true ∧ accountStatus=ACTIVE). Authority and
//      protection are derived ENTIRELY from the database-backed hierarchy and
//      the final-active-super-admin invariant — never from a hardcoded
//      identity (id, email or name).
//   3. 409 (Conflict) if user.role === STUDENT AND the student has ANY
//      financial records. This preserves the audit trail & bank-reconciliation
//      integrity of the university ledger:
//        - rows in `invoices` (Invoice.studentId = user.id)
//        - rows in `receipts` (Receipt.studentId = user.id)
//        - rows in `transactions` (Transaction.userId = user.id)
//        - rows in `refunds` (Refund.requestedById = user.id OR a
//          Refund.originalTransaction → Transaction.userId = student.id)
//      Non-student accounts (ADMIN / BURSARY staff) can be deleted freely unless
//      doing so would violate the final-active-super-admin invariant.
//   4. Cleanup: inside a Prisma transaction:
//        - SET NULL audit_logs.userId → preserve audit history for deleted
//          users (we never delete audit rows — data protection / compliance).
//        - DELETE refresh_tokens for this user → force-logout everywhere.
//        - NULL out studentImport.studentId? No — studentImport already stores
//          studentId separately; we just delete the user row and FK on
//          users.studentImportId → user SET NULL because of the way schema is
//          defined (relation optional, nullable by default for studentImportId).
//        - DELETE user row.
//   5. Write audit entry: action = DELETE_USER with role, email, wasProtected,
//      studentFinancialGate.
// ---------------------------------------------------------------------------

/**
 * D7 — FINAL ACTIVE SUPER ADMIN INVARIANT (centralised, concurrency-safe).
 *
 * The invariant: at least one user with (role=ADMIN ∧ isSuperAdmin=true ∧
 * accountStatus=ACTIVE) must exist at all times.
 *
 * Every mutation that can REMOVE a user from that set — Super Admin flag
 * revocation, ADMIN → BURSARY/STUDENT role change, ACTIVE → non-ACTIVE status
 * change, deactivate/suspend and delete — MUST call this helper INSIDE the same
 * transaction as the mutation itself.
 *
 * Serialisation: a plain count followed by a separate write is NOT safe under
 * concurrency (two requests can each observe the same "1 remaining" and both
 * proceed). The helper therefore FIRST takes a pessimistic row/range lock on
 * the current ACTIVE Super Administrator set (SELECT ... FOR UPDATE, MySQL
 * InnoDB), which makes concurrent invariant-affecting transactions queue. The
 * subsequent count then observes the latest committed state, so the count and
 * the mutating write can never interleave down to zero.
 */
async function assertSuperAdminInvariant(
  tx: any,
  targetId: number,
): Promise<'ok' | 'finalSuperAdmin'> {
  // 1. Serialise on the ACTIVE Super Administrator set.
  await tx.$queryRaw`
    SELECT id FROM users
    WHERE role = ${Role.ADMIN}
      AND isSuperAdmin = ${true}
      AND accountStatus = ${AccountStatus.ACTIVE}
    FOR UPDATE
  `;
  // 2. Count the ACTIVE Super Admins that would REMAIN after the mutation.
  const remaining = await tx.user.count({
    where: {
      role: Role.ADMIN,
      isSuperAdmin: true,
      accountStatus: AccountStatus.ACTIVE,
      id: { not: targetId },
    },
  });
  return remaining > 0 ? 'ok' : 'finalSuperAdmin';
}

/**
 * Build the canonical UserAccessOut payload (contract §2/§27) consumed by the
 * frontend access editor: identity + access mode + the role baseline + the raw
 * saved selection + the EFFECTIVE (restrict-only) intersection.
 */
function buildUserAccessOut(
  user: {
    id: number;
    email: string;
    firstName: string;
    middleName?: string | null;
    lastName: string;
    role: Role;
    accountStatus: AccountStatus;
    isSuperAdmin: boolean;
  },
  access: UserAccessDescriptor,
) {
  const rolePermissions = [...access.rolePermissionKeys];
  const selectedPermissions = [...access.customPermissionKeys];
  const effectivePermissions = [...access.effectivePermissionKeys];
  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      middleName: user.middleName ?? null,
      lastName: user.lastName,
      role: user.role,
      accountStatus: user.accountStatus,
      isSuperAdmin: user.isSuperAdmin,
    },
    accessMode: access.accessMode,
    rolePermissions,
    rolePermissionCount: rolePermissions.length,
    selectedPermissions,
    effectivePermissions,
    effectivePermissionCount: effectivePermissions.length,
    // Protection is derived from the database-backed hierarchy — a Super
    // Administrator (role=ADMIN ∧ isSuperAdmin=true), evaluated through the
    // CENTRALISED helper so a non-ADMIN carrying a stray isSuperAdmin=true flag
    // is NOT reported as protected. Never from a hardcoded identity: there is no
    // id/email/name allow-list anywhere in the system.
    isProtected: isSuperAdmin({ id: user.id, role: user.role, isSuperAdmin: user.isSuperAdmin }),
  };
}

async function hasFinancialRecordsForStudent(userId: number): Promise<{
  any: boolean;
  invoices: number;
  receipts: number;
  transactions: number;
  refundsAsRequester: number;
  refundsViaTransactions: number;
  feeAssignments: number;
  ledgerEntries: number;
}> {
  const [
    invoices,
    receipts,
    transactions,
    refundsAsRequester,
    refundsViaTransactions,
    feeAssignments,
    ledgerEntries,
  ] = await Promise.all([
    prisma.invoice.count({ where: { studentId: userId } }),
    prisma.receipt.count({ where: { studentId: userId } }),
    prisma.transaction.count({ where: { userId } }),
    prisma.refund.count({ where: { requestedById: userId } }),
    prisma.refund.count({
      where: { originalTransaction: { userId } },
    }),
    prisma.feeAssignment.count({ where: { targetStudentId: userId } }),
    prisma.generalLedger.count({ where: { userId } }),
  ] as const);
  return {
    any:
      invoices + receipts + transactions + refundsAsRequester +
      refundsViaTransactions + feeAssignments + ledgerEntries > 0,
    invoices,
    receipts,
    transactions,
    refundsAsRequester,
    refundsViaTransactions,
    feeAssignments,
    ledgerEntries,
  };
}

router.delete(
  '/users/:id',
  requirePermission('MANAGE_USERS'),
  validateParams(UserIdParam),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof UserIdParam>;

    const existing = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        isSuperAdmin: true,
        accountStatus: true,
      },
    });
    if (!existing) {
      return res.status(404).json({ status: 'fail', error: 'User not found' });
    }

    // Gate 2 — student financial integrity (read-only business gate)
    if (existing.role === Role.STUDENT) {
      const fin = await hasFinancialRecordsForStudent(id);
      if (fin.any) {
        const counts: string[] = [];
        if (fin.invoices > 0) counts.push(`${fin.invoices} invoice(s)`);
        if (fin.receipts > 0) counts.push(`${fin.receipts} receipt(s)`);
        if (fin.transactions > 0) counts.push(`${fin.transactions} transaction(s)`);
        if (fin.refundsAsRequester > 0 || fin.refundsViaTransactions > 0) {
          counts.push(`${fin.refundsAsRequester + fin.refundsViaTransactions} refund record(s)`);
        }
        if (fin.feeAssignments > 0) counts.push(`${fin.feeAssignments} direct-bill assignment(s)`);
        if (fin.ledgerEntries > 0) counts.push(`${fin.ledgerEntries} ledger entry/entries`);
        return res.status(409).json({
          status: 'fail',
          error: 'Cannot delete student with existing financial records. Use accountStatus=SUSPENDED/GRADUATED instead.',
          code: 'STUDENT_HAS_FINANCIAL_RECORDS',
          breakdown: counts,
        });
      }
    }

    // Gate 3 — the final-active-super-admin invariant + session/audit cleanup +
    // the user deletion all run in ONE transaction, and the target is RE-READ
    // INSIDE it. The invariant decision is therefore derived from the CURRENT
    // committed state — never from the pre-transaction read above, which can be
    // stale (TOCTOU: the target's role / flag / status may change between the
    // outer read and the delete, e.g. a non-super-admin promoted to an ACTIVE
    // Super Administrator in that window must NOT slip past the invariant).
    const outcome = await prisma.$transaction(async (tx) => {
      // Authoritative read — the ONLY source for the invariant decision below.
      const target = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          role: true,
          firstName: true,
          lastName: true,
          isSuperAdmin: true,
          accountStatus: true,
        },
      });
      if (!target) return { kind: 'notFound' as const };

      const isActiveSuperAdmin =
        target.role === Role.ADMIN &&
        target.isSuperAdmin === true &&
        target.accountStatus === AccountStatus.ACTIVE;

      if (isActiveSuperAdmin) {
        const invariant = await assertSuperAdminInvariant(tx, id);
        if (invariant === 'finalSuperAdmin') return { kind: 'finalSuperAdmin' as const };
      }

      // Preserve audit history (don't DELETE audit rows) — just detach userId
      await tx.auditLog.updateMany({
        where: { userId: id },
        data: { userId: null },
      });
      // Force-logout all existing sessions
      await tx.refreshToken.deleteMany({
        where: { userId: id },
      });
      // User row delete (studentImportId FK goes null per schema)
      await tx.user.delete({
        where: { id },
      });
      return { kind: 'deleted' as const, target };
    });

    if (outcome.kind === 'notFound') {
      return res.status(404).json({ status: 'fail', error: 'User not found' });
    }
    if (outcome.kind === 'finalSuperAdmin') {
      return res.status(409).json({
        status: 'fail',
        code: 'FINAL_SUPER_ADMIN',
        error: 'Cannot delete the final active Super Administrator. Grant the flag to another active administrator first.',
      });
    }

    // Gate 4 — audit trail of the deletion itself, from the transactional
    // snapshot so the recorded role/flag reflect what was actually deleted.
    const { target } = outcome;
    await writeAudit(req, {
      action: 'DELETE_USER',
      entityType: 'USER',
      entityId: id,
      details: {
        email: target.email,
        role: target.role,
        name: `${target.firstName ?? ''} ${target.lastName ?? ''}`.trim(),
        protectedAccount: isSuperAdmin({
          id: target.id,
          role: target.role,
          isSuperAdmin: target.isSuperAdmin,
        }),
        studentGatePassed: target.role === Role.STUDENT,
      },
    });

    return res.status(200).json({
      status: 'success',
      data: {
        message: `User ${target.role} (${target.email}) deleted successfully`,
        deletedUserId: id,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// HIERARCHICAL STAFF ACCESS — individual permission overlay (§2/§8/§14/§27)
//   GET   /admin/users/:id/access       read the resolved access configuration
//   PATCH /admin/users/:id/access       set INHERIT/CUSTOM (+ permissionKeys)
//   POST  /admin/users/:id/super-admin  grant/revoke the protected super-admin
//
// Invariants enforced here (server-authoritative):
//   · Individual access RESTRICTS only — granted keys must be a subset of the
//     role maximum (ADMIN baseline / BURSARY baseline) and of the ACTOR's own
//     effective permissions. It can never widen capability.
//   · ADMIN-only capabilities are never assignable to a BURSARY user; the
//     super-administrator-only capability is never delegable to anyone.
//   · A CUSTOM selection with ZERO keys is a VALID explicit zero.
// ---------------------------------------------------------------------------

const USER_ACCESS_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  middleName: true,
  lastName: true,
  role: true,
  accountStatus: true,
  isSuperAdmin: true,
} as const;

router.get(
  '/users/:id/access',
  requirePermission('MANAGE_USERS'),
  validateParams(UserIdParam),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof UserIdParam>;
    const user = await prisma.user.findUnique({
      where: { id },
      select: USER_ACCESS_USER_SELECT as any,
    });
    if (!user) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    const target = user as any;
    // An administrator's individual access is Super-Admin-only: a normal
    // (non-flagged) admin must never inspect a peer administrator's capability.
    if (target.role === Role.ADMIN && !isSuperAdmin(req.user)) {
      return res.status(403).json({
        status: 'fail',
        code: 'SUPER_ADMIN_REQUIRED',
        error: "Only a Super Administrator may view an administrator's individual access.",
      });
    }
    const access = await getUserAccess(id);
    if (!access) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    res.status(200).json({ status: 'success', data: buildUserAccessOut(target, access) });
  }),
);

const UpdateUserAccessSchema = z
  .object({
    accessMode: z.enum([AccessMode.INHERIT, AccessMode.CUSTOM]),
    // Required for CUSTOM (an EMPTY array is a valid explicit zero). Ignored
    // for INHERIT.
    permissionKeys: z.array(z.string().trim().min(1).max(64)).max(200).optional(),
  })
  .strict();

router.patch(
  '/users/:id/access',
  requirePermission('MANAGE_USERS'),
  validateParams(UserIdParam),
  validateBody(UpdateUserAccessSchema),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof UserIdParam>;
    const { accessMode, permissionKeys } = req.body as z.infer<typeof UpdateUserAccessSchema>;
    const actor = req.user as { id: number; role: Role; isSuperAdmin: boolean; permissions?: string[] };
    const actorIsSuperAdmin = isSuperAdmin(actor);

    const target = await prisma.user.findUnique({
      where: { id },
      select: USER_ACCESS_USER_SELECT as any,
    });
    if (!target) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    const t = target as any;

    // Individual access applies to STAFF only — a STUDENT never has a profile.
    if (t.role === Role.STUDENT) {
      return res.status(400).json({
        status: 'fail',
        code: 'NOT_STAFF',
        error: 'Individual access configuration applies to ADMIN and BURSARY users only.',
      });
    }

    if (t.role === Role.ADMIN && !actorIsSuperAdmin) {
      return res.status(403).json({
        status: 'fail',
        code: 'SUPER_ADMIN_REQUIRED',
        error: "Only a Super Administrator may change an administrator's individual access.",
      });
    }

    const targetIsSuperAdmin = isSuperAdmin({ id: t.id, role: t.role, isSuperAdmin: t.isSuperAdmin });
    if (targetIsSuperAdmin && accessMode === AccessMode.CUSTOM && !actorIsSuperAdmin) {
      return res.status(403).json({
        status: 'fail',
        code: 'SUPER_ADMIN_REQUIRED',
        error: 'Only a Super Administrator may configure individual access for a Super Administrator.',
      });
    }

    const baselineSet = new Set(await getRolePermissions(t.role as Role));

    let normalizedKeys: string[] = [];
    let permRows: { id: number; key: string }[] = [];
    if (accessMode === AccessMode.CUSTOM) {
      if (permissionKeys === undefined) {
        return res.status(400).json({
          status: 'fail',
          code: 'PERMISSION_KEYS_REQUIRED',
          error:
            'permissionKeys is required when accessMode is CUSTOM (an empty array is a valid explicit zero).',
        });
      }
      normalizedKeys = Array.from(new Set(permissionKeys.map((k) => k.trim())));

      // Super-administrator-only capabilities are never delegable to anyone.
      const superOnlyRequested = normalizedKeys.filter((k) => isSuperAdminOnlyPermission(k));
      if (superOnlyRequested.length > 0) {
        return res.status(400).json({
          status: 'fail',
          code: 'SUPER_ADMIN_ONLY_PERMISSION',
          error: `Super-Administrator-only permission keys cannot be delegated: ${superOnlyRequested.join(', ')}`,
        });
      }
      // ADMIN-only capabilities can never belong to a BURSARY user.
      if (t.role !== Role.ADMIN) {
        const adminOnlyRequested = normalizedKeys.filter((k) => isAdminOnlyPermission(k));
        if (adminOnlyRequested.length > 0) {
          return res.status(400).json({
            status: 'fail',
            code: 'ADMIN_ONLY_PERMISSION',
            error: `ADMIN-only permission keys cannot be assigned to a ${t.role} user: ${adminOnlyRequested.join(', ')}`,
          });
        }
      }

      // Resolve canonical permission rows (unknown keys → 400).
      if (normalizedKeys.length > 0) {
        const found = await prisma.permission.findMany({
          where: { key: { in: normalizedKeys } },
          select: { id: true, key: true },
        });
        const foundSet = new Set(found.map((p) => p.key));
        const missing = normalizedKeys.filter((k) => !foundSet.has(k));
        if (missing.length > 0) {
          return res.status(400).json({
            status: 'fail',
            code: 'UNKNOWN_PERMISSION',
            error: `Unknown permission keys: ${missing.join(', ')}`,
          });
        }
        permRows = found;
      }

      // Individual access can only RESTRICT the role maximum — never exceed it.
      const outsideBaseline = normalizedKeys.filter((k) => !baselineSet.has(k));
      if (outsideBaseline.length > 0) {
        return res.status(400).json({
          status: 'fail',
          code: 'OUT_OF_ROLE_SCOPE',
          error: `Permission keys outside the ${t.role} role maximum cannot be granted: ${outsideBaseline.join(', ')}`,
        });
      }
      // A delegator may only hand out capabilities it itself holds.
      if (!actorIsSuperAdmin) {
        const actorPerms = new Set(Array.isArray(actor.permissions) ? actor.permissions : []);
        const notHeld = normalizedKeys.filter((k) => !actorPerms.has(k));
        if (notHeld.length > 0) {
          return res.status(403).json({
            status: 'fail',
            code: 'EXCEEDS_ACTOR_PERMISSIONS',
            error: `You cannot grant permissions you do not hold: ${notHeld.join(', ')}`,
          });
        }
      }
    }

    // Diff against the CURRENT stored configuration so a no-op save never logs a
    // misleading change entry.
    const before = await getUserAccess(id);
    if (!before) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    const beforeSelected = new Set(before.customPermissionKeys);
    const afterSelected = new Set(permRows.map((p) => p.key));
    const modeChanged = before.accessMode !== accessMode;
    const selectionChanged =
      accessMode === AccessMode.CUSTOM &&
      (beforeSelected.size !== afterSelected.size ||
        [...afterSelected].some((k) => !beforeSelected.has(k)));
    const hasDiff = modeChanged || selectionChanged;

    if (hasDiff) {
      await prisma.$transaction(async (tx) => {
        const profile = await tx.userPermissionProfile.upsert({
          where: { userId: id },
          create: { userId: id, accessMode, updatedById: actor.id },
          update: { accessMode, updatedById: actor.id },
        });
        await tx.userPermission.deleteMany({ where: { profileId: profile.id } });
        if (accessMode === AccessMode.CUSTOM && permRows.length > 0) {
          await tx.userPermission.createMany({
            data: permRows.map((p) => ({ profileId: profile.id, permissionId: p.id })),
            skipDuplicates: true,
          });
        }
        // Individual access is resolved LIVE per request, so only the target's
        // EXISTING sessions need clearing — never any other user's.
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });

      await writeAudit(req, {
        action: modeChanged ? 'USER_ACCESS_MODE_CHANGED' : 'USER_PERMISSIONS_UPDATED',
        entityType: 'USER',
        entityId: id,
        details: {
          previousAccessMode: before.accessMode,
          accessMode,
          before: before.customPermissionKeys,
          after: [...afterSelected],
          role: t.role,
        },
      });
    }

    const after = await getUserAccess(id);
    if (!after) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    res.status(200).json({ status: 'success', data: buildUserAccessOut(t, after) });
  }),
);

const SetSuperAdminSchema = z.object({ grant: z.boolean() }).strict();

router.post(
  '/users/:id/super-admin',
  requireSuperAdmin,
  validateParams(UserIdParam),
  validateBody(SetSuperAdminSchema),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof UserIdParam>;
    const { grant } = req.body as z.infer<typeof SetSuperAdminSchema>;
    const actor = req.user as { id: number };

    // D10/D7 — the read → invariant check → write sequence runs in ONE
    // transaction so a concurrent revocation/demotion cannot slip past the
    // final-active-super-admin invariant.
    const outcome = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({
        where: { id },
        select: USER_ACCESS_USER_SELECT as any,
      });
      if (!target) return { kind: 'notFound' as const };
      const t = target as any;

      if (grant && t.role !== Role.ADMIN) return { kind: 'targetNotAdmin' as const };

      const currentFlag = t.isSuperAdmin === true;
      if (currentFlag === grant) return { kind: 'unchanged' as const, target: t };

      // The FINAL active super administrator must never lose the flag.
      if (!grant && t.accountStatus === AccountStatus.ACTIVE) {
        const invariant = await assertSuperAdminInvariant(tx, id);
        if (invariant === 'finalSuperAdmin') return { kind: 'finalSuperAdmin' as const };
      }

      await tx.user.update({ where: { id }, data: { isSuperAdmin: grant } });
      // Force the target to re-authenticate so its new capability set is
      // resolved fresh from the database on the next request.
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { kind: 'changed' as const, target: t };
    });

    if (outcome.kind === 'notFound') {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    if (outcome.kind === 'targetNotAdmin') {
      return res.status(400).json({
        status: 'fail',
        code: 'TARGET_NOT_ADMIN',
        error: 'Only a user whose role is ADMIN can be granted the Super Administrator flag.',
      });
    }
    if (outcome.kind === 'finalSuperAdmin') {
      return res.status(409).json({
        status: 'fail',
        code: 'FINAL_SUPER_ADMIN',
        error: 'Cannot revoke the Super Administrator flag from the final active Super Administrator.',
      });
    }

    if (outcome.kind === 'changed') {
      await writeAudit(req, {
        action: grant ? 'SUPER_ADMIN_GRANTED' : 'SUPER_ADMIN_REVOKED',
        entityType: 'USER',
        entityId: id,
        details: { email: outcome.target.email, role: outcome.target.role, changedBy: actor.id },
      });
    }

    const fresh = await prisma.user.findUnique({
      where: { id },
      select: USER_ACCESS_USER_SELECT as any,
    });
    const access = await getUserAccess(id);
    if (!fresh || !access) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    res.status(200).json({ status: 'success', data: buildUserAccessOut(fresh as any, access) });
  }),
);

// ---------------------------------------------------------------------------
// Roles CRUD (4 routes, STUDENT hidden)
//   POST   /admin/roles              atomically REPLACE role permissions
//   PATCH  /admin/roles/:role        atomically REPLACE role permissions
// Permission: MANAGE_ROLES
// ---------------------------------------------------------------------------

const ROLE_META: Record<string, { name: string; description: string; modifiable: boolean }> = {
  [Role.ADMIN]: {
    name: 'Administrator',
    description: 'Full system access with all permissions. Protected super-administrator.',
    modifiable: false,
  },
  [Role.BURSARY]: {
    name: 'Bursary',
    description: 'Financial operations, payments and receipts',
    modifiable: true,
  },
  [Role.STUDENT]: {
    name: 'Student',
    description: 'Fixed student self-service access. Not configurable.',
    modifiable: false,
  },
};

const RoleNameParam = z.object({ role: z.enum([Role.ADMIN, Role.BURSARY]) });

type RolePermRow = { permission: { key: string; name: string; category: string | null; description?: string | null } };

function buildRoleOut(role: string, permsRows: RolePermRow[]) {
  const meta = ROLE_META[role] ?? { name: role, description: '', modifiable: false };
  const isSuperAdminRole = role === Role.ADMIN;
  // ADMIN is a protected super-administrator: runtime authorization always grants
  // it the ENTIRE registry, so report the canonical catalogue rather than a
  // (possibly stale) RolePermission snapshot.
  const permissions = isSuperAdminRole
    ? PERMISSION_CATALOGUE.map((p) => ({
        key: p.key,
        name: p.name,
        category: p.category,
        description: p.description,
      }))
    : permsRows.map((rp) => ({
        ...rp.permission,
        category: rp.permission.category ?? 'Admin',
      }));
  return {
    role,
    name: meta.name,
    description: meta.description,
    /** true only for BURSARY — the single configurable role in this phase. */
    modifiable: meta.modifiable,
    /** true for ADMIN: protected super-administrator, never editable. */
    isSuperAdmin: isSuperAdminRole,
    permissions,
    permissionsCount: permissions.length,
  };
}

async function loadRolePermissionKeys(role: string): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({
    where: { role: role as Role },
    select: { permission: { select: { key: true } } },
  });
  return rows.map((r) => r.permission.key);
}

async function replaceRolePermissions(
  req: ReqLike | undefined,
  role: string,
  permissionKeys: string[],
  auditAction: 'CREATE_ROLE' | 'UPDATE_ROLE'
) {
  const asRole = role as Role;

  // --- Layer 3: only the CONFIGURABLE role may be modified -------------------
  // ADMIN is the protected super-administrator (its permission set is always the
  // full registry and is never stored/edited) and STUDENT is a fixed role.
  // Accepting either here would allow privilege escalation or a lockout.
  if (asRole !== Role.BURSARY) {
    return {
      ok: false as const,
      status: 403,
      error: `Role '${role}' cannot be modified. Only the BURSARY role has a configurable permission set.`,
    };
  }

  // --- Normalise input: reject malformed values, remove duplicates -----------
  if (!Array.isArray(permissionKeys)) {
    return { ok: false as const, status: 400, error: 'permissionKeys must be an array.' };
  }
  const malformed = permissionKeys.filter((k) => typeof k !== 'string' || k.trim().length === 0 || k.length > 64);
  if (malformed.length > 0) {
    return { ok: false as const, status: 400, error: 'permissionKeys contains invalid entries.' };
  }
  const uniqueKeys = Array.from(new Set(permissionKeys.map((k) => k.trim())));

  // --- Reject ADMIN-only capabilities (Layer 3, server-side) -----------------
  const adminOnlyRequested = uniqueKeys.filter((k) => isAdminOnlyPermission(k));
  if (adminOnlyRequested.length > 0) {
    return {
      ok: false as const,
      status: 400,
      error: `ADMIN-only permission keys cannot be assigned: ${adminOnlyRequested.join(', ')}`,
    };
  }

  const [perms, oldKeys] = await Promise.all([
    prisma.permission.findMany({
      where: { key: { in: uniqueKeys } },
      select: { id: true, key: true },
    }),
    loadRolePermissionKeys(role),
  ]);
  const foundKeys = new Set(perms.map((p) => p.key));
  const missing = uniqueKeys.filter((k) => !foundKeys.has(k));
  if (missing.length > 0) {
    return { ok: false as const, status: 400, error: `Unknown permission keys: ${missing.join(', ')}` };
  }
  const newSet = new Set(perms.map((p) => p.key));
  const oldSet = new Set(oldKeys);
  const addedKeys = perms.filter((p) => !oldSet.has(p.key)).map((p) => p.key).sort();
  const removedKeys = oldKeys.filter((k) => !newSet.has(k)).sort();

  const finalRows: RolePermRow[] = await prisma.$transaction(async (tx) => {
    await tx.rolePermission.deleteMany({ where: { role: asRole } });
    if (perms.length > 0) {
      await tx.rolePermission.createMany({
        data: perms.map((p) => ({ role: asRole, permissionId: p.id })),
        skipDuplicates: true,
      });
    }
    return tx.rolePermission.findMany({
      where: { role: asRole },
      include: { permission: { select: { key: true, name: true, category: true, description: true } } },
    });
  });

  const hasDiff = addedKeys.length > 0 || removedKeys.length > 0;
  let summary = 'No changes';
  if (hasDiff) {
    const parts: string[] = [];
    if (addedKeys.length) parts.push(`Added [${addedKeys.join(', ')}]`);
    if (removedKeys.length) parts.push(`Removed [${removedKeys.join(', ')}]`);
    summary = parts.join('; ');
  }
  if (hasDiff) {
    bumpRolePermsVersion();
    await writeAudit(req, {
      action: auditAction,
      entityType: 'ROLE',
      entityId: role,
      details: {
        permissionKeys: finalRows.map((r) => r.permission.key),
        addedKeys,
        removedKeys,
        summary,
      },
    });
  }

  if (hasDiff) {
    // === ROLE PERMISSIONS CHANGED → INVALIDATE ALL ACTIVE SESSIONS FOR THIS ROLE ===
    // JWT access tokens are STATIC signed claims (created at login/refresh). If an
    // Admin disables the "Students" permission set for Bursary, any Bursary user who
    // is ALREADY logged in would otherwise KEEP their old 15m accessToken carrying
    // the old permissions array (with VIEW_STUDENTS etc.) — and the sidebar would
    // still show Student Management until the token rotated (up to 14d via
    // refreshToken). Bumping the perms version alone is not enough because the
    // frontend has the token persisted. Fix: revoke every unrevoked refreshToken
    // row whose user.role === the role we just changed. On the user's NEXT page
    // load, /auth/refresh will 401 (revoked) → the user's session validation flow
    // will re-call AuthService.me() via the new /auth/me fetch, which returns
    // FRESH DB permissions (attached to user.permissions). Our matching frontend
    // AuthContext merge priority change ensures user.permissions wins over the
    // stale token claims, so the sidebar IMMEDIATELY hides the disabled sections
    // — no logout required. In parallel, requiring a fresh refreshToken on next
    // access rotation also guarantees that newly issued tokens carry the correct
    // permissions array signed in the JWT.
    const affectedUserIds = await prisma.user.findMany({
      where: { role: asRole },
      select: { id: true },
    });
    if (affectedUserIds.length > 0) {
      const revokedCount = await prisma.refreshToken.updateMany({
        where: {
          userId: { in: affectedUserIds.map((u) => u.id) },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      await writeAudit(req, {
        action: 'ROLE_PERMS_SYNCED',
        entityType: 'ROLE',
        entityId: role,
        details: {
          addedKeys,
          removedKeys,
          revokedSessions: revokedCount.count,
          affectedUserIds: affectedUserIds.map((u) => u.id),
        },
      });
    }
  }

  return {
    ok: true as const,
    status: auditAction === 'CREATE_ROLE' ? 201 : 200,
    addedKeys,
    removedKeys,
    data: buildRoleOut(role, finalRows),
  };
}

router.get(
  '/roles',
  requirePermission('MANAGE_ROLES'),
  catchAsync(async (_req: any, res) => {
    // STUDENT is included as a READ-ONLY entry so the UI shows the complete,
    // accurate picture (it is never configurable — it is a fixed role enforced
    // by restrictTo(Role.STUDENT) rather than by permission keys).
    const visibleRoles = [Role.ADMIN, Role.BURSARY, Role.STUDENT];
    const items = await Promise.all(
      visibleRoles.map(async (r) => {
        const perms: RolePermRow[] = await prisma.rolePermission.findMany({
          where: { role: r },
          include: { permission: { select: { key: true, name: true, category: true, description: true } } },
        });
        return buildRoleOut(r, perms);
      })
    );
    res.status(200).json({
      status: 'success',
      data: {
        items,
        // Only roles whose permission set may be replaced via POST/PATCH /admin/roles.
        configurableRoles: items.filter((r) => r.modifiable).map((r) => r.role),
      },
    });
  }),
);

router.get(
  '/roles/:role',
  requirePermission('MANAGE_ROLES'),
  validateParams(RoleNameParam),
  catchAsync(async (req: any, res) => {
    const { role } = req.params as z.infer<typeof RoleNameParam>;
    const perms: RolePermRow[] = await prisma.rolePermission.findMany({
      where: { role },
      include: { permission: { select: { key: true, name: true, category: true, description: true } } },
    });
    res.status(200).json({ status: 'success', data: buildRoleOut(role, perms) });
  }),
);

const CreateRoleSchema = z
  .object({
    role: z.enum([Role.ADMIN, Role.BURSARY]),
    // An empty array is VALID: it means "this role has no permissions".
    permissionKeys: z.array(z.string().min(1).max(64)).max(200),
  })
  .strict();

router.post(
  '/roles',
  requirePermission('MANAGE_ROLES'),
  validateBody(CreateRoleSchema),
  catchAsync(async (req: any, res) => {
    const { role, permissionKeys } = req.body as z.infer<typeof CreateRoleSchema>;
    const result = await replaceRolePermissions(req, role, permissionKeys, 'CREATE_ROLE');
    if (!result.ok) {
      return res.status(result.status).json({ status: 'fail', message: result.error });
    }
    res.status(result.status).json({
      status: 'success',
      diff: { added: result.addedKeys, removed: result.removedKeys },
      data: result.data,
    });
  }),
);

const UpdateRoleSchema = z
  .object({
    // An empty array is VALID: it removes every permission from the role.
    permissionKeys: z.array(z.string().min(1).max(64)).max(200),
  })
  .strict();

router.patch(
  '/roles/:role',
  requirePermission('MANAGE_ROLES'),
  validateParams(RoleNameParam),
  validateBody(UpdateRoleSchema),
  catchAsync(async (req: any, res) => {
    const { role } = req.params as z.infer<typeof RoleNameParam>;
    const { permissionKeys } = req.body as z.infer<typeof UpdateRoleSchema>;
    const result = await replaceRolePermissions(req, role, permissionKeys, 'UPDATE_ROLE');
    if (!result.ok) {
      return res.status(result.status).json({ status: 'fail', message: result.error });
    }
    res.status(result.status).json({
      status: 'success',
      diff: { added: result.addedKeys, removed: result.removedKeys },
      data: result.data,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /admin/permissions  (canonical PERMISSION_CATALOGUE + roles_assigned)
//   Permission: MANAGE_ROLES
//   This is the ONE source the frontend uses for displayable permissions;
//   `adminOnly`/`assignable` tell the UI which keys can never be granted to a
//   configurable role.
// ---------------------------------------------------------------------------

router.get(
  '/permissions',
  requirePermission('MANAGE_ROLES'),
  catchAsync(async (_req: any, res) => {
    const allRolePerms = await prisma.rolePermission.findMany({
      include: { permission: { select: { key: true } } },
    });
    const byPermKey = new Map<string, string[]>();
    for (const rp of allRolePerms) {
      const k = rp.permission.key;
      if (!byPermKey.has(k)) byPermKey.set(k, []);
      byPermKey.get(k)!.push(rp.role);
    }
    const items = PERMISSION_CATALOGUE.map((def) => ({
      key: def.key,
      name: def.name,
      category: def.category,
      description: def.description,
      adminOnly: def.adminOnly,
      // D4 — a capability reserved to a FLAG-AWARE Super Administrator is never
      // delegable to any other user (not even a normal ADMIN).
      superAdminOnly: def.superAdminOnly,
      assignable: def.assignable,
      roles_assigned: byPermKey.get(def.key) ?? [],
    }));
    res.status(200).json({ status: 'success', data: { items } });
  }),
);

// ---------------------------------------------------------------------------
// E1: Composite Global Search — GET /admin/search?q=
// ---------------------------------------------------------------------------

const AdminSearchQuery = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
router.get(
  '/search',
  requirePermission('VIEW_DASHBOARD'),
  validateQuery(AdminSearchQuery),
  catchAsync(async (req: any, res) => {
    const { q, limit } = req.query as z.infer<typeof AdminSearchQuery>;
    const result = await AdminSearchService.composite(q, { limit });
    res.status(200).json({ status: 'success', data: result });
  }),
);

// ---------------------------------------------------------------------------
// System Settings CRUD singleton (id=1)
//   Permission: SYSTEM_SETTINGS
// ---------------------------------------------------------------------------

router.get(
  '/settings',
  requirePermission('SYSTEM_SETTINGS'),
  catchAsync(async (_req: any, res) => {
    const settings = await SystemSettingsService.get();
    res.status(200).json({ status: 'success', data: settings });
  }),
);

const SystemSettingsPatchSchema = z
  .object({
    universityName: z.string().min(1).max(200).optional(),
    universityLogoUrl: z.string().max(500).nullable().optional(),
    universityFaviconUrl: z.string().max(500).nullable().optional(),
    universityAddress: z.string().max(500).nullable().optional(),
    universityPhone: z.string().max(40).nullable().optional(),
    universityEmail: z.string().email().max(150).nullable().optional(),
    universityWebsite: z.string().max(200).nullable().optional(),
    paystackLiveEnabled: z.boolean().optional(),
    activePaymentGateway: z.enum([PaymentGateway.PAYSTACK, PaymentGateway.ALATPAY]).optional(),
    largePaymentThreshold: z.union([z.number().min(0), z.string().refine((v) => Number(v) >= 0).transform((v) => Number(v))]).optional(),
    importErrorThreshold: z.coerce.number().int().min(0).optional(),
    receiptFooterText: z.string().max(500).nullable().optional(),
    receiptBursarName: z.string().max(190).nullable().optional(),
    receiptBursarTitle: z.string().max(190).nullable().optional(),
    receiptBursarSignatureUrl: z.string().max(500).nullable().optional(),
    receiptPrefix: z.string().min(1).max(10).optional(),
    paymentRefPrefix: z.string().min(1).max(10).optional(),
    emailProviderForceSmtp: z.boolean().optional(),
  })
  .strict();

router.patch(
  '/settings',
  requirePermission('SYSTEM_SETTINGS'),
  validateBody(SystemSettingsPatchSchema),
  catchAsync(async (req: any, res) => {
    const rawPatch = req.body as z.infer<typeof SystemSettingsPatchSchema>;
    const patch: any = { ...rawPatch };
    if (patch.largePaymentThreshold !== undefined && patch.largePaymentThreshold !== null) {
      patch.largePaymentThreshold = new Prisma.Decimal(Number(patch.largePaymentThreshold));
    }
    const updated = await SystemSettingsService.update(patch, {
      updatedById: req.user?.id ?? undefined,
    });
    res.status(200).json({ status: 'success', data: updated });
  }),
);

// ---------------------------------------------------------------------------
// Payment Config (GET + PATCH toggle)
//   GET    /admin/payment-config
//   PATCH  /admin/payment-config
//   Permission: PAYSTACK_CONFIG
//   Audit: GATEWAY_TOGGLE
// ---------------------------------------------------------------------------

router.get(
  '/payment-config',
  requirePermission('PAYSTACK_CONFIG'),
  catchAsync(async (_req: any, res) => {
    const settings = await SystemSettingsService.get();
    const activeGateway = settings.activePaymentGateway ?? PaymentGateway.ALATPAY;
    const supportedGateways = [
      {
        key: PaymentGateway.PAYSTACK,
        label: 'Paystack',
        status: settings.activePaymentGateway === PaymentGateway.PAYSTACK ? 'ACTIVE' : 'INACTIVE',
      },
      {
        key: PaymentGateway.ALATPAY,
        label: 'ALAT Pay',
        status: settings.activePaymentGateway === PaymentGateway.ALATPAY ? 'ACTIVE' : 'INACTIVE',
      },
    ];
    res.status(200).json({
      status: 'success',
      data: { activeGateway, supportedGateways },
    });
  }),
);

const PaymentConfigPatchSchema = z
  .object({
    activeGateway: z.enum([PaymentGateway.PAYSTACK, PaymentGateway.ALATPAY]),
  })
  .strict();

router.patch(
  '/payment-config',
  requirePermission('PAYSTACK_CONFIG'),
  validateBody(PaymentConfigPatchSchema),
  catchAsync(async (req: any, res) => {
    const { activeGateway } = req.body as z.infer<typeof PaymentConfigPatchSchema>;
    const before = await SystemSettingsService.get();
    const updated = await SystemSettingsService.update(
      { activePaymentGateway: activeGateway } as any,
      { updatedById: req.user?.id ?? undefined },
    );
    await writeAudit(req, {
      action: 'GATEWAY_TOGGLE',
      entityType: 'PAYMENT_CONFIG',
      entityId: '1',
      details: {
        oldGateway: before.activePaymentGateway ?? null,
        newGateway: activeGateway,
      },
    });
    const supportedGateways = [
      {
        key: PaymentGateway.PAYSTACK,
        label: 'Paystack',
        status: updated.activePaymentGateway === PaymentGateway.PAYSTACK ? 'ACTIVE' : 'INACTIVE',
      },
      {
        key: PaymentGateway.ALATPAY,
        label: 'ALAT Pay',
        status: updated.activePaymentGateway === PaymentGateway.ALATPAY ? 'ACTIVE' : 'INACTIVE',
      },
    ];
    res.status(200).json({
      status: 'success',
      data: {
        activeGateway: updated.activePaymentGateway,
        supportedGateways,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Admin Notifications
// ---------------------------------------------------------------------------

const NotifListQuery = z.object({
  read: z.enum(['unread', 'all']).optional().default('unread'),
  page: z.coerce.number().int().min(1).max(100).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});
router.get(
  '/notifications',
  requirePermission('VIEW_DASHBOARD'),
  validateQuery(NotifListQuery),
  catchAsync(async (req: any, res) => {
    const { read, page, limit } = req.query as z.infer<typeof NotifListQuery>;
    const result = await AdminNotificationService.listNotifications({ read, page, limit });
    res.status(200).json({ status: 'success', data: result });
  }),
);

const NotifIdParam = z.object({ id: z.coerce.number().int().positive() });
router.post(
  '/notifications/:id/read',
  requirePermission('VIEW_DASHBOARD'),
  validateParams(NotifIdParam),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof NotifIdParam>;
    const userId = Number(req.user?.id ?? 0);
    if (!userId || userId <= 0) {
      return res.status(401).json({ status: 'fail', message: 'Authentication required' });
    }
    const marked = await AdminNotificationService.markRead(id, userId);
    res.status(200).json({ status: 'success', data: marked });
  }),
);

// ---------------------------------------------------------------------------
// Admin: Payments list (transactions with student/invoice/fee/receipt includes)
// ---------------------------------------------------------------------------
const AdminPaymentListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  sort: z.string().optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  q: z.string().trim().max(200).optional(),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'REVERSED']).optional(),
  gateway: z.enum(['PAYSTACK', 'ALATPAY']).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  studentId: z.coerce.number().int().positive().optional(),
  feeId: z.coerce.number().int().positive().optional(),
  invoiceId: z.coerce.number().int().positive().optional(),
});

router.get(
  '/payments',
  requirePermission('VIEW_PAYMENTS'),
  validateQuery(AdminPaymentListQuery),
  catchAsync(async (req: any, res) => {
    const q = req.query as z.infer<typeof AdminPaymentListQuery>;
    const page = q.page;
    const pageSize = q.pageSize;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (q.status) where.status = q.status;
    if (q.gateway) where.gateway = q.gateway;
    if (q.studentId) where.userId = q.studentId;
    if (q.invoiceId) where.invoiceId = q.invoiceId;
    if (q.feeId) where.invoice = { feeId: q.feeId };
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {};
      if (q.dateFrom) where.createdAt.gte = new Date(q.dateFrom);
      if (q.dateTo) where.createdAt.lte = new Date(q.dateTo + 'T23:59:59.999Z');
    }
    if (q.q) {
      where.OR = [
        { reference: { contains: q.q, mode: 'insensitive' } },
        { paystackReference: { contains: q.q, mode: 'insensitive' } },
        { user: { OR: [
          { firstName: { contains: q.q, mode: 'insensitive' } },
          { lastName: { contains: q.q, mode: 'insensitive' } },
          { email: { contains: q.q, mode: 'insensitive' } },
          { matricNumber: { contains: q.q, mode: 'insensitive' } },
        ]}},
        { invoice: { OR: [
          { invoiceNumber: { contains: q.q, mode: 'insensitive' } },
          { fee: { OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { feeCode: { contains: q.q, mode: 'insensitive' } },
          ]}},
        ]}},
      ];
    }

    type AdminTxnAllowedSort = 'createdAt' | 'amount' | 'status';
    type AdminTxnAllowedOrder = 'asc' | 'desc';
    const ADMIN_TXN_ALLOWED_SORTS: ReadonlySet<AdminTxnAllowedSort> = new Set(['createdAt', 'amount', 'status']);
    const ADMIN_TXN_ALLOWED_ORDERS: ReadonlySet<AdminTxnAllowedOrder> = new Set(['asc', 'desc']);
    const ADMIN_TXN_SORT_TO_FIELD: Record<AdminTxnAllowedSort, 'createdAt' | 'amount' | 'status'> = {
      createdAt: 'createdAt',
      amount: 'amount',
      status: 'status',
    };
    const rawSortTxn = q.sort as AdminTxnAllowedSort | string | undefined;
    const rawOrderTxn = q.order as AdminTxnAllowedOrder | string | undefined;
    const sortTxn: AdminTxnAllowedSort = ADMIN_TXN_ALLOWED_SORTS.has(rawSortTxn as AdminTxnAllowedSort)
      ? (rawSortTxn as AdminTxnAllowedSort)
      : 'createdAt';
    const orderTxn: AdminTxnAllowedOrder = ADMIN_TXN_ALLOWED_ORDERS.has(rawOrderTxn as AdminTxnAllowedOrder)
      ? (rawOrderTxn as AdminTxnAllowedOrder)
      : 'desc';
    const orderBy = { [ADMIN_TXN_SORT_TO_FIELD[sortTxn]]: orderTxn };

    const [items, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        skip, take: pageSize,
        orderBy,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, matricNumber: true } },
          invoice: { select: { id: true, invoiceNumber: true, fee: { select: { id: true, name: true, feeCode: true } } } },
          receipts: { take: 1, orderBy: { generatedAt: 'desc' }, select: { id: true, receiptNumber: true, verificationToken: true, isVoided: true } },
        },
      }),
      prisma.transaction.count({ where }),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Admin: Verify Payment workspace
//   GET  /admin/payments/:id        → transaction detail (read-only)
//   POST /admin/payments/:id/verify → run provider verification
// Both require VERIFY_PAYMENT. The transaction is loaded server-side by :id;
// the browser may not substitute provider identifiers.
// ---------------------------------------------------------------------------
const AdminPaymentsIdParam = z.object({ id: z.coerce.number().int().positive() });
router.get(
  '/payments/lookup',
  requirePermission('VERIFY_PAYMENT'),
  lookupTransactionForVerify,
);
router.get(
  '/payments/:id',
  requirePermission('VERIFY_PAYMENT'),
  validateParams(AdminPaymentsIdParam),
  getTransactionForVerify,
);
router.post(
  '/payments/:id/verify',
  requirePermission('VERIFY_PAYMENT'),
  validateParams(AdminPaymentsIdParam),
  verifyPaymentByTransactionId,
);

// ---------------------------------------------------------------------------
// Admin: Receipts list
// ---------------------------------------------------------------------------
const AdminReceiptListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  sort: z.string().optional().default('paidAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  q: z.string().trim().max(200).optional(),
  isVoided: z.enum(['true', 'false']).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  studentId: z.coerce.number().int().positive().optional(),
  feeId: z.coerce.number().int().positive().optional(),
});

router.get(
  '/receipts',
  requirePermission('VIEW_RECEIPTS'),
  validateQuery(AdminReceiptListQuery),
  catchAsync(async (req: any, res) => {
    const q = req.query as z.infer<typeof AdminReceiptListQuery>;
    const page = q.page;
    const pageSize = q.pageSize;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (q.isVoided === 'true') where.isVoided = true;
    if (q.isVoided === 'false') where.isVoided = false;
    if (q.studentId) where.studentId = q.studentId;
    if (q.feeId) where.invoice = { feeId: q.feeId };
    if (q.dateFrom || q.dateTo) {
      where.paidAt = {};
      if (q.dateFrom) where.paidAt.gte = new Date(q.dateFrom);
      if (q.dateTo) where.paidAt.lte = new Date(q.dateTo + 'T23:59:59.999Z');
    }
    if (q.q) {
      where.OR = [
        { receiptNumber: { contains: q.q, mode: 'insensitive' } },
        { verificationToken: { contains: q.q, mode: 'insensitive' } },
        { student: { OR: [
          { firstName: { contains: q.q, mode: 'insensitive' } },
          { lastName: { contains: q.q, mode: 'insensitive' } },
          { email: { contains: q.q, mode: 'insensitive' } },
          { matricNumber: { contains: q.q, mode: 'insensitive' } },
        ]}},
        { invoice: { OR: [
          { invoiceNumber: { contains: q.q, mode: 'insensitive' } },
          { fee: { OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { feeCode: { contains: q.q, mode: 'insensitive' } },
          ]}},
        ]}},
      ];
    }

    type AdminRcpAllowedSort = 'paidAt' | 'paidAmount' | 'receiptNumber';
    type AdminRcpAllowedOrder = 'asc' | 'desc';
    const ADMIN_RCP_ALLOWED_SORTS: ReadonlySet<AdminRcpAllowedSort> = new Set(['paidAt', 'paidAmount', 'receiptNumber']);
    const ADMIN_RCP_ALLOWED_ORDERS: ReadonlySet<AdminRcpAllowedOrder> = new Set(['asc', 'desc']);
    const ADMIN_RCP_SORT_TO_FIELD: Record<AdminRcpAllowedSort, 'paidAt' | 'paidAmount' | 'receiptNumber'> = {
      paidAt: 'paidAt',
      paidAmount: 'paidAmount',
      receiptNumber: 'receiptNumber',
    };
    const rawSortRcp = q.sort as AdminRcpAllowedSort | string | undefined;
    const rawOrderRcp = q.order as AdminRcpAllowedOrder | string | undefined;
    const sortRcp: AdminRcpAllowedSort = ADMIN_RCP_ALLOWED_SORTS.has(rawSortRcp as AdminRcpAllowedSort)
      ? (rawSortRcp as AdminRcpAllowedSort)
      : 'paidAt';
    const orderRcp: AdminRcpAllowedOrder = ADMIN_RCP_ALLOWED_ORDERS.has(rawOrderRcp as AdminRcpAllowedOrder)
      ? (rawOrderRcp as AdminRcpAllowedOrder)
      : 'desc';
    const orderBy = { [ADMIN_RCP_SORT_TO_FIELD[sortRcp]]: orderRcp };

    const [items, total] = await Promise.all([
      prisma.receipt.findMany({
        where,
        skip, take: pageSize,
        orderBy,
        include: {
          student: { select: { id: true, firstName: true, lastName: true, email: true, matricNumber: true } },
          invoice: { select: { id: true, invoiceNumber: true, fee: { select: { id: true, name: true, feeCode: true } } } },
          transaction: { select: { reference: true, paystackChannel: true, gateway: true, type: true, amount: true, status: true, createdAt: true } },
          voidedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
      prisma.receipt.count({ where }),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  }),
);

router.get(
  '/receipts/export.csv',
  requirePermission('VIEW_RECEIPTS'),
  validateQuery(AdminReceiptListQuery),
  catchAsync(async (req: any, res) => {
    const q = req.query as z.infer<typeof AdminReceiptListQuery>;
    const where: any = {};
    if (q.isVoided === 'true') where.isVoided = true;
    if (q.isVoided === 'false') where.isVoided = false;
    if (q.studentId) where.studentId = q.studentId;
    if (q.feeId) where.invoice = { feeId: q.feeId };
    if (q.dateFrom || q.dateTo) {
      where.paidAt = {};
      if (q.dateFrom) where.paidAt.gte = new Date(q.dateFrom);
      if (q.dateTo) where.paidAt.lte = new Date(q.dateTo + 'T23:59:59.999Z');
    }
    if (q.q) {
      where.OR = [
        { receiptNumber: { contains: q.q, mode: 'insensitive' } },
        { verificationToken: { contains: q.q, mode: 'insensitive' } },
        { student: { OR: [
          { firstName: { contains: q.q, mode: 'insensitive' } },
          { lastName: { contains: q.q, mode: 'insensitive' } },
          { email: { contains: q.q, mode: 'insensitive' } },
          { matricNumber: { contains: q.q, mode: 'insensitive' } },
        ]}},
        { invoice: { OR: [
          { invoiceNumber: { contains: q.q, mode: 'insensitive' } },
          { fee: { OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { feeCode: { contains: q.q, mode: 'insensitive' } },
          ]}},
        ]}},
      ];
    }
    const rows = await prisma.receipt.findMany({
      where,
      take: 50000,
      orderBy: { paidAt: 'desc' },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, email: true, matricNumber: true } },
        invoice: { select: { id: true, invoiceNumber: true, fee: { select: { id: true, name: true, feeCode: true } } } },
        transaction: { select: { reference: true, paystackChannel: true, gateway: true, type: true, amount: true, status: true, createdAt: true } },
      },
    });
    const header = ['receiptNumber', 'verificationToken', 'paidAt', 'paidAmount', 'studentName', 'studentEmail', 'matricNumber', 'invoiceNumber', 'feeName', 'feeCode', 'gateway', 'channel', 'txReference', 'status', 'voided'];
    let csv = '\uFEFF' + csvLineSafe(header);
    for (const r of rows) {
      const stu = r.student as any;
      const stuName = [stu?.firstName, stu?.lastName].filter(Boolean).join(' ');
      const inv = r.invoice as any;
      const tx = r.transaction as any;
      csv += csvLineSafe([
        r.receiptNumber, r.verificationToken, r.paidAt?.toISOString() ?? '', String(r.paidAmount ?? ''),
        stuName, stu?.email ?? '', stu?.matricNumber ?? '', inv?.invoiceNumber ?? '',
        inv?.fee?.name ?? '', inv?.fee?.feeCode ?? '', tx?.gateway ?? '', tx?.paystackChannel ?? '',
        tx?.reference ?? '', tx?.status ?? '', r.isVoided ? 'YES' : 'NO',
      ]);
    }
    const ts = (d: any) => (d ? new Date(String(d)).toISOString().slice(0, 10).replace(/-/g, '') : 'all');
    const filename = `admin_receipts_${ts(q.dateFrom)}_${ts(q.dateTo)}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    if (((q as any).format ?? 'csv') === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=admin_receipts_${ts(q.dateFrom)}_${ts(q.dateTo)}.json`);
      return res.status(200).json({ status: 'success', data: { rows } });
    }
    const csvWithIntegrity = appendCsvIntegrityTrailer(csv);
    res.status(200).send(csvWithIntegrity);
  }),
);

// ---------------------------------------------------------------------------
// Admin: Download formal receipt PDF by id (bypass student-scope check)
// ---------------------------------------------------------------------------
const ReceiptIdParam = z.object({ id: z.coerce.number().int().positive() });
router.get(
  '/receipts/:id/download',
  requirePermission('GENERATE_RECEIPT'),
  validateParams(ReceiptIdParam),
  catchAsync(async (req: any, res: any, next: any) => {
    const { downloadFormalReceipt } = await import('../controllers/receipt');
    return downloadFormalReceipt(req, res, next);
  }),
);

// ---------------------------------------------------------------------------
// Admin: Verify receipt by verificationToken OR receiptNumber (inline panel)
// ---------------------------------------------------------------------------
const ReceiptVerifyParam = z.object({ tokenOrNumber: z.string().min(1).max(100).trim() });
router.get(
  '/receipts/verify/:tokenOrNumber',
  requirePermission('VIEW_RECEIPTS'),
  validateParams(ReceiptVerifyParam),
  catchAsync(async (req: any, res) => {
    const tokenOrNumber = String(req.params.tokenOrNumber || '').trim();
    const row: any = await prisma.receipt.findFirst({
      where: { OR: [
        { verificationToken: tokenOrNumber },
        { receiptNumber: tokenOrNumber },
      ]},
      include: {
        student: { select: { id: true, firstName: true, lastName: true, email: true, matricNumber: true } },
        invoice: { include: { fee: { select: { id: true, name: true, feeCode: true } } } },
        transaction: { select: { reference: true, paystackReference: true, alatpayReference: true, paystackChannel: true, gateway: true, type: true, amount: true, status: true, createdAt: true } },
      },
    });

    const brand = await buildBranding();

    if (!row) {
      res.status(404).json({
        status: 'fail',
        verified: false,
        message: 'Receipt not found or verification token invalid',
        branding: brand,
      });
      return;
    }

    res.status(200).json({
      status: 'success',
      verified: !row.isVoided,
      data: {
        id: row.id,
        receiptNumber: row.receiptNumber,
        verificationToken: row.verificationToken,
        paidAmount: Number(row.paidAmount),
        paidAt: row.paidAt,
        isVoided: row.isVoided,
        voidedAt: row.voidedAt || null,
        paymentChannel: row.paymentChannel,
        paymentMethodDetail: row.paymentMethodDetail,
        paystackReference: row.paystackReference || null,
        alatpayReference: (row.transaction?.alatpayReference) || null,
        student: row.student,
        invoice: row.invoice ? {
          id: row.invoice.id,
          invoiceNumber: row.invoice.invoiceNumber || null,
          dueDate: row.invoice.dueDate || null,
          session: row.invoice.session || null,
          semester: row.invoice.semester || null,
          fee: row.invoice.fee ? { name: row.invoice.fee.name, feeCode: row.invoice.fee.feeCode } : null,
        } : null,
        transaction: row.transaction,
      },
      branding: brand,
    });
  }),
);

// -----------------------------------------------------------------------------
// EMAIL: Templates configuration + delivery logs + resend credentials
// (mounted after protect/restrictTo(ADMIN))
// -----------------------------------------------------------------------------

const resendCredentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req: Request) => {
    const id = (req.params as any).id;
    void id;
    return 5;
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const uid = (req as any).user?.id ?? 'anon';
    const targetId = (req.params as any).id ?? 'all';
    return `resend-creds:${uid}:${targetId}`;
  },
  message: { status: 'fail', message: 'Too many credential resend requests. Please try again in 15 minutes.' },
});

const emailTypeValues: readonly string[] = Object.values(EmailType);
const emailStatusValues: readonly string[] = Object.values(EmailDeliveryStatus);

const TemplateKeyParam = z.object({ templateKey: z.string().min(1).max(100).trim() });
// 1. GET template by key (ADMIN role + MANAGE_EMAIL_TEMPLATES capability)
router.get('/email-templates/:templateKey', requirePermission('MANAGE_EMAIL_TEMPLATES'), validateParams(TemplateKeyParam), catchAsync(async (req: Request, res: Response) => {
  const key = String((req.params as any).templateKey || '').trim();
  if (!key) return res.status(400).json({ status: 'fail', message: 'templateKey required' });
  const data = await EmailTemplateService.getByKey(key);
  res.json({ status: 'success', data });
}));

// 2. PATCH template by key (ADMIN role + MANAGE_EMAIL_TEMPLATES capability)
router.patch('/email-templates/:templateKey', requirePermission('MANAGE_EMAIL_TEMPLATES'), validateParams(TemplateKeyParam), validateBody(EmailTemplateConfigPatchSchema), catchAsync(async (req: Request, res: Response) => {
  const key = String((req.params as any).templateKey || '').trim();
  if (!key) return res.status(400).json({ status: 'fail', message: 'templateKey required' });
  const actorId = Number((req as any).user?.id);
  const before = await EmailTemplateService.getByKey(key);
  const updated = await EmailTemplateService.updateByKey(key, req.body as any, { updatedById: Number.isFinite(actorId) ? actorId : undefined });

  const actor = Number.isFinite(actorId) ? actorId : null;
  try {
    await prisma.auditLog.create({
      data: {
        action: 'EMAIL_TEMPLATE_UPDATED',
        entityType: 'EMAIL_TEMPLATE',
        entityId: key,
        userId: actor,
        oldValue: { before: { subject: before.subjectLine, greeting: before.greeting, buttonLabel: before.buttonLabel } } as any,
        newValue: { updatedFields: Object.keys(req.body || {}) } as any,
        details: { templateKey: key, changedFields: Object.keys(req.body || {}) } as any,
        ipAddress: reqIp(req),
        userAgent: reqUa(req),
      },
    });
  } catch { /* ignore */ }
  const data = await EmailTemplateService.getByKey(key);
  void updated;
  res.json({ status: 'success', data });
}));

// Helpers for BigInt JSON serialization (Prisma BIGINT primary keys cannot serialize to JSON)
function stringifyBigintsDeep(v: any): any {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(stringifyBigintsDeep);
  const out: any = {};
  for (const k of Object.keys(v)) out[k] = stringifyBigintsDeep((v as any)[k]);
  return out;
}

// Helpers for PII mask
function maskEmail(emailLike: string): string {
  const s = String(emailLike || '');
  const at = s.lastIndexOf('@');
  if (at <= 1) return s.length ? '*'.repeat(Math.max(1, s.length)) : s;
  const first = s[0];
  const user = s.slice(1, at);
  const domain = s.slice(at);
  return `${first}${'*'.repeat(Math.max(1, user.length))}${domain}`;
}
function maskMatric(matric: string | null | undefined): string | null {
  if (!matric) return matric ?? null;
  const s = String(matric);
  if (s.length <= 3) return '*'.repeat(s.length);
  return `...${s.slice(-3)}`;
}
function maskDeliveryLogRow(row: any, viewerRole: string) {
  let r: any = stringifyBigintsDeep(row);
  if (viewerRole !== 'ADMIN') {
    r.toAddress = maskEmail(r.toAddress);
    if (r.recipient && typeof r.recipient === 'object' && r.recipient !== null) {
      const rec = { ...r.recipient };
      rec.matricNumber = maskMatric(rec.matricNumber);
      if (rec.email) rec.email = maskEmail(rec.email);
      if (rec.firstName) rec.firstName = viewerRole === 'BURSARY' ? rec.firstName : '*'.repeat(String(rec.firstName).length);
      r.recipient = rec;
    }
  }
  return r;
}

// 3. GET delivery logs list (ADMIN|BURSARY role + VIEW_EMAIL_DELIVERY_LOGS; Bursary sees masked PII)
const emailDeliveryLogsListSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  emailType: z.string().optional(),
  status: z.string().optional(),
  toAddressContains: z.string().max(254).optional(),
  recipientId: z.coerce.number().int().optional(),
  studentImportId: z.coerce.number().int().optional(),
});
router.get('/email-delivery-logs', requirePermission('VIEW_EMAIL_DELIVERY_LOGS'), validateQuery(emailDeliveryLogsListSchema), catchAsync(async (req: Request, res: Response) => {
  const q = (req.query as any);
  const page = Number(q.page) || 1;
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 25));
  const skip = (page - 1) * pageSize;
  const viewerRole = String((req as any).user?.role || '');

  const where: any = {};
  if (q.emailType && emailTypeValues.includes(String(q.emailType).toUpperCase())) {
    where.emailType = String(q.emailType).toUpperCase();
  }
  if (q.status && emailStatusValues.includes(String(q.status).toUpperCase())) {
    where.status = String(q.status).toUpperCase();
  }
  if (typeof q.toAddressContains === 'string' && q.toAddressContains.trim().length) {
    where.toAddress = { contains: q.toAddressContains.trim(), mode: 'insensitive' };
  }
  if (Number.isFinite(Number(q.recipientId))) {
    where.recipientId = Number(q.recipientId);
  }
  if (Number.isFinite(Number(q.studentImportId))) {
    where.studentImportId = Number(q.studentImportId);
  }

  const [total, rows] = await Promise.all([
    prisma.emailDeliveryLog.count({ where }),
    prisma.emailDeliveryLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      include: {
        recipient: { select: { id: true, email: true, firstName: true, lastName: true, matricNumber: true } },
        triggeredByAdmin: { select: { id: true, email: true, firstName: true, lastName: true, role: true } },
        studentImport: { select: { id: true, importNumber: true, fileName: true, createdAt: true } },
      },
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const mapped = rows.map(r => maskDeliveryLogRow(r, viewerRole));
  res.json({
    status: 'success',
    data: {
      rows: mapped,
      total,
      page,
      pageSize,
      totalPages,
      hasNext: page < totalPages,
    },
  });
}));

// 4. GET single delivery log detail (ADMIN|BURSARY role + VIEW_EMAIL_DELIVERY_LOGS; Bursary sees PII masked)
router.get('/email-delivery-logs/:id', requirePermission('VIEW_EMAIL_DELIVERY_LOGS'), validateParams(z.object({ id: z.union([z.coerce.string().min(1), z.coerce.number().int().min(1)]) })), catchAsync(async (req: Request, res: Response) => {
  const rawId = (req.params as any).id;
  let id: bigint;
  try {
    id = BigInt(String(rawId));
    if (id <= 0n) throw new Error('non-positive');
  } catch {
    return res.status(400).json({ status: 'fail', message: 'Invalid delivery log id' });
  }
  const viewerRole = String((req as any).user?.role || '');
  const row = await prisma.emailDeliveryLog.findUnique({
    where: { id },
    include: {
      recipient: { select: { id: true, email: true, firstName: true, lastName: true, matricNumber: true } },
      triggeredByAdmin: { select: { id: true, email: true, firstName: true, lastName: true, role: true } },
      studentImport: { select: { id: true, importNumber: true, fileName: true, createdAt: true, totalRecords: true, successfulRecords: true } },
    },
  });
  if (!row) return res.status(404).json({ status: 'fail', message: 'Delivery log not found' });
  res.json({ status: 'success', data: maskDeliveryLogRow(row, viewerRole) });
}));

// 5. POST resend credentials (ADMIN role + RESEND_CREDENTIALS capability, 5/15m per target user per admin)
router.post('/users/:id/resend-credentials', requirePermission('RESEND_CREDENTIALS'), resendCredentialsLimiter, validateParams(z.object({ id: z.coerce.number().int().min(1) })), catchAsync(async (req: Request, res: Response) => {
  const targetId = Number((req.params as any).id);
  const actorId = Number((req as any).user?.id);
  const ip = reqIp(req);
  const ua = reqUa(req);
  if (!Number.isFinite(actorId)) return res.status(401).json({ status: 'fail', message: 'Unauthorized' });
  await StudentService.sendCredentialEmail(targetId, actorId, { forcePasswordReset: true, ip, userAgent: ua });
  // Most recent delivery log for this user is PENDING in DB; return 202.
  const lastLog = await prisma.emailDeliveryLog.findFirst({
    where: { recipientId: targetId, emailType: EmailType.STUDENT_CREDENTIALS },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, attempts: true, createdAt: true },
  });
  res.status(202).json({
    status: 'success',
    data: {
      deliveryLogId: lastLog?.id ? String(lastLog.id) : null,
      queued: true,
      message: 'A new temporary password has been generated and the credentials email queued for delivery.',
    },
  });
}));

// --- Controlled manual transaction cancellation (BLOCKER 3) ---------------
// Mirror of /bursary/transactions/:id/cancel for ADMIN-role mount.
// See bursary.ts for full eligibility semantics.
const AdminCancelTxParams = z.object({
  id: z.coerce.number().int().positive(),
});
router.post(
  '/transactions/:id/cancel',
  requirePermission('VOID_TRANSACTIONS'),
  validateParams(AdminCancelTxParams),
  validateBody(CancelTransactionBodySchema),
  catchAsync(async (req: any, res) => {
    const transactionId = Number(req.params.id);
    const body = req.body as z.infer<typeof CancelTransactionBodySchema>;
    const result = await TransactionCancellationService.cancelTransaction({
      transactionId,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorPermissions: req.user.permissions ?? [],
      reason: body.reason,
      writtenExplanation: body.writtenExplanation,
      evidenceReference: body.evidenceReference,
      evidenceOverride: body.evidenceOverride,
      req: req as any,
    });
    res.status(200).json({
      status: 'success',
      data: {
        id: transactionId,
        cancelled: true,
        transaction: result.transaction,
        auditId: result.auditId,
        auditedAt: result.auditedAt,
        cancellation: result.cancellation,
      },
    });
  }),
);

export default router;
