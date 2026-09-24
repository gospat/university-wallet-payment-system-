import express, { Request } from 'express';
import { getDashboardStats, addStudent } from '../controllers/admin';
import { protect, restrictTo, requirePermission } from '../middlewares/auth';
import { z } from 'zod';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate';
import { CreateStudentSchema } from '../services/student';
import {
  confirmStudentUpload,
  downloadErrorCsv,
  previewStudentUpload,
  stageStudentUpload,
} from '../controllers/bulkUpload';
import { Role, Prisma, AccountStatus, PaymentGateway } from '@prisma/client';
import { adminListRefunds, adminApproveRefund, adminRejectRefund } from '../controllers/refunds';
import prisma from '../config/database';
import { RefundService } from '../services/refund';
import { catchAsync } from '../utils/catchAsync';
import { AdminSearchService } from '../services/search';
import { SystemSettingsService } from '../services/systemSettings';
import { AdminNotificationService } from '../services/adminNotification';
import { PERMISSION_DEFS } from '../services/permissionSeed';
import { buildBranding } from '../utils/branding';
import bcrypt from 'bcrypt';
import { reqIp, reqUa } from '../utils/http';

const router = express.Router();

router.use(protect);
router.use(restrictTo('ADMIN'));

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

router.get('/stats', getDashboardStats);
router.post('/students', validateBody(CreateStudentSchema), addStudent);

router.post('/students/upload', stageStudentUpload);
router.get('/students/upload/:id', previewStudentUpload);
router.get('/students/upload/:id/errors.csv', downloadErrorCsv);
router.post('/students/upload/:id/confirm', confirmStudentUpload);

router.get('/refunds', adminListRefunds);
const RefundIdParam = z.object({ id: z.coerce.number().int().positive() });
router.post('/refunds/:id/approve', validateParams(RefundIdParam), adminApproveRefund as any);
router.post('/refunds/:id/reject', validateParams(RefundIdParam), adminRejectRefund as any);

const AdminTxUpdatePatchBody = z.record(z.any());
router.patch('/transactions/:id',
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
router.get('/audit-logs', validateQuery(AuditLogsQuery), catchAsync(async (req: any, res) => {
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
  accountStatus: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
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
    if (search) {
      where.OR = [
        { email: { contains: search } },
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { matricNumber: { contains: search } },
      ];
    }
    if (role) where.role = role;
    if (accountStatus) where.accountStatus = accountStatus;

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: USER_SELECT as any,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    res.status(200).json({
      status: 'success',
      data: { items, total, page, pageSize, pageCount },
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
    matricNumber: z.string().min(3).max(50).optional().nullable(),
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
    matricNumber: z.string().min(3).max(50).optional().nullable(),
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
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    const updateData: Prisma.UserUpdateInput = {};
    if (body.firstName !== undefined) updateData.firstName = body.firstName;
    if (body.middleName !== undefined) updateData.middleName = body.middleName ?? undefined;
    if (body.lastName !== undefined) updateData.lastName = body.lastName;
    if (body.matricNumber !== undefined) updateData.matricNumber = body.matricNumber ?? undefined;
    if (body.role !== undefined) updateData.role = body.role;
    if (body.accountStatus !== undefined) updateData.accountStatus = body.accountStatus;
    if (body.phoneNumber !== undefined) updateData.phoneNumber = body.phoneNumber ?? undefined;

    if (Object.keys(updateData).length === 0) {
      const user = await prisma.user.findUnique({ where: { id }, select: USER_SELECT as any });
      return res.status(200).json({ status: 'success', data: user });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
      select: USER_SELECT as any,
    });
    const changedFields = Object.keys(updateData);
    await writeAudit(req, {
      action: 'UPDATE_USER',
      entityType: 'USER',
      entityId: id,
      details: { changedFields },
    });
    res.status(200).json({ status: 'success', data: updated });
  }),
);

router.post(
  '/users/:id/deactivate',
  requirePermission('MANAGE_USERS'),
  validateParams(UserIdParam),
  catchAsync(async (req: any, res) => {
    const { id } = req.params as z.infer<typeof UserIdParam>;
    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true, accountStatus: true } });
    if (!existing) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }
    const newStatus = existing.accountStatus === AccountStatus.ACTIVE ? AccountStatus.SUSPENDED : AccountStatus.ACTIVE;
    const updated = await prisma.user.update({
      where: { id },
      data: { accountStatus: newStatus },
      select: USER_SELECT as any,
    });
    await writeAudit(req, {
      action: 'ACCOUNT_STATUS_CHANGE',
      entityType: 'USER',
      entityId: id,
      details: { oldStatus: existing.accountStatus, newStatus },
    });
    res.status(200).json({ status: 'success', data: updated });
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
// Roles CRUD (4 routes, STUDENT hidden)
//   GET    /admin/roles              list (STUDENT hidden)
//   GET    /admin/roles/:role        get one (STUDENT 404)
//   POST   /admin/roles              create role permissions
//   PATCH  /admin/roles/:role        update role permissions
//   Permission: MANAGE_ROLES
// ---------------------------------------------------------------------------

const ROLE_META: Record<string, { name: string; description: string }> = {
  [Role.ADMIN]: { name: 'Administrator', description: 'Full system access with all permissions' },
  [Role.BURSARY]: { name: 'Bursary', description: 'Financial operations, payments and receipts' },
};

const RoleNameParam = z.object({ role: z.enum([Role.ADMIN, Role.BURSARY]) });

router.get(
  '/roles',
  requirePermission('MANAGE_ROLES'),
  catchAsync(async (_req: any, res) => {
    const visibleRoles = [Role.ADMIN, Role.BURSARY];
    const items = await Promise.all(
      visibleRoles.map(async (r) => {
        const perms = await prisma.rolePermission.findMany({
          where: { role: r },
          include: { permission: { select: { key: true, name: true, category: true } } },
        });
        const meta = ROLE_META[r];
        return {
          role: r,
          name: meta.name,
          description: meta.description,
          permissions: perms.map((rp) => rp.permission),
          permissionsCount: perms.length,
        };
      })
    );
    res.status(200).json({ status: 'success', data: { items } });
  }),
);

router.get(
  '/roles/:role',
  requirePermission('MANAGE_ROLES'),
  validateParams(RoleNameParam),
  catchAsync(async (req: any, res) => {
    const { role } = req.params as z.infer<typeof RoleNameParam>;
    const perms = await prisma.rolePermission.findMany({
      where: { role },
      include: { permission: { select: { key: true, name: true, category: true, description: true } } },
    });
    const meta = ROLE_META[role];
    const data = {
      role,
      name: meta.name,
      description: meta.description,
      permissions: perms.map((rp) => rp.permission),
      permissionsCount: perms.length,
    };
    res.status(200).json({ status: 'success', data });
  }),
);

const CreateRoleSchema = z
  .object({
    role: z.enum([Role.ADMIN, Role.BURSARY]),
    permissionKeys: z.array(z.string().min(1).max(64)).min(1),
  })
  .strict();

router.post(
  '/roles',
  requirePermission('MANAGE_ROLES'),
  validateBody(CreateRoleSchema),
  catchAsync(async (req: any, res) => {
    const { role, permissionKeys } = req.body as z.infer<typeof CreateRoleSchema>;
    const perms = await prisma.permission.findMany({
      where: { key: { in: permissionKeys } },
      select: { id: true, key: true },
    });
    const foundKeys = new Set(perms.map((p) => p.key));
    const missing = permissionKeys.filter((k) => !foundKeys.has(k));
    if (missing.length > 0) {
      return res.status(400).json({ status: 'fail', message: `Unknown permission keys: ${missing.join(', ')}` });
    }
    for (const p of perms) {
      await prisma.rolePermission.upsert({
        where: { role_permissionId: { role, permissionId: p.id } },
        create: { role, permissionId: p.id },
        update: {},
      });
    }
    await writeAudit(req, {
      action: 'CREATE_ROLE',
      entityType: 'ROLE',
      entityId: role,
      details: { permissionKeys },
    });
    const allPerms = await prisma.rolePermission.findMany({
      where: { role },
      include: { permission: { select: { key: true, name: true, category: true } } },
    });
    const meta = ROLE_META[role];
    res.status(201).json({
      status: 'success',
      data: {
        role,
        name: meta.name,
        description: meta.description,
        permissions: allPerms.map((rp) => rp.permission),
        permissionsCount: allPerms.length,
      },
    });
  }),
);

const UpdateRoleSchema = z
  .object({
    permissionKeys: z.array(z.string().min(1).max(64)).min(1),
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
    const perms = await prisma.permission.findMany({
      where: { key: { in: permissionKeys } },
      select: { id: true, key: true },
    });
    const foundKeys = new Set(perms.map((p) => p.key));
    const missing = permissionKeys.filter((k) => !foundKeys.has(k));
    if (missing.length > 0) {
      return res.status(400).json({ status: 'fail', message: `Unknown permission keys: ${missing.join(', ')}` });
    }
    await prisma.rolePermission.deleteMany({ where: { role } });
    for (const p of perms) {
      await prisma.rolePermission.create({
        data: { role, permissionId: p.id },
      });
    }
    await writeAudit(req, {
      action: 'UPDATE_ROLE',
      entityType: 'ROLE',
      entityId: role,
      details: { permissionKeys },
    });
    const allPerms = await prisma.rolePermission.findMany({
      where: { role },
      include: { permission: { select: { key: true, name: true, category: true } } },
    });
    const meta = ROLE_META[role];
    res.status(200).json({
      status: 'success',
      data: {
        role,
        name: meta.name,
        description: meta.description,
        permissions: allPerms.map((rp) => rp.permission),
        permissionsCount: allPerms.length,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /admin/permissions  (15-entries + roles_assigned from PERMISSION_DEFS)
//   Permission: MANAGE_ROLES
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
    const items = PERMISSION_DEFS.map((def) => ({
      key: def.key,
      name: def.name,
      category: def.category,
      description: def.description ?? null,
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
    largePaymentThreshold: z.union([z.number().min(0), z.string().refine((v) => Number(v) >= 0).transform((v) => Number(v))]).optional(),
    importErrorThreshold: z.coerce.number().int().min(0).optional(),
    receiptFooterText: z.string().max(500).nullable().optional(),
    receiptBursarName: z.string().max(190).nullable().optional(),
    receiptBursarTitle: z.string().max(190).nullable().optional(),
    receiptBursarSignatureUrl: z.string().max(500).nullable().optional(),
    receiptPrefix: z.string().min(1).max(10).optional(),
    paymentRefPrefix: z.string().min(1).max(10).optional(),
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

    const orderBy: any = {};
    const allowedSorts: Record<string, string> = {
      createdAt: 'createdAt', amount: 'amount', status: 'status',
    };
    orderBy[allowedSorts[q.sort as string] || 'createdAt'] = q.order || 'desc';

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

    const orderBy: any = {};
    const allowedSorts: Record<string, string> = {
      paidAt: 'paidAt', paidAmount: 'paidAmount', receiptNumber: 'receiptNumber',
    };
    orderBy[allowedSorts[q.sort as string] || 'paidAt'] = q.order || 'desc';

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
router.get(
  '/receipts/verify/:tokenOrNumber',
  requirePermission('VIEW_RECEIPTS'),
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
        transaction: { select: { reference: true, paystackReference: true, paystackChannel: true, gateway: true, type: true, amount: true, status: true, createdAt: true } },
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

export default router;
