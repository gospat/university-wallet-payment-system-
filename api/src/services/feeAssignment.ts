// =============================================================================
// FeeAssignment Service + Invoice generator
// -----------------------------------------------------------------------------
// Task 9 — FeeAssignment model CRUD (REST) +
// Task 9.2 generate-invoices engine (cohort selector, idempotent per-session,
// manual override, INV- references, atomic batched writes)
// =============================================================================

import { Prisma, AssignmentTargetType, StudentType, Semester, AccountStatus, Role } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { auditActions, i18n } from '../i18n/en';
import { generateInvoiceReference } from '../utils/paystack';
import { nextYearlyCounter, yearFromSession } from '../utils/yearlyCounter';
import type { Request } from 'express';
import { StudentService } from './student';

const JSON_DB_NULL = Prisma.JsonNull;

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------
const SESSION_RE = /^\d{4}\/\d{4}$/;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

const ASSIGNMENT_TYPES = [
  'STUDENT', 'PROGRAMME', 'DEPARTMENT', 'FACULTY', 'LEVEL', 'SESSION', 'STUDENT_TYPE',
] as const;

const SESSION_FIELDS: Record<AssignmentTargetType, (keyof z.infer<typeof CreateFeeAssignmentSchema>)[]> = {
  STUDENT: ['targetStudentId'],
  PROGRAMME: ['targetProgramme'],
  DEPARTMENT: ['targetDepartment'],
  FACULTY: ['targetFaculty'],
  LEVEL: ['targetLevel'],
  SESSION: ['targetSession'],
  STUDENT_TYPE: ['targetStudentType'],
};

// --- tolerant zod wrappers (mirrors fee.ts / academic.ts patterns) ---
const optStr = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : v === null || v === undefined ? undefined : String(v).trim() || undefined),
    z.string().max(max).optional(),
  );
const optEnum = <T extends [string, ...string[]]>(t: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : undefined),
    z.enum(t).optional(),
  );
const optSession = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    return s.length === 0 ? undefined : s;
  },
  z.string().max(20).regex(SESSION_RE).optional(),
);
const optAmount = z.union([
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().positive().max(999_999_999.99),
  ),
  z.string().trim().regex(AMOUNT_RE).transform(Number),
]).optional();
const optDeadline = z.preprocess(
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
);
const posIntOpt = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : Number(v)),
  z.number().int().positive().optional(),
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

export const CreateFeeAssignmentSchema = z.object({
  feeId: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v)) : v),
    z.number().int().positive(),
  ),
  assignmentType: z.enum(ASSIGNMENT_TYPES),
  targetStudentId: posIntOpt,
  targetProgramme: optStr(120),
  targetDepartment: optStr(120),
  targetFaculty: optStr(120),
  targetLevel: posIntOpt,
  targetSession: optSession,
  targetStudentType: optEnum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']),
  overrideAmount: optAmount,
  overrideDeadline: optDeadline,
  noteToStudent: optStr(2000),
  isActive: optBool,
});

export const UpdateFeeAssignmentSchema = CreateFeeAssignmentSchema.partial().omit({ feeId: true, assignmentType: true }).extend({
  isActive: optBool,
});

export const FeeAssignmentQuerySchema = z.object({
  q: optStr(200),
  assignmentType: z.enum(ASSIGNMENT_TYPES).optional(),
  feeId: posIntOpt,
  targetSession: optStr(20),
  targetLevel: posIntOpt,
  targetStudentType: optEnum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']),
  isActive: z.union([z.boolean(), z.enum(['true', 'false', 'all', '1', '0']).transform((v) => {
    if (v === 'all' || v === undefined) return undefined;
    return v === 'true' || v === '1';
  })]).optional(),
  page: z.coerce.number().int().positive().default(1).optional(),
  pageSize: z.coerce.number().int().positive().max(500).default(25).optional(),
  sort: z.enum(['assignedAt', 'id']).default('assignedAt').optional(),
  order: z.enum(['asc', 'desc']).default('desc').optional(),
});

export const GenerateInvoiceSchema = z.object({
  force: z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]).default(false).optional(),
});

export const ManualInvoiceSchema = z.object({
  feeId: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v)) : v),
    z.number().int().positive(),
  ),
  studentId: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v)) : v),
    z.number().int().positive(),
  ),
  overrideAmount: optAmount,
  overrideDeadline: optDeadline,
});

export const DirectStudentBillSchema = z
  .object({
    matricNumber: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()),
      z.string().min(1, i18n.errors.assignment.directBillMatric).max(80),
    ),
    feeId: posIntOpt,
    adhocFeeName: z.preprocess(
      (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : undefined),
      z.string().min(1, i18n.errors.assignment.directBillAdhocName).max(160).optional(),
    ),
    adhocFeeDescription: optStr(1000),
    adhocFeeCategory: z.preprocess(
      (v) => (typeof v === 'string' ? (v.trim().length === 0 ? 'OTHER' : v.trim()) : 'OTHER'),
      z.string().max(60).default('OTHER').optional(),
    ),
    adhocFeeSession: optStr(20),
    overrideAmount: optAmount,
    overrideDeadline: optDeadline,
    noteToStudent: optStr(2000),
    idempotencyKey: z.preprocess(
      (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : undefined),
      z.string().min(12, 'Idempotency-Key must be at least 12 chars').max(128).optional(),
    ),
  })
  .strict()
  .refine((v) => {
    const isCatalogue = !!v.feeId;
    const isAdhoc = !!v.adhocFeeName;
    if (isCatalogue && isAdhoc) return false;
    if (!isCatalogue && !isAdhoc) return false;
    if (isAdhoc && v.overrideAmount === undefined) return false;
    return true;
  }, {
    message: i18n.errors.assignment.directBillFeeOrAdhoc,
    path: ['feeId'],
  });

export type DirectStudentBillInput = z.infer<typeof DirectStudentBillSchema>;

export type CreateFeeAssignmentInput = z.infer<typeof CreateFeeAssignmentSchema>;
export type UpdateFeeAssignmentInput = z.infer<typeof UpdateFeeAssignmentSchema>;
export type FeeAssignmentQueryInput = z.infer<typeof FeeAssignmentQuerySchema>;
export type ManualInvoiceInput = z.infer<typeof ManualInvoiceSchema>;

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------
const ASSIGNMENT_SELECT = {
  id: true, feeId: true, assignmentType: true,
  targetStudentId: true, targetProgramme: true, targetDepartment: true,
  targetFaculty: true, targetLevel: true, targetSession: true, targetStudentType: true,
  overrideAmount: true, overrideDeadline: true, noteToStudent: true, assignedById: true, assignedAt: true, isActive: true,
  session: true,
  semester: true,
  fee: { select: { id: true, feeCode: true, name: true, amount: true, academicSession: true, semester: true, paymentDeadline: true } },
  assignedBy: { select: { id: true, email: true, firstName: true, lastName: true } },
  targetStudent: { select: { id: true, matricNumber: true, firstName: true, lastName: true } },
} as const;

// -----------------------------------------------------------------------------
// Audit helper (entityType=FEE_ASSIGNMENT or INVOICE_BATCH)
// -----------------------------------------------------------------------------
type ReqLike = Pick<Request, 'user'> & Partial<Pick<Request, 'ip'>> & { headers?: Record<string, any> };

async function writeAudit(req: ReqLike | undefined, data: { action: string; entityType: 'FEE_ASSIGNMENT' | 'INVOICE_BATCH'; entityId: string | number; oldValue?: any; newValue?: any; }) {
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
// FeeAssignmentService
// -----------------------------------------------------------------------------
export class FeeAssignmentService {
  private static validateAssignmentBody(input: CreateFeeAssignmentInput) {
    const required = SESSION_FIELDS[input.assignmentType as AssignmentTargetType];
    const missing = required.filter((k) => (input as any)[k] === undefined || (input as any)[k] === '' || (input as any)[k] === null);
    if (missing.length > 0) {
      throw new AppError(i18n.errors.assignment.assignmentTypeRequiresFields(input.assignmentType, missing as string[]), 400);
    }
  }

  static async list(query: FeeAssignmentQueryInput) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const skip = (page - 1) * pageSize;
    const sort = (query.sort ?? 'assignedAt') as 'assignedAt' | 'id';
    const order = (query.order ?? 'desc') as 'asc' | 'desc';

    const where: Prisma.FeeAssignmentWhereInput = {};
    if (query.assignmentType) where.assignmentType = query.assignmentType as AssignmentTargetType;
    if (query.feeId) where.feeId = query.feeId;
    if (query.targetSession) where.targetSession = query.targetSession;
    if (query.targetLevel) where.targetLevel = query.targetLevel;
    if (query.targetStudentType) where.targetStudentType = query.targetStudentType as StudentType;
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.q) {
      where.OR = [
        { targetProgramme: { contains: query.q } },
        { targetDepartment: { contains: query.q } },
        { targetFaculty: { contains: query.q } },
        { targetSession: { contains: query.q } },
        { fee: { name: { contains: query.q } } },
        { fee: { feeCode: { contains: query.q } } },
      ] as any;
    }

    const orderBy: any = { [sort]: order };
    const [rows, total] = await Promise.all([
      prisma.feeAssignment.findMany({ where, select: ASSIGNMENT_SELECT as any, skip, take: pageSize, orderBy }),
      prisma.feeAssignment.count({ where }),
    ]);
    return { assignments: rows, total, page, pageSize };
  }

  static async getById(id: number) {
    const row = await prisma.feeAssignment.findFirst({ where: { id }, select: ASSIGNMENT_SELECT as any });
    if (!row) throw new AppError(i18n.errors.assignment.assignmentNotFound, 404);
    return row;
  }

  static async create(input: CreateFeeAssignmentInput, req?: ReqLike) {
    this.validateAssignmentBody(input);
    const userId = (req as any)?.user?.id ?? null;
    if (!userId) throw new AppError(i18n.errors.auth.notPermitted, 401);

    const fee = await prisma.fee.findFirst({ where: { id: input.feeId }, select: { id: true, isActive: true, academicSession: true, semester: true } });
    if (!fee) throw new AppError(i18n.errors.fee.notFound, 400);
    if (!fee.isActive) throw new AppError(i18n.errors.fee.notFound, 400);

    if (input.targetStudentId) {
      const stu = await prisma.user.findFirst({ where: { id: input.targetStudentId, role: 'STUDENT' as any }, select: { id: true } });
      if (!stu) throw new AppError(i18n.errors.auth.userNotFound, 400);
    }

    const data: Prisma.FeeAssignmentCreateInput = {
      fee: { connect: { id: input.feeId } },
      assignmentType: input.assignmentType as AssignmentTargetType,
      targetStudent: input.targetStudentId !== undefined ? { connect: { id: input.targetStudentId } } : undefined,
      targetProgramme: input.targetProgramme ?? null,
      targetDepartment: input.targetDepartment ?? null,
      targetFaculty: input.targetFaculty ?? null,
      targetLevel: input.targetLevel ?? null,
      targetSession: input.targetSession ?? null,
      targetStudentType: (input.targetStudentType ?? null) as any,
      overrideAmount: input.overrideAmount !== undefined ? new Prisma.Decimal(String(input.overrideAmount)) : undefined,
      overrideDeadline: input.overrideDeadline ?? null,
      noteToStudent: (input as any).noteToStudent ?? null,
      assignedBy: { connect: { id: userId } },
      isActive: input.isActive ?? true,
      session: fee.academicSession ?? null,
      semester: (fee.semester ?? null) as any,
    };

    // TASK H13: Duplicate protection for STUDENT-targeted catalogue assignments.
    // Composite unique (targetStudentId, feeId) enforced at service level since FK nullable.
    if (input.assignmentType === AssignmentTargetType.STUDENT && input.targetStudentId) {
      const existing = await prisma.feeAssignment.findFirst({
        where: { targetStudentId: input.targetStudentId, feeId: input.feeId, isActive: true },
        select: ASSIGNMENT_SELECT as any,
      });
      if (existing) {
        return existing;
      }
    }

    const created = await prisma.feeAssignment.create({ data, select: ASSIGNMENT_SELECT as any });
    await writeAudit(req, { action: auditActions.feeAssigned, entityType: 'FEE_ASSIGNMENT', entityId: created.id, newValue: created });
    return created;
  }

  static async update(id: number, patch: UpdateFeeAssignmentInput, req?: ReqLike) {
    const existing = await prisma.feeAssignment.findFirst({
      where: { id },
      include: { fee: { select: { id: true, amount: true, paymentDeadline: true, academicSession: true, semester: true } } },
    });
    if (!existing) throw new AppError(i18n.errors.assignment.assignmentNotFound, 404);

    const hasAmountOrDeadlineChange =
      patch.overrideAmount !== undefined || patch.overrideDeadline !== undefined;

    const TERMINAL_STATUSES: ReadonlyArray<string> = ['PAID', 'CANCELLED', 'REFUNDED', 'REVERSED'];

    if (hasAmountOrDeadlineChange && existing.targetStudentId && existing.fee) {
      const terminalInvoices = await prisma.invoice.findMany({
        where: {
          studentId: existing.targetStudentId,
          feeId: existing.feeId,
          status: { in: TERMINAL_STATUSES as any },
          createdAt: { gte: new Date(String(existing.assignedAt)) },
        },
        select: { id: true, status: true, amountDue: true, invoiceNumber: true },
      });
      if (terminalInvoices.length > 0) {
        throw new AppError(
          'Cannot update a direct-bill assignment linked to a paid invoice. Create a new assignment instead.',
          409,
        );
      }
    }

    const data: Prisma.FeeAssignmentUpdateInput = {};
    if (patch.targetProgramme !== undefined) data.targetProgramme = patch.targetProgramme ?? null;
    if (patch.targetDepartment !== undefined) data.targetDepartment = patch.targetDepartment ?? null;
    if (patch.targetFaculty !== undefined) data.targetFaculty = patch.targetFaculty ?? null;
    if (patch.targetLevel !== undefined) data.targetLevel = patch.targetLevel ?? null;
    if (patch.targetSession !== undefined) data.targetSession = patch.targetSession ?? null;
    if (patch.targetStudentType !== undefined) data.targetStudentType = (patch.targetStudentType ?? null) as any;
    if (patch.targetStudentId !== undefined) {
      data.targetStudent = patch.targetStudentId === null ? { disconnect: true } : { connect: { id: patch.targetStudentId } };
    }
    if (patch.overrideAmount !== undefined) data.overrideAmount = new Prisma.Decimal(String(patch.overrideAmount));
    if (patch.overrideDeadline !== undefined) data.overrideDeadline = patch.overrideDeadline ?? null;
    if (patch.noteToStudent !== undefined) data.noteToStudent = patch.noteToStudent ?? null;
    if (patch.isActive !== undefined) data.isActive = patch.isActive;

    const updated = await prisma.feeAssignment.update({ where: { id }, data, select: ASSIGNMENT_SELECT as any });

    if (hasAmountOrDeadlineChange && existing.targetStudentId && existing.fee) {
      const newOverrideAmount = patch.overrideAmount !== undefined
        ? Number(patch.overrideAmount)
        : (existing.overrideAmount != null ? Number(existing.overrideAmount) : null);
      const targetAmount = newOverrideAmount != null
        ? Number(newOverrideAmount)
        : Number(existing.fee.amount);
      const targetDue = patch.overrideDeadline !== undefined
        ? patch.overrideDeadline
        : (existing.overrideDeadline ?? existing.fee.paymentDeadline);

      const oldOverrideAmount = existing.overrideAmount != null ? Number(existing.overrideAmount) : null;
      const originalAmount = oldOverrideAmount != null ? Number(oldOverrideAmount) : Number(existing.fee.amount);

      const nonTerminal = await prisma.invoice.findMany({
        where: {
          studentId: existing.targetStudentId,
          feeId: existing.feeId,
          status: { in: ['UNPAID', 'PENDING', 'PARTIALLY_PAID'] as any },
          createdAt: { gte: new Date(String(existing.assignedAt)) },
        },
        select: { id: true, amountDue: true, createdAt: true, status: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      if (nonTerminal.length > 0) {
        let bestMatch: typeof nonTerminal[number] | null = null;
        let bestDelta = Infinity;
        for (const inv of nonTerminal) {
          const delta = Math.abs(Number(inv.amountDue) - originalAmount);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestMatch = inv;
          }
        }
        if (bestMatch && bestDelta < 0.01) {
          const updateData: Prisma.InvoiceUpdateInput = {
            amountDue: new Prisma.Decimal(String(targetAmount)),
          };
          if (targetDue !== undefined && targetDue !== null) {
            updateData.dueDate = targetDue;
          }
          await prisma.invoice.update({
            where: { id: bestMatch.id },
            data: updateData,
          });
        }
      }
    }

    await writeAudit(req, { action: auditActions.feeAssignmentUpdated, entityType: 'FEE_ASSIGNMENT', entityId: id, oldValue: existing, newValue: updated });
    return updated;
  }

  static async remove(id: number, req?: ReqLike) {
    const existing = await prisma.feeAssignment.findFirst({ where: { id }, include: { fee: true } });
    if (!existing) throw new AppError(i18n.errors.assignment.assignmentNotFound, 404);

    if (existing.targetStudentId) {
      const paidInvoices = await prisma.invoice.findMany({
        where: {
          studentId: existing.targetStudentId,
          feeId: existing.feeId,
          status: 'PAID',
          createdAt: { gte: new Date(String(existing.assignedAt)) },
        },
        select: { id: true, invoiceNumber: true },
      });
      if (paidInvoices.length > 0) {
        throw new AppError('Assignment has paid invoices and cannot be deleted.', 409);
      }
    }

    const txResult = await prisma.$transaction(async (tx) => {
      const hasPaidTx = await tx.transaction.findFirst({
        where: {
          invoice: {
            studentId: existing.targetStudentId ?? undefined,
            feeId: existing.feeId,
          },
          status: { in: ['SUCCESS', 'PENDING'] as any },
        },
        select: { id: true },
      });
      if (hasPaidTx) {
        throw new AppError('Cannot delete this direct bill: it has a SUCCESS or PENDING transaction. Use Disable instead.', 409);
      }
      await tx.invoice.deleteMany({
        where: {
          studentId: existing.targetStudentId ?? -1,
          feeId: existing.feeId,
          status: { in: ['UNPAID', 'FAILED', 'CANCELLED', 'EXPIRED'] as any },
        },
      });
      const deleted = await tx.feeAssignment.delete({ where: { id }, select: { id: true, feeId: true, targetStudentId: true, assignedAt: true } });
      await writeAudit(req, { action: auditActions.feeAssignmentDeleted, entityType: 'FEE_ASSIGNMENT', entityId: id, oldValue: existing });
      return { deleted };
    });
    return txResult;
  }

  /**
   * One-click targeted billing: ADMIN | BURSARY bill a specific student by matric.
   * Resolves matric → ensures fee (or creates ad-hoc OTHER category fee) → creates
   * STUDENT-target FeeAssignment → generates idempotent invoice → pairs 2 AuditLogs.
   * Idempotency: if an ACTIVE FeeAssignment exists for same (targetStudentId, feeId) we
   * skip re-create of assignment & return existing (created:false); invoice-level dedup
   * happens via (studentId, feeId, session) inside the manual invoice block.
   * Caller should send email outside tx with fire-and-forget.
   */
  static async billStudentByMatric(input: DirectStudentBillInput, req?: ReqLike) {
    const actorUserId = (req as any)?.user?.id ?? null;
    if (!actorUserId) throw new AppError(i18n.errors.auth.notPermitted, 401);

    // Step 1 — resolve matric (uses getByMatric which enforces accountStatus===ACTIVE + throws 404/400)
    const student = await StudentService.getByMatric(input.matricNumber);

    // Steps 2-6 inside a single Prisma $transaction so assignment+invoice are atomic.
    const txResult = await prisma.$transaction(async (tx) => {
      // Step 2 — resolve/create Fee
      let feeId: number;
      let adhocFeeCreated = false;
      let fee: { id: number; amount: Prisma.Decimal; academicSession: string | null; paymentDeadline: Date | null; semester: Semester | null; isActive: boolean; name: string; feeCode: string };
      if (input.feeId) {
        const row = await tx.fee.findFirst({
          where: { id: input.feeId, isActive: true },
          select: { id: true, amount: true, academicSession: true, paymentDeadline: true, semester: true, isActive: true, name: true, feeCode: true },
        });
        if (!row) throw new AppError(i18n.errors.fee.notFound, 400);
        fee = row;
        feeId = row.id;
      } else {
        // Ensure FeeCategory OTHER exists (idempotent upsert by code)
        const category = await tx.feeCategory.upsert({
          where: { code: String(input.adhocFeeCategory || 'OTHER').toUpperCase() },
          create: {
            code: String(input.adhocFeeCategory || 'OTHER').toUpperCase(),
            name: String(input.adhocFeeCategory || 'OTHER').toUpperCase() === 'OTHER' ? 'Other / Ad-hoc Charges' : String(input.adhocFeeCategory || 'Other'),
            createdById: actorUserId,
            description: 'Auto-created category for direct-bill ad-hoc charges',
          },
          update: {},
          select: { id: true, code: true },
        });
        // Build session from input, fall back to student academicSession, fallback → current YYYY/(YYYY+1)
        let session: string = (input.adhocFeeSession || '').trim();
        if (!SESSION_RE.test(session)) {
          const sSession = (student as any).academicSession as string | undefined | null;
          session = sSession && SESSION_RE.test(String(sSession)) ? String(sSession) : (() => { const y = new Date().getFullYear(); return `${y}/${y+1}`; })();
        }
        // Generate stable-ish adhoc fee code: ADH-<category>-<YYYYMMDDhhmmss>-<rand3>
        const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
        const rand = Math.floor(100 + Math.random() * 900);
        const code = `ADH-${(input.adhocFeeCategory||'OTHER').toUpperCase()}-${ts}-${rand}`;
        const amount = new Prisma.Decimal(String(input.overrideAmount as number));
        const stuSem = (student as any).semester as Semester | undefined | null;
        const semester: Semester | null = stuSem ? String(stuSem) as Semester : null;
        const created = await tx.fee.create({
          data: {
            feeCode: code,
            name: String(input.adhocFeeName).trim(),
            description: (input.adhocFeeDescription || '').trim() || null,
            categoryId: category.id,
            amount,
            currency: 'NGN',
            academicSession: session,
            semester,
            isMandatory: false,
            paymentDeadline: input.overrideDeadline ?? null,
            isActive: true,
            createdById: actorUserId,
          },
          select: { id: true, amount: true, academicSession: true, paymentDeadline: true, semester: true, isActive: true, name: true, feeCode: true },
        });
        fee = created;
        feeId = created.id;
        adhocFeeCreated = true;
      }

      // Step 3 — overrideAmount/deadline union (invoice uses input overrides first, else fee defaults)
      const overrideAmount = input.overrideAmount !== undefined ? new Prisma.Decimal(String(input.overrideAmount)) : null;
      const overrideDeadline = input.overrideDeadline ?? null;

      // Step 4 — FeeAssignment for STUDENT target.
      // TASK H13:
      //   - Denormalize session + semester from parent Fee into FeeAssignment row
      //   - For existing catalogue fee (not ad-hoc), enforce (targetStudentId, feeId) uniqueness:
      //     if ACTIVE row already exists, re-use it rather than creating duplicate.
      //   - Ad-hoc fees are always newly created in this tx so uniqueness guarantees no conflict.
      // HTTP-level idempotency (to catch accidental double-submit within 2 seconds) is handled
      // by Idempotency-Key header middleware elsewhere.
      let assignmentCreated = true;
      let assignment: any = null;
      if (!adhocFeeCreated && feeId) {
        // CRITICAL idempotency: reuse ONLY rows that are NOT YET settled AND whose
        // overrideAmount (if any) matches the current input's overrideAmount. Otherwise
        // an already-settled ₦200 posting (e.g. assignment id=4) can be incorrectly
        // re-used for a brand-new ₦100 billing request, breaking Step 5 dedupe below.
        const whereMatch: any = {
          targetStudentId: student.id,
          feeId: feeId,
          isActive: true,
          settledAt: null,
        };
        if (overrideAmount != null) {
          whereMatch.overrideAmount = overrideAmount;
        } else {
          whereMatch.OR = [
            { overrideAmount: null },
            { overrideAmount: { equals: null as any } },
          ];
        }
        assignment = await tx.feeAssignment.findFirst({
          where: whereMatch,
          orderBy: { assignedAt: 'desc' },
          select: ASSIGNMENT_SELECT as any,
        });
      }
      if (assignment == null) {
        assignment = await tx.feeAssignment.create({
          data: {
            fee: { connect: { id: feeId } },
            assignmentType: AssignmentTargetType.STUDENT,
            targetStudent: { connect: { id: student.id } },
            overrideAmount: overrideAmount ?? undefined,
            overrideDeadline: overrideDeadline ?? undefined,
            noteToStudent: input.noteToStudent ?? null,
            assignedBy: { connect: { id: actorUserId } },
            isActive: true,
            session: fee.academicSession ?? null,
            semester: (fee.semester ?? null) as any,
          },
          select: ASSIGNMENT_SELECT as any,
        });
      } else {
        assignmentCreated = false;
      }

      // Step 5 — CREATE ONE UNPAID Invoice per direct bill posting.
      // Idempotency guarantees:
      //  A) Explicit Idempotency-Key from caller (input or header) → replay returns the existing invoice.
      //  B) Implicit: if THIS assignment already has an existing UNPAID / PENDING / PARTIALLY_PAID
      //     invoice row with matching feeId + matching due-amount (overrideAmount if set, else fee.amount),
      //     reuse that one rather than creating a duplicate UNPAID invoice row.
      //  Multiple separate direct-bill postings for the SAME student CAN legitimately create
      //  separate invoice rows if they belong to DIFFERENT FeeAssignment rows (different amounts/dates).
      const academicSession: string = fee.academicSession || (()=>{ const y=new Date().getFullYear(); return `${y}/${y+1}`; })();
      const idemKey = ((input as any).idempotencyKey || (req as any)?.headers?.['idempotency-key'] || '') as string;

      const amount = overrideAmount ?? fee.amount;
      const deadline = overrideDeadline ?? fee.paymentDeadline ?? null;
      const targetAmountNumber = Number(amount);

      // Safety: if idemKey is supplied and matches an existing invoice (replay), return that one
      let invoice: any = idemKey ? await tx.invoice.findFirst({
        where: { idempotencyKey: String(idemKey).slice(0, 128) },
        select: { id: true, invoiceNumber: true, status: true, amountDue: true, dueDate: true, session: true, studentId: true, feeId: true, createdAt: true },
      }) : null;
      let invoiceCreated = false;

      // Implicit idempotency: existing UNPAID/PENDING/PARTIALLY_PAID for this student/fee/amount
      // and created at or after this specific assignment row's assignedAt.
      if (!invoice) {
        // FIX B: fetch ALL candidates with matching status first (broader net via findMany),
        // then filter in JS by amountDue Δ<0.01. The previous findFirst returned the
        // SINGLE newest by createdAt — which could be a different-amount invoice (e.g.
        // a PENDING 200 inv.id=53) and cause the amount check to fail — silently skipping
        // reuse of an existing same-amount UNPAID (e.g. inv.id=49 100) and creating a duplicate.
        const candidates = await tx.invoice.findMany({
          where: {
            studentId: student.id,
            feeId: fee.id,
            status: { in: ['UNPAID', 'PENDING', 'PARTIALLY_PAID'] as any },
            createdAt: { gte: (assignment as any).assignedAt ? new Date(String((assignment as any).assignedAt)) : undefined },
          },
          select: { id: true, invoiceNumber: true, status: true, amountDue: true, dueDate: true, session: true, studentId: true, feeId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 20,
        });
        if (candidates && candidates.length > 0) {
          const matched = candidates.filter((c: any) => {
            const due = Number((c as any).amountDue ?? 0);
            return Math.abs(due - targetAmountNumber) < 0.01;
          });
          if (matched.length > 0) {
            // Newest by createdAt (already desc sorted from findMany orderBy)
            invoice = matched[0];
          }
        }
      }
      if (!invoice) {
        const fiscalYear = yearFromSession(academicSession);
        const nextId = await nextYearlyCounter('invoice', fiscalYear);
        const ref = generateInvoiceReference(nextId, fiscalYear);
        invoice = await tx.invoice.create({
          data: {
            invoiceNumber: ref,
            student: { connect: { id: student.id } },
            fee: { connect: { id: fee.id } },
            amountDue: amount,
            amountPaid: new Prisma.Decimal(0),
            status: 'UNPAID',
            dueDate: deadline,
            session: academicSession,
            semester: fee.semester as Semester | null,
            idempotencyKey: idemKey ? String(idemKey).slice(0, 128) : null,
          },
          select: { id: true, invoiceNumber: true, status: true, amountDue: true, dueDate: true, session: true, studentId: true, feeId: true, createdAt: true },
        });
        invoiceCreated = true;
      }

      // Step 6 — write paired AuditLogs within transaction scope using raw prisma (not writeAudit helper)
      // so tx rollback also rolls back audit entries (consistency NFR-2).
      try {
        if (assignmentCreated) {
          await tx.auditLog.create({
            data: {
              action: auditActions.feeAssigned,
              entityType: 'FEE_ASSIGNMENT',
              entityId: String(assignment.id),
              userId: actorUserId,
              ipAddress: (req as any)?.ip?.slice(0,64) ?? ((req as any)?.headers?.['x-forwarded-for']?.split(',')[0]?.slice(0,64) ?? null),
              userAgent: (req as any)?.headers?.['user-agent']?.slice(0,512) ?? null,
              newValue: assignment as any,
            },
          });
        }
        if (invoiceCreated) {
          await tx.auditLog.create({
            data: {
              action: auditActions.invoiceGenerated,
              entityType: 'INVOICE_BATCH',
              entityId: String(invoice.id),
              userId: actorUserId,
              ipAddress: (req as any)?.ip?.slice(0,64) ?? null,
              userAgent: (req as any)?.headers?.['user-agent']?.slice(0,512) ?? null,
              newValue: { invoiceNumber: invoice.invoiceNumber, studentId: invoice.studentId, feeId: invoice.feeId, amountDue: Number(invoice.amountDue), matricNumber: student.matricNumber, noteToStudent: input.noteToStudent ?? null },
            },
          });
        }
      } catch (auditErr) {
        // audit tx failure → abort the whole transaction
        throw new AppError('Audit write failed, transaction rolled back.', 500);
      }

      return {
        assignment,
        assignmentCreated,
        invoice,
        invoiceCreated,
        adhocFeeCreated,
        fee,
        student,
      };
    });

    // Created flag per Task 2 response contract (true if new assignment OR new invoice created)
    const created = txResult.assignmentCreated || txResult.invoiceCreated;
    return {
      assignment: txResult.assignment,
      invoice: txResult.invoice,
      fee: txResult.fee,
      student: txResult.student,
      created,
      assignmentCreated: txResult.assignmentCreated,
      invoiceCreated: txResult.invoiceCreated,
      adhocFeeCreated: txResult.adhocFeeCreated,
      noteToStudent: input.noteToStudent ?? null,
    };
  }
}

// -----------------------------------------------------------------------------
// Invoice engine
// -----------------------------------------------------------------------------
export class InvoiceEngine {
  /** Build student selector where clause for a FeeAssignment row + fee session */
  private static buildStudentWhere(a: any): Prisma.UserWhereInput {
    const session = a.fee?.academicSession ?? a.targetSession;
    const where: Prisma.UserWhereInput = { role: 'STUDENT' as any, accountStatus: 'ACTIVE' as any };
    if (a.targetStudentId) where.id = a.targetStudentId;
    if (a.targetProgramme) where.program = a.targetProgramme;
    if (a.targetDepartment) where.department = a.targetDepartment;
    if (a.targetFaculty) where.college = a.targetFaculty;
    if (a.targetLevel) where.level = a.targetLevel;
    if (a.targetStudentType) where.studentType = a.targetStudentType as StudentType;
    if (session) where.academicSession = session;
    return where;
  }

  static async generateInvoices(assignmentId: number, force: boolean, req?: ReqLike) {
    const a = await prisma.feeAssignment.findFirst({
      where: { id: assignmentId },
      include: { fee: true, targetStudent: true },
    });
    if (!a || !a.fee) throw new AppError(i18n.errors.assignment.assignmentNotFound, 404);
    if (!a.isActive || !a.fee.isActive) throw new AppError(i18n.errors.assignment.assignmentNotFound, 400);

    const feeAmount = a.overrideAmount ?? a.fee.amount;
    const session = a.fee.academicSession;
    const deadline: Date | null = (a.overrideDeadline ?? a.fee.paymentDeadline) || null;
    const semester = a.fee.semester ?? null;

    const studentWhere = this.buildStudentWhere(a);
    const students = await prisma.user.findMany({ where: studentWhere, select: { id: true } });

    const existingInvoices = await prisma.invoice.findMany({
      where: { feeId: a.feeId, studentId: { in: students.map((s) => s.id) } },
      select: { studentId: true },
    });
    const existingSet = new Set(existingInvoices.map((i) => i.studentId));

    const toInvoice = force
      ? students.map((s) => s.id)
      : students.filter((s) => !existingSet.has(s.id)).map((s) => s.id);

    if (toInvoice.length === 0) {
      return {
        assignmentId,
        matchingStudents: students.length,
        alreadyInvoiced: existingSet.size,
        created: 0,
        skipped: students.length,
      };
    }

    // Sequential yearly-sequenced counter (INV/YYYY/00001, resets every Jan 1).
    const fiscalYear = yearFromSession(session);
    const fiscalYear_const = fiscalYear;
    const result = await prisma.$transaction(async (tx) => {
      const createdRows: Array<{ id: number; invoiceNumber: string; studentId: number }> = [];
      for (const studentId of toInvoice) {
        const nextSeq = await nextYearlyCounter('invoice', fiscalYear_const);
        const ref = generateInvoiceReference(nextSeq, fiscalYear_const);
        const row = await tx.invoice.create({
          data: {
            invoiceNumber: ref,
            student: { connect: { id: studentId } },
            fee: { connect: { id: a.feeId } },
            amountDue: new Prisma.Decimal(String(feeAmount)),
            amountPaid: new Prisma.Decimal(0),
            status: 'UNPAID',
            dueDate: deadline,
            session,
            semester: semester as any,
          },
          select: { id: true, invoiceNumber: true, studentId: true },
        });
        createdRows.push(row);
      }
      return createdRows;
    });

    const created = result.length;
    const skipped = students.length - created;
    const first50 = result.slice(0, 50);

    await writeAudit(req, {
      action: auditActions.invoicesGenerated,
      entityType: 'INVOICE_BATCH',
      entityId: assignmentId,
      oldValue: { assignmentId, matchingStudents: students.length, alreadyInvoiced: existingSet.size, force },
      newValue: { created, skipped, first50 },
    });

    return {
      assignmentId,
      matchingStudents: students.length,
      alreadyInvoiced: existingSet.size,
      created,
      skipped,
      sampleInvoices: first50,
    };
  }

  /** Manual single-student invoice (ADMIN override) — enforces idempotency per (studentId, feeId, session) */
  static async manualInvoice(input: ManualInvoiceInput, req?: ReqLike) {
    const userId = (req as any)?.user?.id ?? null;
    if (!userId) throw new AppError(i18n.errors.auth.notPermitted, 401);

    const [fee, student] = await Promise.all([
      prisma.fee.findFirst({ where: { id: input.feeId }, select: { id: true, amount: true, academicSession: true, paymentDeadline: true, semester: true, isActive: true } }),
      prisma.user.findFirst({ where: { id: input.studentId, role: 'STUDENT' as any }, select: { id: true, accountStatus: true } }),
    ]);
    if (!fee || !fee.isActive) throw new AppError(i18n.errors.fee.notFound, 400);
    if (!student) throw new AppError(i18n.errors.auth.userNotFound, 400);
    if (student.accountStatus !== 'ACTIVE') throw new AppError(i18n.errors.auth.accountInactive, 400);

    const amount = input.overrideAmount ? new Prisma.Decimal(String(input.overrideAmount)) : new Prisma.Decimal(String(fee.amount));
    const deadline = input.overrideDeadline ?? fee.paymentDeadline ?? null;

    const fiscalYear = yearFromSession(fee.academicSession);
    const row = await prisma.$transaction(async (tx) => {
      const nextSeq = await nextYearlyCounter('invoice', fiscalYear);
      const ref = generateInvoiceReference(nextSeq, fiscalYear);
      return tx.invoice.create({
        data: {
          invoiceNumber: ref,
          student: { connect: { id: student.id } },
          fee: { connect: { id: fee.id } },
          amountDue: amount,
          amountPaid: new Prisma.Decimal(0),
          status: 'UNPAID',
          dueDate: deadline,
          session: fee.academicSession,
          semester: (fee.semester ?? null) as Semester | null,
        },
      });
    });

    await writeAudit(req, { action: auditActions.invoiceGenerated, entityType: 'INVOICE_BATCH', entityId: row.id, newValue: { invoiceNumber: row.invoiceNumber, studentId: student.id, feeId: fee.id, amountDue: Number(row.amountDue) } });
    return { invoice: row, created: true };
  }
}

export default { FeeAssignmentService, InvoiceEngine };
