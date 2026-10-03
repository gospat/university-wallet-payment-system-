import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Login from "./pages/Login";
import ChangePassword from "./pages/ChangePassword";
import DashboardHome from "./pages/DashboardHome";
import NoPermission from "./pages/NoPermission";
import AdminUsers from "./pages/admin/UsersPage";
import StudentImport from "./pages/admin/StudentImportPage";
import ImportHistory from "./pages/admin/ImportHistoryPage";
import Reconciliation from "./pages/bursary/ReconciliationPage";
import PortalShell from "./layouts/PortalShell";
import RequireAuth, { RequirePermission } from "./components/RequireAuth";
import { Permissions } from "./types/permissions";

/**
 * App router.
 *
 * Protected pages use the pattern:
 *   <PortalShell> → <RequireAuth> → <RequirePermission> → Page
 * All protected pages share PortalShell layout (RBAC-gated sidebar nav) and useAuth/hasPermission.
 *
 * No new permission keys are introduced.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<RequireAuth><ChangePassword /></RequireAuth>} />
      <Route path="/no-permission" element={<NoPermission />} />

      {/* Protected area wrapped in PortalShell. */}
      <Route
        element={
          <RequireAuth>
            <PortalShell />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<DashboardHome />} />

        {/* Admin routes */}
        <Route
          path="/admin/users"
          element={
            <RequirePermission permission={Permissions.MANAGE_USERS}>
              <AdminUsers />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/students/import"
          element={
            <RequirePermission permission={Permissions.MANAGE_USERS}>
              <StudentImport />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/students/import-history"
          element={
            <RequirePermission permission={Permissions.MANAGE_USERS}>
              <ImportHistory />
            </RequirePermission>
          }
        />

        {/* Bursary routes */}
        <Route
          path="/bursary/reconciliation"
          element={
            <RequirePermission permission={Permissions.VIEW_RECONCILIATION}>
              <Reconciliation />
            </RequirePermission>
          }
        />

        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
