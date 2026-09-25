import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import type { Request } from 'express';
import { auditActions } from '../i18n/en';

const JSON_DB_NULL = Prisma.JsonNull;

type ReqLike = Pick<Request, 'user'> & Partial<Pick<Request, 'ip'>> & { headers?: Record<string, any> };

type AuditEntityType = 'FACULTY' | 'DEPARTMENT' | 'PROGRAMME' | 'LEVEL' | 'ACADEMIC_SESSION';

async function writeAudit(
  req: ReqLike | undefined,
  data: { action: string; entityType: AuditEntityType; entityId: string | number; oldValue?: any; newValue?: any }
) {
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

type ListParams = { search?: string; page?: number; limit?: number; isActive?: boolean };
type ListResult<T> = { rows: T[]; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean };

function paginate<T>(rows: T[], total: number, page: number, limit: number): ListResult<T> {
  const totalPages = Math.ceil(total / limit);
  return {
    rows,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

// --- tolerant zod wrappers (empty string → undefined, same pattern as fee.ts) ---
const optStr = (max: number, min = 0) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : v === null || v === undefined ? undefined : String(v).trim() || undefined),
    min > 0 ? z.string().min(min).max(max).trim().optional() : z.string().max(max).trim().optional(),
  );
const optEmail = (max = 150) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim().toLowerCase()) : undefined),
    z.string().email().max(max).optional(),
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
const posInt = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v)) : v),
  z.number().int().positive(),
);
const posIntOpt = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : Number(v)),
  z.number().int().positive().optional(),
);
const posIntOrNull = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string' && v.trim() === '') return null;
    return Number(v);
  },
  z.union([z.number().int().positive(), z.null()]).optional(),
);

export const CreateFacultySchema = z.object({
  name: z.preprocess((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()), z.string().min(2).max(150)),
  code: optStr(30, 1),
  deanEmail: optEmail(150),
  isActive: optBool,
});
export const UpdateFacultySchema = CreateFacultySchema.partial();
export type CreateFacultyInput = z.infer<typeof CreateFacultySchema>;
export type UpdateFacultyInput = z.infer<typeof UpdateFacultySchema>;

export const CreateDepartmentSchema = z.object({
  name: z.preprocess((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()), z.string().min(2).max(150)),
  code: optStr(30, 1),
  facultyId: posInt,
  headEmail: optEmail(150),
  isActive: optBool,
});
export const UpdateDepartmentSchema = CreateDepartmentSchema.partial().omit({ facultyId: true }).extend({
  facultyId: posIntOpt,
});
export type CreateDepartmentInput = z.infer<typeof CreateDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof UpdateDepartmentSchema>;

export const CreateProgrammeSchema = z.object({
  name: z.preprocess((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()), z.string().min(2).max(150)),
  code: optStr(30, 1),
  departmentId: posInt,
  durationYears: z.preprocess(
    (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? 4 : Number(v)),
    z.number().int().positive().max(20).default(4).optional(),
  ),
  coordinatorEmail: optEmail(150),
  isActive: optBool,
});
export const UpdateProgrammeSchema = CreateProgrammeSchema.partial().omit({ departmentId: true }).extend({
  departmentId: posIntOpt,
});
export type CreateProgrammeInput = z.infer<typeof CreateProgrammeSchema>;
export type UpdateProgrammeInput = z.infer<typeof UpdateProgrammeSchema>;

export const CreateLevelSchema = z.object({
  level: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v)),
    z.string().min(1).max(20).trim(),
  ),
  programmeId: posIntOrNull,
  isActive: optBool,
});
export const UpdateLevelSchema = CreateLevelSchema.partial().extend({
  programmeId: posIntOrNull,
});
export type CreateLevelInput = z.infer<typeof CreateLevelSchema>;
export type UpdateLevelInput = z.infer<typeof UpdateLevelSchema>;

export const CreateAcademicSessionSchema = z.object({
  name: z.preprocess((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()), z.string().min(4).max(20)),
  startDate: z.preprocess(
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
  endDate: z.preprocess(
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
export const UpdateAcademicSessionSchema = CreateAcademicSessionSchema.partial();
export type CreateAcademicSessionInput = z.infer<typeof CreateAcademicSessionSchema>;
export type UpdateAcademicSessionInput = z.infer<typeof UpdateAcademicSessionSchema>;

export const ListQuerySchema = z.object({
  search: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : undefined),
    z.string().max(200).optional(),
  ),
  page: z.coerce.number().int().positive().default(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(25).optional(),
  isActive: z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]).optional(),
});

const FACULTY_SELECT = {
  id: true, name: true, code: true, deanEmail: true, isActive: true, createdAt: true, updatedAt: true,
} as const;

const DEPARTMENT_SELECT = {
  id: true, name: true, code: true, facultyId: true, headEmail: true, isActive: true, createdAt: true, updatedAt: true,
  faculty: { select: { id: true, name: true, code: true } },
} as const;

const PROGRAMME_SELECT = {
  id: true, name: true, code: true, departmentId: true, durationYears: true, coordinatorEmail: true, isActive: true, createdAt: true, updatedAt: true,
  department: { select: { id: true, name: true, code: true, faculty: { select: { id: true, name: true } } } },
} as const;

const LEVEL_SELECT = {
  id: true, level: true, programmeId: true, isActive: true, createdAt: true, updatedAt: true,
  programme: { select: { id: true, name: true, code: true, department: { select: { id: true, name: true, faculty: { select: { id: true, name: true } } } } } },
} as const;

const SESSION_SELECT = {
  id: true, name: true, startDate: true, endDate: true, isActive: true, createdAt: true, updatedAt: true,
} as const;

// -----------------------------------------------------------------------------
// FacultyService
// -----------------------------------------------------------------------------
export class FacultyService {
  static async list(params: ListParams = {}): Promise<ListResult<any>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 25;
    const skip = (page - 1) * limit;

    const where: Prisma.FacultyWhereInput = {};
    if (params.search) {
      where.OR = [
        { name: { contains: params.search } },
        { code: { contains: params.search } },
      ];
    }
    if (params.isActive !== undefined) where.isActive = params.isActive;

    const [rows, total] = await Promise.all([
      prisma.faculty.findMany({ where, select: FACULTY_SELECT as any, skip, take: limit, orderBy: { name: 'asc' } }),
      prisma.faculty.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  static async get(id: number) {
    const row = await prisma.faculty.findFirst({ where: { id }, select: FACULTY_SELECT as any });
    if (!row) throw new AppError('Faculty not found', 404);
    return row;
  }

  static async create(data: CreateFacultyInput, req?: ReqLike) {
    try {
      const payload: Prisma.FacultyCreateInput = {
        name: data.name,
        code: data.code ?? null,
        deanEmail: data.deanEmail ?? null,
        isActive: data.isActive ?? true,
      };
      const created: any = await prisma.faculty.create({ data: payload, select: FACULTY_SELECT as any });
      await writeAudit(req, { action: auditActions.facultyCreated, entityType: 'FACULTY', entityId: created.id, newValue: created });
      return created;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : 'name';
        if (target.includes('code')) throw new AppError('A faculty with this code already exists', 400);
        throw new AppError('A faculty with this name already exists', 400);
      }
      throw err;
    }
  }

  static async update(id: number, data: UpdateFacultyInput, req?: ReqLike) {
    const existing = await prisma.faculty.findFirst({ where: { id } });
    if (!existing) throw new AppError('Faculty not found', 404);

    const payload: Prisma.FacultyUpdateInput = {};
    if (data.name !== undefined) payload.name = data.name;
    if (data.code !== undefined) payload.code = data.code ?? null;
    if (data.deanEmail !== undefined) payload.deanEmail = data.deanEmail ?? null;
    if (data.isActive !== undefined) payload.isActive = data.isActive;

    try {
      const updated = await prisma.faculty.update({ where: { id }, data: payload, select: FACULTY_SELECT as any });
      await writeAudit(req, { action: auditActions.facultyUpdated, entityType: 'FACULTY', entityId: id, oldValue: existing, newValue: updated });
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : 'name';
        if (target.includes('code')) throw new AppError('A faculty with this code already exists', 400);
        throw new AppError('A faculty with this name already exists', 400);
      }
      throw err;
    }
  }

  static async deactivate(id: number, req?: ReqLike) {
    const existing = await prisma.faculty.findFirst({
      where: { id },
      include: { _count: { select: { departments: { where: { isActive: true } } } } },
    });
    if (!existing) throw new AppError('Faculty not found', 404);
    const activeChildren = (existing as any)._count.departments;
    if (activeChildren > 0) {
      throw new AppError(`Cannot deactivate Faculty because it is still referenced by ${activeChildren} active Department(s)`, 400);
    }
    const updated = await prisma.faculty.update({ where: { id }, data: { isActive: false }, select: FACULTY_SELECT as any });
    await writeAudit(req, { action: auditActions.facultyDeactivated, entityType: 'FACULTY', entityId: id, oldValue: existing, newValue: updated });
    return updated;
  }

  static async remove(id: number, req?: ReqLike) {
    const existing = await prisma.faculty.findFirst({
      where: { id },
      include: {
        _count: {
          select: {
            departments: true,
          },
        },
      },
    });
    if (!existing) throw new AppError('College not found', 404);

    const [students, fees] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT', facultyId: id } }),
      prisma.fee.count({ where: { facultyId: id } }),
    ]);
    const references: string[] = [];
    const deptCount = (existing as any)._count.departments;
    if (deptCount > 0) references.push(`${deptCount} department(s)`);
    if (students > 0) references.push(`${students} student(s)`);
    if (fees > 0) references.push(`${fees} fee catalogue item(s)`);
    if (references.length > 0) {
      throw new AppError(
        `Cannot delete this College: it is still referenced by — ${references.join(', ')}. ` +
        `Please remove, reassign, or deactivate those records first (or use Deactivate to soft-delete instead).`,
        409,
      );
    }
    const deleted = await prisma.faculty.delete({ where: { id }, select: { id: true, name: true, code: true } });
    await writeAudit(req, { action: auditActions.facultyDeleted, entityType: 'FACULTY', entityId: id, oldValue: existing });
    return { deleted };
  }
}

// -----------------------------------------------------------------------------
// DepartmentService
// -----------------------------------------------------------------------------
export class DepartmentService {
  static async list(params: ListParams = {}): Promise<ListResult<any>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 25;
    const skip = (page - 1) * limit;

    const where: Prisma.DepartmentWhereInput = {};
    if (params.search) {
      where.OR = [
        { name: { contains: params.search } },
        { code: { contains: params.search } },
      ] as any;
    }
    if (params.isActive !== undefined) where.isActive = params.isActive;

    const [rows, total] = await Promise.all([
      prisma.department.findMany({ where, select: DEPARTMENT_SELECT as any, skip, take: limit, orderBy: { name: 'asc' } }),
      prisma.department.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  static async get(id: number) {
    const row = await prisma.department.findFirst({ where: { id }, select: DEPARTMENT_SELECT as any });
    if (!row) throw new AppError('Department not found', 404);
    return row;
  }

  static async create(data: CreateDepartmentInput, req?: ReqLike) {
    const faculty = await prisma.faculty.findFirst({ where: { id: data.facultyId } });
    if (!faculty) throw new AppError('Referenced faculty does not exist', 400);

    try {
      const payload: Prisma.DepartmentCreateInput = {
        name: data.name,
        code: data.code ?? null,
        headEmail: data.headEmail ?? null,
        isActive: data.isActive ?? true,
        faculty: { connect: { id: data.facultyId } },
      };
      const created: any = await prisma.department.create({ data: payload, select: DEPARTMENT_SELECT as any });
      await writeAudit(req, { action: auditActions.departmentCreated, entityType: 'DEPARTMENT', entityId: created.id, newValue: created });
      return created;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new AppError('A department with this name already exists under the selected faculty', 400);
      }
      throw err;
    }
  }

  static async update(id: number, data: UpdateDepartmentInput, req?: ReqLike) {
    const existing = await prisma.department.findFirst({ where: { id } });
    if (!existing) throw new AppError('Department not found', 404);

    if (data.facultyId !== undefined) {
      const faculty = await prisma.faculty.findFirst({ where: { id: data.facultyId } });
      if (!faculty) throw new AppError('Referenced faculty does not exist', 400);
    }

    const payload: Prisma.DepartmentUpdateInput = {};
    if (data.name !== undefined) payload.name = data.name;
    if (data.code !== undefined) payload.code = data.code ?? null;
    if (data.headEmail !== undefined) payload.headEmail = data.headEmail ?? null;
    if (data.isActive !== undefined) payload.isActive = data.isActive;
    if (data.facultyId !== undefined) payload.faculty = { connect: { id: data.facultyId } };

    try {
      const updated = await prisma.department.update({ where: { id }, data: payload, select: DEPARTMENT_SELECT as any });
      await writeAudit(req, { action: auditActions.departmentUpdated, entityType: 'DEPARTMENT', entityId: id, oldValue: existing, newValue: updated });
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new AppError('A department with this name already exists under the selected faculty', 400);
      }
      throw err;
    }
  }

  static async deactivate(id: number, req?: ReqLike) {
    const existing = await prisma.department.findFirst({
      where: { id },
      include: { _count: { select: { programmes: { where: { isActive: true } } } } },
    });
    if (!existing) throw new AppError('Department not found', 404);
    const activeChildren = (existing as any)._count.programmes;
    if (activeChildren > 0) {
      throw new AppError(`Cannot deactivate Department because it is still referenced by ${activeChildren} active Programme(s)`, 400);
    }
    const updated = await prisma.department.update({ where: { id }, data: { isActive: false }, select: DEPARTMENT_SELECT as any });
    await writeAudit(req, { action: auditActions.departmentDeactivated, entityType: 'DEPARTMENT', entityId: id, oldValue: existing, newValue: updated });
    return updated;
  }

  static async remove(id: number, req?: ReqLike) {
    const existing = await prisma.department.findFirst({
      where: { id },
      include: { _count: { select: { programmes: true } } },
    });
    if (!existing) throw new AppError('Department not found', 404);

    const [students, fees] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT', departmentId: id } }),
      prisma.fee.count({ where: { departmentId: id } }),
    ]);
    const references: string[] = [];
    const progCount = (existing as any)._count.programmes;
    if (progCount > 0) references.push(`${progCount} programme(s)`);
    if (students > 0) references.push(`${students} student(s)`);
    if (fees > 0) references.push(`${fees} fee catalogue item(s)`);
    if (references.length > 0) {
      throw new AppError(
        `Cannot delete this Department: it is still referenced by — ${references.join(', ')}. ` +
        `Please remove, reassign, or deactivate those records first (or use Deactivate to soft-delete instead).`,
        409,
      );
    }
    const deleted = await prisma.department.delete({ where: { id }, select: { id: true, name: true, code: true } });
    await writeAudit(req, { action: auditActions.departmentDeleted, entityType: 'DEPARTMENT', entityId: id, oldValue: existing });
    return { deleted };
  }
}

// -----------------------------------------------------------------------------
// ProgrammeService
// -----------------------------------------------------------------------------
export class ProgrammeService {
  static async list(params: ListParams = {}): Promise<ListResult<any>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 25;
    const skip = (page - 1) * limit;

    const where: Prisma.ProgrammeWhereInput = {};
    if (params.search) {
      where.OR = [
        { name: { contains: params.search } },
        { code: { contains: params.search } },
      ] as any;
    }
    if (params.isActive !== undefined) where.isActive = params.isActive;

    const [rows, total] = await Promise.all([
      prisma.programme.findMany({ where, select: PROGRAMME_SELECT as any, skip, take: limit, orderBy: { name: 'asc' } }),
      prisma.programme.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  static async get(id: number) {
    const row = await prisma.programme.findFirst({ where: { id }, select: PROGRAMME_SELECT as any });
    if (!row) throw new AppError('Programme not found', 404);
    return row;
  }

  static async create(data: CreateProgrammeInput, req?: ReqLike) {
    const dept = await prisma.department.findFirst({ where: { id: data.departmentId } });
    if (!dept) throw new AppError('Referenced department does not exist', 400);

    try {
      const payload: Prisma.ProgrammeCreateInput = {
        name: data.name,
        code: data.code ?? null,
        durationYears: data.durationYears ?? 4,
        coordinatorEmail: data.coordinatorEmail ?? null,
        isActive: data.isActive ?? true,
        department: { connect: { id: data.departmentId } },
      };
      const created: any = await prisma.programme.create({ data: payload, select: PROGRAMME_SELECT as any });
      await writeAudit(req, { action: auditActions.programmeCreated, entityType: 'PROGRAMME', entityId: created.id, newValue: created });
      return created;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new AppError('A programme with this name already exists under the selected department', 400);
      }
      throw err;
    }
  }

  static async update(id: number, data: UpdateProgrammeInput, req?: ReqLike) {
    const existing = await prisma.programme.findFirst({ where: { id } });
    if (!existing) throw new AppError('Programme not found', 404);

    if (data.departmentId !== undefined) {
      const dept = await prisma.department.findFirst({ where: { id: data.departmentId } });
      if (!dept) throw new AppError('Referenced department does not exist', 400);
    }

    const payload: Prisma.ProgrammeUpdateInput = {};
    if (data.name !== undefined) payload.name = data.name;
    if (data.code !== undefined) payload.code = data.code ?? null;
    if (data.durationYears !== undefined) payload.durationYears = data.durationYears;
    if (data.coordinatorEmail !== undefined) payload.coordinatorEmail = data.coordinatorEmail ?? null;
    if (data.isActive !== undefined) payload.isActive = data.isActive;
    if (data.departmentId !== undefined) payload.department = { connect: { id: data.departmentId } };

    try {
      const updated = await prisma.programme.update({ where: { id }, data: payload, select: PROGRAMME_SELECT as any });
      await writeAudit(req, { action: auditActions.programmeUpdated, entityType: 'PROGRAMME', entityId: id, oldValue: existing, newValue: updated });
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new AppError('A programme with this name already exists under the selected department', 400);
      }
      throw err;
    }
  }

  static async deactivate(id: number, req?: ReqLike) {
    const existing = await prisma.programme.findFirst({
      where: { id },
      include: { _count: { select: { levels: { where: { isActive: true } } } } },
    });
    if (!existing) throw new AppError('Programme not found', 404);
    const activeChildren = (existing as any)._count.levels;
    if (activeChildren > 0) {
      throw new AppError(`Cannot deactivate Programme because it is still referenced by ${activeChildren} active Level(s)`, 400);
    }
    const updated = await prisma.programme.update({ where: { id }, data: { isActive: false }, select: PROGRAMME_SELECT as any });
    await writeAudit(req, { action: auditActions.programmeDeactivated, entityType: 'PROGRAMME', entityId: id, oldValue: existing, newValue: updated });
    return updated;
  }

  static async remove(id: number, req?: ReqLike) {
    const existing = await prisma.programme.findFirst({
      where: { id },
      include: { _count: { select: { levels: true } } },
    });
    if (!existing) throw new AppError('Programme not found', 404);

    const [students, fees] = await Promise.all([
      prisma.user.count({ where: { role: 'STUDENT', programmeId: id } }),
      prisma.fee.count({ where: { programmeId: id } }),
    ]);
    const references: string[] = [];
    const levelCount = (existing as any)._count.levels;
    if (levelCount > 0) references.push(`${levelCount} level(s)`);
    if (students > 0) references.push(`${students} student(s)`);
    if (fees > 0) references.push(`${fees} fee catalogue item(s)`);
    if (references.length > 0) {
      throw new AppError(
        `Cannot delete this Programme: it is still referenced by — ${references.join(', ')}. ` +
        `Please remove, reassign, or deactivate those records first (or use Deactivate to soft-delete instead).`,
        409,
      );
    }
    const deleted = await prisma.programme.delete({ where: { id }, select: { id: true, name: true, code: true } });
    await writeAudit(req, { action: auditActions.programmeDeleted, entityType: 'PROGRAMME', entityId: id, oldValue: existing });
    return { deleted };
  }
}

// -----------------------------------------------------------------------------
// LevelService
// -----------------------------------------------------------------------------
export class LevelService {
  static async list(params: ListParams = {}): Promise<ListResult<any>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 25;
    const skip = (page - 1) * limit;

    const where: Prisma.LevelWhereInput = {};
    if (params.search) {
      where.OR = [
        { level: { contains: params.search } },
      ];
    }
    if (params.isActive !== undefined) where.isActive = params.isActive;

    const [rows, total] = await Promise.all([
      prisma.level.findMany({ where, select: LEVEL_SELECT as any, skip, take: limit, orderBy: { level: 'asc' } }),
      prisma.level.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  static async get(id: number) {
    const row = await prisma.level.findFirst({ where: { id }, select: LEVEL_SELECT as any });
    if (!row) throw new AppError('Level not found', 404);
    return row;
  }

  static async create(data: CreateLevelInput, req?: ReqLike) {
    if (data.programmeId !== undefined && data.programmeId !== null) {
      const prog = await prisma.programme.findFirst({ where: { id: data.programmeId } });
      if (!prog) throw new AppError('Referenced programme does not exist', 400);
    }

    try {
      const payload: Prisma.LevelCreateInput = {
        level: data.level,
        isActive: data.isActive ?? true,
      };
      if (data.programmeId !== undefined && data.programmeId !== null) {
        payload.programme = { connect: { id: data.programmeId } };
      }
      const created = await prisma.level.create({ data: payload, select: LEVEL_SELECT as any });
      await writeAudit(req, { action: 'LEVEL_CREATED', entityType: 'LEVEL', entityId: created.id, newValue: created });
      return created;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new AppError('A level with this number already exists (with or without the same programme assignment)', 400);
      }
      throw err;
    }
  }

  static async update(id: number, data: UpdateLevelInput, req?: ReqLike) {
    const existing = await prisma.level.findFirst({ where: { id } });
    if (!existing) throw new AppError('Level not found', 404);

    if (data.programmeId !== undefined && data.programmeId !== null) {
      const prog = await prisma.programme.findFirst({ where: { id: data.programmeId } });
      if (!prog) throw new AppError('Referenced programme does not exist', 400);
    }

    const payload: Prisma.LevelUpdateInput = {};
    if (data.level !== undefined) payload.level = data.level;
    if (data.isActive !== undefined) payload.isActive = data.isActive;
    if (data.programmeId !== undefined) {
      if (data.programmeId === null) {
        payload.programme = { disconnect: true };
      } else {
        payload.programme = { connect: { id: data.programmeId } };
      }
    }

    try {
      const updated = await prisma.level.update({ where: { id }, data: payload, select: LEVEL_SELECT as any });
      await writeAudit(req, { action: 'LEVEL_UPDATED', entityType: 'LEVEL', entityId: id, oldValue: existing, newValue: updated });
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new AppError('A level with this number already exists (with or without the same programme assignment)', 400);
      }
      throw err;
    }
  }

  static async deactivate(id: number, req?: ReqLike) {
    const existing = await prisma.level.findFirst({ where: { id } });
    if (!existing) throw new AppError('Level not found', 404);
    const updated = await prisma.level.update({ where: { id }, data: { isActive: false }, select: LEVEL_SELECT as any });
    await writeAudit(req, { action: 'LEVEL_DEACTIVATED', entityType: 'LEVEL', entityId: id, oldValue: existing, newValue: updated });
    return updated;
  }
}

// -----------------------------------------------------------------------------
// AcademicSessionService
// -----------------------------------------------------------------------------
export class AcademicSessionService {
  static async list(params: ListParams = {}): Promise<ListResult<any>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 25;
    const skip = (page - 1) * limit;

    const where: Prisma.AcademicSessionWhereInput = {};
    if (params.search) {
      where.OR = [{ name: { contains: params.search } }];
    }
    if (params.isActive !== undefined) where.isActive = params.isActive;

    const [rows, total] = await Promise.all([
      prisma.academicSession.findMany({ where, select: SESSION_SELECT as any, skip, take: limit, orderBy: { name: 'desc' } }),
      prisma.academicSession.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  static async get(id: number) {
    const row = await prisma.academicSession.findFirst({ where: { id }, select: SESSION_SELECT as any });
    if (!row) throw new AppError('Academic session not found', 404);
    return row;
  }

  static async create(data: CreateAcademicSessionInput, req?: ReqLike) {
    try {
      const payload: Prisma.AcademicSessionCreateInput = {
        name: data.name,
        startDate: data.startDate ?? null,
        endDate: data.endDate ?? null,
        isActive: data.isActive ?? true,
      };
      const created = await prisma.academicSession.create({ data: payload, select: SESSION_SELECT as any });
      await writeAudit(req, { action: 'ACADEMIC_SESSION_CREATED', entityType: 'ACADEMIC_SESSION', entityId: created.id, newValue: created });
      return created;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new AppError('An academic session with this name already exists', 400);
      }
      throw err;
    }
  }

  static async update(id: number, data: UpdateAcademicSessionInput, req?: ReqLike) {
    const existing = await prisma.academicSession.findFirst({ where: { id } });
    if (!existing) throw new AppError('Academic session not found', 404);

    const payload: Prisma.AcademicSessionUpdateInput = {};
    if (data.name !== undefined) payload.name = data.name;
    if (data.startDate !== undefined) payload.startDate = data.startDate ?? null;
    if (data.endDate !== undefined) payload.endDate = data.endDate ?? null;
    if (data.isActive !== undefined) payload.isActive = data.isActive;

    try {
      const updated = await prisma.academicSession.update({ where: { id }, data: payload, select: SESSION_SELECT as any });
      await writeAudit(req, { action: 'ACADEMIC_SESSION_UPDATED', entityType: 'ACADEMIC_SESSION', entityId: id, oldValue: existing, newValue: updated });
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new AppError('An academic session with this name already exists', 400);
      }
      throw err;
    }
  }

  static async deactivate(id: number, req?: ReqLike) {
    const existing = await prisma.academicSession.findFirst({ where: { id } });
    if (!existing) throw new AppError('Academic session not found', 404);
    const updated = await prisma.academicSession.update({ where: { id }, data: { isActive: false }, select: SESSION_SELECT as any });
    await writeAudit(req, { action: 'ACADEMIC_SESSION_DEACTIVATED', entityType: 'ACADEMIC_SESSION', entityId: id, oldValue: existing, newValue: updated });
    return updated;
  }
}

// -----------------------------------------------------------------------------
// Hierarchy validation helper (§92 cross-structure validation)
// -----------------------------------------------------------------------------
export interface HierarchyInput {
  facultyName?: string;
  departmentName?: string;
  programmeName?: string;
  levelName?: string;
  sessionName?: string;
}

export interface HierarchyError {
  code: string;
  field: string;
  message: string;
}

export interface HierarchyResult {
  valid: boolean;
  errors: HierarchyError[];
}

export async function validateHierarchy(input: HierarchyInput): Promise<HierarchyResult> {
  const errors: HierarchyError[] = [];

  const hasAnyField =
    input.facultyName !== undefined ||
    input.departmentName !== undefined ||
    input.programmeName !== undefined ||
    input.levelName !== undefined ||
    input.sessionName !== undefined;

  if (!hasAnyField) {
    return { valid: true, errors: [] };
  }

  const rawFacultyName = input.facultyName;
  const rawDepartmentName = input.departmentName;
  const rawProgrammeName = input.programmeName;
  const rawLevelName = input.levelName;
  const rawSessionName = input.sessionName;

  let facultyRow: any = null;
  if (rawFacultyName) {
    facultyRow = await prisma.faculty.findFirst({
      where: { name: { equals: rawFacultyName } },
      select: { id: true, name: true },
    });
  }

  let departmentRow: any = null;
  if (rawDepartmentName) {
    departmentRow = await prisma.department.findFirst({
      where: { name: { equals: rawDepartmentName } },
      select: { id: true, name: true, facultyId: true, faculty: { select: { id: true, name: true } } },
    });
  }

  let programmeRow: any = null;
  if (rawProgrammeName) {
    programmeRow = await prisma.programme.findFirst({
      where: { name: { equals: rawProgrammeName } },
      select: {
        id: true,
        name: true,
        departmentId: true,
        department: { select: { id: true, name: true, facultyId: true, faculty: { select: { id: true, name: true } } } },
      },
    });
  }

  let levelRow: any = null;
  if (rawLevelName) {
    levelRow = await prisma.level.findFirst({
      where: { level: { equals: rawLevelName } },
      select: {
        id: true,
        level: true,
        programmeId: true,
        programme: {
          select: {
            id: true,
            name: true,
            departmentId: true,
            department: { select: { id: true, name: true, facultyId: true, faculty: { select: { id: true, name: true } } } },
          },
        },
      },
    });
  }

  let sessionRow: any = null;
  if (rawSessionName) {
    sessionRow = await prisma.academicSession.findFirst({
      where: { name: { equals: rawSessionName } },
      select: { id: true, name: true },
    });
  }

  const hasAnyMasterRow = facultyRow || departmentRow || programmeRow || levelRow || sessionRow;
  if (!hasAnyMasterRow) {
    return { valid: true, errors: [] };
  }

  const facultyName = rawFacultyName ?? '';
  const departmentName = rawDepartmentName ?? '';
  const programmeName = rawProgrammeName ?? '';
  const levelName = rawLevelName ?? '';

  if (departmentRow && facultyRow) {
    const deptFacultyName = departmentRow.faculty?.name;
    if (deptFacultyName && deptFacultyName.toLowerCase() !== facultyName.toLowerCase()) {
      errors.push({
        code: 'HIERARCHY_MISMATCH',
        field: 'department',
        message: `${departmentName} Department does not belong to ${facultyName} Faculty.`,
      });
    }
  }

  if (programmeRow && departmentRow) {
    const progDeptName = programmeRow.department?.name;
    if (progDeptName && progDeptName.toLowerCase() !== departmentName.toLowerCase()) {
      errors.push({
        code: 'HIERARCHY_MISMATCH',
        field: 'programme',
        message: `${programmeName} Programme does not belong to ${departmentName} Department.`,
      });
    }
  }

  if (programmeRow && facultyRow && programmeRow.department?.faculty?.name) {
    const progFacultyName = programmeRow.department.faculty.name;
    if (progFacultyName.toLowerCase() !== facultyName.toLowerCase()) {
      errors.push({
        code: 'HIERARCHY_MISMATCH',
        field: 'programme',
        message: `${programmeName} Programme (via Department) does not belong to ${facultyName} Faculty.`,
      });
    }
  }

  if (levelRow && programmeRow) {
    const levelProgName = levelRow.programme?.name;
    if (levelProgName && levelProgName.toLowerCase() !== programmeName.toLowerCase()) {
      errors.push({
        code: 'HIERARCHY_MISMATCH',
        field: 'level',
        message: `${levelName} Level does not belong to ${programmeName} Programme.`,
      });
    }
  }

  if (levelRow && departmentRow && levelRow.programme?.department?.name) {
    const levelDeptName = levelRow.programme.department.name;
    if (levelDeptName.toLowerCase() !== departmentName.toLowerCase()) {
      errors.push({
        code: 'HIERARCHY_MISMATCH',
        field: 'level',
        message: `${levelName} Level (via Programme) does not belong to ${departmentName} Department.`,
      });
    }
  }

  if (levelRow && facultyRow && levelRow.programme?.department?.faculty?.name) {
    const levelFacultyName = levelRow.programme.department.faculty.name;
    if (levelFacultyName.toLowerCase() !== facultyName.toLowerCase()) {
      errors.push({
        code: 'HIERARCHY_MISMATCH',
        field: 'level',
        message: `${levelName} Level (via Programme/Department) does not belong to ${facultyName} Faculty.`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

export default {
  FacultyService,
  DepartmentService,
  ProgrammeService,
  LevelService,
  AcademicSessionService,
  validateHierarchy,
};
