import React, { Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import ForcePasswordChangeGate from './components/ForcePasswordChangeGate';
import SessionInactivityModal from './components/SessionInactivityModal';
import StudentLogin from './pages/auth/StudentLogin';
import AdminLogin from './pages/auth/AdminLogin';
import BursaryLogin from './pages/auth/BursaryLogin';
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage';
import ResetPasswordPage from './pages/auth/ResetPasswordPage';
import StudentDashboard from './pages/student/Dashboard';
import PrivateRoute from './components/PrivateRoute';
import PortalShell from './components/PortalShell';
import { FileQuestion, Home, ShieldAlert, Loader2 } from 'lucide-react';
import { StudentFeesPage, InvoiceDetailPage } from './pages/student/Fees';
import PublicVerifyReceiptPage from './pages/public/PublicVerifyReceipt';
import StudentProfilePage from './pages/student/Profile';
import StudentCheckoutPage from './pages/student/Checkout';
import StudentCallbackPage from './pages/student/Callback';
import StudentPaymentConfirmation from './pages/student/PaymentConfirmation';
import { useBranding } from './context/BrandingContext';
import { i18n } from './i18n/en';
import { navCounters, NavCounters } from './services/api';
import StudentMyReceiptsPage from './pages/student/MyReceipts';

const AdminDashboard = React.lazy(() => import('./pages/admin/Dashboard'));
const AdminRefunds = React.lazy(() => import('./pages/admin/Refunds'));
const AdminAuditLogs = React.lazy(() => import('./pages/admin/AuditLogs'));
const AdminStudents = React.lazy(() => import('./pages/admin/Students'));
const BursaryDashboard = React.lazy(() => import('./pages/bursary/Dashboard'));
const BursaryRefunds = React.lazy(() => import('./pages/bursary/Refunds'));
const FacultiesPage = React.lazy(() => import('./pages/admin/academic/Faculties'));
const DepartmentsPage = React.lazy(() => import('./pages/admin/academic/Departments'));
const ProgrammesPage = React.lazy(() => import('./pages/admin/academic/Programmes'));
const UsersPage = React.lazy(() => import('./pages/admin/Users'));
const RolesPage = React.lazy(() => import('./pages/admin/Roles'));
const PermissionsPage = React.lazy(() => import('./pages/admin/Permissions'));
const SystemSettingsPage = React.lazy(() => import('./pages/admin/SystemSettings'));
const PaymentConfigPage = React.lazy(() => import('./pages/admin/PaymentConfig'));
const AdminPaymentsPage = React.lazy(() => import('./pages/admin/Payments'));
const AdminReceiptsPage = React.lazy(() => import('./pages/admin/Receipts'));
const BursaryPaymentsPage = React.lazy(() => import('./pages/bursary/Payments'));
const BursaryReceiptsPage = React.lazy(() => import('./pages/bursary/Receipts'));
const AdminFeesWrapped = React.lazy(() => import('./pages/admin/Fees').then(m => ({ default: m.AdminFeesWrapped })));
const BursaryFeesWrapped = React.lazy(() => import('./pages/admin/Fees').then(m => ({ default: m.BursaryFeesWrapped })));
const AdminCreateBillWrapped = React.lazy(() => import('./pages/admin/Fees').then(m => ({ default: m.AdminCreateBillWrapped })));
const BursaryCreateBillWrapped = React.lazy(() => import('./pages/admin/Fees').then(m => ({ default: m.BursaryCreateBillWrapped })));
const AdminDirectBillingWrapped = React.lazy(() => import('./pages/bursary/DirectBilling').then(m => ({ default: m.AdminDirectBillingWrapped })));
const BursaryDirectBillingWrapped = React.lazy(() => import('./pages/bursary/DirectBilling').then(m => ({ default: m.BursaryDirectBillingWrapped })));
// STAGE 5 — Bursary Reports Module pages
const BursaryReportsCentre = React.lazy(() => import('./pages/bursary/ReportsCentre'));
const BursaryGenericReport = React.lazy(() => import('./pages/bursary/GenericReport'));
const BursaryStudentStatementPage = React.lazy(() => import('./pages/bursary/StudentStatementPage'));
const BursaryReconciliationExceptionsPage = React.lazy(() => import('./pages/bursary/ReconciliationExceptionsPage'));
const BursaryExportCentre = React.lazy(() => import('./pages/bursary/ExportCentre'));
const BursaryScheduledReports = React.lazy(() => import('./pages/bursary/ScheduledReports'));

const PageLoader: React.FC = () => (
  <div className="min-h-[60vh] flex items-center justify-center">
    <div className="inline-flex items-center gap-3 text-sm text-gray-500 bg-white rounded-xl px-5 py-3 border border-gray-200 shadow-sm">
      <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
      <span className="font-medium">Loading page…</span>
    </div>
  </div>
);

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

const SessionGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { authNotice, isAuthenticated } = useAuth();
  return (
    <>
      {authNotice && isAuthenticated && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-0 inset-x-0 z-[90] bg-amber-50 border-b border-amber-200"
        >
          <div className="max-w-6xl mx-auto px-4 py-2.5 text-sm text-amber-900 font-medium text-center">
            {authNotice}
          </div>
        </div>
      )}
      <SessionInactivityModal />
      {children}
    </>
  );
};

const App: React.FC = () => {
  return (
    <Router>
      <AuthProvider>
        <SessionGate>
          <ForcePasswordChangeGate>
            <Routes>
          <Route path="/" element={<PortalChooser />} />

          <Route path="/public/verify-receipt" element={<PublicVerifyReceiptPage />} />
          <Route path="/public/verify-receipt/:token" element={<PublicVerifyReceiptPage />} />
          <Route path="/verify-receipt/:token" element={<PublicVerifyReceiptPage />} />

          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/student/login" element={<StudentLogin />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/bursary/login" element={<BursaryLogin />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />

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
            <Route path="/admin/dashboard" element={<Suspense fallback={<PageLoader />}><AdminDashboard /></Suspense>} />
            <Route path="/admin/students" element={<Suspense fallback={<PageLoader />}><AdminStudentsWrapped /></Suspense>} />
            <Route path="/admin/fees" element={<Suspense fallback={<PageLoader />}><AdminFeesWrapped /></Suspense>} />
            <Route path="/admin/fees/:tab" element={<Suspense fallback={<PageLoader />}><AdminFeesWrapped /></Suspense>} />
            <Route path="/admin/bills/create" element={<Suspense fallback={<PageLoader />}><AdminCreateBillWrapped /></Suspense>} />
            <Route path="/admin/refunds" element={<Suspense fallback={<PageLoader />}><AdminRefunds /></Suspense>} />
            <Route path="/admin/audit-logs" element={<Suspense fallback={<PageLoader />}><AdminAuditLogs /></Suspense>} />
            <Route path="/admin/users" element={<Suspense fallback={<PageLoader />}><UsersPage /></Suspense>} />
            <Route path="/admin/roles" element={<Suspense fallback={<PageLoader />}><RolesPage /></Suspense>} />
            <Route path="/admin/permissions" element={<Suspense fallback={<PageLoader />}><PermissionsPage /></Suspense>} />
            <Route path="/admin/settings" element={<Suspense fallback={<PageLoader />}><SystemSettingsPage /></Suspense>} />
            <Route path="/admin/payment-config" element={<Suspense fallback={<PageLoader />}><PaymentConfigPage /></Suspense>} />

            <Route path="/admin/academic/faculties" element={<Suspense fallback={<PageLoader />}><FacultiesPage /></Suspense>} />
            <Route path="/admin/academic/departments" element={<Suspense fallback={<PageLoader />}><DepartmentsPage /></Suspense>} />
            <Route path="/admin/academic/programmes" element={<Suspense fallback={<PageLoader />}><ProgrammesPage /></Suspense>} />

            <Route path="/admin/payments" element={<Suspense fallback={<PageLoader />}><AdminPaymentsWrapped /></Suspense>} />
            <Route path="/admin/receipts" element={<Suspense fallback={<PageLoader />}><AdminReceiptsWrapped /></Suspense>} />
            <Route path="/admin/reports/daily" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/daily" title="Daily Reports" subtitle="Daily transaction summaries" />
            } />
            <Route path="/admin/reports/monthly" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/monthly" title="Monthly Reports" subtitle="Monthly financial summaries" />
            } />
            <Route path="/admin/reports/fee" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/fee" title="Fee Reports" subtitle="Fee structure analysis" />
            } />
            <Route path="/admin/reports/faculty" element={
              <PlaceholderPage role="ADMIN" activePath="/admin/reports/faculty" title="College Reports" subtitle="College-level reporting" />
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

            <Route path="/admin/direct-billing" element={<Suspense fallback={<PageLoader />}><AdminDirectBillingWrapped /></Suspense>} />
            <Route path="/admin/direct-billing/:tab" element={<Suspense fallback={<PageLoader />}><AdminDirectBillingWrapped /></Suspense>} />
          </Route>

          <Route element={<PrivateRoute roles={['BURSARY', 'ADMIN']} />}>
            <Route path="/bursary/dashboard" element={<Suspense fallback={<PageLoader />}><BursaryDashboard /></Suspense>} />
            <Route path="/bursary/students" element={<Suspense fallback={<PageLoader />}><BursaryStudentsWrapped /></Suspense>} />
            <Route path="/bursary/fees" element={<Suspense fallback={<PageLoader />}><BursaryFeesWrapped /></Suspense>} />
            <Route path="/bursary/fees/:tab" element={<Suspense fallback={<PageLoader />}><BursaryFeesWrapped /></Suspense>} />
            <Route path="/bursary/bills/create" element={<Suspense fallback={<PageLoader />}><BursaryCreateBillWrapped /></Suspense>} />
            <Route path="/bursary/refunds" element={<Suspense fallback={<PageLoader />}><BursaryRefunds /></Suspense>} />

            <Route path="/bursary/payments" element={<Suspense fallback={<PageLoader />}><BursaryPaymentsWrapped /></Suspense>} />
            <Route path="/bursary/receipts" element={<Suspense fallback={<PageLoader />}><BursaryReceiptsWrapped /></Suspense>} />
            <Route path="/bursary/audit-logs" element={<Suspense fallback={<PageLoader />}><AdminAuditLogs /></Suspense>} />
            <Route path="/bursary/direct-billing" element={<Suspense fallback={<PageLoader />}><BursaryDirectBillingWrapped /></Suspense>} />
            <Route path="/bursary/direct-billing/:tab" element={<Suspense fallback={<PageLoader />}><BursaryDirectBillingWrapped /></Suspense>} />
            <Route path="/bursary/reports/centre" element={
              <Suspense fallback={<PageLoader />}><BursaryReportsCentre role="BURSARY" activePath="/bursary/reports/centre" /></Suspense>
            } />
            <Route path="/bursary/reports/view/:reportKey" element={
              <Suspense fallback={<PageLoader />}><BursaryGenericReportWrapped /></Suspense>
            } />
            <Route path="/bursary/reports/student-statement" element={
              <Suspense fallback={<PageLoader />}><BursaryStudentStatementPage role="BURSARY" activePath="/bursary/reports/student-statement" /></Suspense>
            } />
            <Route path="/bursary/reports/exceptions" element={
              <Suspense fallback={<PageLoader />}><BursaryReconciliationExceptionsPage role="BURSARY" activePath="/bursary/reports/exceptions" /></Suspense>
            } />
            <Route path="/bursary/reports/export-centre" element={
              <Suspense fallback={<PageLoader />}><BursaryExportCentre role="BURSARY" activePath="/bursary/reports/export-centre" /></Suspense>
            } />
            <Route path="/bursary/reports/scheduled" element={
              <Suspense fallback={<PageLoader />}><BursaryScheduledReports role="BURSARY" activePath="/bursary/reports/scheduled" /></Suspense>
            } />
            {/* Backward compat: old placeholder routes redirect to Reports Centre */}
            <Route path="/bursary/reports/daily" element={<Navigate to="/bursary/reports/view/daily-collections" replace />} />
            <Route path="/bursary/reports/monthly" element={<Navigate to="/bursary/reports/view/monthly-collections" replace />} />
            <Route path="/bursary/reports/fee" element={<Navigate to="/bursary/reports/view/revenue-by-bill" replace />} />
            <Route path="/bursary/reports/faculty" element={<Navigate to="/bursary/reports/view/hierarchical-revenue" replace />} />
            <Route path="/bursary/reports/department" element={<Navigate to="/bursary/reports/view/hierarchical-revenue" replace />} />
            <Route path="/bursary/reports/programme" element={<Navigate to="/bursary/reports/view/hierarchical-revenue" replace />} />
            <Route path="/bursary/reports/student" element={<Navigate to="/bursary/reports/student-statement" replace />} />
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
          </Route>

          <Route path="*" element={<Navigate to="/404" replace />} />
          </Routes>
        </ForcePasswordChangeGate>
        </SessionGate>
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

// STAGE 5 — Bursary Generic Report wrapper (receives role+activePath, renders own PortalShell)
const BursaryGenericReportWrapped: React.FC = () => {
  const location = useLocation();
  return <BursaryGenericReport role="BURSARY" activePath={location.pathname} />;
};

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
