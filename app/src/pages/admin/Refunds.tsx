import React from 'react';
import { ShieldAlert, LayoutDashboard, CreditCard } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PortalShell from '../../components/PortalShell';
import { useAuth } from '../../context/AuthContext';
import { useLocation } from 'react-router-dom';
import i18n from '../../i18n/en';

const AdminRefundsPage: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const fullName = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();

  const dashboardPath = '/admin/dashboard';
  const paymentsPath = '/admin/payments';

  return (
    <PortalShell
      role="ADMIN"
      activePath={location.pathname}
      brand={i18n.portals.admin.dashboardBrand}
      userText={fullName || i18n.portals.admin.dashboardGreeting('')}
      userEmail={user?.email ?? undefined}
      onLogout={logout}
      userPermissions={(user?.permissions as string[]) ?? []}
      showGlobalSearch
    >
      <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
        <div className="max-w-lg w-full">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="bg-amber-50 border-b border-amber-100 px-6 py-5 flex items-center gap-4">
              <div className="h-14 w-14 rounded-xl bg-amber-100 text-amber-700 grid place-items-center shrink-0">
                <ShieldAlert className="h-7 w-7" />
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-slate-900">Refunds Disabled</h1>
                <p className="text-sm text-amber-700 mt-0.5">Platform policy is in effect</p>
              </div>
            </div>

            <div className="px-6 py-6 space-y-4">
              <p className="text-sm leading-relaxed text-slate-700">
                Refunds are disabled per platform policy. For transaction reversals or account
                corrections, please contact the university bursary office or process a manual
                ledger adjustment.
              </p>
              <p className="text-xs leading-relaxed text-slate-500">
                Audit records of historical refunds remain viewable in the database and
                downloadable upon admin request.
              </p>
            </div>

            <div className="px-6 py-5 bg-slate-50 border-t border-slate-100 flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => navigate(dashboardPath)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white ring-1 ring-slate-200 hover:bg-slate-100 text-slate-700 text-sm font-medium transition-colors"
              >
                <LayoutDashboard className="h-4 w-4" />
                Back to Dashboard
              </button>
              <button
                type="button"
                onClick={() => navigate(paymentsPath)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium transition-colors"
              >
                <CreditCard className="h-4 w-4" />
                View Payments
              </button>
            </div>
          </div>
        </div>
      </div>
    </PortalShell>
  );
};

export default AdminRefundsPage;
