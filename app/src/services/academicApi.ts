import api, { API_BASE_URL } from './api';

export type AcademicBulkKind = 'college' | 'department' | 'programme';

export interface BulkRowError {
  row: number;
  record: string;
  message: string;
}

export interface BulkImportResult {
  created: number;
  skipped: number;
  errors: BulkRowError[];
  ids: number[];
  createdItems: Array<{ id: number; code: string; name: string }>;
  errorsCsvUrl?: string | null;
}

const pluralKind: Record<AcademicBulkKind, string> = {
  college: 'faculties',
  department: 'departments',
  programme: 'programmes',
};

export const templateDownloadUrl = (kind: AcademicBulkKind): string => {
  const token = localStorage.getItem('token') ?? '';
  return `${API_BASE_URL}/academic/${pluralKind[kind]}/template.csv?t=${Date.now()}&access_token=${encodeURIComponent(token)}`;
};

export const templateDownloadXlsxUrl = (kind: AcademicBulkKind): string => {
  const token = localStorage.getItem('token') ?? '';
  return `${API_BASE_URL}/academic/${pluralKind[kind]}/template.xlsx?t=${Date.now()}&access_token=${encodeURIComponent(token)}`;
};

export const facultiesTemplateXlsxUrl = (): string => {
  const token = localStorage.getItem('token') ?? '';
  return `${API_BASE_URL}/academic/faculties/template.xlsx?t=${Date.now()}&access_token=${encodeURIComponent(token)}`;
};

export const departmentsTemplateXlsxUrl = (): string => {
  const token = localStorage.getItem('token') ?? '';
  return `${API_BASE_URL}/academic/departments/template.xlsx?t=${Date.now()}&access_token=${encodeURIComponent(token)}`;
};

export const programmesTemplateXlsxUrl = (): string => {
  const token = localStorage.getItem('token') ?? '';
  return `${API_BASE_URL}/academic/programmes/template.xlsx?t=${Date.now()}&access_token=${encodeURIComponent(token)}`;
};

export const bulkImport = async (
  kind: AcademicBulkKind,
  file: File
): Promise<BulkImportResult> => {
  const formData = new FormData();
  formData.append('file', file);
  const res = await api.post<{ data: BulkImportResult }>(
    `/academic/${pluralKind[kind]}/bulk-import`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
  return res.data?.data ?? ({} as BulkImportResult);
};

export interface FacultyOut {
  id: number;
  name: string;
  code: string;
  description?: string | null;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
  _count?: { departments?: number; programmes?: number };
}

export interface DepartmentOut {
  id: number;
  name: string;
  code: string;
  description?: string | null;
  facultyId: number;
  faculty?: FacultyOut;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
  _count?: { programmes?: number };
}

export interface ProgrammeOut {
  id: number;
  name: string;
  code: string;
  description?: string | null;
  departmentId: number;
  department?: DepartmentOut;
  facultyId?: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
  _count?: { levels?: number };
}

export interface LevelOut {
  id: number;
  name: string;
  code: string;
  level: number;
  description?: string | null;
  programmeId?: number | null;
  programme?: ProgrammeOut | null;
  departmentId?: number | null;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AcademicSessionOut {
  id: number;
  name: string;
  code: string;
  startDate?: string | null;
  endDate?: string | null;
  isCurrent?: boolean;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ListQueryParams {
  page?: number;
  pageSize?: number;
  q?: string;
  isActive?: boolean;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CreateFacultyInput {
  name: string;
  code: string;
  description?: string;
  isActive?: boolean;
}

export interface UpdateFacultyInput extends Partial<CreateFacultyInput> {}

export interface CreateDepartmentInput {
  name: string;
  code: string;
  facultyId: number;
  description?: string;
  isActive?: boolean;
}

export interface UpdateDepartmentInput extends Partial<CreateDepartmentInput> {}

export interface CreateProgrammeInput {
  name: string;
  code: string;
  departmentId: number;
  facultyId?: number;
  description?: string;
  isActive?: boolean;
}

export interface UpdateProgrammeInput extends Partial<CreateProgrammeInput> {}

export interface CreateLevelInput {
  name: string;
  code: string;
  level: number;
  programmeId?: number | null;
  departmentId?: number | null;
  description?: string;
  isActive?: boolean;
}

export interface UpdateLevelInput extends Partial<CreateLevelInput> {}

export interface CreateSessionInput {
  name: string;
  code: string;
  startDate?: string;
  endDate?: string;
  isCurrent?: boolean;
  isActive?: boolean;
}

export interface UpdateSessionInput extends Partial<CreateSessionInput> {}

type BackendListResult<T> = {
  rows: T[];
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

const list = async <T>(path: string, params?: ListQueryParams): Promise<ListResponse<T>> => {
  const res = await api.get<{ data: BackendListResult<T> }>(path, { params });
  const raw = res.data.data ?? {} as BackendListResult<T>;
  const page = Number(params?.page) || 1;
  const pageSize = Number(params?.pageSize) || 50;
  return {
    items: Array.isArray(raw.rows) ? raw.rows : [],
    total: Number(raw.total) || 0,
    page,
    pageSize,
    totalPages: Number(raw.totalPages) || Math.max(1, Math.ceil((Number(raw.total) || 0) / pageSize)),
  };
};

const unwrapEnvelope = <TOut>(payload: any): TOut => {
  if (!payload) return payload as TOut;
  const keys = ['faculty', 'department', 'programme', 'level', 'session', 'academicSession'];
  for (const k of keys) {
    if (typeof payload === 'object' && payload !== null && payload[k] !== undefined) {
      return payload[k] as TOut;
    }
  }
  return payload as TOut;
};

function sanitizeAcademicBody<T extends Record<string, any>>(body: T): T {
  const out: any = { ...body };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string' && out[k].trim() === '') {
      delete out[k];
    }
  }
  for (const numKey of ['facultyId', 'departmentId', 'programmeId', 'level', 'durationYears'] as const) {
    if (out[numKey] === '' || out[numKey] === null || out[numKey] === undefined) {
      delete out[numKey];
    } else if (typeof out[numKey] === 'string') {
      const parsed = Number(out[numKey]);
      if (isNaN(parsed) || parsed <= 0) {
        delete out[numKey];
      } else {
        out[numKey] = parsed;
      }
    }
  }
  return out as T;
}

const create = async <TIn extends Record<string, any>, TOut>(path: string, data: TIn): Promise<TOut> => {
  const res = await api.post<{ data: any }>(path, sanitizeAcademicBody(data));
  return unwrapEnvelope<TOut>(res.data.data);
};

const update = async <TIn extends Record<string, any>, TOut>(path: string, id: number, data: TIn): Promise<TOut> => {
  const res = await api.patch<{ data: any }>(`${path}/${id}`, sanitizeAcademicBody(data));
  return unwrapEnvelope<TOut>(res.data.data);
};

const deactivate = async (path: string, id: number): Promise<void> => {
  await api.post(`${path}/${id}/deactivate`);
};

const remove = async (path: string, id: number): Promise<{ deleted: { id: number; name?: string | null; code?: string | null } }> => {
  const res = await api.delete<{ data: any }>(`${path}/${id}`);
  return (res.data?.data ?? { deleted: null }) as any;
};

export const facultiesApi = {
  list: (params?: ListQueryParams) => list<FacultyOut>('/academic/faculties', params),
  create: (data: CreateFacultyInput) => create<CreateFacultyInput, FacultyOut>('/academic/faculties', data),
  update: (id: number, data: UpdateFacultyInput) => update<UpdateFacultyInput, FacultyOut>('/academic/faculties', id, data),
  deactivate: (id: number) => deactivate('/academic/faculties', id),
  remove: (id: number) => remove('/academic/faculties', id),
};

export const departmentsApi = {
  list: (params?: ListQueryParams) => list<DepartmentOut>('/academic/departments', params),
  create: (data: CreateDepartmentInput) => create<CreateDepartmentInput, DepartmentOut>('/academic/departments', data),
  update: (id: number, data: UpdateDepartmentInput) => update<UpdateDepartmentInput, DepartmentOut>('/academic/departments', id, data),
  deactivate: (id: number) => deactivate('/academic/departments', id),
  remove: (id: number) => remove('/academic/departments', id),
};

export const programmesApi = {
  list: (params?: ListQueryParams) => list<ProgrammeOut>('/academic/programmes', params),
  create: (data: CreateProgrammeInput) => create<CreateProgrammeInput, ProgrammeOut>('/academic/programmes', data),
  update: (id: number, data: UpdateProgrammeInput) => update<UpdateProgrammeInput, ProgrammeOut>('/academic/programmes', id, data),
  deactivate: (id: number) => deactivate('/academic/programmes', id),
  remove: (id: number) => remove('/academic/programmes', id),
};

export const levelsApi = {
  list: (params?: ListQueryParams) => list<LevelOut>('/academic/levels', params),
  create: (data: CreateLevelInput) => create<CreateLevelInput, LevelOut>('/academic/levels', data),
  update: (id: number, data: UpdateLevelInput) => update<UpdateLevelInput, LevelOut>('/academic/levels', id, data),
  deactivate: (id: number) => deactivate('/academic/levels', id),
};

export const sessionsApi = {
  list: (params?: ListQueryParams) => list<AcademicSessionOut>('/academic/sessions', params),
  create: (data: CreateSessionInput) => create<CreateSessionInput, AcademicSessionOut>('/academic/sessions', data),
  update: (id: number, data: UpdateSessionInput) => update<UpdateSessionInput, AcademicSessionOut>('/academic/sessions', id, data),
  deactivate: (id: number) => deactivate('/academic/sessions', id),
};
