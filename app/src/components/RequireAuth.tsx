import React, { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

/**
 * RequireAuth — Module 2 AC-11.2 flow gate.
 *   - User not authenticated → /login
 *   - Authenticated but mustChangePassword=true AND current route != /change-password → /change-password
 *   - Otherwise → renders children (or <Outlet/>).
 */
export default function RequireAuth({
  children,
}: {
  children?: React.ReactNode;
}) {
  const { isAuthenticated, mustChangePassword, me } = useAuth();
  const location = useLocation();

  useEffect(() => {
    // placeholder
  }, []);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (
    mustChangePassword &&
    location.pathname !== "/change-password" &&
    location.pathname !== "/login"
  ) {
    return <Navigate to="/change-password" replace state={{ from: location }} />;
  }
  if (!children) {
    // Used as an <Outlet/> wrapper in <Route>.
    return null;
  }
  return <>{children}</>;
}

/**
 * RequirePermission — wraps children with an additional RBAC check.
 * If permission missing, redirects to /no-permission.
 */
export function RequirePermission({
  permission,
  children,
}: {
  permission: string;
  children: React.ReactNode;
}) {
  const { hasPermission } = useAuth();
  if (!hasPermission(permission)) {
    return <Navigate to="/no-permission" replace />;
  }
  return <>{children}</>;
}
