import { Link } from "react-router-dom";

export default function NoPermissionPage() {
  return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <h1 style={{ color: "#b91c1c" }}>403 — Permission Required</h1>
      <p style={{ color: "#374151" }}>Your account does not have access to this page.</p>
      <Link to="/dashboard" style={{ color: "#2563eb" }}>
        Return to dashboard
      </Link>
    </div>
  );
}
