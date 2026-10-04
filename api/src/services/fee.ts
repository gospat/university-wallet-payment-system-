// =============================================================================
// Fee Service — FeeCategory + Fee versioned CRUD
// -----------------------------------------------------------------------------
// §13 Fees, §14 Categories, §15 Fee Assignment Rules (pre-req), FR-D1..FR-D5,
// FR-M1..M3 (reuses student.ts patterns: Zod schemas + typed field-by-field
// Prisma.UserCreateInput-style literal building + entityType=* audit JSON with
// Prisma.JsonNull where applicable).
//
// Versioning rule (FR-D5, TR-8.3):
//   - A Fee is "frozen" once it has Invoice rows OR linked Transaction rows
//     (any status). Any PATCH attempt on `amount` / `isMandatory` /
//     `paymentDeadline` / `categoryId` on a frozen fee -> 409 Conflict.
//     Non-monetary fields (name, description, college/department/program
//     scopes) still remain mutable by admin.
//   - Clone endpoint POST fees/:id/clone duplicates a Fee with user-supplied
//     academicSession, level, program overrides; version suffix appended to
//     feeCode when there is a collision.
//   - FeeCategory delete is blocked (400) when any Fee references the
//     category (Fee-category FK has RESTRICT behaviour), with the count of
//     linked fees in the error message (i18n.errors.fee.categoryInUse).
//
// §14 Default categories (seeded on first GET if none found):
//   1. Tuition Fees
//   2. Accommodation / Hostel Fees
//   3. Registration Fees
//   4. Acceptance Fees
//   5. Laboratory / Practical Fees
//   6. Library Fees
//   7. Sports / Games Fees
//   8. Medical / Health Services Fees
//   9. Students' Union / SUG Dues
//  10. Project / Thesis Fees
//  11. Industrial Training (SIWES) Fees
//  12. Matriculation / Convocation Fees
//  13. ID Card Fees
//  14. Examination Fees
//  15. Levy / Developmental Levy
//  16. Other Charges
// =============================================================================

import { Prisma, StudentType, Semester } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { auditActions, i18n } from '../i18n/en';
import type { Request } from 'express';

const JSON_DB_NULL = Prisma.JsonNull;

const FEE_CATEGORY_DEFAULTS: Array<{ code: string; name: string; description?: string }> = [
  { code: 'TUITION', name: 'Tuition Fees', description: 'Academic tuition for the registered programme of study.' },
  { code: 'HOSTEL', name: 'Accommodation / Hostel Fees', description: 'Student on-campus / off-campus accommodation levy.' },
  { code: 'REGISTRATION', name: 'Registration Fees', description: 'Session / semester registration administrative fee.' },
  { code: 'ACCEPTANCE', name: 'Acceptance Fees', description: 'One-off provisional admission acceptance payment.' },
  { code: 'LAB_PRACTICAL', name: 'Laboratory / Practical Fees', description: 'Lab consumables, practical workshop, studio / studio-bench fees.' },
  { code: 'LIBRARY', name: 'Library Fees', description: 'Library services / late return / borrowing levy.' },
  { code: 'SPORTS', name: 'Sports / Games Fees', description: 'University sports complex / games levy.' },
  { code: 'MEDICAL', name: 'Medical / Health Services Fees', description: 'Health centre / medical checkup / insurance levy.' },
  { code: 'SUG', name: "Students' Union / SUG Dues", description: 'Student Union Government dues.' },
  { code: 'PROJECT_THESIS', name: 'Project / Thesis Fees', description: 'Final-year project, dissertation or thesis supervision fee.' },
  { code: 'SIWES', name: 'Industrial Training (SIWES) Fees', description: 'SIWES / IT placement coordination and supervision.' },
  { code: 'MATRIC_CONVOCATION', name: 'Matriculation / Convocation Fees', description: 'Matriculation or graduation convocation ceremony fee.' },
  { code: 'IDCARD', name: 'ID Card Fees', description: 'Student ID card issuance / replacement.' },
  { code: 'EXAMINATION', name: 'Examination Fees', description: 'Exam registration, malpractice screening or card fee.' },
  { code: 'DEVELOPMENT_LEVY', name: 'Levy / Developmental Levy', description: 'Capital development levy for institutional infrastructure.' },
  { code: 'OTHER', name: 'Other Charges', description: 'Miscellaneous fee category for ad-hoc charges (must always include a description on the Fee row).' },
];

// -----------------------------------------------------------------------------
// Zod schemas
// -----------------------------------------------------------------------------
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,30}$/;
const SESSION_RE = /^\d{4}\/\d{4}$/;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

const optStr = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : v === null || v === undefined ? undefined : String(v).trim() || undefined),
    z.string().max(max).trim().optional(),
  );

const optEnum = <T extends [string, ...string[]]>(t: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : undefined),
    z.enum(t).optional(),
  );

const optBool = z.preprocess(
  (v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'off' || s === 'no' || s === '') return false;
    }
    return v;
  },
  z.boolean().optional(),
);

function normalizeCode(raw: string, max = 32) {
  let s = raw.trim().toUpperCase();
  s = s.replace(/[^A-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s.slice(0, max);
}

function slugifyShort(raw: string, max = 20) {
  let s = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, max);
}

function currentAcademicSession() {
  const now = new Date();
  const y = now.getFullYear();
  // Nigeria academic year typically starts September/October. Use Sept as the cut.
  const cutover = new Date(y, 8, 1); // September 1st
  const start = now >= cutover ? y : y - 1;
  return `${start}/${start + 1}`;
}

const _CreateFeeCategoryBase = z.object({
  name: z.string().min(2).max(120).trim(),
  code: z.preprocess(
    (v) => {
      if (typeof v === 'string' && v.trim() === '') return undefined;
      return v;
    },
    z.string().min(2).max(32).trim().regex(CODE_RE, 'Category code must be uppercase letters, numbers, underscore or hyphen (2-32 chars).').optional()
  ),
  description: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(3).max(500).trim().optional()
  ),
}).superRefine((val, ctx) => {
  if (!val.code) {
    const slug = (val.name || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
    const generated = slug.length >= 2 ? `CAT-${slug}` : `CAT-${Date.now().toString(36).toUpperCase()}`;
    (val as any).code = generated;
  }
});

export const CreateFeeCategorySchema = _CreateFeeCategoryBase;
export const UpdateFeeCategorySchema = _CreateFeeCategoryBase.innerType().partial();
export type CreateFeeCategoryInput = z.infer<typeof CreateFeeCategorySchema>;
export type UpdateFeeCategoryInput = z.infer<typeof UpdateFeeCategorySchema>;

export const FeeQuerySchema = z.object({
  q: z.string().max(200).trim().optional(),
  session: z.string().max(20).trim().optional(),
  category: z.union([z.string().max(32), z.coerce.number()]).optional(),
  college: z.string().max(120).trim().optional(),
  department: z.string().max(120).trim().optional(),
  program: z.string().max(120).trim().optional(),
  level: z.coerce.number().int().positive().max(1000).optional(),
  studentType: z.enum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']).optional(),
  semester: z.enum(['FIRST', 'SECOND']).optional(),
  isActive: z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]).optional(),
  isMandatory: z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]).optional(),
  page: z.coerce.number().int().positive().default(1).optional(),
  pageSize: z.coerce.number().int().positive().max(500).default(25).optional(),
  sort: z.enum(['createdAt', 'name', 'feeCode', 'academicSession', 'amount']).default('createdAt').optional(),
  order: z.enum(['asc', 'desc']).default('desc').optional(),
});
export type FeeQueryInput = z.infer<typeof FeeQuerySchema>;

export const CreateFeeSchema = z.object({
  feeCode: z.preprocess(
    (v) => {
      if (typeof v !== 'string') return undefined;
      const s = v.trim();
      return s.length === 0 ? undefined : s;
    },
    z.string().min(2).max(32).trim().regex(CODE_RE, 'Fee code must be 2-32 letters, numbers, underscore or hyphen.').optional(),
  ),
  name: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()),
    z.string().min(3).max(200),
  ),
  description: optStr(2000),
  categoryId: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v)) : v),
    z.number().int().positive(),
  ),
  amount: z.union([
    z.coerce.number().positive().max(999_999_999.99),
    z.string().trim().regex(AMOUNT_RE).transform(Number),
  ]),
  currency: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
    z.string().toUpperCase().length(3).default('NGN').optional(),
  ),
  academicSession: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : undefined),
    z.string().trim().regex(SESSION_RE, 'Academic session must be YYYY/YYYY (e.g. 2025/2026).').optional(),
  ),
  semester: optEnum(['FIRST', 'SECOND']),
  college: optStr(120),
  department: optStr(120),
  program: optStr(120),
  level: z.preprocess(
    (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : Number(v)),
    z.number().int().positive().max(1000).optional(),
  ),
  studentType: optEnum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']),
  isMandatory: optBool,
  paymentDeadline: z.preprocess(
    (v) => {
      if (v === null || v === undefined) return undefined;
      if (typeof v === 'string') {
        if (v.trim() === '') return undefined;
        const d = new Date(v);
        return Number.isNaN(+d) ? undefined : d;
      }
      return v instanceof Date ? v : new Date(String(v));
    },
    z.date().optional(),
  ),
  isActive: optBool,
});
export type CreateFeeInput = z.infer<typeof CreateFeeSchema>;

export const UpdateFeeSchema = z.object({}).passthrough().and(
  CreateFeeSchema.partial().omit({ amount: true, categoryId: true }).extend({
    amount: z.union([
      z.coerce.number().positive().max(999_999_999.99),
      z.string().trim().regex(AMOUNT_RE).transform(Number),
    ]).optional(),
    categoryId: z.preprocess(
      (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v)) : v),
      z.number().int().positive().optional(),
    ),
  }),
);
export type UpdateFeeInput = z.infer<typeof UpdateFeeSchema>;

export const CloneFeeSchema = z.object({
  academicSession: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : undefined),
    z.string().trim().regex(SESSION_RE).optional(),
  ),
  feeCode: z.preprocess(
    (v) => {
      if (typeof v !== 'string') return undefined;
      const s = v.trim();
      return s.length === 0 ? undefined : s;
    },
    z.string().min(2).max(32).trim().regex(CODE_RE).optional(),
  ),
  semester: optEnum(['FIRST', 'SECOND']),
  program: optStr(120),
  level: z.preprocess(
    (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : Number(v)),
    z.number().int().positive().max(1000).optional(),
  ),
  college: optStr(120),
  department: optStr(120),
  studentType: optEnum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']),
  amount: z.union([
    z.coerce.number().positive().max(999_999_999.99),
    z.string().trim().regex(AMOUNT_RE).transform(Number),
  ]).optional(),
});
export type CloneFeeInput = z.infer<typeof CloneFeeSchema>;

// -----------------------------------------------------------------------------
// Output shapes (matches selectors below)
// -----------------------------------------------------------------------------
const CATEGORY_SELECT = { id: true, name: true, code: true, description: true, createdAt: true, createdById: true, createdBy: { select: { id: true, email: true, firstName: true, lastName: true } } } as const;
const FEE_SELECT = {
  id: true, feeCode: true, name: true, description: true,
  categoryId: true, category: { select: { id: true, name: true, code: true } },
  amount: true, currency: true,
  academicSession: true, semester: true,
  college: true, department: true, program: true, level: true, studentType: true,
  isMandatory: true, paymentDeadline: true, isActive: true,
  createdById: true, createdAt: true, updatedAt: true,
  createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
  _count: { select: { assignments: true, invoices: true } },
} as const;

type CategoryOut = Awaited<ReturnType<typeof prisma.feeCategory.findFirst<{ select: typeof CATEGORY_SELECT }>>>;
type FeeOut = Awaited<ReturnType<typeof prisma.fee.findFirst<{ select: typeof FEE_SELECT }>>>;

// -----------------------------------------------------------------------------
// Audit helper (stubs ip/ua missing fields — called with req when available)
// -----------------------------------------------------------------------------
type ReqLike = Pick<Request, 'user'> & Partial<Pick<Request, 'ip'>> & { headers?: Record<string, any> };

async function writeAudit(req: ReqLike | undefined, data: { action: string; entityType: 'FEE_CATEGORY' | 'FEE'; entityId: string | number; oldValue?: any; newValue?: any; }) {
  const userId = (req as any)?.user?.id ?? null;
  const ipAddress = (req as any)?.ip ?? (req as any)?.headers?.['x-forwarded-for']?.split(',')[0] ?? null;
  const userAgent = (req as any)?.headers?.['user-agent'] ?? null;
  try {
    await prisma.auditLog.create({
      data: {
        action: data.action,
        entityType: data.entityType,
        entityId: String(data.entityId),
        userId,
        ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
        oldValue: data.oldValue === undefined || data.oldValue === null ? JSON_DB_NULL : (data.oldValue as Prisma.InputJsonValue),
        newValue: data.newValue === undefined || data.newValue === null ? JSON_DB_NULL : (data.newValue as Prisma.InputJsonValue),
      },
    });
  } catch {
    // audit writes should never break the request
  }
}

// -----------------------------------------------------------------------------
// FeeCategoryService
// -----------------------------------------------------------------------------
export class FeeCategoryService {
  private static async ensureDefaultCategories(): Promise<void> {
    const existing = await prisma.feeCategory.count();
    if (existing > 0) return;
    // Upsert 16 rows one-by-one (small list). Ignore code duplicates.
    for (const c of FEE_CATEGORY_DEFAULTS) {
      await prisma.feeCategory.upsert({
        where: { code: c.code },
        create: { code: c.code, name: c.name, description: c.description ?? null },
        update: {},
      });
    }
  }

  static async list(): Promise<Array<NonNullable<CategoryOut>>> {
    await this.ensureDefaultCategories();
    return prisma.feeCategory.findMany({
      select: { ...CATEGORY_SELECT, _count: { select: { fees: true } } },
      orderBy: { name: 'asc' },
    }) as Promise<any>;
  }

  static async getById(id: number): Promise<NonNullable<CategoryOut>> {
    await this.ensureDefaultCategories();
    const row = await prisma.feeCategory.findFirst({
      where: { id },
      select: { ...CATEGORY_SELECT, _count: { select: { fees: true } } },
    }) as any;
    if (!row) throw new AppError(i18n.errors.fee.notFound, 404);
    return row;
  }

  static async create(input: CreateFeeCategoryInput, req?: ReqLike) {
    await this.ensureDefaultCategories();
    const code: string = (input.code || '').trim() || (() => {
      const slug = (input.name || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
      return slug.length >= 2 ? `CAT-${slug}` : `CAT-${Date.now().toString(36).toUpperCase()}`;
    })();
    const exists = await prisma.feeCategory.findFirst({ where: { code }, select: { id: true } });
    if (exists) throw new AppError(i18n.errors.fee.categoryExists, 400, [{ path: ['code'], message: i18n.errors.fee.categoryExists }]);

    const data: Prisma.FeeCategoryCreateInput = {
      name: input.name,
      code: code.toUpperCase(),
      description: input.description ?? null,
    };
    const userId = (req as any)?.user?.id ?? null;
    if (userId) data.createdBy = { connect: { id: userId } };

    const created = await prisma.feeCategory.create({
      data,
      select: { ...CATEGORY_SELECT, _count: { select: { fees: true } } },
    }) as any;

    await writeAudit(req, { action: auditActions.feeCategoryCreated, entityType: 'FEE_CATEGORY', entityId: created.id, newValue: created });
    return created;
  }

  static async update(id: number, patch: UpdateFeeCategoryInput, req?: ReqLike) {
    await this.ensureDefaultCategories();
    const existing = await prisma.feeCategory.findFirst({ where: { id } });
    if (!existing) throw new AppError(i18n.errors.fee.notFound, 404);

    if (patch.code !== undefined) {
      const dup = await prisma.feeCategory.findFirst({ where: { code: patch.code, NOT: { id } } });
      if (dup) throw new AppError(i18n.errors.fee.categoryExists, 400);
    }

    const data: Prisma.FeeCategoryUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.code !== undefined) data.code = patch.code.toUpperCase();
    if (patch.description !== undefined) data.description = patch.description ?? null;

    const updated = await prisma.feeCategory.update({
      where: { id },
      data,
      select: { ...CATEGORY_SELECT, _count: { select: { fees: true } } },
    }) as any;

    await writeAudit(req, { action: auditActions.feeCategoryUpdated, entityType: 'FEE_CATEGORY', entityId: id, oldValue: existing, newValue: updated });
    return updated;
  }

  static async remove(id: number, req?: ReqLike) {
    await this.ensureDefaultCategories();
    const existing = await prisma.feeCategory.findFirst({ where: { id }, include: { _count: { select: { fees: true } } } });
    if (!existing) throw new AppError(i18n.errors.fee.notFound, 404);
    if ((existing as any)._count.fees > 0) {
      throw new AppError(i18n.errors.fee.categoryInUse((existing as any)._count.fees), 400);
    }
    await prisma.feeCategory.delete({ where: { id } });
    await writeAudit(req, { action: auditActions.feeCategoryDeleted, entityType: 'FEE_CATEGORY', entityId: id, oldValue: existing });
    return true;
  }
}

// -----------------------------------------------------------------------------
// FeeService
// -----------------------------------------------------------------------------
export class FeeService {
  static {
    // ensure defaults are available synchronously via the first access path.
    FeeCategoryService.list().catch(() => {});
  }

  private static async assertFrozen(id: number, patch: UpdateFeeInput): Promise<void> {
    // 409 if amount / categoryId / isMandatory / paymentDeadline change while invoices OR transactions exist.
    const freezeable = ['amount', 'categoryId', 'isMandatory', 'paymentDeadline'];
    const willModifyFrozen = freezeable.some((k) => Object.prototype.hasOwnProperty.call(patch, k));
    if (!willModifyFrozen) return;
    const row = await prisma.fee.findFirst({
      where: { id },
      select: {
        _count: { select: { invoices: true, assignments: true } },
        invoices: { take: 1, select: { id: true } },
      },
    });
    if (!row) return;
    // any invoice on the fee -> consider frozen. For more precision we could also
    // walk invoices -> transactions, but existence of any invoice is sufficient
    // to preserve immutable integrity of the fee row.
    if (row.invoices.length > 0 || (row._count as any).invoices > 0) {
      throw new AppError(i18n.errors.fee.versionedFee, 409);
    }
  }

  static async list(query: FeeQueryInput) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const skip = (page - 1) * pageSize;
    const sort = (query.sort ?? 'createdAt') as 'createdAt' | 'name' | 'feeCode' | 'academicSession' | 'amount';
    const order = (query.order ?? 'desc') as 'asc' | 'desc';

    const where: Prisma.FeeWhereInput = {};
    if (query.q) {
      const qLike = `%${query.q}%`;
      where.OR = [
        { name: { contains: query.q } },
        { feeCode: { contains: query.q } },
        { description: { contains: query.q } },
      ] as any;
      // Reference qLike to avoid potential unused-var lint when OR already handled.
      void qLike;
    }
    if (query.session) where.academicSession = query.session;
    if (query.category !== undefined) {
      const cat = typeof query.category === 'number'
        ? { id: query.category }
        : { code: String(query.category).toUpperCase() };
      where.category = cat as any;
    }
    if (query.college) where.college = query.college;
    if (query.department) where.department = query.department;
    if (query.program) where.program = query.program;
    if (query.level) where.level = query.level;
    if (query.studentType) where.studentType = query.studentType as StudentType;
    if (query.semester) where.semester = query.semester as Semester;
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.isMandatory !== undefined) where.isMandatory = query.isMandatory;

    const orderBy: any = { [sort]: order };

    const [rows, total] = await Promise.all([
      prisma.fee.findMany({ where, select: FEE_SELECT as any, skip, take: pageSize, orderBy }),
      prisma.fee.count({ where }),
    ]);
    return { fees: rows as unknown as FeeOut[], total, page, pageSize };
  }

  static async getById(id: number): Promise<NonNullable<FeeOut>> {
    const row = await prisma.fee.findFirst({ where: { id }, select: FEE_SELECT as any });
    if (!row) throw new AppError(i18n.errors.fee.notFound, 404);
    return row as any;
  }

  static async create(input: CreateFeeInput, req?: ReqLike) {
    const category = await prisma.feeCategory.findFirst({ where: { id: input.categoryId }, select: { id: true, code: true, name: true } });
    if (!category) throw new AppError(i18n.errors.fee.notFound, 400);

    const academicSession = input.academicSession ?? null;

    let feeCode: string;
    if (input.feeCode && String(input.feeCode).trim()) {
      feeCode = normalizeCode(input.feeCode, 32);
      if (feeCode.length < 2) throw new AppError('Fee code must be at least 2 characters after cleaning.', 400);
    } else {
      const slug = slugifyShort(input.name, 18) || 'fee';
      const base = `FEE-${normalizeCode(category.code || category.name, 8)}-${slug.toUpperCase()}`;
      let candidate = base.slice(0, 28);
      for (let attempt = 0; attempt < 10; attempt++) {
        const exists = await prisma.fee.findFirst({
          where: {
            feeCode: candidate,
            academicSession: academicSession ?? undefined,
            program: input.program ?? null,
            level: input.level ?? null,
          },
          select: { id: true },
        });
        if (!exists) break;
        const suf = Math.random().toString(36).toUpperCase().slice(2, 6);
        candidate = `${base.slice(0, 22)}-${suf}`;
      }
      feeCode = candidate;
    }

    const dup = await prisma.fee.findFirst({
      where: {
        feeCode,
        academicSession: academicSession ?? undefined,
        program: input.program ?? null,
        level: input.level ?? null,
      },
      select: { id: true },
    });
    if (dup) throw new AppError(i18n.errors.fee.codeExists, 400);

    const userId = (req as any)?.user?.id ?? null;
    if (!userId) throw new AppError(i18n.errors.auth.notPermitted, 401);

    const data: Prisma.FeeCreateInput = {
      feeCode,
      name: input.name,
      description: input.description ?? null,
      amount: new Prisma.Decimal(String(input.amount)),
      currency: input.currency ?? 'NGN',
      academicSession: academicSession ?? "",
      semester: (input.semester ?? null) as any,
      college: input.college ?? null,
      department: input.department ?? null,
      program: input.program ?? null,
      level: input.level ?? null,
      studentType: (input.studentType ?? null) as any,
      isMandatory: input.isMandatory ?? true,
      paymentDeadline: input.paymentDeadline ?? null,
      isActive: input.isActive ?? true,
      category: { connect: { id: input.categoryId } },
      createdBy: { connect: { id: userId } },
    };

    const created = await prisma.fee.create({ data, select: FEE_SELECT as any }) as any;
    await writeAudit(req, { action: auditActions.feeCreated, entityType: 'FEE', entityId: created.id, newValue: created });
    return created;
  }

  static async update(id: number, patch: UpdateFeeInput, req?: ReqLike) {
    const existing = await prisma.fee.findFirst({ where: { id } });
    if (!existing) throw new AppError(i18n.errors.fee.notFound, 404);

    await this.assertFrozen(id, patch);

    if (patch.feeCode !== undefined || patch.academicSession !== undefined) {
      const newCode = patch.feeCode ?? existing.feeCode;
      const newSession = patch.academicSession ?? existing.academicSession;
      const dup = await prisma.fee.findFirst({
        where: {
          feeCode: newCode,
          academicSession: newSession,
          program: (patch.program ?? existing.program) as any,
          level: (patch.level ?? existing.level) as any,
          NOT: { id },
        },
        select: { id: true },
      });
      if (dup) throw new AppError(i18n.errors.fee.codeExists, 400);
    }

    const data: Prisma.FeeUpdateInput = {};
    if (patch.feeCode !== undefined) data.feeCode = patch.feeCode.toUpperCase();
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description ?? null;
    if (patch.categoryId !== undefined) data.category = { connect: { id: patch.categoryId } };
    if (patch.amount !== undefined) data.amount = new Prisma.Decimal(String(patch.amount));
    if (patch.currency !== undefined) data.currency = patch.currency;
    if (patch.academicSession !== undefined) data.academicSession = patch.academicSession;
    if (patch.semester !== undefined) data.semester = (patch.semester ?? null) as any;
    if (patch.college !== undefined) data.college = patch.college ?? null;
    if (patch.department !== undefined) data.department = patch.department ?? null;
    if (patch.program !== undefined) data.program = patch.program ?? null;
    if (patch.level !== undefined) data.level = patch.level ?? null;
    if (patch.studentType !== undefined) data.studentType = (patch.studentType ?? null) as any;
    if (patch.isMandatory !== undefined) data.isMandatory = patch.isMandatory;
    if (patch.paymentDeadline !== undefined) data.paymentDeadline = patch.paymentDeadline ?? null;
    if (patch.isActive !== undefined) data.isActive = patch.isActive;

    const updated = await prisma.fee.update({ where: { id }, data, select: FEE_SELECT as any }) as any;
    await writeAudit(req, { action: auditActions.feeUpdated, entityType: 'FEE', entityId: id, oldValue: existing, newValue: updated });
    return updated;
  }

  static async clone(id: number, body: CloneFeeInput, req?: ReqLike) {
    const existing = await prisma.fee.findFirst({ where: { id }, select: FEE_SELECT as any });
    if (!existing) throw new AppError(i18n.errors.fee.notFound, 404);
    const ex = existing as any;

    const newAcademicSession = body.academicSession ?? null;
    let feeCode: string;
    if (body.feeCode) {
      feeCode = normalizeCode(body.feeCode, 32);
    } else {
      const base = normalizeCode(ex.feeCode, 26);
      feeCode = base;
    }
    let attempt = 0;
    for (;;) {
      const code = attempt === 0 ? feeCode : `${feeCode.slice(0, 26)}-V${attempt + 1}`;
      const d = await prisma.fee.findFirst({
        where: {
          feeCode: code,
          academicSession: newAcademicSession ?? undefined,
          program: (body.program ?? ex.program) as any,
          level: (body.level ?? ex.level) as any,
        },
        select: { id: true },
      });
      if (!d) { feeCode = code; break; }
      attempt++;
      if (attempt > 9) throw new AppError(i18n.errors.fee.codeExists, 400);
    }

    const createInput: CreateFeeInput = {
      feeCode,
      name: ex.name,
      description: ex.description ?? undefined,
      categoryId: ex.categoryId,
      amount: body.amount ?? Number(ex.amount),
      currency: ex.currency,
      academicSession: newAcademicSession ?? undefined,
      semester: (body.semester ?? ex.semester) as any,
      college: (body.college ?? ex.college) as any,
      department: (body.department ?? ex.department) as any,
      program: (body.program ?? ex.program) as any,
      level: (body.level ?? ex.level) as any,
      studentType: (ex.studentType ?? undefined) as any,
      isMandatory: !!ex.isMandatory,
      paymentDeadline: ex.paymentDeadline ?? undefined,
      isActive: !!ex.isActive,
    };
    const created = await this.create(createInput, req);
    await writeAudit(req, { action: auditActions.feeCloned, entityType: 'FEE', entityId: (created as any).id, oldValue: { clonedFromFeeId: id }, newValue: created });
    return created;
  }

  static async setActive(id: number, isActive: boolean, req?: ReqLike) {
    return this.update(id, { isActive } as any, req);
  }

  static async remove(id: number, req?: ReqLike) {
    const existing = await prisma.fee.findFirst({ where: { id } });
    if (!existing) throw new AppError(i18n.errors.fee.notFound, 404);

    const [assignmentCount, invoiceCount, paidTransactionCount] = await Promise.all([
      prisma.feeAssignment.count({ where: { feeId: id } }),
      prisma.invoice.count({ where: { feeId: id } }),
      prisma.transaction.count({
        where: {
          invoice: { feeId: id },
          status: { in: ['SUCCESS', 'PENDING'] },
        },
      }),
    ]);

    if (assignmentCount > 0 || invoiceCount > 0 || paidTransactionCount > 0) {
      throw new AppError(
        `Cannot delete this fee (bill catalogue). It is referenced by: ${assignmentCount} assignment(s), ${invoiceCount} invoice(s), ${paidTransactionCount} paid transaction(s). Deactivate instead to prevent new usage while keeping history intact.`,
        409,
      );
    }

    await prisma.fee.delete({ where: { id } });
    await writeAudit(req, { action: auditActions.feeDeleted, entityType: 'FEE', entityId: id, oldValue: existing });
    return { deleted: { id, name: existing.name, feeCode: existing.feeCode } };
  }
}

export default { FeeCategoryService, FeeService };
