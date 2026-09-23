import api from './api';

export interface UserOut {
  id: number;
  email: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  matricNumber?: string | null;
  admissionNumber?: string | null;
  jambNumber?: string | null;
  college?: string | null;
  department?: string | null;
  program?: string | null;
  level?: number | null;
  academicSession?: string | null;
  studentType?: string | null;
  entryMode?: string | null;
  admissionYear?: number | null;
  graduationYear?: number | null;
  phoneNumber?: string | null;
  address?: string | null;
  role: 'ADMIN' | 'BURSARY' | 'STUDENT';
  accountStatus: 'ACTIVE' | 'SUSPENDED' | 'GRADUATED' | 'WITHDRAWN';
  lastLoginAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface RolePermissionOut {
  key: string;
  name: string;
  category: string;
  description?: string | null;
}

export interface RoleOut {
  role: 'ADMIN' | 'BURSARY';
  name: string;
  description: string;
  permissions: RolePermissionOut[];
  permissionsCount: number;
}

export interface PermissionOut {
  key: string;
  name: string;
  category: string;
  description?: string | null;
  roles_assigned: string[];
}

export interface SystemSettingsOut {
  id?: number;
  universityName: string;
  universityLogoUrl?: string | null;
  universityFaviconUrl?: string | null;
  universityAddress?: string | null;
  universityPhone?: string | null;
  universityEmail?: string | null;
  universityWebsite?: string | null;
  paystackLiveEnabled: boolean;
  activePaymentGateway: 'PAYSTACK' | 'ALATPAY';
  largePaymentThreshold: number | string;
  importErrorThreshold: number;
  receiptFooterText?: string | null;
  receiptBursarName?: string | null;
  receiptBursarTitle?: string | null;
  receiptBursarSignatureUrl?: string | null;
  receiptPrefix: string;
  paymentRefPrefix: string;
  updatedById?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export type SystemSettingsPatch = Partial<Omit<SystemSettingsOut, 'id' | 'createdAt' | 'updatedAt' | 'updatedById'>>;

export interface GatewayStatus {
  key: 'PAYSTACK' | 'ALATPAY';
  label: string;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface PaymentConfigOut {
  activeGateway: 'PAYSTACK' | 'ALATPAY';
  supportedGateways: GatewayStatus[];
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface UserListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  role?: 'ADMIN' | 'BURSARY' | 'STUDENT';
  accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'GRADUATED' | 'WITHDRAWN';
}

export interface CreateUserInput {
  email: string;
  password: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  matricNumber?: string | null;
  role: 'ADMIN' | 'BURSARY' | 'STUDENT';
  accountStatus?: 'ACTIVE' | 'SUSPENDED';
  phoneNumber?: string | null;
}

export interface UpdateUserInput {
  firstName?: string;
  middleName?: string | null;
  lastName?: string;
  matricNumber?: string | null;
  role?: 'ADMIN' | 'BURSARY' | 'STUDENT';
  accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'GRADUATED' | 'WITHDRAWN';
  phoneNumber?: string | null;
}

export interface ResetPasswordInput {
  newPassword: string;
}

export interface UpdateRoleInput {
  permissionKeys: string[];
}

export interface UpdateRolePermissionInput extends UpdateRoleInput {}

const unwrapData = <T>(r: any): T => (r?.data?.data ?? r?.data) as T;

export const usersApi = {
  list: (params?: UserListParams) =>
    api.get<{ data: PaginatedResponse<UserOut> }>('/admin/users', { params }).then(unwrapData<PaginatedResponse<UserOut>>),
  get: (id: number) =>
    api.get<{ data: UserOut }>(`/admin/users/${id}`).then(unwrapData<UserOut>),
  create: (body: CreateUserInput) =>
    api.post<{ data: UserOut }>('/admin/users', body).then(unwrapData<UserOut>),
  update: (id: number, body: UpdateUserInput) =>
    api.patch<{ data: UserOut }>(`/admin/users/${id}`, body).then(unwrapData<UserOut>),
  deactivate: (id: number) =>
    api.post<{ data: UserOut }>(`/admin/users/${id}/deactivate`).then(unwrapData<UserOut>),
  resetPassword: (id: number, body: ResetPasswordInput) =>
    api.post<{ data: { message?: string; generatedPassword?: string } }>(`/admin/users/${id}/reset-password`, body).then(unwrapData<{ message?: string; generatedPassword?: string }>),
};

export const rolesApi = {
  list: () =>
    api.get<{ data: { items: RoleOut[] } }>('/admin/roles').then((r) => (unwrapData<any>(r)?.items ?? []) as RoleOut[]),
  get: (role: 'ADMIN' | 'BURSARY') =>
    api.get<{ data: RoleOut }>(`/admin/roles/${role}`).then(unwrapData<RoleOut>),
  assignPermissions: (role: 'ADMIN' | 'BURSARY', permissionKeys: string[]) =>
    api.post<{ data: RoleOut }>('/admin/roles', { role, permissionKeys }).then(unwrapData<RoleOut>),
  update: (role: 'ADMIN' | 'BURSARY', body: UpdateRolePermissionInput) =>
    api.patch<{ data: RoleOut }>(`/admin/roles/${role}`, body).then(unwrapData<RoleOut>),
};

export const permissionsApi = {
  list: () =>
    api.get<{ data: { items: PermissionOut[] } }>('/admin/permissions').then((r) => (unwrapData<any>(r)?.items ?? []) as PermissionOut[]),
};

export const settingsApi = {
  get: () =>
    api.get<{ data: SystemSettingsOut }>('/admin/settings').then(unwrapData<SystemSettingsOut>),
  patch: (body: SystemSettingsPatch) =>
    api.patch<{ data: SystemSettingsOut }>('/admin/settings', body).then(unwrapData<SystemSettingsOut>),
};

export const paymentConfigApi = {
  get: () =>
    api.get<{ data: PaymentConfigOut }>('/admin/payment-config').then(unwrapData<PaymentConfigOut>),
  save: (activeGateway: 'PAYSTACK' | 'ALATPAY') =>
    api.patch<{ data: PaymentConfigOut }>('/admin/payment-config', { activeGateway }).then(unwrapData<PaymentConfigOut>),
};
