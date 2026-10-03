import { useAuthContext } from "@/contexts/AuthContext";
import { Permissions } from "@/types/permissions";

/**
 * Hook — mirrors the pattern `useAuth()` / `hasPermission()` used everywhere else.
 */
export function useAuth() {
  const ctx = useAuthContext();
  return {
    ...ctx,
    isAuthenticated: !!ctx.token && !!ctx.me,
    role: ctx.me?.role ?? null,
    mustChangePassword: ctx.me?.mustChangePassword ?? false,
    hasPermission: (key: Permissions | string) => ctx.hasPermission(key),
  };
}
export default useAuth;
