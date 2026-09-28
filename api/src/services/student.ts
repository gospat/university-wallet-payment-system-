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
import crypto from 'crypto';
import { z } from 'zod';
import { dispatchEmail } from '../queues/emailQueue';

// ---------------------------------------------------------------------------
// Secure password generator — parity with frontend create-student widget.
// Guarantees at least 1 uppercase, 1 lowercase, 1 digit, 1 symbol; then
// fills remaining chars from combined pool + Fisher-Yates shuffled.
// NEVER use user-owned data (matric, email, names) as a password source —
// that made the previous reset implementation trivially guessable.
// ---------------------------------------------------------------------------
function generateStrongTemporaryPassword(length = 14): string {
  const uppers = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lowers = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const syms = '!@#$%^&*';
  const all = uppers + lowers + digits + syms;

  const pick = (pool: string): string => pool[crypto.randomInt(pool.length)];

  const chars = [pick(uppers), pick(lowers), pick(digits), pick(syms)];
  for (let i = 4; i < length; i++) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// -----------------------------------------------------------------------------
// Zod schemas (reused by routes for validateBody/validateQuery)
// -----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hierarchy resolvers — new simplified flow: caller sends programmeId /
// levelId / sessionId and the service writes human-readable display names
// (college / department / program / level / academicSession) into the user
// row by fetching the Programme / Level / Session rows.
//
// Legacy string fields (college / department / program / level as number /
// academicSession as string) are still accepted for backward compatibility
// (bulk uploads that send names, older front-end payloads). If both the id
// AND the legacy string are provided, the resolved display value from the id
// wins.
// ---------------------------------------------------------------------------
async function resolveProgrammeContext(
  input: Partial<CreateStudentInput>,
): Promise<{ program?: string | null; department?: string | null; college?: string | null }> {
  if (input.programmeId !== undefined && input.programmeId !== null) {
    const idNum = Number(input.programmeId);
    if (!Number.isNaN(idNum) && idNum > 0) {
      const row = await prisma.programme.findFirst({
        where: { id: idNum },
        select: {
          name: true,
          department: {
            select: { name: true, faculty: { select: { name: true } } },
          },
        },
      });
      if (row) {
        return {
          program: row.name,
          department: row.department?.name ?? null,
          college: row.department?.faculty?.name ?? null,
        };
      }
    }
  }
  return {
    program: input.program ?? undefined,
    department: input.department ?? undefined,
    college: input.college ?? undefined,
  };
}

async function resolveLevelDisplay(input: Partial<CreateStudentInput>): Promise<number | null | undefined> {
  if (input.levelId !== undefined && input.levelId !== null) {
    const idNum = Number(input.levelId);
    if (!Number.isNaN(idNum) && idNum > 0) {
      const row = await prisma.level.findFirst({ where: { id: idNum }, select: { level: true } });
      if (row) return Number(row.level);
    }
  }
  if (input.level === undefined || input.level === null) return undefined;
  const n = Number(input.level);
  return Number.isNaN(n) ? null : n;
}

async function resolveSessionDisplay(input: Partial<CreateStudentInput>): Promise<string | null | undefined> {
  if (input.academicSessionId !== undefined && input.academicSessionId !== null) {
    const idNum = Number(input.academicSessionId);
    if (!Number.isNaN(idNum) && idNum > 0) {
      const row = await prisma.academicSession.findFirst({ where: { id: idNum }, select: { name: true } });
      if (row) return row.name;
    }
  }
  return input.academicSession ?? undefined;
}

// ProgrammeId / LevelId / AcademicSessionId accepted but not listed in the
// Zod strict keys because they were not originally required. For this pass we
// accept them via `.passthrough()` and consume them inside the service via
// type assertion.
const optStr = (max: number, min = 0) =>
  z.preprocess(
    (v) => {
      if (v === null || v === undefined) return undefined;
      const s = typeof v === 'string' ? v.trim() : String(v).trim();
      return s.length === 0 ? undefined : s;
    },
    min > 0 ? z.string().min(min).max(max).optional() : z.string().max(max).optional(),
  );
const optStrNullable = (max: number, min = 0) =>
  z.preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      const s = typeof v === 'string' ? v.trim() : String(v).trim();
      return s.length === 0 ? null : s;
    },
    (min > 0
      ? z.string().min(min).max(max).nullable().optional()
      : z.string().max(max).nullable().optional()) as any,
  );
const optEnumNullable = <T extends [string, ...string[]]>(t: T) =>
  z.preprocess(
    (v) => {
      if (v === null || v === undefined) return null;
      const s = typeof v === 'string' ? v.trim() : String(v).trim();
      return s.length === 0 ? null : s;
    },
    z.enum(t).nullable().optional(),
  );
const optYearNullable = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  },
  z.number().int().min(1990).max(2100).nullable().optional(),
);

export const CreateStudentSchema = z.object({
  email: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() : String(v ?? '').trim().toLowerCase()),
    z.string().email().max(255),
  ),
  firstName: z.preprocess((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()), z.string().min(1).max(80)),
  middleName: optStrNullable(80),
  lastName: z.preprocess((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()), z.string().min(1).max(80)),
  matricNumber: z.preprocess((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()), z.string().min(3).max(50)),
  admissionNumber: optStrNullable(50),
  jambNumber: optStrNullable(50),
  college: optStrNullable(120, 2),
  department: optStrNullable(120, 2),
  program: optStrNullable(120, 2),
  level: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .optional()
    .nullable()
    .superRefine((val, ctx) => {
      if (val === undefined || val === null || val === '') return;
      const stripped = String(val)
        .toLowerCase()
        .replace(/\s*level\s*$/i, '')
        .replace(/[^0-9-]/g, '')
        .trim();
      const n = Number(stripped);
      if (stripped === '' || Number.isNaN(n) || !Number.isInteger(n) || n < 100 || n > 1000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'level must be an integer between 100 and 1000 (e.g. 100, 200, or "300 Level")',
        });
      }
    })
    .transform((val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const stripped = String(val)
        .toLowerCase()
        .replace(/\s*level\s*$/i, '')
        .replace(/[^0-9-]/g, '')
        .trim();
      const n = Number(stripped);
      if (stripped === '' || Number.isNaN(n) || !Number.isInteger(n) || n < 100 || n > 1000) return undefined;
      return n;
    }),
  academicSession: optStrNullable(20),
  studentType: optEnumNullable(['UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER']),
  entryMode: optEnumNullable(['UTME', 'DIRECT_ENTRY', 'TRANSFER', 'OTHER']),
  admissionYear: optYearNullable,
  graduationYear: optYearNullable,
  phoneNumber: optStrNullable(30),
  address: optStrNullable(500),
  password: z.preprocess(
    (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : String(v)),
    z.string().min(8).max(128).optional(),
  ),
}).passthrough();
export type CreateStudentInput = z.infer<typeof CreateStudentSchema> & {
  programmeId?: number | string | null;
  levelId?: number | string | null;
  academicSessionId?: number | string | null;
};

export const UpdateStudentSchema = CreateStudentSchema.partial().extend({
  accountStatus: z.enum(['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN']).optional(),
});
export type UpdateStudentInput = z.infer<typeof UpdateStudentSchema> & {
  programmeId?: number | string | null;
  levelId?: number | string | null;
  academicSessionId?: number | string | null;
};

export const StudentSelfUpdateSchema = z.object({
  firstName: z.string().min(1).max(80).trim().optional(),
  middleName: z.string().max(80).trim().optional().nullable(),
  lastName: z.string().min(1).max(80).trim().optional(),
  phoneNumber: z.string().max(30).trim().optional().nullable(),
  address: z.string().max(500).trim().optional().nullable(),
  email: z.string().trim().max(255).email().optional(),
});
export type StudentSelfUpdateInput = z.infer<typeof StudentSelfUpdateSchema>;

export const StudentQuerySchema = z.object({
  q: z.string().max(200).trim().optional(),
  matricNumber: z.string().max(50).trim().optional(),
  college: z.string().max(120).trim().optional(),
  department: z.string().max(120).trim().optional(),
  program: z.string().max(120).trim().optional(),
  level: z.coerce.number().int().optional(),
  academicSession: z.string().max(20).trim().optional(),
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
  static async create<T extends { ip?: string; userAgent?: string; importId?: number; sendCredentialEmail?: boolean; returnPlaintextPassword?: boolean }>(
    input: CreateStudentInput,
    actorId: number,
    opts?: T,
  ): Promise<T['returnPlaintextPassword'] extends true ? { user: Selected; temporaryPasswordPlaintext: string } : Selected> {
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

    // ---- hierarchy resolution (programmeId → dept + college) ----------------
    const [hierarchy, resolvedLevel, resolvedSession] = await Promise.all([
      resolveProgrammeContext(input),
      resolveLevelDisplay(input),
      resolveSessionDisplay(input),
    ]);

    // ---- defensive: if caller sent an id, it must resolve; otherwise 400 ----
    const pIdNum = input.programmeId !== undefined && input.programmeId !== null ? Number(input.programmeId) : NaN;
    if (!Number.isNaN(pIdNum) && pIdNum > 0 && !hierarchy.program) {
      throw new AppError(i18n.errors.students.invalidProgrammeId, 400);
    }
    const lIdNum = input.levelId !== undefined && input.levelId !== null ? Number(input.levelId) : NaN;
    if (!Number.isNaN(lIdNum) && lIdNum > 0 && resolvedLevel === undefined) {
      throw new AppError(i18n.errors.students.invalidLevelId, 400);
    }
    const sIdNum = input.academicSessionId !== undefined && input.academicSessionId !== null ? Number(input.academicSessionId) : NaN;
    if (!Number.isNaN(sIdNum) && sIdNum > 0 && resolvedSession === undefined) {
      throw new AppError(i18n.errors.students.invalidSessionId, 400);
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
    if (hierarchy.college !== undefined) createData.college = hierarchy.college ?? undefined;
    if (hierarchy.department !== undefined) createData.department = hierarchy.department ?? undefined;
    if (hierarchy.program !== undefined) createData.program = hierarchy.program ?? undefined;
    if (resolvedLevel !== undefined) createData.level = resolvedLevel ?? undefined;
    if (resolvedSession !== undefined) createData.academicSession = resolvedSession ?? undefined;
    if (input.studentType !== undefined) createData.studentType = (input.studentType ?? undefined) as any;
    if (input.entryMode !== undefined) createData.entryMode = (input.entryMode ?? undefined) as any;
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

    if (opts?.sendCredentialEmail !== false) {
      try {
        const firstName = (created as any).firstName || '';
        const lastName = (created as any).lastName || '';
        const studentName = `${firstName} ${lastName}`.trim() || 'Student';
        void dispatchEmail({
          emailType: 'student_credentials',
          recipientId: (created as any).id,
          reference: `user:${(created as any).id}`,
          to: (created as any).email,
          triggeredByAdminId: actorId,
          studentImportId: opts?.importId,
          idempotencyKey: `student-credentials:userId:${(created as any).id}:${Date.now()}`,
          payload: {
            userId: (created as any).id,
            firstName,
            lastName,
            studentName,
            matricNumber: (created as any).matricNumber || '',
            email: (created as any).email,
            temporaryPassword: pwd,
          },
        });
      } catch (dispatchErr: any) {
        try {
          console.warn('[StudentService.create] credential email dispatch failed (non-fatal):', dispatchErr?.message?.slice(0, 200));
        } catch { /* mute */ }
      }
    }

    if (opts?.returnPlaintextPassword === true) {
      return { user: created as Selected, temporaryPasswordPlaintext: pwd } as any;
    }
    return created as any;
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
    const trimmed = String(matric ?? '').trim();
    if (!trimmed) throw new AppError(i18n.errors.auth.userNotFound, 404);
    const user = await prisma.user.findFirst({
      where: {
        role: Role.STUDENT,
        OR: [
          { matricNumber: trimmed },
          { matricNumber: trimmed.toLowerCase() },
          { matricNumber: trimmed.toUpperCase() },
        ],
      },
      select: STUDENT_SELECT,
    });
    if (!user) throw new AppError(i18n.errors.auth.matricNotFound(trimmed), 404);
    if (user.accountStatus !== AccountStatus.ACTIVE) {
      const msg =
        user.accountStatus === AccountStatus.SUSPENDED
          ? i18n.errors.auth.accountSuspended
          : user.accountStatus === AccountStatus.GRADUATED
            ? i18n.errors.auth.accountGraduated
            : i18n.errors.auth.accountInactive;
      throw new AppError(msg, 400);
    }
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

    // ---- hierarchy resolution if any id-based field changed -------------
    const patchData: Prisma.UserUpdateInput = { ...(input as Prisma.UserUpdateInput) };
    if (
      input.programmeId !== undefined ||
      input.levelId !== undefined ||
      input.academicSessionId !== undefined ||
      input.college !== undefined ||
      input.department !== undefined ||
      input.program !== undefined ||
      input.level !== undefined ||
      input.academicSession !== undefined
    ) {
      const [hierarchy, resolvedLevel, resolvedSession] = await Promise.all([
        resolveProgrammeContext(input),
        resolveLevelDisplay(input),
        resolveSessionDisplay(input),
      ]);
      const pIdNum = input.programmeId !== undefined && input.programmeId !== null ? Number(input.programmeId) : NaN;
      if (!Number.isNaN(pIdNum) && pIdNum > 0 && !hierarchy.program) {
        throw new AppError(i18n.errors.students.invalidProgrammeId, 400);
      }
      const lIdNum = input.levelId !== undefined && input.levelId !== null ? Number(input.levelId) : NaN;
      if (!Number.isNaN(lIdNum) && lIdNum > 0 && resolvedLevel === undefined) {
        throw new AppError(i18n.errors.students.invalidLevelId, 400);
      }
      const sIdNum = input.academicSessionId !== undefined && input.academicSessionId !== null ? Number(input.academicSessionId) : NaN;
      if (!Number.isNaN(sIdNum) && sIdNum > 0 && resolvedSession === undefined) {
        throw new AppError(i18n.errors.students.invalidSessionId, 400);
      }
      if (hierarchy.college !== undefined) patchData.college = hierarchy.college ?? null;
      if (hierarchy.department !== undefined) patchData.department = hierarchy.department ?? null;
      if (hierarchy.program !== undefined) patchData.program = hierarchy.program ?? null;
      if (resolvedLevel !== undefined) patchData.level = resolvedLevel ?? null;
      if (resolvedSession !== undefined) patchData.academicSession = resolvedSession ?? null;
    }
    // Strip id-based fields from the final update patch since they are not real DB columns.
    delete (patchData as any).programmeId;
    delete (patchData as any).levelId;
    delete (patchData as any).academicSessionId;

    const updated = await prisma.$transaction(async (tx) => {
      const patched = await tx.user.update({
        where: { id },
        data: patchData,
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

    const temporaryPassword = opts?.newPassword ?? generateStrongTemporaryPassword(14);
    const hash = await bcrypt.hash(temporaryPassword, 12);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          password: hash,
          failedLoginAttempts: 0,
          lockedUntil: null,
          mustChangePassword: true,
        },
      });
      await tx.auditLog.create({
        data: {
          action: i18n.auditActions.passwordResetCompleted,
          entityType: 'USER', entityId: String(id), userId: actorId,
          oldValue: JSON_DB_NULL, newValue: { passwordChanged: true, mustChangePassword: true } as Prisma.InputJsonValue,
          ipAddress: opts?.ip, userAgent: opts?.userAgent,
        },
      });
    });

    return { temporaryPassword };
  }

  // ---------------------------------------------------------------------------
  // Send credential email (with optional password reset) — ADMIN resend flow
  // If forcePasswordReset=true → resets password first, MUST be set MUST_CHANGE=true
  // Always dispatches student_credentials email; returns non-throwing dispatcher.
  // ---------------------------------------------------------------------------
  static async sendCredentialEmail(
    id: number,
    actorId: number,
    opts?: { forcePasswordReset?: boolean; ip?: string; userAgent?: string },
  ): Promise<{ id: number; temporaryPassword: string }> {
    let temporaryPassword: string;
    const existing = await prisma.user.findFirst({
      where: { id, role: Role.STUDENT },
      select: { id: true, email: true, matricNumber: true, firstName: true, lastName: true },
    });
    if (!existing) throw new AppError(i18n.errors.auth.userNotFound, 404);
    if (opts?.forcePasswordReset !== false) {
      const r = await this.resetPassword(id, actorId, { ip: opts?.ip, userAgent: opts?.userAgent });
      temporaryPassword = r.temporaryPassword;
    } else {
      // Not resetting — we don't know the existing hash, so still reset defensively.
      // Passwords can never be recovered from bcrypt hash, so a reset is mandatory for resend.
      const r = await this.resetPassword(id, actorId, { ip: opts?.ip, userAgent: opts?.userAgent });
      temporaryPassword = r.temporaryPassword;
    }
    try {
      const user = existing;
      const studentName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Student';
      void dispatchEmail({
        emailType: 'student_credentials',
        recipientId: id,
        reference: `user:${id}:resend`,
        to: user.email || '',
        triggeredByAdminId: actorId,
        idempotencyKey: `student-credentials:userId:${id}:resend:${Date.now()}`,
        payload: {
          userId: id,
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          studentName,
          matricNumber: user.matricNumber || '',
          email: user.email || '',
          temporaryPassword,
        },
      });
    } catch (e: any) {
      try { console.warn('[StudentService.sendCredentialEmail] dispatch failed (non-fatal):', e?.message?.slice(0, 200)); } catch {}
    }
    return { id, temporaryPassword };
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
