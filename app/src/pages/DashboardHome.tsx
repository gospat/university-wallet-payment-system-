import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Permissions } from "@/types/permissions";

export default function DashboardHome() {
  const { me, hasPermission } = useAuth();
  return (
    <div>
      <h1 style={{ margin: "0 0 4px" }}>
        Welcome, {me?.firstName} {me?.lastName}
      </h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>
        Role: <strong>{me?.role}</strong> · {me?.email}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
        {hasPermission(Permissions.MANAGE_USERS) && (
          <Card title="User Management" to="/admin/users" desc="Create, edit, and delete users.">
            Users list & delete actions
          </Card>
        )}
        {hasPermission(Permissions.MANAGE_USERS) && (
          <Card title="Bulk Student Import" to="/admin/students/import" desc="Upload a CSV of students and queue async import.">
            Import CSV, 250-row batches
          </Card>
        )}
        {hasPermission(Permissions.MANAGE_USERS) && (
          <Card title="Import History" to="/admin/students/import-history" desc="Review runs and resend credentials.">
            Resend per-row credential emails
          </Card>
        )}
        {hasPermission(Permissions.VIEW_RECONCILIATION) && (
          <Card title="Reconciliation" to="/bursary/reconciliation" desc="Collected vs settled, last 7 days, exceptions.">
            Stat cards + bar chart
          </Card>
        )}
      </div>
    </div>
  );
}

function Card({
  title,
  to,
  desc,
  children,
}: {
  title: string;
  to: string;
  desc?: string;
  children?: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      style={{
        textDecoration: "none",
        color: "inherit",
        background: "#fff",
        padding: 18,
        borderRadius: 10,
        border: "1px solid #e5e7eb",
        boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
        display: "block",
      }}
    >
      <h3 style={{ margin: "0 0 4px", fontSize: 16, color: "#111827" }}>{title}</h3>
      {desc && <p style={{ margin: 0, color: "#6b7280", fontSize: 13 }}>{desc}</p>}
      {children && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#2563eb" }}>{children}</div>
      )}
    </Link>
  );
}
