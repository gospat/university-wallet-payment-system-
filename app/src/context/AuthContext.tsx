import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import api, { onAuthExpired, setAuthTokenPersistence } from '../services/api';
import { mapRoleToDashboard, mapRoleToLogin, type Role } from '../config/session';

interface User {
  id: number;
  email: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  role: Role;
  matricNumber?: string | null;
  college?: string | null;
  department?: string | null;
  program?: string | null;
  level?: number | null;
  academicSession?: string | null;
  accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'GRADUATED' | 'WITHDRAWN';
  mustChangePassword?: boolean | null;
  permissions?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  login: (token: string, user: User, refreshToken?: string | null) => void;
  refresh: () => Promise<boolean>;
  logout: (reason?: 'SESSION_EXPIRED' | 'LOGOUT' | 'ACCOUNT_INACTIVE') => Promise<void>;
  clearMustChangePassword: () => void;
  isAuthenticated: boolean;
  isValidating: boolean;
  authNotice?: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const STORAGE_TOKEN = 'token';
const STORAGE_REFRESH = 'refreshToken';
const STORAGE_USER = 'user';
const STORAGE_NOTICE = 'auth_notice';
const STORAGE_LOGIN_AT = 'login_at';

export { STORAGE_TOKEN, STORAGE_USER, STORAGE_NOTICE, STORAGE_REFRESH, STORAGE_LOGIN_AT };

const isBrowser = typeof window !== 'undefined';

const readStorageUser = (): User | null => {
  if (!isBrowser) return null;
  try {
    const raw = localStorage.getItem(STORAGE_USER);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch (_) {
    return null;
  }
};

const readStorageToken = (): string | null => {
  if (!isBrowser) return null;
  return localStorage.getItem(STORAGE_TOKEN);
};

const readStorageRefresh = (): string | null => {
  if (!isBrowser) return null;
  return localStorage.getItem(STORAGE_REFRESH);
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => readStorageUser());
  const [token, setToken] = useState<string | null>(() => readStorageToken());
  const [refreshToken, setRefreshToken] = useState<string | null>(() => readStorageRefresh());
  const [isValidating, setIsValidating] = useState<boolean>(true);
  const [authNotice, setAuthNotice] = useState<string | null>(
    () => (isBrowser ? localStorage.getItem(STORAGE_NOTICE) : null)
  );
  const mountedRef = useRef(true);
  const refreshPromiseRef = useRef<Promise<boolean> | null>(null);
  const logoutInFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    setAuthTokenPersistence({
      getAccessToken: readStorageToken,
      getRefreshToken: readStorageRefresh,
      setTokens: (accessToken, refreshTokenNew) => {
        if (!isBrowser) return;
        if (accessToken) localStorage.setItem(STORAGE_TOKEN, accessToken);
        else localStorage.removeItem(STORAGE_TOKEN);
        if (refreshTokenNew) localStorage.setItem(STORAGE_REFRESH, refreshTokenNew);
        else localStorage.removeItem(STORAGE_REFRESH);
        setToken(accessToken ?? null);
        setRefreshToken(refreshTokenNew ?? null);
      },
      clearAll: () => {
        if (!isBrowser) return;
        localStorage.removeItem(STORAGE_TOKEN);
        localStorage.removeItem(STORAGE_REFRESH);
        localStorage.removeItem(STORAGE_USER);
        setToken(null);
        setRefreshToken(null);
        setUser(null);
      },
      onRefreshRequired: async (): Promise<{ accessToken: string; refreshToken: string } | null> => {
        if (refreshPromiseRef.current) {
          return refreshPromiseRef.current.then((ok) => {
            if (!ok) return null;
            return { accessToken: readStorageToken() || '', refreshToken: readStorageRefresh() || '' };
          });
        }
        refreshPromiseRef.current = (async () => {
          try {
            const rt = readStorageRefresh();
            if (!rt) return false;
            const res = await api.post<{ status: string; data?: { user?: User }; accessToken?: string; refreshToken?: string; token?: string }>(
              '/auth/refresh',
              { refreshToken: rt },
            );
            const newAccess = res.data?.accessToken ?? res.data?.token ?? null;
            const newRefresh = res.data?.refreshToken ?? null;
            if (!newAccess) return false;
            if (isBrowser) {
              localStorage.setItem(STORAGE_TOKEN, newAccess);
              if (newRefresh) localStorage.setItem(STORAGE_REFRESH, newRefresh);
              const freshUser = (res.data?.data?.user as User | undefined) ?? null;
              if (freshUser) {
                localStorage.setItem(STORAGE_USER, JSON.stringify(freshUser));
                setUser(freshUser);
              }
            }
            setToken(newAccess);
            setRefreshToken(newRefresh);
            return true;
          } catch {
            return false;
          } finally {
            refreshPromiseRef.current = null;
          }
        })();
        const ok = await refreshPromiseRef.current;
        if (!ok) return null;
        return { accessToken: readStorageToken() || '', refreshToken: readStorageRefresh() || '' };
      },
      onAuthExpired: () => {
        fireLogoutNotice('SESSION_EXPIRED');
      },
    });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fireLogoutNotice = useCallback(
    (reason: 'SESSION_EXPIRED' | 'LOGOUT' | 'ACCOUNT_INACTIVE') => {
      if (isBrowser) {
        localStorage.removeItem(STORAGE_TOKEN);
        localStorage.removeItem(STORAGE_REFRESH);
        localStorage.removeItem(STORAGE_USER);
        if (reason === 'SESSION_EXPIRED') {
          localStorage.setItem(STORAGE_NOTICE, 'Your session has expired. Please log in again.');
        } else if (reason === 'ACCOUNT_INACTIVE') {
          localStorage.setItem(STORAGE_NOTICE, 'Your account is no longer active.');
        } else {
          localStorage.removeItem(STORAGE_NOTICE);
        }
      }
      setToken(null);
      setRefreshToken(null);
      setUser(null);
      setIsValidating(false);
      if (reason === 'SESSION_EXPIRED') {
        setAuthNotice('Your session has expired. Please log in again.');
      } else if (reason === 'ACCOUNT_INACTIVE') {
        setAuthNotice('Your account is no longer active.');
      } else {
        setAuthNotice(null);
      }
      if (isBrowser) {
        const role = readStorageUser()?.role ?? null;
        const loginUrl = mapRoleToLogin(role);
        const dest = `${window.location.origin}${loginUrl}`;
        try {
          if (window.location.pathname !== loginUrl) {
            window.location.assign(dest);
          }
        } catch (_) {
          /* noop */
        }
      }
    },
    [],
  );

  const performSessionValidation = useCallback(async (): Promise<void> => {
    try {
      const res = await api.get<{ status: string; data: { user: User } }>('/auth/me');
      if (!mountedRef.current) return;
      const fresh: User = res.data.data.user;
      if (fresh.accountStatus && fresh.accountStatus !== 'ACTIVE') {
        setAuthNotice('Your account is no longer active.');
        if (isBrowser) {
          localStorage.setItem(STORAGE_NOTICE, 'Your account is no longer active.');
        }
        setToken(null);
        setRefreshToken(null);
        setUser(null);
        if (isBrowser) {
          localStorage.removeItem(STORAGE_TOKEN);
          localStorage.removeItem(STORAGE_REFRESH);
          localStorage.removeItem(STORAGE_USER);
        }
        setIsValidating(false);
        return;
      }
      setUser(fresh);
      if (isBrowser) localStorage.setItem(STORAGE_USER, JSON.stringify(fresh));
    } catch (err: any) {
      if (!mountedRef.current) return;
      if (err && (err.statusCode === 401 || err.statusCode === 403)) {
        setToken(null);
        setRefreshToken(null);
        setUser(null);
        if (isBrowser) {
          localStorage.removeItem(STORAGE_TOKEN);
          localStorage.removeItem(STORAGE_REFRESH);
          localStorage.removeItem(STORAGE_USER);
        }
        const msg =
          err.statusCode === 403
            ? 'Your account is no longer active.'
            : 'Your session has expired. Please log in again.';
        setAuthNotice(msg);
        if (isBrowser) localStorage.setItem(STORAGE_NOTICE, msg);
      }
    } finally {
      if (mountedRef.current) {
        setIsValidating(false);
      }
    }
  }, []);

  useEffect(() => {
    if (authNotice) {
      const t = window.setTimeout(() => {
        setAuthNotice(null);
        if (isBrowser) localStorage.removeItem(STORAGE_NOTICE);
      }, 10000);
      return () => window.clearTimeout(t);
    }
  }, [authNotice]);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setIsValidating(false);
      return;
    }
    setIsValidating(true);
    Promise.resolve().then(() => {
      if (!cancelled && mountedRef.current) {
        performSessionValidation();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, performSessionValidation]);

  useEffect(() => {
    const unsub = onAuthExpired(() => {
      fireLogoutNotice('SESSION_EXPIRED');
    });
    return unsub;
  }, [fireLogoutNotice]);

  const login = useCallback((newToken: string, newUser: User, newRefreshToken?: string | null) => {
    if (isBrowser) {
      localStorage.setItem(STORAGE_TOKEN, newToken);
      localStorage.setItem(STORAGE_USER, JSON.stringify(newUser));
      localStorage.setItem(STORAGE_LOGIN_AT, String(Date.now()));
      if (newRefreshToken) localStorage.setItem(STORAGE_REFRESH, newRefreshToken);
      else localStorage.removeItem(STORAGE_REFRESH);
      localStorage.removeItem(STORAGE_NOTICE);
    }
    setToken(newToken);
    setRefreshToken(newRefreshToken ?? null);
    setUser(newUser);
    setAuthNotice(null);
    setIsValidating(false);
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!isBrowser) return false;
    try {
      const rt = localStorage.getItem(STORAGE_REFRESH);
      if (!rt) return false;
      const res = await api.post<{ status: string; data?: { user?: User }; accessToken?: string; refreshToken?: string; token?: string }>(
        '/auth/refresh',
        { refreshToken: rt },
      );
      const newAccess = res.data?.accessToken ?? res.data?.token ?? null;
      const newRefresh = res.data?.refreshToken ?? null;
      if (!newAccess) return false;
      localStorage.setItem(STORAGE_TOKEN, newAccess);
      if (newRefresh) localStorage.setItem(STORAGE_REFRESH, newRefresh);
      const freshUser = (res.data?.data?.user as User | undefined) ?? null;
      if (freshUser) {
        localStorage.setItem(STORAGE_USER, JSON.stringify(freshUser));
        setUser(freshUser);
      }
      setToken(newAccess);
      setRefreshToken(newRefresh);
      return true;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(
    async (reason: 'SESSION_EXPIRED' | 'LOGOUT' | 'ACCOUNT_INACTIVE' = 'LOGOUT') => {
      if (logoutInFlightRef.current) return;
      logoutInFlightRef.current = true;
      try {
        if (reason === 'LOGOUT' && isBrowser) {
          const rt = localStorage.getItem(STORAGE_REFRESH);
          if (rt) {
            try {
              await api
                .post('/auth/logout', { refreshToken: rt })
                .catch(() => {});
            } catch {
              /* noop */
            }
          }
        }
      } finally {
        fireLogoutNotice(reason);
        logoutInFlightRef.current = false;
      }
    },
    [fireLogoutNotice],
  );

  const clearMustChangePassword = useCallback(() => {
    setUser((u) => {
      if (!u) return u;
      const next = { ...u, mustChangePassword: false };
      if (isBrowser) {
        localStorage.setItem(STORAGE_USER, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      token,
      refreshToken,
      login,
      refresh,
      logout,
      clearMustChangePassword,
      isAuthenticated: !!token,
      isValidating,
      authNotice,
    }),
    [user, token, refreshToken, login, refresh, logout, clearMustChangePassword, isValidating, authNotice]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
};

export const __helpers = { mapRoleToDashboard, mapRoleToLogin };

