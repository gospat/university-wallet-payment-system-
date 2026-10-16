import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ShieldAlert } from 'lucide-react';
import { mapRoleToLogin, mapRoleToDashboard, type Role } from '../config/session';

interface PrivateRouteProps {
  roles?: Array<Role>;
  /**
   * Capability required to view the route (e.g. 'VIEW_STUDENTS').
   *
   * Role-only guards are not sufficient for the configurable BURSARY role, so a
   * route may additionally require a permission. ADMIN is the protected
   * super-administrator and always passes. The backend still enforces the same
   * permission — this guard is UX, not security.
   */
  permission?: string;
}

const privateRolesToLogin = (roles: Array<Role> | undefined) => {
  if (!roles) return '/student/login';
  if (roles.length === 1) return mapRoleToLogin(roles[0]);
  if (roles.includes('ADMIN')) return '/admin/login';
  if (roles.includes('BURSARY')) return '/bursary/login';
  return '/student/login';
};

const portalLabel = (role: Role | string): string => {
  if (role === 'ADMIN') return 'Admin';
  if (role === 'BURSARY') return 'Bursary';
  return 'Student';
};

type SessionUser = ReturnType<typeof useAuth>['user'];

const AccessDenied: React.FC<{ user?: SessionUser }> = ({ user }) => {
  const correctDashboard = user ? mapRoleToDashboard(user.role) : '/student/login';
  const correctLogin = user ? mapRoleToLogin(user.role) : '/student/login';
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 border border-gray-100 text-center">
        <div className="bg-red-100 p-4 rounded-full w-20 h-20 flex items-center justify-center mx-auto mb-6">
          <ShieldAlert className="h-10 w-10 text-red-600" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h1>
        <p className="text-gray-500 mb-6">
          Your account does not have the required permissions to view this page.
        </p>
        <div className="space-y-3">
          <a
            href={correctDashboard}
            className="block w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg"
          >
            Go to {user ? portalLabel(user.role) : ''} Portal
          </a>
          <a
            href={correctLogin}
            className="block w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-lg"
          >
            Return to {user ? portalLabel(user.role) : ''} Sign In
          </a>
        </div>
      </div>
    </div>
  );
};

const SessionSpinner: React.FC = () => (
  <div className="min-h-screen flex items-center justify-center bg-gray-50">
    <div className="inline-block h-10 w-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
  </div>
);

const PrivateRoute: React.FC<PrivateRouteProps> = ({ roles, permission }) => {
  const { user, isAuthenticated, isValidating } = useAuth();
  const location = useLocation();

  if (isValidating) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center text-gray-500" aria-live="polite">
          <div className="inline-block h-10 w-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-sm font-medium">Verifying session…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    const loginTarget = privateRolesToLogin(roles);
    const from = location.pathname + location.search + location.hash;
    const safeFrom =
      roles && from.startsWith(roles.length === 1 ? (roles[0] === 'ADMIN' ? '/admin/' : roles[0] === 'BURSARY' ? '/bursary/' : '/student/') : '/')
        ? from
        : undefined;
    return (
      <Navigate
        to={loginTarget}
        replace
        state={safeFrom ? { from: safeFrom } : undefined}
      />
    );
  }

  const roleDenied = !!(roles && user && !roles.includes(user.role));
  const permissionDenied = !roleDenied && !!permission && !hasPermission(user, permission);

  if (roleDenied || permissionDenied) {
    return <AccessDenied user={user} />;
  }

  if (roles && !user) {
    return <SessionSpinner />;
  }

  return <Outlet />;
};

/**
 * Does the session hold `permission`?
 * ADMIN is the protected super-administrator and always passes.
 * An EMPTY permissions array means "zero permissions" — it never grants access.
 */
export function hasPermission(user: SessionUser | null | undefined, permission: string): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  return Array.isArray(user.permissions) && user.permissions.includes(permission);
}

/**
 * Permission-aware route/element guard for the configurable BURSARY role.
 * Renders `children` when the session holds `permission`, otherwise the same
 * "Access Denied" screen used by PrivateRoute. ADMIN always passes.
 */
export const RequirePermission: React.FC<{ permission: string; children: React.ReactNode }> = ({
  permission,
  children,
}) => {
  const { user, isValidating } = useAuth();
  if (isValidating) return <SessionSpinner />;
  if (!user) return <SessionSpinner />;
  if (hasPermission(user, permission)) return <>{children}</>;
  return <AccessDenied user={user} />;
};

/**
 * Prefix identifying the report-VIEW capabilities that may grant entry to the
 * Reports Centre. Deliberately excludes:
 *   • `REPORTS_EXPORT_*` — an export capability alone is not permission to view
 *     reports;
 *   • `REPORTS_SCHEDULE` — ADMIN-only, so it can never be a BURSARY entry
 *     capability.
 * Any future `REPORTS_VIEW_*` key added to the canonical backend registry is
 * therefore admitted automatically and this rule can never drift.
 */
export const REPORTS_VIEW_PERMISSION_PREFIX = 'REPORTS_VIEW_';

/**
 * Does the session hold ANY of `permissions`, or any permission beginning with
 * `permissionPrefix`? ADMIN (the protected super-administrator) always passes;
 * an EMPTY permissions array means "zero permissions" and never grants access.
 *
 * Used where a single page is legitimately reachable through more than one
 * capability (e.g. the Reports Centre and the Bills workspace) — the backend
 * still enforces the specific capability for every individual request.
 */
export function hasAnyPermission(
  user: SessionUser | null | undefined,
  permissions?: string[],
  permissionPrefix?: string,
): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  const owned = user.permissions;
  if (!Array.isArray(owned) || owned.length === 0) return false;
  if (permissions && permissions.some((p) => owned.includes(p))) return true;
  if (permissionPrefix && owned.some((p) => p.startsWith(permissionPrefix))) return true;
  return false;
}

/**
 * Permission-aware route/element guard that renders `children` when the session
 * holds AT LEAST ONE of the supplied capabilities. ADMIN always passes.
 * Renders the same "Access Denied" screen as PrivateRoute otherwise.
 */
export const RequireAnyPermission: React.FC<{
  /** Explicit capability keys — pass when the allowed set is a fixed list. */
  permissions?: string[];
  /** Capability prefix — pass when any registered key with that prefix qualifies. */
  permissionPrefix?: string;
  children: React.ReactNode;
}> = ({ permissions, permissionPrefix, children }) => {
  const { user, isValidating } = useAuth();
  if (isValidating) return <SessionSpinner />;
  if (!user) return <SessionSpinner />;
  if (hasAnyPermission(user, permissions, permissionPrefix)) return <>{children}</>;
  return <AccessDenied user={user} />;
};

export default PrivateRoute;
