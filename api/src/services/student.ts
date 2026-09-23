// =============================================================================
// Student Service — CRUD + search/filter + account lifecycle helpers
// =============================================================================
// Conventions:
//   - Service methods are idempotent where applicable.
//   - All mutations use Prisma $transaction and write audit logs.
//   - Student records = users where role=STUDENT; Bursary/Admin are forbidden
//     from ever appearing in StudentService queries (we hard filter role=STUDENT).
//   - Every "update" method takes an actorId and writes entityType/entityId
//     audit logs (oldValue/newValue JSON) per §38 audit spec.
// =============================================================================

import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import { i18n } from '../i18n/en';
import { AccountStatus, Role, User, Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { z } from 'zod';

// -----------------------------------------------------------------------------
// Zod schemas (reused by routes for validateBody/validateQuery)
// -----------------------------------------------------------------------------

export const CreateStudentSchema = z.object({
  email: z.string().email().max(254),
  firstName: z.string().min(1).max(80).trim(),
  middleName: z.string().max(80).trim().optional().nullable(),
  lastName: z.string().min(1).max(80).trim(),
  matricNumber: z.string().min(3).max(50).trim(),
  admissionNumber: z.string().max(50).trim().optional().nullable(),
  jambNumber: z.string().max(50).trim().optional().nullable(),
  college: z.string().min(2).max(120).trim().optional().nullable(),
  department: z.string().min(2).max(120).trim().optional().nullable(),
  program: z.string().min(2).max(120).trim().optional().nullable(),
  level: z.coerce.number().int().min(100).max(1000).optional().nullable(),
  academicSession: z.string().max(20).trim().optional().nullable(),
  studentType: z.enum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']).optional().nullable(),
  entryMode: z.enum(['UTME', 'DIRECT_ENTRY', 'TRANSFER', 'OTHER']).optional().nullable(),
  admissionYear: z.coerce.number().int().min(1990).max(2100).optional().nullable(),
  graduationYear: z.coerce.number().int().min(1990).max(2100).optional().nullable(),
  phoneNumber: z.string().max(30).trim().optional().nullable(),
  address: z.string().max(500).trim().optional().nullable(),
  password: z.string().min(8).max(128).optional(),
});
export type CreateStudentInput = z.infer<typeof CreateStudentSchema>;

export const UpdateStudentSchema = CreateStudentSchema.partial().extend({
  accountStatus: z.enum(['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN']).optional(),
});
export type UpdateStudentInput = z.infer<typeof UpdateStudentSchema>;

export const StudentSelfUpdateSchema = z.object({
  firstName: z.string().min(1).max(80).trim().optional(),
  middleName: z.string().max(80).trim().optional().nullable(),
  lastName: z.string().min(1).max(80).trim().optional(),
  phoneNumber: z.string().max(30).trim().optional().nullable(),
  address: z.string().max(500).trim().optional().nullable(),
  email: z.string().email().max(254).optional(),
});
export type StudentSelfUpdateInput = z.infer<typeof StudentSelfUpdateSchema>;

export const StudentQuerySchema = z.object({
  q: z.string().max(200).optional(),
  matricNumber: z.string().max(50).optional(),
  college: z.string().max(120).optional(),
  department: z.string().max(120).optional(),
  program: z.string().max(120).optional(),
  level: z.coerce.number().int().optional(),
  academicSession: z.string().max(20).optional(),
  studentType: z.enum(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']).optional(),
  accountStatus: z.enum(['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['createdAt', 'firstName', 'lastName', 'matricNumber', 'level']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type StudentQueryInput = z.infer<typeof StudentQuerySchema>;

// -----------------------------------------------------------------------------
// Public shape — everything except password hash.
// -----------------------------------------------------------------------------
const STUDENT_SELECT = {
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
  failedLoginAttempts: true,
  lockedUntil: true,
  studentImportId: true,
  createdAt: true,
  updatedAt: true,
} as const;

type Selected = Awaited<ReturnType<typeof prisma.user.findMany<{ select: typeof STUDENT_SELECT }>>>[number];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function defaultPasswordFor(input: CreateStudentInput): string {
  if (input.password) return input.password;
  // Fallback: matricNumber if provided, otherwise a random 10-char password.
  if (input.matricNumber) return input.matricNumber;
  return Math.random().toString(36).slice(2, 12);
}

// Prisma's Json column types require JsonNull (DbNull) rather than the JS null
// literal when no old/new values exist — otherwise TS complains we assign a
// non InputJsonValue to a Json column.
const JSON_DB_NULL = Prisma.JsonNull;

// -----------------------------------------------------------------------------
// Service API
// -----------------------------------------------------------------------------

export class StudentService {
  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------
  static async create(
    input: CreateStudentInput,
    actorId: number,
    opts?: { ip?: string; userAgent?: string; importId?: number },
  ): Promise<Selected> {
    const duplicate = await prisma.user.findFirst({
      where: {
        OR: [{ email: input.email }, { matricNumber: input.matricNumber }],
      },
      select: { id: true, email: true, matricNumber: true },
    });
    if (duplicate) {
      if (duplicate.email === input.email) throw new AppError(i18n.errors.auth.emailExists, 400);
      throw new AppError(i18n.errors.auth.matricExists, 400);
    }

    const pwd = defaultPasswordFor(input);
    const passwordHash = await bcrypt.hash(pwd, 12);

    const createData: Prisma.UserCreateInput = {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      password: passwordHash,
      role: Role.STUDENT,
      accountStatus: (input as any).accountStatus ?? AccountStatus.ACTIVE,
    };
    if (input.middleName !== undefined) createData.middleName = input.middleName ?? undefined;
    if (input.matricNumber !== undefined) createData.matricNumber = input.matricNumber;
    if (input.admissionNumber !== undefined) createData.admissionNumber = input.admissionNumber ?? undefined;
    if (input.jambNumber !== undefined) createData.jambNumber = input.jambNumber ?? undefined;
    if (input.college !== undefined) createData.college = input.college ?? undefined;
    if (input.department !== undefined) createData.department = input.department ?? undefined;
    if (input.program !== undefined) createData.program = input.program ?? undefined;
    if (input.level !== undefined) createData.level = input.level ?? undefined;
    if (input.academicSession !== undefined) createData.academicSession = input.academicSession ?? undefined;
    if (input.studentType !== undefined) createData.studentType = input.studentType ?? undefined;
    if (input.entryMode !== undefined) createData.entryMode = input.entryMode ?? undefined;
    if (input.admissionYear !== undefined) createData.admissionYear = input.admissionYear ?? undefined;
    if (input.graduationYear !== undefined) createData.graduationYear = input.graduationYear ?? undefined;
    if (input.phoneNumber !== undefined) createData.phoneNumber = input.phoneNumber ?? undefined;
    if (input.address !== undefined) createData.address = input.address ?? undefined;
    if (opts?.importId !== undefined) createData.studentImportId = opts.importId;

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: createData,
        select: STUDENT_SELECT,
      });
      await tx.auditLog.create({
        data: {
          action: i18n.auditActions.studentCreated,
          entityType: 'USER',
          entityId: String(user.id),
          userId: actorId,
          oldValue: JSON_DB_NULL,
          newValue: {
            email: user.email,
            matricNumber: user.matricNumber,
            college: user.college,
            department: user.department,
            program: user.program,
            level: user.level,
            academicSession: user.academicSession,
            studentImportId: opts?.importId ?? null,
          } as any,
          ipAddress: opts?.ip,
          userAgent: opts?.userAgent,
        },
      });
      return user;
    });

    return created as Selected;
  }

  // ---------------------------------------------------------------------------
  // Get by id (returns 404 if not found OR not a STUDENT)
  // ---------------------------------------------------------------------------
  static async getById(id: number): Promise<Selected> {
    const user = await prisma.user.findFirst({
      where: { id, role: Role.STUDENT },
      select: STUDENT_SELECT,
    });
    if (!user) throw new AppError(i18n.errors.auth.userNotFound, 404);
    return user as unknown as Selected;
  }

  static async getByMatric(matric: string): Promise<Selected> {
    const user = await prisma.user.findFirst({
      where: { matricNumber: matric, role: Role.STUDENT },
      select: STUDENT_SELECT,
    });
    if (!user) throw new AppError(i18n.errors.auth.userNotFound, 404);
    return user as unknown as Selected;
  }

  // ---------------------------------------------------------------------------
  // Update (admin/bursary only; allows accountStatus changes)
  // ---------------------------------------------------------------------------
  static async update(
    id: number,
    input: UpdateStudentInput,
    actorId: number,
    opts?: { ip?: string; userAgent?: string },
  ): Promise<Selected> {
    const existing = await prisma.user.findFirst({
      where: { id, role: Role.STUDENT },
      select: STUDENT_SELECT,
    });
    if (!existing) throw new AppError(i18n.errors.auth.userNotFound, 404);

    if (input.email || input.matricNumber) {
      const dup = await prisma.user.findFirst({
        where: {
          id: { not: id },
          OR: [
            input.email ? { email: input.email } : undefined,
            input.matricNumber ? { matricNumber: input.matricNumber } : undefined,
          ].filter(Boolean) as any[],
        },
        select: { id: true },
      });
      if (dup) {
        throw new AppError(
          input.email
            ? i18n.errors.auth.emailExists
            : i18n.errors.auth.matricExists,
          400,
        );
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const patched = await tx.user.update({
        where: { id },
        data: input as Prisma.UserUpdateInput,
        select: STUDENT_SELECT,
      });
      await tx.auditLog.create({
        data: {
          action: i18n.auditActions.studentUpdated,
          entityType: 'USER',
          entityId: String(id),
          userId: actorId,
          oldValue: existing as unknown as Prisma.InputJsonValue,
          newValue: patched as unknown as Prisma.InputJsonValue,
          ipAddress: opts?.ip,
          userAgent: opts?.userAgent,
        },
      });
      return patched;
    });
    return updated as unknown as Selected;
  }

  // ---------------------------------------------------------------------------
  // Self-update (student edits their own contact info only)
  // Fields like matric, college, department, program, level, accountStatus
  // are forbidden from self-edits per §2 student-forbidden list.
  // ---------------------------------------------------------------------------
  static async selfUpdate(
    id: number,
    input: StudentSelfUpdateInput,
    opts?: { ip?: string; userAgent?: string },
  ): Promise<Selected> {
    const existing = await prisma.user.findFirst({
      where: { id, role: Role.STUDENT },
      select: STUDENT_SELECT,
    });
    if (!existing) throw new AppError(i18n.errors.auth.userNotFound, 404);

    const patch: Partial<User> = {};
    if (input.firstName !== undefined) patch.firstName = input.firstName;
    if (input.middleName !== undefined) patch.middleName = input.middleName ?? null;
    if (input.lastName !== undefined) patch.lastName = input.lastName;
    if (input.phoneNumber !== undefined) patch.phoneNumber = input.phoneNumber ?? null;
    if (input.address !== undefined) patch.address = input.address ?? null;

    if (input.email && input.email !== existing.email) {
      const dup = await prisma.user.findFirst({ where: { email: input.email, id: { not: id } }, select: { id: true } });
      if (dup) throw new AppError(i18n.errors.auth.emailExists, 400);
      patch.email = input.email;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const patched = await tx.user.update({ where: { id }, data: patch, select: STUDENT_SELECT });
      await tx.auditLog.create({
        data: {
          action: i18n.auditActions.studentUpdated,
          entityType: 'USER',
          entityId: String(id),
          userId: id,
          oldValue: {
            firstName: existing.firstName, middleName: existing.middleName,
            lastName: existing.lastName, phoneNumber: existing.phoneNumber,
            address: existing.address, email: existing.email,
          } as Prisma.InputJsonValue,
          newValue: {
            firstName: patched.firstName, middleName: patched.middleName,
            lastName: patched.lastName, phoneNumber: patched.phoneNumber,
            address: patched.address, email: patched.email,
          } as Prisma.InputJsonValue,
          ipAddress: opts?.ip,
          userAgent: opts?.userAgent,
        },
      });
      return patched;
    });
    return updated as unknown as Selected;
  }

  // ---------------------------------------------------------------------------
  // Delete is NEVER used for financial records per §36. Instead, "soft-delete"
  // via accountStatus = WITHDRAWN / GRADUATED. We expose setStatus here.
  // ---------------------------------------------------------------------------
  static async setAccountStatus(
    id: number,
    status: AccountStatus,
    actorId: number,
    opts?: { ip?: string; userAgent?: string },
  ): Promise<Selected> {
    const existing = await prisma.user.findFirst({ where: { id, role: Role.STUDENT }, select: STUDENT_SELECT });
    if (!existing) throw new AppError(i18n.errors.auth.userNotFound, 404);
    const updated = await prisma.$transaction(async (tx) => {
      const patched = await tx.user.update({ where: { id }, data: { accountStatus: status }, select: STUDENT_SELECT });
      await tx.auditLog.create({
        data: {
          action: i18n.auditActions.studentUpdated,
          entityType: 'USER',
          entityId: String(id),
          userId: actorId,
          oldValue: { accountStatus: existing.accountStatus } as Prisma.InputJsonValue,
          newValue: { accountStatus: status } as Prisma.InputJsonValue,
          ipAddress: opts?.ip, userAgent: opts?.userAgent,
        },
      });
      return patched;
    });
    return updated as unknown as Selected;
  }

  // ---------------------------------------------------------------------------
  // Reset a student's password (ADMIN only — used after bulk upload, or when
  // a student can't recover via OTP). Returns the generated password in the
  // response object so bursary can tell the student, but NEVER logs it.
  // ---------------------------------------------------------------------------
  static async resetPassword(
    id: number,
    actorId: number,
    opts?: { ip?: string; userAgent?: string; newPassword?: string },
  ): Promise<{ temporaryPassword: string }> {
    const existing = await prisma.user.findFirst({ where: { id, role: Role.STUDENT }, select: { id: true, matricNumber: true } });
    if (!existing) throw new AppError(i18n.errors.auth.userNotFound, 404);

    const temporaryPassword =
      opts?.newPassword ??
      (existing.matricNumber || Math.random().toString(36).slice(2, 12));
    const hash = await bcrypt.hash(temporaryPassword, 12);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { password: hash, failedLoginAttempts: 0, lockedUntil: null } });
      await tx.auditLog.create({
        data: {
          action: i18n.auditActions.passwordResetCompleted,
          entityType: 'USER', entityId: String(id), userId: actorId,
          oldValue: JSON_DB_NULL, newValue: { passwordChanged: true } as Prisma.InputJsonValue,
          ipAddress: opts?.ip, userAgent: opts?.userAgent,
        },
      });
    });

    return { temporaryPassword };
  }

  // ---------------------------------------------------------------------------
  // Search + filter
  // ---------------------------------------------------------------------------
  static async search(input: StudentQueryInput) {
    const { q, page, pageSize, sort, order, ...filters } = input;
    const skip = (page - 1) * pageSize;

    const where: any = { role: Role.STUDENT };
    if (filters.matricNumber) where.matricNumber = { contains: filters.matricNumber, mode: 'insensitive' };
    if (filters.college) where.college = { contains: filters.college, mode: 'insensitive' };
    if (filters.department) where.department = { contains: filters.department, mode: 'insensitive' };
    if (filters.program) where.program = { contains: filters.program, mode: 'insensitive' };
    if (filters.level !== undefined && filters.level !== null) where.level = filters.level;
    if (filters.academicSession) where.academicSession = { contains: filters.academicSession, mode: 'insensitive' };
    if (filters.studentType) where.studentType = filters.studentType;
    if (filters.accountStatus) where.accountStatus = filters.accountStatus;

    if (q) {
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { middleName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { matricNumber: { contains: q, mode: 'insensitive' } },
        { admissionNumber: { contains: q, mode: 'insensitive' } },
        { jambNumber: { contains: q, mode: 'insensitive' } },
        { phoneNumber: { contains: q, mode: 'insensitive' } },
      ];
    }

    const orderBy: any = [{ [sort]: order }];
    // matricNumber sorts alphabetically are fine for most sessions.

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: STUDENT_SELECT,
        skip,
        take: pageSize,
        orderBy,
      }),
      prisma.user.count({ where }),
    ]);

    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    return { items: items as unknown as Selected[], total, page, pageSize, pageCount };
  }
}
