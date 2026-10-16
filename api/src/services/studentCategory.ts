// =============================================================================
// StudentCategoryService — admin-managed student categories.
//
// Replaces the hard-coded StudentType enum as the source of truth for
// "what kind of student is this?" (Undergraduate, Postgraduate, Top-Up, …).
//
// Rules (per product requirement):
//   • Admins can CREATE new categories at any time (additive, not hard-coded).
//   • A category can be DEACTIVATED freely — it simply stops being selectable
//     for new students/uploads while every existing student keeps it.
//   • A category can only be HARD-DELETED while NO student references it.
//     `remove()` returns 409 with the exact reference count otherwise, and the
//     `users.studentCategoryId` FK is ON DELETE RESTRICT as a DB-level backstop.
//
// The stable machine key `code` is mirrored into User.studentType for backwards
// compatibility with existing fee targeting / reporting that still reads the
// legacy enum.
// =============================================================================

import { Prisma, StudentType } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/database';
import { AppError } from '../utils/AppError';
import type { Request } from 'express';
import { i18n, auditActions } from '../i18n/en';

const JSON_DB_NULL = Prisma.JsonNull;

type ReqLike = Pick<Request, 'user'> & Partial<Pick<Request, 'ip'>> & { headers?: Record<string, any> };
type AuditEntityType = 'STUDENT_CATEGORY';

async function writeAudit(
  req: ReqLike | undefined,
  data: { action: string; entityType: AuditEntityType; entityId: string | number; oldValue?: any; newValue?: any },
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

// -----------------------------------------------------------------------------
// Validation — tolerant, same conventions as services/academic.ts
// -----------------------------------------------------------------------------
const optBool = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'off' || s === 'no' || s === '') return false;
  }
  return v;
}, z.boolean().optional());

export const CreateStudentCategorySchema = z.object({
  name: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()),
    z.string().min(2).max(150),
  ),
  code: z.preprocess(
    (v) => {
      if (typeof v !== 'string' || v.trim() === '') return undefined;
      return v.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    },
    z.string().min(2).max(40).optional(),
  ),
  description: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined),
    z.string().max(500).optional(),
  ),
  isActive: optBool,
  sortOrder: z.preprocess(
    (v) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : Number(v)),
    z.number().int().min(0).max(9999).optional(),
  ),
});
export const UpdateStudentCategorySchema = CreateStudentCategorySchema.partial();
export type CreateStudentCategoryInput = z.infer<typeof CreateStudentCategorySchema>;
export type UpdateStudentCategoryInput = z.infer<typeof UpdateStudentCategorySchema>;

export const StudentCategoryListQuerySchema = z.object({
  search: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim().length === 0 ? undefined : v.trim()) : undefined),
    z.string().max(200).optional(),
  ),
  page: z.coerce.number().int().positive().default(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(50).optional(),
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')])
    .optional(),
});

type ListParams = { search?: string; page?: number; limit?: number; isActive?: boolean };
type ListResult<T> = { rows: T[]; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean };

function paginate<T>(rows: T[], total: number, page: number, limit: number): ListResult<T> {
  const totalPages = Math.ceil(total / limit);
  return { rows, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}

const CATEGORY_SELECT = {
  id: true,
  name: true,
  code: true,
  description: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { students: true } },
} as const;

// -----------------------------------------------------------------------------
// Mirroring helpers — keep the legacy StudentType enum in step with `code`.
// -----------------------------------------------------------------------------
export const CATEGORY_ENUM_CODES = [
  'UNDERGRADUATE',
  'POSTGRADUATE',
  'PART_TIME',
  'JUPEB',
  'OTHER',
  'TOP_UP',
] as const;

/** Map a category `code` to the legacy StudentType enum (unknown → OTHER). */
export function mirrorStudentTypeForCategory(code: string | null | undefined): StudentType {
  if (!code) return StudentType.OTHER;
  const key = String(code).trim().toUpperCase();
  const found = (StudentType as Record<string, StudentType>)[key];
  return found ?? StudentType.OTHER;
}

/** Normalise a code/name for tolerant (case/space/punctuation-insensitive) matching. */
export function normalizeCategoryKey(v: unknown): string {
  return String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

export type CategoryLookup = { id: number; code: string; name: string; isActive: boolean };

// -----------------------------------------------------------------------------
// Lookup cache. A 7,000-row import resolves a category per row; without a cache
// that would be 7,000 identical queries. Categories change rarely, so a short
// TTL (disabled in tests for determinism) + explicit invalidation on every
// mutation keeps lookups O(1) without serving stale data for long.
// -----------------------------------------------------------------------------
const CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 60_000;
let _cache: { at: number; rows: CategoryLookup[] } | null = null;

export function invalidateStudentCategoryCache(): void {
  _cache = null;
}

async function loadCategoryRows(): Promise<CategoryLookup[]> {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) return _cache.rows;
  const rows = await prisma.studentCategory.findMany({
    select: { id: true, code: true, name: true, isActive: true },
  });
  _cache = { at: now, rows };
  return rows;
}

/**
 * Load every category and index it by normalised code AND normalised name, so
 * bulk import can resolve 7,000+ rows in memory instead of querying per row.
 */
export async function loadStudentCategoryIndex(): Promise<Map<string, CategoryLookup>> {
  const rows = await loadCategoryRows();
  const index = new Map<string, CategoryLookup>();
  for (const r of rows) {
    index.set(normalizeCategoryKey(r.code), r);
    index.set(normalizeCategoryKey(r.name), r);
    // Also index by raw numeric id so spreadsheet cells containing a category
    // id (e.g. 3) resolve without a separate DB round-trip.
    index.set(String(r.id), r);
  }
  return index;
}

/** Resolve a raw (code OR display name) value against a pre-built index. */
export function resolveFromIndex(
  index: Map<string, CategoryLookup>,
  raw: unknown,
): CategoryLookup | null {
  const key = normalizeCategoryKey(raw);
  if (!key) return null;
  return index.get(key) ?? null;
}

/**
 * Resolve a raw value (numeric id, or category code / display name) against the
 * DB, requiring the category to be ACTIVE. Returns null when unknown/inactive —
 * callers decide whether that is a hard error.
 */
export async function resolveActiveStudentCategory(raw: unknown): Promise<CategoryLookup | null> {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const rows = await loadCategoryRows();
  let hit: CategoryLookup | undefined;
  if (/^\d+$/.test(s)) hit = rows.find((r) => r.id === Number(s));
  if (!hit) {
    const key = normalizeCategoryKey(s);
    hit = rows.find(
      (r) => normalizeCategoryKey(r.code) === key || normalizeCategoryKey(r.name) === key,
    );
  }
  if (!hit || !hit.isActive) return null;
  return hit;
}

// -----------------------------------------------------------------------------
// Slug helper — derive a stable-ish code from a name when none is supplied.
// -----------------------------------------------------------------------------
function deriveCode(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------
export class StudentCategoryService {
  static async list(params: ListParams = {}): Promise<ListResult<any>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.StudentCategoryWhereInput = {};
    if (params.search) {
      where.OR = [
        { name: { contains: params.search } },
        { code: { contains: params.search } },
      ];
    }
    if (params.isActive !== undefined) where.isActive = params.isActive;

    const [rows, total] = await Promise.all([
      prisma.studentCategory.findMany({
        where,
        select: CATEGORY_SELECT as any,
        skip,
        take: limit,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.studentCategory.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  static async get(id: number) {
    const row = await prisma.studentCategory.findFirst({ where: { id }, select: CATEGORY_SELECT as any });
    if (!row) throw new AppError('Student Category not found', 404);
    return row;
  }

  static async create(data: CreateStudentCategoryInput, req?: ReqLike) {
    const code = data.code ?? deriveCode(data.name);
    if (!code) throw new AppError('Unable to derive a category code — please provide one.', 400);

    try {
      const created: any = await prisma.studentCategory.create({
        data: {
          name: data.name,
          code,
          description: data.description ?? null,
          isActive: data.isActive ?? true,
          sortOrder: data.sortOrder ?? 0,
          createdById: (req as any)?.user?.id ?? null,
        },
        select: CATEGORY_SELECT as any,
      });
      invalidateStudentCategoryCache();
      await writeAudit(req, {
        action: auditActions.studentCategoryCreated,
        entityType: 'STUDENT_CATEGORY',
        entityId: created.id,
        newValue: created,
      });
      return created;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : '';
        if (target.includes('code')) throw new AppError('A student category with this code already exists', 400);
        throw new AppError('A student category with this name already exists', 400);
      }
      throw err;
    }
  }

  static async update(id: number, data: UpdateStudentCategoryInput, req?: ReqLike) {
    const existing = await prisma.studentCategory.findFirst({ where: { id } });
    if (!existing) throw new AppError('Student Category not found', 404);

    const payload: Prisma.StudentCategoryUpdateInput = {};
    if (data.name !== undefined) payload.name = data.name;
    if (data.description !== undefined) payload.description = data.description ?? null;
    if (data.isActive !== undefined) payload.isActive = data.isActive;
    if (data.sortOrder !== undefined) payload.sortOrder = data.sortOrder;

    // The code is the mirror key written into User.studentType. Changing it once
    // students depend on it would desync the legacy mirror, so only allow a code
    // change while no student references the category.
    if (data.code !== undefined && data.code !== existing.code) {
      const students = await prisma.user.count({ where: { studentCategoryId: id } });
      if (students > 0) {
        throw new AppError(
          `Cannot change the code of this category: ${students} student(s) already reference it. ` +
            `Create a new category instead, or deactivate this one.`,
          409,
        );
      }
      payload.code = data.code;
    }

    try {
      const updated = await prisma.studentCategory.update({ where: { id }, data: payload, select: CATEGORY_SELECT as any });
      invalidateStudentCategoryCache();
      await writeAudit(req, {
        action: auditActions.studentCategoryUpdated,
        entityType: 'STUDENT_CATEGORY',
        entityId: id,
        oldValue: existing,
        newValue: updated,
      });
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : '';
        if (target.includes('code')) throw new AppError('A student category with this code already exists', 400);
        throw new AppError('A student category with this name already exists', 400);
      }
      throw err;
    }
  }

  /** Deactivate is ALWAYS allowed — existing students keep the category. */
  static async deactivate(id: number, req?: ReqLike) {
    const existing = await prisma.studentCategory.findFirst({ where: { id } });
    if (!existing) throw new AppError('Student Category not found', 404);
    const updated = await prisma.studentCategory.update({
      where: { id },
      data: { isActive: false },
      select: CATEGORY_SELECT as any,
    });
    invalidateStudentCategoryCache();
    await writeAudit(req, {
      action: auditActions.studentCategoryDeactivated,
      entityType: 'STUDENT_CATEGORY',
      entityId: id,
      oldValue: existing,
      newValue: updated,
    });
    return updated;
  }

  /**
   * Hard delete — allowed ONLY while no student references the category.
   * Returns 409 with the exact count otherwise (mirrors the academic
   * Faculty/Department `remove()` contract).
   */
  static async remove(id: number, req?: ReqLike) {
    const existing = await prisma.studentCategory.findFirst({ where: { id } });
    if (!existing) throw new AppError('Student Category not found', 404);

    const students = await prisma.user.count({ where: { studentCategoryId: id } });
    if (students > 0) {
      throw new AppError(
        `Cannot delete this Student Category: ${students} student(s) were uploaded under it. ` +
          `Reassign those students to another category first, or use Deactivate to retire it instead.`,
        409,
      );
    }

    const deleted = await prisma.studentCategory.delete({
      where: { id },
      select: { id: true, name: true, code: true },
    });
    invalidateStudentCategoryCache();
    await writeAudit(req, {
      action: auditActions.studentCategoryDeleted,
      entityType: 'STUDENT_CATEGORY',
      entityId: id,
      oldValue: existing,
    });
    return { deleted };
  }
}

export const studentCategoryErrors = i18n.errors.students;
