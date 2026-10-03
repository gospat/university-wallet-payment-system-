import React, { useRef, useState } from "react";
import api from "@/utils/api";
import Alert from "@/components/Alert";

/**
 * Module 4 — Student CSV Import upload page.
 * MANAGE_USERS permission (frontend also gates via nav).
 */
export default function StudentImportPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ jobId: string; importRunId: number; importRunUuid: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setErr(null);
    setResult(null);
  };

  const onUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setErr("Select a CSV file first.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("csv", file);
      const { data } = await api.post<{ jobId: string; importRunId: number; importRunUuid: string; status: string }>(
        "/admin/students/import",
        fd,
        { headers: { "Content-Type": "multipart/form-data" } }
      );
      setResult({ jobId: data.jobId, importRunId: data.importRunId, importRunUuid: data.importRunUuid });
    } catch (e: any) {
      setErr(e?.response?.data?.error ?? e?.message ?? "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 style={{ margin: 0 }}>Admin → Students: Import CSV</h1>
      <p style={{ color: "#6b7280", marginTop: 4 }}>
        The HTTP request returns immediately (non-blocking). Import worker processes in batches of 250 and queues
        credential emails after each commit.
      </p>
      {err && <Alert variant="danger" onClose={() => setErr(null)}>{err}</Alert>}
      {result && (
        <Alert variant="success">
          Import queued — <strong>jobId</strong> {result.jobId}, <strong>run #{result.importRunId}</strong> (
          {result.importRunUuid}). Go to Import History to track progress and resend emails.
        </Alert>
      )}
      <form onSubmit={onUpload} style={{ background: "#fff", padding: 20, border: "1px solid #e5e7eb", borderRadius: 10, marginTop: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onPick}
            style={{ flex: 1, padding: 8, border: "1px dashed #cbd5e1", borderRadius: 8 }}
          />
          <button
            type="submit"
            disabled={busy || !file}
            style={{
              background: "#2563eb",
              color: "#fff",
              padding: "10px 16px",
              border: "none",
              borderRadius: 8,
              fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Uploading…" : "Upload & Queue Import"}
          </button>
        </div>
        <div style={{ marginTop: 14, fontSize: 13, color: "#64748b" }}>
          Expected CSV columns (case-insensitive): <code>firstName</code>, <code>lastName</code> (or{" "}
          <code>surname</code>), <code>email</code>, <code>matricNumber</code>, <code>department</code>,{" "}
          <code>faculty</code>, <code>level</code>, <code>session</code>. Password defaults to{" "}
          <code>lastName.toLowerCase()</code>.
        </div>
      </form>
    </div>
  );
}
