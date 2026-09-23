import api from './api';

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
  programmeId: number;
  programme?: ProgrammeOut;
  departmentId?: number;
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
  programmeId: number;
  departmentId?: number;
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

const list = async <T>(path: string, params?: ListQueryParams): Promise<ListResponse<T>> => {
  const res = await api.get<{ data: ListResponse<T> }>(path, { params });
  return res.data.data;
};

const create = async <TIn, TOut>(path: string, data: TIn): Promise<TOut> => {
  const res = await api.post<{ data: TOut }>(path, data);
  return res.data.data;
};

const update = async <TIn, TOut>(path: string, id: number, data: TIn): Promise<TOut> => {
  const res = await api.patch<{ data: TOut }>(`${path}/${id}`, data);
  return res.data.data;
};

const deactivate = async (path: string, id: number): Promise<void> => {
  await api.post(`${path}/${id}/deactivate`);
};

export const facultiesApi = {
  list: (params?: ListQueryParams) => list<FacultyOut>('/academic/faculties', params),
  create: (data: CreateFacultyInput) => create<CreateFacultyInput, FacultyOut>('/academic/faculties', data),
  update: (id: number, data: UpdateFacultyInput) => update<UpdateFacultyInput, FacultyOut>('/academic/faculties', id, data),
  deactivate: (id: number) => deactivate('/academic/faculties', id),
};

export const departmentsApi = {
  list: (params?: ListQueryParams) => list<DepartmentOut>('/academic/departments', params),
  create: (data: CreateDepartmentInput) => create<CreateDepartmentInput, DepartmentOut>('/academic/departments', data),
  update: (id: number, data: UpdateDepartmentInput) => update<UpdateDepartmentInput, DepartmentOut>('/academic/departments', id, data),
  deactivate: (id: number) => deactivate('/academic/departments', id),
};

export const programmesApi = {
  list: (params?: ListQueryParams) => list<ProgrammeOut>('/academic/programmes', params),
  create: (data: CreateProgrammeInput) => create<CreateProgrammeInput, ProgrammeOut>('/academic/programmes', data),
  update: (id: number, data: UpdateProgrammeInput) => update<UpdateProgrammeInput, ProgrammeOut>('/academic/programmes', id, data),
  deactivate: (id: number) => deactivate('/academic/programmes', id),
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
