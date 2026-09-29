import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

export const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3001/api/v1';

type AppErrorData = {
  status?: string;
  message?: string;
  code?: number;
};

export type AuthExpiredHandler = () => void;

const pendingAuthHandlers = new Set<AuthExpiredHandler>();

export const onAuthExpired = (fn: AuthExpiredHandler): (() => void) => {
  pendingAuthHandlers.add(fn);
  return () => pendingAuthHandlers.delete(fn);
};

const fireAuthExpired = () => {
  pendingAuthHandlers.forEach((fn) => {
    try {
      fn();
    } catch (_) {
      /* noop */
    }
  });
};

const isBrowser = typeof window !== 'undefined';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  timeout: 30000,
  withCredentials: false,
});

const attachToken = (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
  if (!isBrowser) return config;
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
};

api.interceptors.request.use(attachToken, (error) => Promise.reject(error));

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<AppErrorData>) => {
    if (!error || !error.config) {
      return Promise.reject(error);
    }
    const status = error.response?.status;
    if (status === 401) {
      fireAuthExpired();
    }
    const safeMessage: string =
      error.response?.data?.message ||
      error.message ||
      (status === 403
        ? 'You do not have permission to perform this action.'
        : status === 429
        ? 'Too many requests. Please try again later.'
        : status === 404
        ? 'The requested resource was not found.'
        : status && status >= 500
        ? 'A server error occurred. Please try again later.'
        : 'An unexpected error occurred.');
    const enriched = new Error(safeMessage) as Error & {
      statusCode?: number;
      payload?: AppErrorData;
    };
    enriched.statusCode = status;
    enriched.payload = error.response?.data;
    return Promise.reject(enriched);
  }
);

export type NavCounters = Record<string, number> & {
  refunds?: number;
  failedWebhooks?: number;
  pendingPayments?: number;
  makePayment?: number;
};

export async function navCounters(): Promise<NavCounters> {
  try {
    const res = await api.get('/dashboard/nav-counters');
    return (res.data?.data ?? {}) as NavCounters;
  } catch (e) {
    return {};
  }
}

export async function downloadBlob(
  relativePath: string,
  fallbackFilename: string,
): Promise<void> {
  const resp = await api.get(relativePath, {
    responseType: 'blob',
  });
  const blob: Blob = resp.data;
  const url = URL.createObjectURL(blob);
  const headers = (resp.headers ?? {}) as Record<string, string>;
  const disp = headers['content-disposition'] ?? '';
  const match = disp.match(/filename="?([^"]+)"?/);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] || fallbackFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default api;
