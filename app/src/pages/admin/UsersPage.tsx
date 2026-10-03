import React, { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/utils/api";
import { Permissions } from "@/types/permissions";
import { useAuth } from "@/hooks/useAuth";
import { RequirePermission } from "@/components/RequireAuth";
import Alert from "@/components/Alert";
import ConfirmDeleteModal from "@/components/ConfirmDeleteModal";

interface UserRow {
  id: number;
  email: string;
  role: "ADMIN" | "BURSARY" | "STUDENT";
  firstName: string;
  lastName: string;
  matricNumber: string | null;
  mustChangePassword: boolean;
  isActive: boolean;
  createdAt: string;
}

const PROTECTED_IDS = new Set([1, 2, 48]);

/**
 * Admin Users Page — Module 3 TR-15, TR-16, TR-18.
 * MANAGE_USERS permission gate (Bursary → 403 via backend + UI redirect).
 */
export default function UsersPage() {
  const { hasPermission } = useAuth();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState<{ kind: "info" | "success" | "warning" | "danger"; text: string } | null>(null);
  const [modal, setModal] = useState<{ open: boolean; target: UserRow | null; busy: boolean }>({
    open: false,
    target: null,
    busy: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<{ data: UserRow[] }>("/admin/users");
      setRows(data.data ?? []);
    } catch (e: any) {
      setAlert({ kind: "danger", text: e?.response?.data?.error ?? "Failed to load users" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onDelete = (row: UserRow) => setModal({ open: true, target: row, busy: false });

  const confirmDelete = async () => {
    if (!modal.target) return;
    setModal({ ...modal, busy: true });
    setAlert(null);
    try {
      await api.delete(`/admin/users/${modal.target.id}`);
      setRows((prev) => prev.filter((r) => r.id !== modal.target!.id));
      setAlert({ kind: "success", text: `Deleted user #${modal.target.id} (${modal.target.email})` });
      setModal({ open: false, target: null, busy: false });
    } catch (e: any) {
      const status = e?.response?.status;
      const message: string = e?.response?.data?.error ?? "Delete failed";
      // Module 3: 409 as warning alert, 403 as danger alert
      if (status === 409) setAlert({ kind: "warning", text: message });
      else if (status === 403) setAlert({ kind: "danger", text: message });
      else setAlert({ kind: "danger", text: message });
      setModal({ ...modal, busy: false });
    }
  };

  const summary = useMemo(() => {
    const byRole = rows.reduce((acc, r) => {
      acc[r.role] = (acc[r.role] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    return byRole;
  }, [rows]);

  if (!hasPermission(Permissions.MANAGE_USERS)) {
    return <RequirePermission permission={Permissions.MANAGE_USERS}><div /></RequirePermission>;
  }

  return (
    <div>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Admin → Users</h1>
        <p style={{ color: "#6b7280", marginTop: 4 }}>
          Summary:{" "}
          {Object.entries(summary).map(([r, c]) => (
            <span key={r} style={{ marginRight: 12 }}>
              {r}: <strong>{c}</strong>
            </span>
          ))}
        </p>
      </header>
      {alert && (
        <Alert variant={alert.kind} onClose={() => setAlert(null)} title={titleFor(alert.kind)}>
          {alert.text}
        </Alert>
      )}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
              <Th>ID</Th>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Matric</Th>
              <Th>PW Status</Th>
              <Th>Created</Th>
              <Th style={{ textAlign: "right" }}>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} style={{ padding: 20, color: "#6b7280" }}>
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 20, color: "#6b7280" }}>
                  No users.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const protected_ = PROTECTED_IDS.has(r.id);
              return (
                <tr key={r.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <Td>{r.id}</Td>
                  <Td>
                    {r.firstName} {r.lastName}
                  </Td>
                  <Td>{r.email}</Td>
                  <Td>
                    <RoleChip role={r.role} />
                  </Td>
                  <Td>{r.matricNumber ?? "—"}</Td>
                  <Td>{r.mustChangePassword ? <Tag color="amber">Must change</Tag> : <Tag color="green">OK</Tag>}</Td>
                  <Td style={{ color: "#6b7280", fontSize: 12 }}>
                    {new Date(r.createdAt).toLocaleDateString()}
                  </Td>
                  <Td style={{ textAlign: "right" }}>
                    <button
                      onClick={() => onDelete(r)}
                      disabled={protected_}
                      title={protected_ ? "Protected account — cannot delete" : "Delete user"}
                      style={{
                        padding: "6px 10px",
                        border: "1px solid " + (protected_ ? "#e5e7eb" : "#fecaca"),
                        background: protected_ ? "#f8fafc" : "#fff",
                        color: protected_ ? "#94a3b8" : "#b91c1c",
                        borderRadius: 6,
                        fontSize: 13,
                        cursor: protected_ ? "not-allowed" : "pointer",
                        fontWeight: 600,
                      }}
                    >
                      {protected_ ? "Protected" : "Delete"}
                    </button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDeleteModal
        open={modal.open}
        busy={modal.busy}
        title={`Delete user #${modal.target?.id ?? ""}?`}
        body={
          <div>
            <p>
              Permanently delete <strong>{modal.target?.email}</strong> (role: {modal.target?.role})?
            </p>
            {modal.target?.role === "STUDENT" && (
              <p style={{ fontSize: 13, color: "#92400e", background: "#fef3c7", padding: 8, borderRadius: 6 }}>
                If this student has any invoices, transactions, receipts, refunds or settlements, the delete will be
                blocked (409).
              </p>
            )}
          </div>
        }
        onCancel={() => setModal({ open: false, target: null, busy: false })}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function titleFor(k: "info" | "success" | "warning" | "danger"): string | undefined {
  if (k === "warning") return "Blocked";
  if (k === "danger") return "Error";
  if (k === "success") return "Success";
  return undefined;
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th style={{ padding: "10px 12px", fontSize: 12, textTransform: "uppercase", color: "#475569", ...style }}>
      {children}
    </th>
  );
}
function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "10px 12px", color: "#111827", ...style }}>{children}</td>;
}

function RoleChip({ role }: { role: string }) {
  const color = role === "ADMIN" ? "violet" : role === "BURSARY" ? "blue" : "slate";
  return <Tag color={color as any}>{role}</Tag>;
}

function Tag({ children, color }: { children: React.ReactNode; color: "violet" | "blue" | "slate" | "green" | "amber" }) {
  const map: any = {
    violet: { bg: "#ede9fe", fg: "#6d28d9" },
    blue: { bg: "#dbeafe", fg: "#1d4ed8" },
    slate: { bg: "#e2e8f0", fg: "#334155" },
    green: { bg: "#dcfce7", fg: "#15803d" },
    amber: { bg: "#fef3c7", fg: "#92400e" },
  };
  const m = map[color] ?? map.slate;
  return (
    <span
      style={{
        background: m.bg,
        color: m.fg,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}
