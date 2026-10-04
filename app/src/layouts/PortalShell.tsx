import React from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Permissions } from "@/types/permissions";

/**
 * PortalShell — shared layout for admin/bursary routes behind RBAC.
 * Sidebar navigation items are conditionally rendered via hasPermission.
 */
export default function PortalShell() {
  const { me, logout, hasPermission, role } = useAuth();
  const navigate = useNavigate();

  const onLogout = (e: React.MouseEvent) => {
    e.preventDefault();
    logout();
    navigate("/login");
  };

  const navItems: Array<{
    label: string;
    to: string;
    permission?: Permissions;
    roles?: Array<"ADMIN" | "BURSARY" | "STUDENT">;
  }> = [
    { label: "Dashboard", to: "/dashboard", permission: Permissions.VIEW_DASHBOARD },
    // Admin nav
    { label: "Users", to: "/admin/users", permission: Permissions.MANAGE_USERS, roles: ["ADMIN"] },
    {
      label: "Students → Import CSV",
      to: "/admin/students/import",
      permission: Permissions.MANAGE_USERS,
      roles: ["ADMIN"],
    },
    {
      label: "Students → Import History",
      to: "/admin/students/import-history",
      permission: Permissions.MANAGE_USERS,
      roles: ["ADMIN"],
    },
    // Bursary nav
    {
      label: "Reconciliation",
      to: "/bursary/reconciliation",
      permission: Permissions.VIEW_RECONCILIATION,
      roles: ["ADMIN", "BURSARY"],
    },
  ];

  const visibleItems = navItems.filter((it) => {
    if (it.roles && role && !it.roles.includes(role as any)) return false;
    if (it.permission && !hasPermission(it.permission)) return false;
    return true;
  });

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          width: 240,
          background: "#1f2937",
          color: "#f9fafb",
          padding: "16px 0",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "8px 20px 16px", fontWeight: 700, fontSize: 16 }}>
          University Payment Gateway
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {visibleItems.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              style={({ isActive }) => ({
                padding: "10px 20px",
                color: isActive ? "#fff" : "#d1d5db",
                background: isActive ? "#111827" : "transparent",
                textDecoration: "none",
                fontWeight: isActive ? 600 : 400,
                borderLeft: isActive ? "3px solid #2563eb" : "3px solid transparent",
              })}
            >
              {it.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginTop: "auto", padding: "12px 20px", borderTop: "1px solid #374151" }}>
          <div style={{ fontSize: 13, color: "#cbd5e1" }}>
            {me?.firstName} {me?.lastName}
          </div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 8 }}>
            {me?.role} · {me?.email}
          </div>
          <a
            href="#"
            onClick={onLogout}
            style={{
              fontSize: 13,
              color: "#f3f4f6",
              textDecoration: "underline",
            }}
          >
            Log out
          </a>
        </div>
      </aside>
      <main
        style={{
          flex: 1,
          padding: "24px 32px",
          background: "#f8fafc",
          overflowX: "auto",
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}
