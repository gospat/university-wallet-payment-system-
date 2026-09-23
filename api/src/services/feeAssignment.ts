// =============================================================================
// FeeAssignment Service + Invoice generator
// -----------------------------------------------------------------------------
// Task 9 — FeeAssignment model CRUD (REST) +
// Task 9.2 generate-invoices engine (cohort selector, idempotent per-session,
// manual override, INV- references, atomic batched writes)
// =============================================================================

import { Prisma, AssignmentTargetType, StudentType, Semester } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { auditActions, i18n } from '../i18n/en';
import { generateInvoiceReference } from '../utils/paystack';
import type { Request } from 'express';

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

export const CreateFeeAssignmentSchema = z.object({
  feeId: z.coerce.number().int().positive(),
  assignmentType: z.enum(ASSIGNMENT_TYPES),
  targetStudentId: z.coerce.number().int().positive().optional(),
  targetProgramme: z.string().max(120).trim().optional(),
  targetDepartment: z.string().max(120).trim().optional(),
  targetFaculty: z.string().max(120).trim().optional(),
  targetLevel: z.coerce.number().int().positive().max(1000).optional(),
  targetSession: z.string().max(20).trim().regex(SESSION_RE).optional(),
  targetStudentType: z.enum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']).optional(),
  overrideAmount: z.union([
    z.coerce.number().positive().max(999_999_999.99),
    z.string().trim().regex(AMOUNT_RE).transform(Number),
  ]).optional(),
  overrideDeadline: z.coerce.date().optional(),
  isActive: z.boolean().default(true).optional(),
});

export const UpdateFeeAssignmentSchema = CreateFeeAssignmentSchema.partial().omit({ feeId: true, assignmentType: true }).extend({
  isActive: z.boolean().optional(),
});

export const FeeAssignmentQuerySchema = z.object({
  q: z.string().max(200).trim().optional(),
  assignmentType: z.enum(ASSIGNMENT_TYPES).optional(),
  feeId: z.coerce.number().int().positive().optional(),
  targetSession: z.string().max(20).trim().optional(),
  targetLevel: z.coerce.number().int().positive().max(1000).optional(),
  targetStudentType: z.enum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']).optional(),
  isActive: z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]).optional(),
  page: z.coerce.number().int().positive().default(1).optional(),
  pageSize: z.coerce.number().int().positive().max(500).default(25).optional(),
  sort: z.enum(['assignedAt', 'id']).default('assignedAt').optional(),
  order: z.enum(['asc', 'desc']).default('desc').optional(),
});

export const GenerateInvoiceSchema = z.object({
  force: z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]).default(false).optional(),
});

export const ManualInvoiceSchema = z.object({
  feeId: z.coerce.number().int().positive(),
  studentId: z.coerce.number().int().positive(),
  overrideAmount: z.union([
    z.coerce.number().positive().max(999_999_999.99),
    z.string().trim().regex(AMOUNT_RE).transform(Number),
  ]).optional(),
  overrideDeadline: z.coerce.date().optional(),
});

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
  overrideAmount: true, overrideDeadline: true, assignedById: true, assignedAt: true, isActive: true,
  fee: { select: { id: true, feeCode: true, name: true, amount: true, academicSession: true, paymentDeadline: true } },
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

    const fee = await prisma.fee.findFirst({ where: { id: input.feeId }, select: { id: true, isActive: true, academicSession: true } });
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
      targetStudentType: input.targetStudentType ?? null,
      overrideAmount: input.overrideAmount !== undefined ? new Prisma.Decimal(String(input.overrideAmount)) : undefined,
      overrideDeadline: input.overrideDeadline ?? null,
      assignedBy: { connect: { id: userId } },
      isActive: input.isActive ?? true,
    };
    const created = await prisma.feeAssignment.create({ data, select: ASSIGNMENT_SELECT as any });
    await writeAudit(req, { action: auditActions.feeAssigned, entityType: 'FEE_ASSIGNMENT', entityId: created.id, newValue: created });
    return created;
  }

  static async update(id: number, patch: UpdateFeeAssignmentInput, req?: ReqLike) {
    const existing = await prisma.feeAssignment.findFirst({ where: { id } });
    if (!existing) throw new AppError(i18n.errors.assignment.assignmentNotFound, 404);

    const data: Prisma.FeeAssignmentUpdateInput = {};
    if (patch.targetProgramme !== undefined) data.targetProgramme = patch.targetProgramme ?? null;
    if (patch.targetDepartment !== undefined) data.targetDepartment = patch.targetDepartment ?? null;
    if (patch.targetFaculty !== undefined) data.targetFaculty = patch.targetFaculty ?? null;
    if (patch.targetLevel !== undefined) data.targetLevel = patch.targetLevel ?? null;
    if (patch.targetSession !== undefined) data.targetSession = patch.targetSession ?? null;
    if (patch.targetStudentType !== undefined) data.targetStudentType = patch.targetStudentType ?? null;
    if (patch.targetStudentId !== undefined) {
      data.targetStudent = patch.targetStudentId === null ? { disconnect: true } : { connect: { id: patch.targetStudentId } };
    }
    if (patch.overrideAmount !== undefined) data.overrideAmount = new Prisma.Decimal(String(patch.overrideAmount));
    if (patch.overrideDeadline !== undefined) data.overrideDeadline = patch.overrideDeadline ?? null;
    if (patch.isActive !== undefined) data.isActive = patch.isActive;

    const updated = await prisma.feeAssignment.update({ where: { id }, data, select: ASSIGNMENT_SELECT as any });
    await writeAudit(req, { action: auditActions.feeAssignmentUpdated, entityType: 'FEE_ASSIGNMENT', entityId: id, oldValue: existing, newValue: updated });
    return updated;
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

    // For idempotency: find existing invoices (studentId, feeId, session)
    const existingInvoices = await prisma.invoice.findMany({
      where: { feeId: a.feeId, session, studentId: { in: students.map((s) => s.id) } },
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

    // Run the entire batch inside a single $transaction to get a stable serial
    // invoice counter; each invoice uses sequentially-increasing nextId based on
    // MAX(id) within the tx to guarantee order within the session.
    const result = await prisma.$transaction(async (tx) => {
      // Reserve a stable numeric base so INV refs are sequential within the batch.
      const baseRow: any = await tx.$queryRawUnsafe<Array<{ next_id: number }>>(
        'SELECT COALESCE(MAX(id),0)+1 AS next_id FROM invoices FOR UPDATE'
      );
      let nextId = Number(baseRow?.[0]?.next_id ?? 0);
      if (Number.isNaN(nextId)) nextId = 1;
      const createdRows: Array<{ id: number; invoiceNumber: string; studentId: number }> = [];
      for (const studentId of toInvoice) {
        const ref = generateInvoiceReference(nextId, session?.split('/')[0] ?? undefined);
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
        nextId += 1;
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

    const existing = await prisma.invoice.findFirst({
      where: { feeId: fee.id, studentId: student.id, session: fee.academicSession },
      select: { id: true, invoiceNumber: true, status: true, amountDue: true },
    });
    if (existing) {
      // Idempotent manual assignment returns the existing row.
      return { invoice: existing, created: false };
    }

    const amount = input.overrideAmount ? new Prisma.Decimal(String(input.overrideAmount)) : new Prisma.Decimal(String(fee.amount));
    const deadline = input.overrideDeadline ?? fee.paymentDeadline ?? null;

    const row = await prisma.$transaction(async (tx) => {
      const baseRow: any = await tx.$queryRawUnsafe<Array<{ next_id: number }>>(
        'SELECT COALESCE(MAX(id),0)+1 AS next_id FROM invoices FOR UPDATE'
      );
      const nextId = Number(baseRow?.[0]?.next_id ?? 1);
      const ref = generateInvoiceReference(nextId, fee.academicSession?.split('/')[0] ?? undefined);
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
