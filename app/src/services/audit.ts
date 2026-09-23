import api from './api';

export interface AuditLogFilters {
  page?: number;
  limit?: number;
  action?: string;
  entity?: string;
  entityId?: number;
  userId?: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface AuditActor {
  id: number;
  email: string;
  firstName?: string;
  lastName?: string;
  role?: string;
}

export interface AuditLog {
  id: number;
  userId: number;
  action: string;
  entity: string;
  entityId: number | null;
  summary: string | null;
  oldValue: any;
  newValue: any;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  user?: AuditActor;
}

export interface AuditListPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface AuditListResponse {
  items: AuditLog[];
  pagination: AuditListPagination;
  filters: Record<string, any>;
}

export const auditApi = {
  list: async (query: AuditLogFilters = {}): Promise<AuditListResponse> => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v === null || v === undefined || v === '') return;
      params.append(k, String(v));
    });
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await api.get(`/admin/audit-logs${qs}`);
    return (res?.data?.data ?? res?.data ?? { items: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1, hasNext: false, hasPrev: false }, filters: {} }) as AuditListResponse;
  },
};
