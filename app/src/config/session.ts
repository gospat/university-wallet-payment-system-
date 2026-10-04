export type Role = 'ADMIN' | 'BURSARY' | 'STUDENT';

export interface SessionTimingConfig {
  accessExpiresMs: number;
  refreshExpiresMs: number;
  idleTimeoutMs: number;
  warningCountdownMs: number;
  absoluteSessionMs: number;
}

export const SessionConfig: SessionTimingConfig = {
  accessExpiresMs: 15 * 60 * 1000,
  refreshExpiresMs: 7 * 24 * 60 * 60 * 1000,
  idleTimeoutMs: 15 * 60 * 1000,
  warningCountdownMs: 60 * 1000,
  absoluteSessionMs: 12 * 60 * 60 * 1000,
};

export const mapRoleToLogin = (role: Role | null | undefined | string): string => {
  if (role === 'ADMIN') return '/admin/login';
  if (role === 'BURSARY') return '/bursary/login';
  return '/login';
};

export const mapRoleToDashboard = (role: Role | null | undefined | string): string => {
  if (role === 'ADMIN') return '/admin/dashboard';
  if (role === 'BURSARY') return '/bursary/dashboard';
  return '/student/dashboard';
};

export const roleAllowedPrefix = (role: Role | null | undefined | string): string => {
  if (role === 'ADMIN') return '/admin/';
  if (role === 'BURSARY') return '/bursary/';
  return '/student/';
};
