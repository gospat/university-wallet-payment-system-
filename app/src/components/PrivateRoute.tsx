import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ShieldAlert } from 'lucide-react';
import { mapRoleToLogin, mapRoleToDashboard, type Role } from '../config/session';

interface PrivateRouteProps {
  roles?: Array<Role>;
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

const PrivateRoute: React.FC<PrivateRouteProps> = ({ roles }) => {
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

  if (roles && user && !roles.includes(user.role)) {
    const correctDashboard = mapRoleToDashboard(user.role);
    const correctLogin = mapRoleToLogin(user.role);
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
              Go to {portalLabel(user.role)} Portal
            </a>
            <a
              href={correctLogin}
              className="block w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-lg"
            >
              Return to {portalLabel(user.role)} Sign In
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (roles && !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="inline-block h-10 w-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <Outlet />;
};

export default PrivateRoute;

