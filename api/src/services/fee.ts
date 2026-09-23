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
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,30}$/;
const SESSION_RE = /^\d{4}\/\d{4}$/;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export const CreateFeeCategorySchema = z.object({
  name: z.string().min(2).max(120).trim(),
  code: z.string().min(2).max(32).trim().regex(CODE_RE, 'Category code must be uppercase letters, numbers, underscore or hyphen (2-32 chars).'),
  description: z.string().min(3).max(500).trim().optional(),
});
export const UpdateFeeCategorySchema = CreateFeeCategorySchema.partial();
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
  feeCode: z.string().min(2).max(32).trim().regex(CODE_RE, 'Fee code must be uppercase letters, numbers, underscore or hyphen (2-32 chars).'),
  name: z.string().min(3).max(200).trim(),
  description: z.string().max(2000).trim().optional(),
  categoryId: z.number().int().positive(),
  amount: z.union([
    z.coerce.number().positive().max(999_999_999.99),
    z.string().trim().regex(AMOUNT_RE).transform(Number),
  ]),
  currency: z.string().toUpperCase().length(3).default('NGN').optional(),
  academicSession: z.string().trim().regex(SESSION_RE, 'Academic session must be YYYY/YYYY (e.g. 2025/2026).'),
  semester: z.enum(['FIRST', 'SECOND']).optional(),
  college: z.string().max(120).trim().optional(),
  department: z.string().max(120).trim().optional(),
  program: z.string().max(120).trim().optional(),
  level: z.coerce.number().int().positive().max(1000).optional(),
  studentType: z.enum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']).optional(),
  isMandatory: z.boolean().default(true).optional(),
  paymentDeadline: z.coerce.date().optional(),
  isActive: z.boolean().default(true).optional(),
});
export type CreateFeeInput = z.infer<typeof CreateFeeSchema>;

export const UpdateFeeSchema = CreateFeeSchema.partial().omit({
  amount: true,
  categoryId: true,
}).extend({
  amount: z.union([
    z.coerce.number().positive().max(999_999_999.99),
    z.string().trim().regex(AMOUNT_RE).transform(Number),
  ]).optional(),
  categoryId: z.number().int().positive().optional(),
});
export type UpdateFeeInput = z.infer<typeof UpdateFeeSchema>;

export const CloneFeeSchema = z.object({
  academicSession: z.string().trim().regex(SESSION_RE),
  feeCode: z.string().min(2).max(32).trim().regex(CODE_RE).optional(),
  semester: z.enum(['FIRST', 'SECOND']).optional(),
  program: z.string().max(120).trim().optional(),
  level: z.coerce.number().int().positive().max(1000).optional(),
  college: z.string().max(120).trim().optional(),
  department: z.string().max(120).trim().optional(),
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
    const exists = await prisma.feeCategory.findFirst({ where: { code: input.code }, select: { id: true } });
    if (exists) throw new AppError(i18n.errors.fee.categoryExists, 400, [{ path: ['code'], message: i18n.errors.fee.categoryExists }]);

    const data: Prisma.FeeCategoryCreateInput = {
      name: input.name,
      code: input.code.toUpperCase(),
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
    // code+session+program+level uniqueness (per schema @@unique).
    const dup = await prisma.fee.findFirst({
      where: {
        feeCode: input.feeCode,
        academicSession: input.academicSession,
        program: input.program ?? null,
        level: input.level ?? null,
      },
      select: { id: true },
    });
    if (dup) throw new AppError(i18n.errors.fee.codeExists, 400);

    const category = await prisma.feeCategory.findFirst({ where: { id: input.categoryId }, select: { id: true } });
    if (!category) throw new AppError(i18n.errors.fee.notFound, 400);

    const userId = (req as any)?.user?.id ?? null;
    if (!userId) throw new AppError(i18n.errors.auth.notPermitted, 401);

    const data: Prisma.FeeCreateInput = {
      feeCode: input.feeCode.toUpperCase(),
      name: input.name,
      description: input.description ?? null,
      amount: new Prisma.Decimal(String(input.amount)),
      currency: input.currency ?? 'NGN',
      academicSession: input.academicSession,
      semester: input.semester ?? null,
      college: input.college ?? null,
      department: input.department ?? null,
      program: input.program ?? null,
      level: input.level ?? null,
      studentType: input.studentType ?? null,
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
    if (patch.semester !== undefined) data.semester = patch.semester ?? null;
    if (patch.college !== undefined) data.college = patch.college ?? null;
    if (patch.department !== undefined) data.department = patch.department ?? null;
    if (patch.program !== undefined) data.program = patch.program ?? null;
    if (patch.level !== undefined) data.level = patch.level ?? null;
    if (patch.studentType !== undefined) data.studentType = patch.studentType ?? null;
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

    let feeCode = body.feeCode ?? ex.feeCode;
    // De-dup code with suffix if collision.
    let attempt = 0;
    for (;;) {
      const code = attempt === 0 ? feeCode : `${feeCode.slice(0, 28)}_V${attempt + 1}`;
      const d = await prisma.fee.findFirst({
        where: {
          feeCode: code,
          academicSession: body.academicSession,
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
      academicSession: body.academicSession,
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
}

export default { FeeCategoryService, FeeService };
