import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import api, { onAuthExpired } from '../services/api';

interface User {
  id: number;
  email: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  role: 'STUDENT' | 'ADMIN' | 'BURSARY';
  matricNumber?: string | null;
  college?: string | null;
  department?: string | null;
  program?: string | null;
  level?: number | null;
  academicSession?: string | null;
  accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'GRADUATED' | 'WITHDRAWN';
  permissions?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: (reason?: 'SESSION_EXPIRED' | 'LOGOUT' | 'ACCOUNT_INACTIVE') => void;
  isAuthenticated: boolean;
  isValidating: boolean;
  authNotice?: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const STORAGE_TOKEN = 'token';
const STORAGE_USER = 'user';
const STORAGE_NOTICE = 'auth_notice';

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

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => readStorageUser());
  const [token, setToken] = useState<string | null>(() => readStorageToken());
  const [isValidating, setIsValidating] = useState<boolean>(true);
  const [authNotice, setAuthNotice] = useState<string | null>(
    () => (isBrowser ? localStorage.getItem(STORAGE_NOTICE) : null)
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const performSessionValidation = useCallback(async (): Promise<void> => {
    try {
      const res = await api.get<{ status: string; data: { user: User } }>('/auth/me');
      if (!mountedRef.current) return;
      const fresh: User = res.data.data.user;
      if (fresh.accountStatus && fresh.accountStatus !== 'ACTIVE') {
        setAuthNotice('Your account is no longer active.');
        localStorage.setItem(STORAGE_NOTICE, 'Your account is no longer active.');
        setToken(null);
        setUser(null);
        localStorage.removeItem(STORAGE_TOKEN);
        localStorage.removeItem(STORAGE_USER);
        setIsValidating(false);
        return;
      }
      setUser(fresh);
      localStorage.setItem(STORAGE_USER, JSON.stringify(fresh));
    } catch (err: any) {
      if (!mountedRef.current) return;
      if (err && (err.statusCode === 401 || err.statusCode === 403)) {
        setToken(null);
        setUser(null);
        localStorage.removeItem(STORAGE_TOKEN);
        localStorage.removeItem(STORAGE_USER);
        const msg =
          err.statusCode === 403
            ? 'Your account is no longer active.'
            : 'Your session has expired. Please log in again.';
        setAuthNotice(msg);
        localStorage.setItem(STORAGE_NOTICE, msg);
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
        localStorage.removeItem(STORAGE_NOTICE);
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
      setAuthNotice('Your session has expired. Please log in again.');
      if (isBrowser) {
        localStorage.setItem(STORAGE_NOTICE, 'Your session has expired. Please log in again.');
      }
      setToken(null);
      setUser(null);
      if (isBrowser) {
        localStorage.removeItem(STORAGE_TOKEN);
        localStorage.removeItem(STORAGE_USER);
      }
    });
    return unsub;
  }, []);

  const login = useCallback((newToken: string, newUser: User) => {
    if (isBrowser) {
      localStorage.setItem(STORAGE_TOKEN, newToken);
      localStorage.setItem(STORAGE_USER, JSON.stringify(newUser));
      localStorage.removeItem(STORAGE_NOTICE);
    }
    setToken(newToken);
    setUser(newUser);
    setAuthNotice(null);
    setIsValidating(false);
  }, []);

  const logout = useCallback(
    (reason: 'SESSION_EXPIRED' | 'LOGOUT' | 'ACCOUNT_INACTIVE' = 'LOGOUT') => {
      if (isBrowser) {
        localStorage.removeItem(STORAGE_TOKEN);
        localStorage.removeItem(STORAGE_USER);
        if (reason === 'SESSION_EXPIRED') {
          localStorage.setItem(
            STORAGE_NOTICE,
            'Your session has expired. Please log in again.'
          );
        } else if (reason === 'ACCOUNT_INACTIVE') {
          localStorage.setItem(STORAGE_NOTICE, 'Your account is no longer active.');
        } else {
          localStorage.removeItem(STORAGE_NOTICE);
        }
      }
      setToken(null);
      setUser(null);
      setIsValidating(false);
      if (reason === 'SESSION_EXPIRED') {
        setAuthNotice('Your session has expired. Please log in again.');
      } else if (reason === 'ACCOUNT_INACTIVE') {
        setAuthNotice('Your account is no longer active.');
      } else {
        setAuthNotice(null);
      }
    },
    []
  );

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      token,
      login,
      logout,
      isAuthenticated: !!token,
      isValidating,
      authNotice,
    }),
    [user, token, login, logout, isValidating, authNotice]
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
