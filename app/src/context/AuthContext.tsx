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
import { getAccessToken, setAccessToken, clearAccessToken } from '../utils/tokenStore';

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
  lastLoginAt?: string | null;
  /**
   * PROTECTED SUPER ADMINISTRATOR flag (contract D1).
   *
   * Super Admin is a FLAG on `role === 'ADMIN'`, not a distinct Role. Only a
   * session with `role === 'ADMIN' && isSuperAdmin === true` is unrestricted.
   * A normal ADMIN (flag absent/false) is evaluated against its permissions
   * array exactly like any other role.
   */
  isSuperAdmin?: boolean;
  /**
   * Individual access mode (contract D2). INHERIT (default) = the user holds
   * the whole role baseline; CUSTOM = the user holds role-base ∩ selected keys.
   * Purely informational on the client — the backend resolves the effective set.
   */
  accessMode?: 'INHERIT' | 'CUSTOM';
  permissions?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
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
const STORAGE_USER = 'user';
const STORAGE_NOTICE = 'auth_notice';
const STORAGE_LOGIN_AT = 'login_at';
// ---------------------------------------------------------------------------
// LEGACY TOKEN KEYS (requirement 10 — migration cleanup)
// ---------------------------------------------------------------------------
// Pre-migration builds persisted BOTH the access token (`token`) and the
// refresh token (`refreshToken`) in script-accessible `localStorage`. Neither
// is read any more: the access token now lives ONLY in memory and the refresh
// token ONLY in an HttpOnly cookie. These keys are purged so a stale credential
// can never be replayed from localStorage.
// ---------------------------------------------------------------------------
const LEGACY_TOKEN_KEY = 'token';
const LEGACY_REFRESH_KEY = 'refreshToken';

export { STORAGE_TOKEN, STORAGE_USER, STORAGE_NOTICE, STORAGE_LOGIN_AT };

const isBrowser = typeof window !== 'undefined';

/** Purge any token material written by pre-migration builds. */
const purgeLegacyTokenStorage = (): void => {
  if (!isBrowser) return;
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_REFRESH_KEY);
  } catch {
    /* ignore */
  }
};

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

function mergeTokenPermissionsIntoUser(
  user: User | null,
  token: string | null | undefined,
): User | null {
  if (!user) return null;
  const claims = decodeTokenPayload(token);
  const tokenPerms = Array.isArray(claims?.permissions) ? claims.permissions : null;
  const tokenRole: Role | undefined = (claims?.role as Role) || undefined;

  // === RBAC PRIORITY CHAIN (HIGHEST → LOWEST) ====================================
  // 1. user.permissions from the API RESPONSE BODY (/auth/me, /auth/login,
  //    /auth/refresh) — AUTHORITATIVE. The backend resolves it from the ONE
  //    canonical registry: ADMIN always receives the full registry, BURSARY is
  //    resolved LIVE from the RolePermission table.
  //    An EMPTY array is a VALID, MEANINGFUL value — it means "this role has no
  //    permissions". It must NEVER be replaced by an invented default, otherwise
  //    removing a permission in Admin → Roles would appear to have no effect.
  // 2. tokenPerms (signed JWT accessToken claims) — used ONLY when the API
  //    response carries no permissions array at all (older/partial payload).
  // 3. [] — the frontend deliberately does NOT maintain its own hardcoded
  //    permission list; it cannot know the backend registry.
  // =================================================================================
  let resolvedPerms: string[];
  if (Array.isArray(user.permissions)) {
    resolvedPerms = user.permissions;
  } else if (tokenPerms) {
    resolvedPerms = tokenPerms;
  } else {
    resolvedPerms = [];
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
    // Always prefer the current in-memory access token's signed claims over the
    // cached copy to avoid a stale-permissions sidebar. On a cold load the
    // in-memory token is empty until the silent cookie restore completes, in
    // which case the cached (already-enriched) user is returned unchanged.
    return mergeTokenPermissionsIntoUser(parsed, getAccessToken());
  } catch (_) {
    return null;
  }
};

type RefreshResponse = {
  status?: string;
  data?: { user?: User };
  accessToken?: string;
  token?: string;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => readStorageUser());
  // The access token lives ONLY in memory (never localStorage). On a cold load it
  // starts empty and is restored from the HttpOnly refresh cookie by the silent
  // boot restore below.
  const [token, setToken] = useState<string | null>(() => getAccessToken());
  const [isValidating, setIsValidating] = useState<boolean>(true);
  const [authNotice, setAuthNotice] = useState<string | null>(
    () => (isBrowser ? localStorage.getItem(STORAGE_NOTICE) : null)
  );
  // Flips true once the one-time silent cookie restore has finished, so a reload
  // never flashes the login page before the restore attempt resolves.
  const [bootChecked, setBootChecked] = useState<boolean>(false);
  const mountedRef = useRef(true);
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);
  const logoutInFlightRef = useRef(false);

  /**
   * Exchange the HttpOnly refresh cookie for a fresh access token.
   *
   * The refresh credential is NEVER exposed to JS: the browser attaches the
   * cookie automatically (withCredentials) and the server returns the rotated
   * refresh token as another HttpOnly cookie. Only the short-lived access token
   * is retained — and only in memory. Concurrent callers share one in-flight
   * request; the request carries NO body.
   */
  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;

    const attempt = (async (): Promise<string | null> => {
      try {
        // NO request body — the HttpOnly cookie IS the credential. The
        // `__skipAuthRefresh` flag stops the shared client's 401 interceptor
        // from recursing back into this same refresh path.
        const res = await api.post<RefreshResponse>('/auth/refresh', undefined, {
          __skipAuthRefresh: true,
        } as any);
        const newAccess = res.data?.accessToken ?? res.data?.token ?? null;
        if (!newAccess) return null;
        setAccessToken(newAccess);
        setToken(newAccess);
        const freshUser = (res.data?.data?.user as User | undefined) ?? null;
        if (freshUser) {
          // Token permissions are the canonical authority; the refresh response
          // body may omit them.
          setUser(enrichAndStoreUser(freshUser, newAccess));
        }
        return newAccess;
      } catch {
        return null;
      }
    })();

    refreshPromiseRef.current = attempt;
    try {
      return await attempt;
    } finally {
      if (refreshPromiseRef.current === attempt) refreshPromiseRef.current = null;
    }
  }, []);

  const fireLogoutNotice = useCallback(
    (reason: 'SESSION_EXPIRED' | 'LOGOUT' | 'ACCOUNT_INACTIVE') => {
      clearAccessToken();
      if (isBrowser) {
        localStorage.removeItem(STORAGE_USER);
        purgeLegacyTokenStorage();
        if (reason === 'SESSION_EXPIRED') {
          localStorage.setItem(STORAGE_NOTICE, 'Your session has expired. Please log in again.');
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
        clearAccessToken();
        setToken(null);
        setUser(null);
        if (isBrowser) {
          localStorage.removeItem(STORAGE_USER);
          purgeLegacyTokenStorage();
        }
        setIsValidating(false);
        return;
      }
      // Merge signed token permissions into fresh user. The /auth/me response
      // safeUserSelect omits the permissions field; the decode-token helper fills
      // that gap from the in-memory access token.
      setUser(enrichAndStoreUser(fresh, getAccessToken()));
    } catch (err: any) {
      if (!mountedRef.current) return;
      if (err && (err.statusCode === 401 || err.statusCode === 403)) {
        clearAccessToken();
        setToken(null);
        setUser(null);
        if (isBrowser) {
          localStorage.removeItem(STORAGE_USER);
          purgeLegacyTokenStorage();
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

  // Register the shared API client's auth bridge and purge any token material
  // persisted by pre-migration builds. The bridge NEVER hands the refresh token
  // to the client — the HttpOnly cookie is managed entirely by the browser.
  useEffect(() => {
    mountedRef.current = true;
    purgeLegacyTokenStorage();
    setAuthTokenPersistence({
      getAccessToken,
      setTokens: (accessToken) => {
        setAccessToken(accessToken);
        setToken(accessToken ?? null);
      },
      clearAll: () => {
        clearAccessToken();
        if (isBrowser) {
          try { localStorage.removeItem(STORAGE_USER); } catch { /* ignore */ }
        }
        purgeLegacyTokenStorage();
        setToken(null);
        setUser(null);
      },
      onRefreshRequired: async (): Promise<{ accessToken: string } | null> => {
        const accessToken = await refreshAccessToken();
        return accessToken ? { accessToken } : null;
      },
      onAuthExpired: () => {
        fireLogoutNotice('SESSION_EXPIRED');
      },
    });
    return () => {
      mountedRef.current = false;
    };
  }, [refreshAccessToken, fireLogoutNotice]);

  useEffect(() => {
    if (authNotice) {
      const t = window.setTimeout(() => {
        setAuthNotice(null);
        if (isBrowser) localStorage.removeItem(STORAGE_NOTICE);
      }, 10000);
      return () => window.clearTimeout(t);
    }
  }, [authNotice]);

  // -------------------------------------------------------------------------
  // SILENT SESSION RESTORE (requirement 10)
  // -------------------------------------------------------------------------
  // The access token is memory-only, so a page reload starts with no bearer
  // token. If a previous session left a cached identity, silently exchange the
  // HttpOnly refresh cookie for a fresh access token; a genuinely signed-out
  // visitor is skipped (no needless probe).
  // -------------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        if (!getAccessToken() && readStorageUser()) {
          await refreshAccessToken();
        }
      } finally {
        if (mountedRef.current) setBootChecked(true);
      }
    })();
  }, [refreshAccessToken]);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      // Delay the "signed out" conclusion until the boot restore has resolved.
      if (bootChecked) setIsValidating(false);
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
  }, [token, bootChecked, performSessionValidation]);

  useEffect(() => {
    const unsub = onAuthExpired(() => {
      fireLogoutNotice('SESSION_EXPIRED');
    });
    return unsub;
  }, [fireLogoutNotice]);

  const login = useCallback((newToken: string, newUser: User, _refreshToken?: string | null) => {
    // Merge signed token permissions into newUser. The login endpoint response body's
    // safeUserSelect currently does NOT include a `permissions` field, so without this
    // enrich step sidebar would filter ALL items for Bursary role (empty permissions
    // array) and only show the 6 Administration items for Admin (adminAllowed set).
    //
    // The third parameter (a refresh token) is intentionally IGNORED: the refresh
    // credential is delivered exclusively as an HttpOnly cookie and must never be
    // persisted by frontend JS. It is retained only for backward compatibility.
    const enriched = enrichAndStoreUser(newUser, newToken);
    setAccessToken(newToken);
    if (isBrowser) {
      localStorage.setItem(STORAGE_LOGIN_AT, String(Date.now()));
      localStorage.removeItem(STORAGE_NOTICE);
    }
    // Drop any token material written by pre-migration builds.
    purgeLegacyTokenStorage();
    setToken(newToken);
    setUser(enriched);
    setAuthNotice(null);
    setIsValidating(false);
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    const accessToken = await refreshAccessToken();
    return Boolean(accessToken);
  }, [refreshAccessToken]);

  const logout = useCallback(
    async (reason: 'SESSION_EXPIRED' | 'LOGOUT' | 'ACCOUNT_INACTIVE' = 'LOGOUT') => {
      if (logoutInFlightRef.current) return;
      logoutInFlightRef.current = true;
      try {
        if (reason === 'LOGOUT') {
          // The HttpOnly refresh cookie is attached automatically
          // (withCredentials); the server revokes the session and clears it.
          try {
            await api.post('/auth/logout').catch(() => {});
          } catch {
            /* noop */
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
      login,
      refresh,
      logout,
      clearMustChangePassword,
      refetchUser,
      isAuthenticated: !!token,
      isValidating,
      authNotice,
    }),
    [user, token, login, refresh, logout, clearMustChangePassword, refetchUser, isValidating, authNotice]
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

