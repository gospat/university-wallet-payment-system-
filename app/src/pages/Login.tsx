import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import Alert from "@/components/Alert";

/**
 * Login page — Module 2 AC-11.1:
 *   login success with mustChangePassword=true → navigate to /change-password.
 */
export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const { mustChangePassword } = await login(email, password);
      if (mustChangePassword) {
        // Module 2 — forced redirect to password change.
        navigate("/change-password", { replace: true });
      } else {
        navigate("/dashboard", { replace: true });
      }
    } catch (e: any) {
      setErr(
        e?.response?.data?.error ?? e?.message ?? "Login failed — check credentials."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(180deg, #eef2ff 0%, #e0e7ff 100%)",
        padding: 20,
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          background: "#fff",
          padding: 28,
          borderRadius: 12,
          width: "min(420px, 100%)",
          boxShadow: "0 10px 30px rgba(15,23,42,0.1)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>University Payment Gateway</h1>
        <p style={{ color: "#6b7280", margin: "4px 0 20px" }}>Sign in to continue</p>
        {err && <Alert variant="danger" onClose={() => setErr(null)}>{err}</Alert>}
        <Field label="Email">
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={input}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={input}
          />
        </Field>
        <button
          type="submit"
          disabled={busy}
          style={{
            width: "100%",
            background: "#2563eb",
            color: "#fff",
            fontWeight: 700,
            border: "none",
            padding: "11px 14px",
            borderRadius: 8,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div style={{ marginTop: 12, fontSize: 12, color: "#6b7280" }}>
          Demo accounts: superadmin@university.example / Admin123! &nbsp;·&nbsp;
          bursary@university.example / Bursary123! &nbsp;·&nbsp;
          student.sample@university.example / sample
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 13, marginBottom: 4, fontWeight: 600, color: "#111827" }}>
        {label}
      </div>
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
};
