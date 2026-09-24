import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import StudentLogin from './pages/auth/StudentLogin';
import AdminLogin from './pages/auth/AdminLogin';
import BursaryLogin from './pages/auth/BursaryLogin';
import StudentDashboard from './pages/student/Dashboard';
import AdminDashboard from './pages/admin/Dashboard';
import AdminRefunds from './pages/admin/Refunds';
import AdminAuditLogs from './pages/admin/AuditLogs';
import AdminStudents from './pages/admin/Students';
import BursaryDashboard from './pages/bursary/Dashboard';
import BursaryRefunds from './pages/bursary/Refunds';
import PrivateRoute from './components/PrivateRoute';
import PortalShell from './components/PortalShell';
import { FileQuestion, Home, ShieldAlert } from 'lucide-react';
import { StudentFeesPage, InvoiceDetailPage } from './pages/student/Fees';
import { AdminFeesWrapped, BursaryFeesWrapped } from './pages/admin/Fees';
import PublicVerifyReceiptPage from './pages/public/PublicVerifyReceipt';
import StudentProfilePage from './pages/student/Profile';
import StudentCheckoutPage from './pages/student/Checkout';
import StudentCallbackPage from './pages/student/Callback';
import StudentPaymentConfirmation from './pages/student/PaymentConfirmation';
import { useAuth } from './context/AuthContext';
import { useBranding } from './context/BrandingContext';
import { i18n } from './i18n/en';
import { navCounters, NavCounters } from './services/api';
import FacultiesPage from './pages/admin/academic/Faculties';
import DepartmentsPage from './pages/admin/academic/Departments';
import ProgrammesPage from './pages/admin/academic/Programmes';
import LevelsPage from './pages/admin/academic/Levels';
import AcademicSessionsPage from './pages/admin/academic/AcademicSessions';
import UsersPage from './pages/admin/Users';
import RolesPage from './pages/admin/Roles';
import PermissionsPage from './pages/admin/Permissions';
import SystemSettingsPage from './pages/admin/SystemSettings';
import PaymentConfigPage from './pages/admin/PaymentConfig';
import AdminPaymentsPage from './pages/admin/Payments';
import AdminReceiptsPage from './pages/admin/Receipts';
import BursaryPaymentsPage from './pages/bursary/Payments';
import BursaryReceiptsPage from './pages/bursary/Receipts';
import StudentMyReceiptsPage from './pages/student/MyReceipts';
import { BursaryDirectBillingWrapped } from './pages/bursary/DirectBilling';

const UnauthorizedPage: React.FC = () => {
  const location = useLocation();
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 border border-gray-100 text-center">
        <div className="bg-red-100 p-4 rounded-full w-20 h-20 flex items-center justify-center mx-auto mb-6">
          <ShieldAlert className="h-10 w-10 text-red-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Unauthorized</h1>
        <p className="text-gray-500 mb-2">
          You do not have permission to access this resource.
        </p>
        {location.state?.from && (
          <p className="text-xs text-gray-400 mb-6 truncate">
            Requested: {location.state.from}
          </p>
        )}
        <a
          href="/"
          className="inline-flex items-center justify-center gap-2 w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg"
        >
          <Home className="h-4 w-4" /> Return Home
        </a>
      </div>
    </div>
  );
};

const NotFoundPage: React.FC = () => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 border border-gray-100 text-center">
        <div className="bg-blue-100 p-4 rounded-full w-20 h-20 flex items-center justify-center mx-auto mb-6">
          <FileQuestion className="h-10 w-10 text-blue-600" />
        </div>
        <p className="text-7xl font-black text-gray-200 mb-2">404</p>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Page Not Found</h1>
        <p className="text-gray-500 mb-6">
          The page you are looking for does not exist or has been moved.
        </p>
        <a
          href="/"
          className="inline-flex items-center justify-center gap-2 w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg"
        >
          <Home className="h-4 w-4" /> Return Home
        </a>
      </div>
    </div>
  );
};

const PortalChooser: React.FC = () => {
  const { brand, loading } = useBranding();
  const title = loading ? 'University Payment Platform' : (brand?.name || 'University Payment Platform');
  const logoUrl = brand?.logoUrl ?? null;
  const cards = [
    {
      title: 'Student Portal',
      sub: 'Fees, payments, receipts',
      to: '/student/login',
      accent: 'from-blue-50 to-blue-100 border-blue-200 text-blue-700',
    },
    {
      title: 'Administrative Portal',
      sub: 'System management',
      to: '/admin/login',
      accent: 'from-gray-50 to-gray-100 border-gray-300 text-gray-800',
    },
    {
      title: 'Bursary Portal',
      sub: 'Finance & operations',
      to: '/bursary/login',
      accent: 'from-amber-50 to-amber-100 border-amber-200 text-amber-700',
    },
  ];
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center px-4 py-12">
      <div className="max-w-4xl w-full">
        <div className="text-center mb-12">
          {logoUrl && (
            <img
              src={logoUrl}
              alt={title}
              className="h-20 w-auto mx-auto mb-6 object-contain"
              onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
            />
          )}
          <h1 className="text-4xl font-black text-gray-900 mb-3 tracking-tight">
            {title}
          </h1>
          <p className="text-lg text-gray-500">
            Choose the portal you would like to access.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-6">
          {cards.map((c) => (
            <a
              key={c.to}
              href={c.to}
              className={`block bg-gradient-to-br ${c.accent} rounded-2xl border p-8 shadow-lg hover:shadow-xl transition-all hover:-translate-y-1`}
            >
              <h2 className="text-xl font-bold mb-1">{c.title}</h2>
              <p className="text-sm opacity-80">{c.sub}</p>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
};

interface PlaceholderProps {
  role: 'ADMIN' | 'BURSARY' | 'STUDENT';
  activePath: string;
  title: string;
  subtitle?: string;
  message?: string;
}

const PlaceholderPage: React.FC<PlaceholderProps> = ({ role, activePath, title, subtitle, message }) => {
  const { user, logout } = useAuth();
  const [navCounts, setNavCounts] = React.useState<NavCounters>({});
  React.useEffect(() => {
    navCounters().then(setNavCounts);
  }, []);
  const brand = role === 'ADMIN'
    ? i18n.portals.admin.dashboardBrand
    : role === 'BURSARY'
    ? i18n.portals.bursary.dashboardBrand
    : i18n.portals.student.dashboardBrand;
  const userText = role === 'ADMIN'
    ? i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin')
    : role === 'BURSARY'
    ? `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()
    : `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || user?.email || '';
  const showGlobalSearch = role !== 'STUDENT';
  const content = (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="max-w-2xl w-full text-center bg-white border border-gray-200 rounded-2xl p-10 shadow-sm">
        <div className="bg-blue-50 p-5 rounded-full w-24 h-24 flex items-center justify-center mx-auto mb-6">
          <FileQuestion className="h-12 w-12 text-blue-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">{title}</h1>
        {subtitle && <p className="text-gray-500 mb-4">{subtitle}</p>}
        <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 px-5 py-4 text-sm">
          {message ?? 'This report is under construction.'}
        </div>
      </div>
    </div>
  );
  return (
    <PortalShell
      role={role}
      activePath={activePath}
      brand={brand}
      userText={userText}
      userEmail={user?.email}
      onLogout={logout}
      userPermissions={user?.permissions as string[] | undefined}
      navCounters={navCounts}
      showGlobalSearch={showGlobalSearch}
    >
      {content}
    </PortalShell>
  );
};

const App: React.FC = () => {
  return (
    <Router>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<PortalChooser />} />

          <Route path="/public/verify-receipt" element={<PublicVerifyReceiptPage />} />
          <Route path="/public/verify-receipt/:token" element={<PublicVerifyReceiptPage />} />
          <Route path="/verify-receipt/:token" element={<PublicVerifyReceiptPage />} />

          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/student/login" element={<StudentLogin />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/bursary/login" element={<BursaryLogin />} />

          <Route path="/unauthorized" element={<UnauthorizedPage />} />
          <Route path="/404" element={<NotFoundPage />} />

          <Route
            path="/_preview/sidebar/:role"
            element={(() => {
              const PreviewSidebarPage: React.FC = () => {
                const { role } = useParams<{ role: string }>();
                const normalized: 'ADMIN' | 'BURSARY' | 'STUDENT' =
                  String(role || '').toUpperCase() === 'BURSARY'
                    ? 'BURSARY'
                    : String(role || '').toUpperCase() === 'ADMIN'
                    ? 'ADMIN'
                    : 'STUDENT';
                const brand =
                  normalized === 'ADMIN'
                    ? i18n.portals.admin.dashboardBrand
                    : normalized === 'BURSARY'
                    ? i18n.portals.bursary.dashboardBrand
                    : i18n.portals.student.dashboardBrand;
                const userText =
                  normalized === 'ADMIN'
                    ? i18n.portals.admin.dashboardGreeting('Ade Admin')
                    : normalized === 'BURSARY'
                    ? 'Bursary: Bola Finance'
                    : 'Chidi Student';
                const userEmail =
                  normalized === 'ADMIN'
                    ? 'admin@university.edu.ng'
                    : normalized === 'BURSARY'
                    ? 'finance@university.edu.ng'
                    : 'chidi.student@university.edu.ng';
                const permissions: Record<string, string[]> = {
                  ADMIN: [
                    'VIEW_STUDENTS','CREATE_STUDENT','BULK_UPLOAD_STUDENTS',
                    'CREATE_FEE','EDIT_FEE','VIEW_PAYMENTS','VERIFY_PAYMENT','GENERATE_RECEIPT','PROCESS_REFUND',
                    'MANAGE_USERS','MANAGE_ROLES','SYSTEM_SETTINGS','PAYSTACK_CONFIG','AUDIT_LOGS_VIEW_FULL','AUDIT_LOGS_VIEW_LIMITED',
                  ],
                  BURSARY: [
                    'VIEW_STUDENTS','CREATE_STUDENT','BULK_UPLOAD_STUDENTS',
                    'CREATE_FEE','EDIT_FEE','VIEW_PAYMENTS','VERIFY_PAYMENT','GENERATE_RECEIPT','PROCESS_REFUND',
                    'AUDIT_LOGS_VIEW_LIMITED',
                  ],
                  STUDENT: [],
                };
                const counters: Record<string, number> = {
                  makePayment: 3,
                  refunds: 5,
                  failedWebhooks: 2,
                  pendingPayments: 12,
                };
                const showGlobalSearch = normalized !== 'STUDENT';
                const activeMap: Record<string, string> = {
                  ADMIN: '/admin/dashboard',
                  BURSARY: '/bursary/dashboard',
                  STUDENT: '/student/dashboard',
                };
                return (
                  <PortalShell
                    role={normalized}
                    activePath={activeMap[normalized]}
                    brand={brand}
                    userText={userText}
                    userEmail={userEmail}
                    onLogout={() => {}}
                    userPermissions={permissions[normalized] ?? []}
                    showGlobalSearch={showGlobalSearch}
                    navCounters={counters}
                  >
                    <div className="py-10 px-6">
                      <div className="max-w-4xl mx-auto">
                        <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Sidebar preview · no auth required</p>
                        <h1 className="text-3xl font-black text-gray-900 mb-2">
                          {normalized} Portal — Sidebar Preview
                        </h1>
                        <p className="text-gray-600 mb-8 leading-relaxed">
                          Left column shows the professional fixed-sidebar navigation for the <strong>{normalized}</strong> role.
                          Active item highlighted with role-tinted accent bar; nav-counter badges visible on key items; mobile drawer collapses for screens below 768px.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          {[
                            { to: '/_preview/sidebar/STUDENT', label: 'STUDENT Preview', accent: 'bg-blue-50 text-blue-700 border border-blue-200' },
                            { to: '/_preview/sidebar/ADMIN', label: 'ADMIN Preview', accent: 'bg-gray-50 text-gray-800 border border-gray-300' },
                            { to: '/_preview/sidebar/BURSARY', label: 'BURSARY Preview', accent: 'bg-amber-50 text-amber-700 border border-amber-200' },
                          ].map((c) => (
                            <a
                              key={c.to}
                              href={c.to}
                              className={`block rounded-xl p-5 shadow-sm hover:-translate-y-0.5 transition-transform ${c.accent}`}
                            >
                              <div className="text-xs uppercase tracking-wider mb-1 opacity-70">Switch role</div>
                              <div className="text-lg font-bold">{c.label}</div>
                            </a>
                          ))}
                        </div>
                        <div className="mt-10 bg-white border border-gray-200 rounded-2xl p-6 text-sm text-gray-700 space-y-2">
                          <p><span className="font-semibold">Active role:</span> {normalized}</p>
                          <p><span className="font-semibold">User permissions granted:</span> {(permissions[normalized] ?? []).length}</p>
                          <p><span className="font-semibold">Nav counter badges:</span> 5 pending refunds · 2 failed webhooks · 12 successful payments today</p>
                          <p><span className="font-semibold">Global search shown?</span> {showGlobalSearch ? 'Yes (Admin/Bursary top bar)' : 'No (Student)'}</p>
                        </div>
                      </div>
                    </div>
                  </PortalShell>
                );
              };
              return <PreviewSidebarPage />;
            })()}
          />

          <Route element={<PrivateRoute roles={['STUDENT']} />}>
            <Route path="/student/dashboard" element={<StudentDashboard />} />
            <Route path="/student/payments" element={<StudentFeesPage initialTab="browse" />} />
            <Route path="/student/payment-history" element={<StudentFeesPage initialTab="history" />} />
            <Route path="/student/fees/schedule" element={<StudentFeesPage initialTab="browse" />} />
            <Route path="/student/invoices" element={<StudentFeesPage initialTab="history" />} />
            <Route path="/student/invoices/:id" element={<InvoiceDetailPage />} />
            <Route path="/student/profile" element={<StudentProfilePage />} />
            <Route path="/student/payments/checkout/:invoiceId" element={<StudentCheckoutPage />} />
            <Route path="/student/callback" element={<StudentCallbackPage />} />
            <Route path="/student/payments/callback" element={<StudentCallbackPage />} />
            <Route path="/student/payments/callback/:paystackRef" element={<StudentCallbackPage />} />
            <Route path="/student/payments/confirm/:invoiceId" element={<StudentPaymentConfirmation />} />
            <Route path="/student/receipts" element={<StudentMyReceiptsWrapped />} />
            <Route path="/student/support" element={
              <PlaceholderPage
                role="STUDENT"
                activePath="/student/support"
                title="Student Support"
                subtitle="Contact the Bursary, IT Support, or access help documentation"
              />
            } />
          </Route>

          <Route element={<PrivateRoute roles={['ADMIN']} />}>
            <Route path="/admin/dashboard" element={<AdminDashboard />} />
            <Route path="/admin/students" element={<AdminStudentsWrapped />} />
            <Route path="/admin/fees" element={<AdminFeesWrapped />} />
            <Route path="/admin/fees/:tab" element={<AdminFeesWrapped />} />
            <Route path="/admin/refunds" element={<AdminRefunds />} />
            <Route path="/admin/audit-logs" element={<AdminAuditLogs />} />
            <Route path="/admin/users" element={<UsersPage />} />
            <Route path="/admin/roles" element={<RolesPage />} />
            <Route path="/admin/permissions" element={<PermissionsPage />} />
            <Route path="/admin/settings" element={<SystemSettingsPage />} />
            <Route path="/admin/payment-config" element={<PaymentConfigPage />} />

            <Route path="/admin/academic/faculties" element={<FacultiesPage />} />
            <Route path="/admin/academic/departments" element={<DepartmentsPage />} />
            <Route path="/admin/academic/programmes" element={<ProgrammesPage />} />
            <Route path="/admin/academic/levels" element={<LevelsPage />} />
            <Route path="/admin/academic/sessions" element={<AcademicSessionsPage />} />

            <Route path="/admin/payments" element={<AdminPaymentsWrapped />} />
            <Route path="/admin/receipts" element={<AdminReceiptsWrapped />} />
            <Route path="/admin/reports/daily" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/daily" title="Daily Reports" subtitle="Daily transaction summaries" />
            } />
            <Route path="/admin/reports/monthly" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/monthly" title="Monthly Reports" subtitle="Monthly financial summaries" />
            } />
            <Route path="/admin/reports/session" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/session" title="Session Reports" subtitle="Session-wise reporting" />
            } />
            <Route path="/admin/reports/fee" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/fee" title="Fee Reports" subtitle="Fee structure analysis" />
            } />
            <Route path="/admin/reports/faculty" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/faculty" title="Faculty Reports" subtitle="Faculty-level reporting" />
            } />
            <Route path="/admin/reports/department" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/department" title="Department Reports" subtitle="Department-level reporting" />
            } />
            <Route path="/admin/reports/programme" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/programme" title="Programme Reports" subtitle="Programme-level reporting" />
            } />
            <Route path="/admin/reports/student" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/student" title="Student Reports" subtitle="Per-student reporting" />
            } />
          </Route>

          <Route element={<PrivateRoute roles={['BURSARY', 'ADMIN']} />}>
            <Route path="/bursary/dashboard" element={<BursaryDashboard />} />
            <Route path="/bursary/students" element={<BursaryStudentsWrapped />} />
            <Route path="/bursary/fees" element={<BursaryFeesWrapped />} />
            <Route path="/bursary/fees/:tab" element={<BursaryFeesWrapped />} />
            <Route path="/bursary/refunds" element={<BursaryRefunds />} />

            <Route path="/bursary/payments" element={<BursaryPaymentsWrapped />} />
            <Route path="/bursary/receipts" element={<BursaryReceiptsWrapped />} />
            <Route path="/bursary/direct-billing" element={<BursaryDirectBillingWrapped />} />
            <Route path="/bursary/direct-billing/:tab" element={<BursaryDirectBillingWrapped />} />
            <Route path="/bursary/reports/daily" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/reports/daily" title="Daily Reports" subtitle="Daily transaction summaries" />
            } />
            <Route path="/bursary/reports/monthly" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/reports/monthly" title="Monthly Reports" subtitle="Monthly financial summaries" />
            } />
            <Route path="/bursary/reports/session" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/reports/session" title="Session Reports" subtitle="Session-wise reporting" />
            } />
            <Route path="/bursary/reports/fee" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/reports/fee" title="Fee Reports" subtitle="Fee structure analysis" />
            } />
            <Route path="/bursary/reports/faculty" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/reports/faculty" title="Faculty Reports" subtitle="Faculty-level reporting" />
            } />
            <Route path="/bursary/reports/department" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/reports/department" title="Department Reports" subtitle="Department-level reporting" />
            } />
            <Route path="/bursary/reports/programme" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/reports/programme" title="Programme Reports" subtitle="Programme-level reporting" />
            } />
            <Route path="/bursary/reports/student" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/reports/student" title="Student Reports" subtitle="Per-student reporting" />
            } />
            <Route path="/bursary/reconciliation" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/reconciliation" title="Reconciliation Dashboard" subtitle="Bursary reconciliation and settlement" />
            } />

            <Route path="/bursary/academic/faculties" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/academic/faculties" title="Faculties" subtitle="Academic faculties (Admin-managed)" />
            } />
            <Route path="/bursary/academic/departments" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/academic/departments" title="Departments" subtitle="Academic departments (Admin-managed)" />
            } />
            <Route path="/bursary/academic/programmes" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/academic/programmes" title="Programmes" subtitle="Academic programmes (Admin-managed)" />
            } />
            <Route path="/bursary/academic/levels" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/academic/levels" title="Levels" subtitle="Academic levels (Admin-managed)" />
            } />
            <Route path="/bursary/academic/sessions" element={
              <PlaceholderPage role="BURSARY" activePath="/bursary/academic/sessions" title="Academic Sessions" subtitle="Academic sessions (Admin-managed)" />
            } />
          </Route>

          <Route path="*" element={<Navigate to="/404" replace />} />
        </Routes>
      </AuthProvider>
    </Router>
  );
};

const StudentsWrappedBase: React.FC<{ role: 'ADMIN' | 'BURSARY' }> = ({ role }) => {
  const { user, logout } = useAuth();
  const dashboardTo = role === 'ADMIN' ? '/admin/dashboard' : '/bursary/dashboard';
  const brand = role === 'ADMIN' ? i18n.portals.admin.dashboardBrand : i18n.portals.bursary.dashboardBrand;
  const userText = role === 'ADMIN'
    ? i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin')
    : `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
  return (
    <AdminStudents
      role={role}
      brand={brand}
      userText={userText}
      onLogout={logout}
      goBack={() => { /* noop — tab nav active */ }}
      dashboardTo={dashboardTo}
    />
  );
};

const AdminStudentsWrapped: React.FC = () => <StudentsWrappedBase role="ADMIN" />;
const BursaryStudentsWrapped: React.FC = () => <StudentsWrappedBase role="BURSARY" />;

const PaymentsWrappedBase: React.FC<{ role: 'ADMIN' | 'BURSARY' }> = ({ role }) => {
  const { user, logout } = useAuth();
  const dashboardTo = role === 'ADMIN' ? '/admin/dashboard' : '/bursary/dashboard';
  const brand = role === 'ADMIN' ? i18n.portals.admin.dashboardBrand : i18n.portals.bursary.dashboardBrand;
  const userText = role === 'ADMIN'
    ? i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin')
    : `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
  const Comp = role === 'ADMIN' ? AdminPaymentsPage : BursaryPaymentsPage;
  return (
    <Comp
      role={role}
      brand={brand}
      userText={userText}
      onLogout={logout}
      goBack={() => {}}
      dashboardTo={dashboardTo}
    />
  );
};
const AdminPaymentsWrapped: React.FC = () => <PaymentsWrappedBase role="ADMIN" />;
const BursaryPaymentsWrapped: React.FC = () => <PaymentsWrappedBase role="BURSARY" />;

const ReceiptsWrappedBase: React.FC<{ role: 'ADMIN' | 'BURSARY' }> = ({ role }) => {
  const { user, logout } = useAuth();
  const dashboardTo = role === 'ADMIN' ? '/admin/dashboard' : '/bursary/dashboard';
  const brand = role === 'ADMIN' ? i18n.portals.admin.dashboardBrand : i18n.portals.bursary.dashboardBrand;
  const userText = role === 'ADMIN'
    ? i18n.portals.admin.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Admin')
    : `Bursary: ${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
  const Comp = role === 'ADMIN' ? AdminReceiptsPage : BursaryReceiptsPage;
  return (
    <Comp
      role={role}
      brand={brand}
      userText={userText}
      onLogout={logout}
      goBack={() => {}}
      dashboardTo={dashboardTo}
    />
  );
};
const AdminReceiptsWrapped: React.FC = () => <ReceiptsWrappedBase role="ADMIN" />;
const BursaryReceiptsWrapped: React.FC = () => <ReceiptsWrappedBase role="BURSARY" />;

const StudentMyReceiptsWrapped: React.FC = () => {
  const { user, logout } = useAuth();
  const brand = i18n.portals.student.dashboardBrand;
  const userText = i18n.portals.student.dashboardGreeting(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || 'Student');
  return (
    <StudentMyReceiptsPage
      brand={brand}
      userText={userText}
      onLogout={logout}
      goBack={() => {}}
      dashboardTo="/student/dashboard"
    />
  );
};

export default App;
