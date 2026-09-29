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

export interface RoleDiff { added: string[]; removed: string[]; }

export const rolesApi = {
  list: () =>
    api.get<{ data: { items: RoleOut[] } }>('/admin/roles').then((r) => (unwrapData<any>(r)?.items ?? []) as RoleOut[]),
  get: (role: 'ADMIN' | 'BURSARY') =>
    api.get<{ data: RoleOut }>(`/admin/roles/${role}`).then(unwrapData<RoleOut>),
  assignPermissions: (role: 'ADMIN' | 'BURSARY', permissionKeys: string[]) =>
    api.post<{ data: RoleOut; diff?: RoleDiff }>('/admin/roles', { role, permissionKeys }).then((r) => unwrapData<any>(r) ?? {}),
  update: (role: 'ADMIN' | 'BURSARY', body: UpdateRolePermissionInput) =>
    api.patch<{ data: RoleOut; diff?: RoleDiff }>(`/admin/roles/${role}`, body).then((r) => unwrapData<any>(r) ?? {}),
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

export type EmailTypeKey =
  | 'STUDENT_CREDENTIALS'
  | 'PASSWORD_RESET'
  | 'PAYMENT_SUCCESSFUL'
  | 'FEE_ASSIGNED'
  | 'BILL_CREATED'
  | 'REFUND_REQUESTED'
  | 'REFUND_APPROVED'
  | 'REFUND_REJECTED'
  | 'OTHER';
export type EmailProviderTypeKey = 'RESEND' | 'SMTP' | 'MOCK';
export type EmailDeliveryStatusKey = 'PENDING' | 'SENT' | 'FAILED' | 'RETRIED';

export interface EmailTemplateConfigOut {
  templateKey: string;
  senderName: string;
  senderAddress: string;
  replyToAddress?: string | null;
  portalLoginUrl: string;
  subjectLine: string;
  greeting: string;
  paragraph: string;
  buttonLabel: string;
  forceChangeNotice: string;
  closing: string;
  accentColor?: string | null;
  updatedById?: number | null;
}

export type EmailTemplateConfigPatch = Partial<Omit<EmailTemplateConfigOut, 'templateKey' | 'updatedById'>>;

export interface EmailDeliveryLogOut {
  id: string;
  emailType: EmailTypeKey;
  toAddress: string;
  recipientId?: number | null;
  recipient?: {
    id: number;
    email?: string;
    firstName?: string;
    lastName?: string;
    matricNumber?: string | null;
  } | null;
  triggeredByAdminId?: number | null;
  triggeredByAdmin?: {
    id: number;
    email: string;
    firstName?: string;
    lastName?: string;
    role: string;
  } | null;
  studentImportId?: number | null;
  studentImport?: {
    id: number;
    importNumber: string;
    fileName: string;
    createdAt: string;
    totalRecords?: number;
    successfulRecords?: number;
  } | null;
  idempotencyKey?: string;
  provider: EmailProviderTypeKey;
  status: EmailDeliveryStatusKey;
  resendMessageId?: string | null;
  smtpMessageId?: string | null;
  attempts: number;
  lastError?: string | null;
  retryAfter?: string | null;
  payloadSummary?: any;
  createdAt: string;
  updatedAt?: string;
}

export interface EmailDeliveryListOut {
  rows: EmailDeliveryLogOut[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

export interface EmailDeliveryListParams {
  page?: number;
  pageSize?: number;
  emailType?: EmailTypeKey;
  status?: EmailDeliveryStatusKey;
  toAddressContains?: string;
  recipientId?: number;
  studentImportId?: number;
}

export const emailTemplatesApi = {
  get: (templateKey: string) =>
    api.get<{ data: EmailTemplateConfigOut }>(`/admin/email-templates/${encodeURIComponent(templateKey)}`).then(unwrapData<EmailTemplateConfigOut>),
  patch: (templateKey: string, patch: EmailTemplateConfigPatch) =>
    api.patch<{ data: EmailTemplateConfigOut }>(`/admin/email-templates/${encodeURIComponent(templateKey)}`, patch).then(unwrapData<EmailTemplateConfigOut>),
};

export const emailDeliveryLogsApi = {
  list: (params?: EmailDeliveryListParams) => {
    const search = new URLSearchParams();
    const p = params || {};
    if (p.page) search.set('page', String(p.page));
    if (p.pageSize) search.set('pageSize', String(p.pageSize));
    if (p.emailType) search.set('emailType', p.emailType);
    if (p.status) search.set('status', p.status);
    if (p.toAddressContains) search.set('toAddressContains', p.toAddressContains);
    if (p.recipientId) search.set('recipientId', String(p.recipientId));
    if (p.studentImportId) search.set('studentImportId', String(p.studentImportId));
    const qs = search.toString();
    return api
      .get<{ data: EmailDeliveryListOut }>(`/admin/email-delivery-logs${qs ? `?${qs}` : ''}`)
      .then(unwrapData<EmailDeliveryListOut>);
  },
  get: (id: string | number) =>
    api.get<{ data: EmailDeliveryLogOut }>(`/admin/email-delivery-logs/${encodeURIComponent(String(id))}`).then(unwrapData<EmailDeliveryLogOut>),
};

export const emailResendCredentialsApi = {
  resend: (userId: number) =>
    api.post<{ data: { deliveryLogId: string | null; queued: boolean; message: string } }>(`/admin/users/${userId}/resend-credentials`).then(unwrapData<{ deliveryLogId: string | null; queued: boolean; message: string }>),
};
