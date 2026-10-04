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
  refetchUser: () => Promise<void>;
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

// ============================================================================
// JWT HELPERS — decode the access token's HS256 payload WITHOUT external deps.
// The access token is the SIGNED authoritative claim set returned by the server on login,
// and contains { id, role, permissions: string[], type: 'access' } in its middle segment
// (see api/src/services/auth.ts signAccessToken). We extract the permission
// permissions claim from the BASE64URL-encoded middle segment. This lets us correctly
// populate user.permissions on the frontend even when safeUserSelect (backend) forgot
// to include permissions in the login/refresh/me response body objects (which previously had no
// permissions field in safeUserSelect). Using the TOKEN as authority ensures that even if
// the server API response changes omits them, sidebar RBAC filtering stays correct.
// ============================================================================
interface DecodedTokenClaims {
  id?: number;
  role?: Role;
  permissions?: string[];
  type?: string;
  exp?: number;
  iat?: number;
  [k: string]: unknown;
}

function base64UrlDecode(s: string): string {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4));
  const padded = std + pad;
  if (typeof atob === 'function') {
    // Robust UTF-8 decoding path: atob → Uint8Array → TextDecoder.
    // Handles any valid UTF-8 byte sequence without throwing URIErrors
    // (unlike the percent-encoding trick with decodeURIComponent).
    const binary = atob(padded);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
      catch { /* fall through to binary fallback */ }
    }
    return binary;
  }
  // Node / polyfill fallback (use a relaxed cast to avoid Buffer/@types dependency)
  const g = globalThis as unknown as { Buffer?: { from: (input: string, enc: string) => { toString: (enc: string) => string } } };
  if (g.Buffer && typeof g.Buffer.from === 'function') {
    try { return g.Buffer.from(padded, 'base64').toString('utf-8'); }
    catch { return ''; }
  }
  return '';
}

function decodeTokenPayload(token: string | null | undefined): DecodedTokenClaims | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const jsonString = base64UrlDecode(parts[1]);
    if (!jsonString) return null;
    return JSON.parse(jsonString) as DecodedTokenClaims;
  } catch {
    return null;
  }
}

// Role-based fallback permission sets (belt-and-suspenders). If the JWT decode crashes
// (for any reason: malformed tokens, future JWT header changes, unknown encoding quirks)
// AND the backend safeUserSelect body still omits permissions (which it currently does),
// we STILL populate sensible defaults so the sidebar NEVER shows the dreaded
// "No menu items available" panel for an authenticated admin/bursary user.
// These arrays mirror the backend permissionSeed.ts exactly:
//   ADMIN → 39 permission keys (entire set, matches screenshot 39/39)
//   BURSARY → 33 keys = (39 total − 6 BURSARY_EXCLUDED keys), matches screenshot 33/39
const FALLBACK_ALL_PERMISSION_KEYS: string[] = [
  'VIEW_DASHBOARD',
  'VIEW_STUDENTS', 'CREATE_STUDENT', 'BULK_UPLOAD_STUDENTS', 'VIEW_IMPORT_HISTORY',
  'VIEW_BILL_CATEGORIES', 'VIEW_BILLS_CATALOGUE', 'CREATE_FEE', 'EDIT_FEE', 'BULK_UPLOAD_FEES', 'ASSIGN_FEES',
  'VIEW_PAYMENTS', 'VERIFY_PAYMENT', 'PROCESS_REFUND',
  'DIRECT_BILL_STUDENT', 'VIEW_DIRECT_BILLS_LOG',
  'VIEW_RECEIPTS', 'GENERATE_RECEIPT', 'VERIFY_RECEIPT',
  'AUDIT_LOGS_VIEW_LIMITED',
  'VIEW_COLLEGES', 'VIEW_DEPARTMENTS', 'VIEW_PROGRAMMES',
  'VIEW_RECONCILIATION', 'VIEW_RECONCILIATION_REPORTS',
  'MANAGE_USERS', 'MANAGE_ROLES', 'SYSTEM_SETTINGS', 'PAYSTACK_CONFIG', 'AUDIT_LOGS_VIEW_FULL',
  'REPORTS_VIEW_COLLECTIONS', 'REPORTS_VIEW_REVENUE', 'REPORTS_VIEW_ACCOUNTING',
  'REPORTS_VIEW_RECONCILIATION', 'REPORTS_VIEW_OUTSTANDING', 'REPORTS_VIEW_STUDENT_STATEMENT',
  'REPORTS_EXPORT_EXCEL', 'REPORTS_EXPORT_PDF', 'REPORTS_SCHEDULE',
];
const BURSARY_EXCLUDED_FALLBACK: ReadonlySet<string> = new Set([
  'MANAGE_USERS', 'MANAGE_ROLES', 'PAYSTACK_CONFIG', 'SYSTEM_SETTINGS', 'AUDIT_LOGS_VIEW_FULL', 'REPORTS_SCHEDULE',
]);
const FALLBACK_BURSARY_PERMISSION_KEYS: string[] = FALLBACK_ALL_PERMISSION_KEYS.filter(
  (k) => !BURSARY_EXCLUDED_FALLBACK.has(k),
);
const FALLBACK_PERMS_BY_ROLE: Readonly<Record<'ADMIN' | 'BURSARY', readonly string[]>> = {
  ADMIN: FALLBACK_ALL_PERMISSION_KEYS,
  BURSARY: FALLBACK_BURSARY_PERMISSION_KEYS,
};

function mergeTokenPermissionsIntoUser(
  user: User | null,
  token: string | null | undefined,
): User | null {
  if (!user) return null;
  const claims = decodeTokenPayload(token);
  const tokenPerms = Array.isArray(claims?.permissions) ? claims.permissions : null;
  const tokenRole: Role | undefined = (claims?.role as Role) || undefined;

  // === RBAC PRIORITY CHAIN (HIGHEST → LOWEST) ====================================
  // 1. user.permissions from API RESPONSE BODY (/auth/me, /auth/login, /auth/refresh)
  //    — HIGHEST PRIORITY. This is the actual RolePermission rows in the DB RIGHT
  //    NOW, re-fetched every time performSessionValidation() runs (page load,
  //    token change, refetchUser). If Admin disabled Students for Bursary in the
  //    Admin → Roles UI, then /auth/me returns user.permissions = 26 keys WITHOUT
  //    VIEW_STUDENTS/CREATE_STUDENT/… — and that MUST win over the STALE signed
  //    JWT accessToken claims, which were signed at the LAST login/refresh time
  //    (maybe 14 days ago, still showing the old 33). Prior implementation had
  //    these two REVERSED, causing the exact bug reported: "Admin unticked
  //    Students → Bursary sidebar still shows Student Management".
  // 2. tokenPerms (signed JWT accessToken claims) — used ONLY if API response body
  //    does NOT carry a permissions array (backwards compat / older servers).
  // 3. Role-based hardcoded fallback arrays (FALLBACK_PERMS_BY_ROLE) — absolute
  //    last resort so sidebar NEVER shows the empty "No menu items available"
  //    panel for a legitimately-authenticated admin/bursary user even if every
  //    single pipeline above failed (malformed token, backend omits field,
  //    corrupt JSON…).
  // =================================================================================
  let resolvedPerms: string[];
  if (Array.isArray(user.permissions) && user.permissions.length > 0) {
    resolvedPerms = user.permissions;
  } else if (tokenPerms && tokenPerms.length > 0) {
    resolvedPerms = tokenPerms;
  } else {
    const effectiveRole = (tokenRole ?? user.role) as 'ADMIN' | 'BURSARY' | 'STUDENT' | undefined;
    resolvedPerms = effectiveRole === 'ADMIN' || effectiveRole === 'BURSARY'
      ? [...FALLBACK_PERMS_BY_ROLE[effectiveRole]]
      : [];
  }

  return {
    ...user,
    role: tokenRole ?? user.role,
    permissions: resolvedPerms,
  };
}

// Ensure any side-effect helper: also persist the ENRICHED user (with merged permissions)
// to localStorage so that page reloads still have the correct data without needing
// a fresh login call.
function enrichAndStoreUser(user: User | null, token: string | null | undefined): User | null {
  const enriched = mergeTokenPermissionsIntoUser(user, token);
  if (isBrowser && enriched) {
    try { localStorage.setItem(STORAGE_USER, JSON.stringify(enriched)); } catch { /* ignore */ }
  }
  return enriched;
}

const readStorageUser = (): User | null => {
  if (!isBrowser) return null;
  try {
    const raw = localStorage.getItem(STORAGE_USER);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as User;
    // Even if cached user object may have stale / empty permissions. Always prefer the
    // current token's signed claims (permissions above the cached copy we read) to avoid the
    // exact same bug reported: user logs in and sidebar is cached user on the sidebar collapse.
    const tokenNow = readStorageToken();
    return mergeTokenPermissionsIntoUser(parsed, tokenNow);
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
                // Merge signed token permissions into freshUser before persisting + setState.
                // Token perms are the canonical authority; /auth/refresh response object may omit them.
                const enriched = enrichAndStoreUser(freshUser, newAccess);
                setUser(enriched);
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
      // Merge signed token permissions into fresh user. The /auth/me response safeUserSelect
      // currently omits the permissions field entirely; our decode-token helper fills that gap.
      const currentToken = readStorageToken();
      const enriched = enrichAndStoreUser(fresh, currentToken);
      setUser(enriched);
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
    // Merge signed token permissions into newUser. The login endpoint response body's
    // safeUserSelect currently does NOT include a `permissions` field, so without this
    // enrich step sidebar would filter ALL items for Bursary role (empty permissions
    // array) and only show the 6 Administration items for Admin (adminAllowed set).
    const enriched = enrichAndStoreUser(newUser, newToken);
    if (isBrowser) {
      localStorage.setItem(STORAGE_TOKEN, newToken);
      localStorage.setItem(STORAGE_LOGIN_AT, String(Date.now()));
      if (newRefreshToken) localStorage.setItem(STORAGE_REFRESH, newRefreshToken);
      else localStorage.removeItem(STORAGE_REFRESH);
      localStorage.removeItem(STORAGE_NOTICE);
    }
    setToken(newToken);
    setRefreshToken(newRefreshToken ?? null);
    setUser(enriched);
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
        // Merge signed token permissions into fresh user.
        const enriched = enrichAndStoreUser(freshUser, newAccess);
        setUser(enriched);
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

  const refetchUser = useCallback(async (): Promise<void> => {
    if (!token) return;
    setIsValidating(true);
    try {
      await performSessionValidation();
    } finally {
      if (mountedRef.current) {
        setIsValidating(false);
      }
    }
  }, [token, performSessionValidation]);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      token,
      refreshToken,
      login,
      refresh,
      logout,
      clearMustChangePassword,
      refetchUser,
      isAuthenticated: !!token,
      isValidating,
      authNotice,
    }),
    [user, token, refreshToken, login, refresh, logout, clearMustChangePassword, refetchUser, isValidating, authNotice]
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

