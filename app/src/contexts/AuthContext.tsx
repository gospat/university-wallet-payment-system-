import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import api from "@/utils/api";
import { Permissions, UserRole } from "@/types/permissions";

/**
 * AuthContext — Module 2 + AC-22.
 *
 * AC-22 RULE:
 *   Permission merge priority:
 *     1. me.permissions          (from /auth/login user obj, highest priority)
 *     2. token-level permissions (e.g. decoded access token claims, next)
 *     3. fallback []            (lowest)
 *
 *   Merge order MUST be: Object.assign({}, fallback, tokenPerms, mePerms)
 *   OR spread:  { ...fallback, ...tokenPerms, ...mePerms }
 *   (NOT reversed).
 */

export interface AuthMe {
  id: number;
  email: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  matricNumber?: string | null;
  mustChangePassword: boolean;
  permissions: string[];
}

export interface LoginResponse {
  accessToken: string;
  user: AuthMe;
  mustChangePassword?: boolean;
}

interface AuthContextValue {
  token: string | null;
  me: AuthMe | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ mustChangePassword: boolean; me: AuthMe }>;
  logout: () => void;
  changePassword: (p: {
    oldPassword?: string;
    newPassword: string;
    confirmPassword: string;
  }) => Promise<void>;
  hasPermission: (key: Permissions | string) => boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const FALLBACK_PERMS: string[] = [];

function mergePerms(tokenPerms: string[] | undefined, mePerms: string[] | undefined): string[] {
  // Priority: mePerms > tokenPerms > FALLBACK_PERMS.
  // Use a Map to preserve priority while de-duping by index-of-first-seen.
  const map = new Map<string, number>();
  const base = [...FALLBACK_PERMS, ...(tokenPerms ?? []), ...(mePerms ?? [])];
  base.forEach((p, idx) => {
    if (!map.has(p)) map.set(p, idx);
  });
  return Array.from(map.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([p]) => p);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem("upg:token");
      return raw ? (JSON.parse(raw) as string) : null;
    } catch {
      return null;
    }
  });
  const [me, setMe] = useState<AuthMe | null>(() => {
    try {
      const raw = localStorage.getItem("upg:me");
      return raw ? (JSON.parse(raw) as AuthMe) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(false);

  const applySession = useCallback((t: string, m: AuthMe) => {
    setToken(t);
    setMe(m);
    localStorage.setItem("upg:token", JSON.stringify(t));
    localStorage.setItem("upg:me", JSON.stringify(m));
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setMe(null);
    localStorage.removeItem("upg:token");
    localStorage.removeItem("upg:me");
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      try {
        const { data } = await api.post<LoginResponse>("/auth/login", { email, password });
        const meWithMerge: AuthMe = {
          ...data.user,
          mustChangePassword: data.user.mustChangePassword ?? data.mustChangePassword ?? false,
          // AC-22: merge order fallback < token perms < me.permissions
          permissions: mergePerms(undefined, data.user.permissions),
        };
        applySession(data.accessToken, meWithMerge);
        return { mustChangePassword: meWithMerge.mustChangePassword, me: meWithMerge };
      } finally {
        setLoading(false);
      }
    },
    [applySession]
  );

  const changePassword = useCallback(
    async (body: { oldPassword?: string; newPassword: string; confirmPassword: string }) => {
      setLoading(true);
      try {
        await api.post("/auth/change-password", body);
        // Flip flag locally so UI re-evaluates mustChangePassword.
        if (me) {
          const updated: AuthMe = { ...me, mustChangePassword: false };
          applySession(token ?? "", updated);
        }
      } finally {
        setLoading(false);
      }
    },
    [applySession, me, token]
  );

  const refresh = useCallback(async () => {
    // Ping auth refresh via POST /auth/refresh — uses refresh token stored server side.
    try {
      const rt = localStorage.getItem("upg:refresh-token");
      const refreshToken = rt ? (JSON.parse(rt) as string) : undefined;
      if (!refreshToken) return;
      const { data } = await api.post<{
        accessToken: string;
        user: AuthMe;
      }>("/auth/refresh", { refreshToken });
      const me2: AuthMe = {
        ...data.user,
        permissions: mergePerms(undefined, data.user.permissions),
      };
      applySession(data.accessToken, me2);
    } catch {
      // logout? keep as-is; 401 interceptor will redirect.
    }
  }, [applySession]);

  const hasPermission = useCallback(
    (key: Permissions | string) => {
      if (!me) return false;
      // AC-22: use me.permissions (highest priority after merge)
      return me.permissions.includes(String(key));
    },
    [me]
  );

  useEffect(() => {
    // Silent refresh on mount if token present but me missing.
    if (token && !me) {
      refresh().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: AuthContextValue = useMemo(
    () => ({ token, me, loading, login, logout, changePassword, hasPermission, refresh }),
    [token, me, loading, login, logout, changePassword, hasPermission, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthContext must be used inside AuthProvider");
  return ctx;
}

export default AuthContext;
