import React, { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import Alert from "@/components/Alert";

/**
 * Change Password page — Module 2.
 *   If mustChangePassword=true (new student default), oldPassword field not required.
 *   Otherwise oldPassword must be provided.
 *   On success → /dashboard.
 */
export default function ChangePasswordPage() {
  const { token, me, mustChangePassword, changePassword } = useAuth();
  const navigate = useNavigate();
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  if (!token) return <Navigate to="/login" replace />;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (newPassword !== confirm) {
      setErr("New passwords do not match");
      return;
    }
    if (newPassword.length < 6) {
      setErr("Password must be at least 6 characters");
      return;
    }
    setBusy(true);
    try {
      await changePassword({
        oldPassword: mustChangePassword ? undefined : oldPassword,
        newPassword,
        confirmPassword: confirm,
      });
      setOk(true);
      setTimeout(() => navigate("/dashboard", { replace: true }), 700);
    } catch (e: any) {
      setErr(e?.response?.data?.error ?? e?.message ?? "Could not change password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "#eef2ff" }}>
      <form onSubmit={onSubmit} style={cardStyle}>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          {mustChangePassword ? "Change your temporary password" : "Change password"}
        </h1>
        <p style={{ color: "#6b7280", marginTop: 4 }}>
          Signed in as <strong>{me?.email}</strong>
        </p>
        {ok && <Alert variant="success">Password updated. Redirecting…</Alert>}
        {err && <Alert variant="danger" onClose={() => setErr(null)}>{err}</Alert>}
        {!mustChangePassword && (
          <Field label="Current password">
            <input type="password" value={oldPassword} required onChange={(e) => setOld(e.target.value)} style={input} />
          </Field>
        )}
        <Field label="New password">
          <input
            type="password"
            required
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            style={input}
            minLength={6}
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={input}
            minLength={6}
          />
        </Field>
        <button type="submit" disabled={busy} style={btnStyle}>
          {busy ? "Saving…" : "Update password"}
        </button>
        {mustChangePassword && (
          <p style={{ fontSize: 12, color: "#6b7280", marginTop: 12 }}>
            This password change is mandatory after your first login.
          </p>
        )}
      </form>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#fff",
  padding: 28,
  borderRadius: 12,
  width: "min(440px, 100%)",
  boxShadow: "0 10px 30px rgba(15,23,42,0.1)",
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 14px",
  border: "none",
  borderRadius: 8,
  background: "#2563eb",
  color: "#fff",
  fontWeight: 700,
  cursor: "pointer",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}
