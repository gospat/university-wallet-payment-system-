import api from './api';

/**
 * Student Categories — admin-managed reference data (real DB table).
 * Mounted at /api/v1/academic/student-categories on the backend.
 *
 * Reads require VIEW_STUDENTS (ADMIN + BURSARY); write operations require
 * MANAGE_STUDENTS (ADMIN only). The server is the authorisation boundary —
 * these helpers only centralise the request/response mapping.
 */
export interface StudentCategory {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  isActive: boolean;
  sortOrder: number | null;
  createdAt: string;
  updatedAt: string;
  _count: { students: number };
}

export interface StudentCategoryListParams {
  search?: string;
  page?: number;
  limit?: number;
  isActive?: boolean;
}

export interface StudentCategoryListResult {
  rows: StudentCategory[];
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface CreateStudentCategoryInput {
  name: string;
  code?: string;
  description?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export type UpdateStudentCategoryInput = Partial<CreateStudentCategoryInput>;

export interface DeletedStudentCategory {
  id: number;
  name: string;
  code: string | null;
}

const BASE = '/academic/student-categories';

const unwrapCategory = (payload: unknown): StudentCategory | null => {
  const p = payload as { category?: StudentCategory } | null | undefined;
  return p?.category ?? null;
};

export const studentCategoriesApi = {
  list: async (params?: StudentCategoryListParams): Promise<StudentCategoryListResult> => {
    const res = await api.get<{ data: StudentCategoryListResult }>(BASE, { params });
    const raw = (res.data?.data ?? {}) as Partial<StudentCategoryListResult>;
    return {
      rows: Array.isArray(raw.rows) ? raw.rows : [],
      total: Number(raw.total) || 0,
      totalPages: Number(raw.totalPages) || 1,
      hasNext: Boolean(raw.hasNext),
      hasPrev: Boolean(raw.hasPrev),
    };
  },

  get: async (id: number): Promise<StudentCategory | null> => {
    const res = await api.get<{ data: unknown }>(`${BASE}/${id}`);
    return unwrapCategory(res.data?.data);
  },

  create: async (input: CreateStudentCategoryInput): Promise<StudentCategory | null> => {
    const res = await api.post<{ data: unknown }>(BASE, input);
    return unwrapCategory(res.data?.data);
  },

  update: async (id: number, input: UpdateStudentCategoryInput): Promise<StudentCategory | null> => {
    const res = await api.patch<{ data: unknown }>(`${BASE}/${id}`, input);
    return unwrapCategory(res.data?.data);
  },

  deactivate: async (id: number): Promise<StudentCategory | null> => {
    const res = await api.post<{ data: unknown }>(`${BASE}/${id}/deactivate`);
    return unwrapCategory(res.data?.data);
  },

  reactivate: async (id: number): Promise<StudentCategory | null> => {
    const res = await api.patch<{ data: unknown }>(`${BASE}/${id}`, { isActive: true });
    return unwrapCategory(res.data?.data);
  },

  remove: async (id: number): Promise<DeletedStudentCategory | null> => {
    const res = await api.delete<{ data: { deleted?: DeletedStudentCategory } }>(`${BASE}/${id}`);
    return res.data?.data?.deleted ?? null;
  },
};
