import React, { useCallback, useEffect, useState } from "react";
import api from "@/utils/api";
import Alert from "@/components/Alert";

interface RunRow {
  id: number;
  uuid: string;
  fileName: string;
  filePath: string;
  totalRows: number | null;
  successCount: number;
  failCount: number;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  startedAt: string;
  finishedAt: string | null;
}
interface ImportRowT {
  id: number;
  importRunId: number;
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  matricNumber: string;
  passwordSent: boolean;
  status: "PENDING" | "SUCCESS" | "FAILED";
  errorMessage: string | null;
  studentId: number | null;
  createdAt: string;
}

/**
 * Module 4 — Import History.
 *
 *   1. List of runs.
 *   2. Click a run → list of rows.
 *   3. Each row has "Resend Credentials" CTA that POSTs to backend resend endpoint → queues email (NOT inline).
 */
export default function ImportHistoryPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runLoading, setRunLoading] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [rows, setRows] = useState<ImportRowT[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [alert, setAlert] = useState<{ kind: "info" | "success" | "warning" | "danger"; text: string } | null>(null);
  const [resendingId, setResendingId] = useState<number | null>(null);

  const loadRuns = useCallback(async () => {
    setRunLoading(true);
    try {
      const { data } = await api.get<{ data: RunRow[] }>("/admin/students/imports?size=200");
      setRuns(data.data);
    } catch (e: any) {
      setAlert({ kind: "danger", text: e?.response?.data?.error ?? "Failed to load runs" });
    } finally {
      setRunLoading(false);
    }
  }, []);
  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const loadRows = useCallback(async (runId: number) => {
    setRowsLoading(true);
    try {
      const { data } = await api.get<{ data: ImportRowT[] }>(`/admin/students/imports/${runId}/rows?size=500`);
      setRows(data.data);
    } catch (e: any) {
      setAlert({ kind: "danger", text: e?.response?.data?.error ?? "Failed to load rows" });
    } finally {
      setRowsLoading(false);
    }
  }, []);

  const onOpenRun = (id: number) => {
    setActiveRunId(id);
    loadRows(id);
  };

  const onResend = async (row: ImportRowT) => {
    setResendingId(row.id);
    setAlert(null);
    try {
      const { data } = await api.post<{ jobId: string; queued: boolean }>(
        `/admin/students/imports/rows/${row.id}/resend-credentials`
      );
      setAlert({
        kind: "success",
        text: `Credential email queued for ${row.matricNumber}. JobId: ${data.jobId}`,
      });
    } catch (e: any) {
      setAlert({ kind: "danger", text: e?.response?.data?.error ?? "Resend failed" });
    } finally {
      setResendingId(null);
    }
  };

  return (
    <div>
      <h1 style={{ margin: 0 }}>Admin → Students: Import History</h1>
      <p style={{ color: "#6b7280", marginTop: 4 }}>
        Click a run to view rows. Each successful row has a <strong>Resend Credentials</strong> button that queues an
        email (never sends inline).
      </p>
      {alert && (
        <Alert variant={alert.kind} onClose={() => setAlert(null)}>
          {alert.text}
        </Alert>
      )}

      <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
        <h3 style={{ margin: "0 0 8px" }}>Runs</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
              <Th>#</Th>
              <Th>File</Th>
              <Th>Status</Th>
              <Th>Success</Th>
              <Th>Failed</Th>
              <Th>Total</Th>
              <Th>Started</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {runLoading && (
              <tr>
                <td colSpan={8} style={{ padding: 14 }}>
                  Loading…
                </td>
              </tr>
            )}
            {!runLoading && runs.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 14, color: "#6b7280" }}>
                  No import runs yet.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                <Td>{r.id}</Td>
                <Td>{r.fileName}</Td>
                <Td>{StatusBadge(r.status)}</Td>
                <Td>{r.successCount}</Td>
                <Td>{r.failCount}</Td>
                <Td>{r.totalRows ?? "—"}</Td>
                <Td style={{ color: "#64748b", fontSize: 12 }}>
                  {new Date(r.startedAt).toLocaleString()}
                </Td>
                <Td style={{ textAlign: "right" }}>
                  <button
                    onClick={() => onOpenRun(r.id)}
                    style={{
                      padding: "6px 10px",
                      background: activeRunId === r.id ? "#1d4ed8" : "#2563eb",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    {activeRunId === r.id ? "Refresh" : "View Rows"}
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {activeRunId !== null && (
        <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, marginTop: 18 }}>
          <h3 style={{ margin: "0 0 8px" }}>Rows — Run #{activeRunId}</h3>
          {rowsLoading ? (
            <div style={{ padding: 14, color: "#6b7280" }}>Loading rows…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 14, color: "#6b7280" }}>No rows yet.</div>
          ) : (
            <div style={{ maxHeight: 520, overflow: "auto", border: "1px solid #eef2f7" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead style={{ position: "sticky", top: 0, background: "#f3f4f6" }}>
                  <tr style={{ textAlign: "left" }}>
                    <Th>Row#</Th>
                    <Th>Student</Th>
                    <Th>Matric</Th>
                    <Th>Email</Th>
                    <Th>Status</Th>
                    <Th>Email Sent</Th>
                    <Th style={{ textAlign: "right" }}>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                      <Td>{r.rowNumber}</Td>
                      <Td>
                        {r.firstName} {r.lastName}
                      </Td>
                      <Td>{r.matricNumber}</Td>
                      <Td>{r.email}</Td>
                      <Td>
                        {r.status === "FAILED" ? (
                          <span style={{ color: "#b91c1c", fontSize: 12 }} title={r.errorMessage ?? ""}>
                            {r.status}
                          </span>
                        ) : (
                          <span>{r.status}</span>
                        )}
                      </Td>
                      <Td>{r.passwordSent ? "✓" : "—"}</Td>
                      <Td style={{ textAlign: "right" }}>
                        <button
                          onClick={() => onResend(r)}
                          disabled={r.status !== "SUCCESS" || resendingId === r.id}
                          title={
                            r.status !== "SUCCESS"
                              ? "Resend unavailable for failed rows"
                              : "Re-queue credential email"
                          }
                          style={{
                            padding: "6px 10px",
                            background: r.status !== "SUCCESS" ? "#f8fafc" : "#0ea5e9",
                            color: r.status !== "SUCCESS" ? "#94a3b8" : "#fff",
                            border: "none",
                            borderRadius: 6,
                            cursor: r.status !== "SUCCESS" ? "not-allowed" : "pointer",
                            fontWeight: 600,
                            fontSize: 12,
                          }}
                        >
                          {resendingId === r.id ? "Queuing…" : "Resend Credentials"}
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      style={{ padding: "10px 12px", fontSize: 12, textTransform: "uppercase", color: "#475569", ...style }}
    >
      {children}
    </th>
  );
}
function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "8px 12px", ...style }}>{children}</td>;
}

function StatusBadge(s: RunRow["status"]) {
  const map = {
    PROCESSING: { bg: "#fef3c7", color: "#92400e" },
    COMPLETED: { bg: "#dcfce7", color: "#166534" },
    FAILED: { bg: "#fee2e2", color: "#991b1b" },
  };
  const m = map[s];
  return (
    <span style={{ background: m.bg, color: m.color, padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
      {s}
    </span>
  );
}
