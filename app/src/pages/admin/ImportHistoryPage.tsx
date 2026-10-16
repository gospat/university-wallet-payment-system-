import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Download, Send } from "lucide-react";
import api, { downloadBlob, apiErrorMessage } from "../../services/api";

type RunStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
type RowStatus = "PENDING" | "SUCCESS" | "FAILED" | "SKIPPED";

interface ImportRun {
  id: number;
  uuid: string;
  fileName: string;
  filePath: string;
  status: RunStatus;
  strategy?: "SKIP" | "UPDATE";
  startedAt: string | null;
  finishedAt: string | null;
  totalRows: number | null;
  successCount: number;
  failCount: number;
  skippedCount: number;
  _count?: { rows?: number };
}

interface ImportRow {
  id: number;
  importRunId: number;
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  matricNumber: string;
  status: RowStatus;
  errorMessage: string | null;
  studentId: number | null;
  passwordSent: boolean;
}

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Admin → Students: Import History.
 *
 *  1. Paginated list of background import runs (status + counters + timestamps).
 *  2. Open a run → paginated, status-filtered list of its rows.
 *  3. Download the run's credentials CSV (authenticated blob download).
 *  4. Per-row "Resend Credentials" which QUEUES an email server-side (202).
 *
 * Rendered inline from Students.tsx for `?view=history` (no PortalShell here).
 */
const ImportHistoryPage: React.FC = () => {
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsPage, setRunsPage] = useState(1);
  const [runsTotal, setRunsTotal] = useState(0);
  const runsPageSize = 20;

  const [activeRun, setActiveRun] = useState<ImportRun | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsPage, setRowsPage] = useState(1);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsStatus, setRowsStatus] = useState<"" | RowStatus>("");
  const rowsPageSize = 50;

  const [alert, setAlert] = useState<{ kind: "info" | "success" | "warning" | "danger"; text: string } | null>(null);
  const [resendingId, setResendingId] = useState<number | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const res = await api.get<{ data: Paged<ImportRun> | ImportRun[] }>("/admin/students/imports", {
        params: { page: runsPage, pageSize: runsPageSize },
      });
      const payload = res.data?.data as Paged<ImportRun> | ImportRun[] | undefined;
      if (Array.isArray(payload)) {
        setRuns(payload);
        setRunsTotal(payload.length);
      } else {
        setRuns(payload?.items ?? []);
        setRunsTotal(Number(payload?.total) || 0);
      }
    } catch (e: unknown) {
      setAlert({ kind: "danger", text: apiErrorMessage(e, "Failed to load import runs.") });
    } finally {
      setRunsLoading(false);
    }
  }, [runsPage]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const loadRows = useCallback(
    async (run: ImportRun, page = rowsPage, status = rowsStatus) => {
      setRowsLoading(true);
      try {
        const res = await api.get<{ data: Paged<ImportRow> | ImportRow[] }>(
          `/admin/students/imports/${run.uuid}/rows`,
          { params: { page, pageSize: rowsPageSize, status: status || undefined } },
        );
        const payload = res.data?.data as Paged<ImportRow> | ImportRow[] | undefined;
        if (Array.isArray(payload)) {
          setRows(payload);
          setRowsTotal(payload.length);
        } else {
          setRows(payload?.items ?? []);
          setRowsTotal(Number(payload?.total) || 0);
        }
      } catch (e: unknown) {
        setAlert({ kind: "danger", text: apiErrorMessage(e, "Failed to load rows.") });
      } finally {
        setRowsLoading(false);
      }
    },
    [rowsPage, rowsStatus],
  );

  const openRun = (run: ImportRun) => {
    setActiveRun(run);
    setRowsPage(1);
    setRowsStatus("");
    setRows([]);
    loadRows(run, 1, "");
  };

  const changeRowsPage = (p: number) => {
    setRowsPage(p);
    if (activeRun) loadRows(activeRun, p, rowsStatus);
  };

  const changeRowsStatus = (s: "" | RowStatus) => {
    setRowsStatus(s);
    setRowsPage(1);
    if (activeRun) loadRows(activeRun, 1, s);
  };

  const onResend = async (row: ImportRow) => {
    setResendingId(row.id);
    setAlert(null);
    try {
      const res = await api.post<{ data: { jobId?: string; queued?: boolean } }>(
        `/admin/students/imports/rows/${row.id}/resend-credentials`,
      );
      const d = res.data?.data ?? {};
      setAlert({
        kind: "success",
        text: `Credential email queued for ${row.matricNumber || row.email}${d.jobId ? ` (job ${String(d.jobId).slice(0, 12)}…)` : ""}. It is sent in the background.`,
      });
    } catch (e: unknown) {
      setAlert({ kind: "danger", text: apiErrorMessage(e, "Resend failed.") });
    } finally {
      setResendingId(null);
    }
  };

  const downloadCredentials = async (run: ImportRun) => {
    setDownloadingKey(run.uuid);
    try {
      await downloadBlob(`/admin/students/imports/${run.uuid}/credentials.csv`, `credentials-${run.uuid}.csv`);
    } catch (e: unknown) {
      setAlert({ kind: "danger", text: apiErrorMessage(e, "Could not download credentials CSV.") });
    } finally {
      setDownloadingKey(null);
    }
  };

  const runsTotalPages = Math.max(1, Math.ceil(runsTotal / runsPageSize));
  const rowsTotalPages = Math.max(1, Math.ceil(rowsTotal / rowsPageSize));

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Import History</h2>
          <p className="text-sm text-gray-500 mt-1">
            Background bulk-import runs. Open a run to inspect its rows, resend credentials, or download the credentials CSV.
          </p>
        </div>
        <button
          onClick={() => { loadRuns(); if (activeRun) loadRows(activeRun, rowsPage, rowsStatus); }}
          disabled={runsLoading}
          className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 rounded-lg font-medium text-sm disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${runsLoading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {alert && (
        <div
          role="alert"
          className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
            alert.kind === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : alert.kind === "danger"
              ? "bg-red-50 border-red-200 text-red-800"
              : alert.kind === "warning"
              ? "bg-amber-50 border-amber-200 text-amber-800"
              : "bg-blue-50 border-blue-200 text-blue-800"
          }`}
        >
          <span className="whitespace-pre-wrap break-words">{alert.text}</span>
          <button type="button" aria-label="Dismiss" className="opacity-70 hover:opacity-100" onClick={() => setAlert(null)}>
            ×
          </button>
        </div>
      )}

      <section className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900">Import Runs</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <Th>File</Th>
                <Th>Status</Th>
                <Th>Strategy</Th>
                <Th>Success</Th>
                <Th>Failed</Th>
                <Th>Skipped</Th>
                <Th>Total</Th>
                <Th>Started</Th>
                <Th>Finished</Th>
                <Th style={{ textAlign: "right" }}>Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runsLoading && runs.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-500">Loading…</td></tr>
              )}
              {!runsLoading && runs.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-500">No import runs yet.</td></tr>
              )}
              {runs.map((r) => (
                <tr key={r.id} className={activeRun?.uuid === r.uuid ? "bg-blue-50/50" : "hover:bg-gray-50/60"}>
                  <Td>{r.fileName}</Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td>{r.strategy ?? "—"}</Td>
                  <Td>{r.successCount}</Td>
                  <Td>{r.failCount}</Td>
                  <Td>{r.skippedCount}</Td>
                  <Td>{r.totalRows ?? "—"}</Td>
                  <Td style={{ color: "#64748b", fontSize: 12 }}>{r.startedAt ? new Date(r.startedAt).toLocaleString() : "—"}</Td>
                  <Td style={{ color: "#64748b", fontSize: 12 }}>{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : "—"}</Td>
                  <Td style={{ textAlign: "right" }}>
                    <div className="inline-flex items-center gap-2">
                      <button
                        onClick={() => downloadCredentials(r)}
                        disabled={r.successCount < 1 || downloadingKey === r.uuid}
                        title={r.successCount < 1 ? "No successful rows — nothing to download" : "Download credentials CSV"}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 text-xs font-semibold hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Download className="h-3.5 w-3.5" /> {downloadingKey === r.uuid ? "…" : "CSV"}
                      </button>
                      <button
                        onClick={() => openRun(r)}
                        className="px-2.5 py-1.5 rounded-md text-xs font-semibold text-white"
                        style={{ background: activeRun?.uuid === r.uuid ? "#1d4ed8" : "#2563eb" }}
                      >
                        {activeRun?.uuid === r.uuid ? "Refresh" : "View Rows"}
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager
          page={runsPage}
          totalPages={runsTotalPages}
          total={runsTotal}
          shown={runs.length}
          disabled={runsLoading}
          onPrev={() => setRunsPage((p) => Math.max(1, p - 1))}
          onNext={() => setRunsPage((p) => Math.min(runsTotalPages, p + 1))}
        />
      </section>

      {activeRun && (
        <section className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-bold text-gray-900">Rows — {activeRun.fileName}</h3>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-600">Status</label>
              <select
                className="h-8 px-2 rounded-md border border-gray-300 text-xs bg-white"
                value={rowsStatus}
                onChange={(e) => changeRowsStatus(e.target.value as "" | RowStatus)}
              >
                <option value="">All</option>
                <option value="PENDING">Pending</option>
                <option value="SUCCESS">Success</option>
                <option value="FAILED">Failed</option>
                <option value="SKIPPED">Skipped</option>
              </select>
              <button
                onClick={() => loadRows(activeRun, rowsPage, rowsStatus)}
                disabled={rowsLoading}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md border border-gray-300 bg-white text-gray-700 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${rowsLoading ? "animate-spin" : ""}`} /> Refresh
              </button>
            </div>
          </div>
          {rowsLoading && rows.length === 0 ? (
            <div className="px-4 py-12 text-center text-gray-500 text-sm">Loading rows…</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-12 text-center text-gray-500 text-sm">No rows match this filter.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <Th>Row#</Th>
                    <Th>Student</Th>
                    <Th>Matric</Th>
                    <Th>Email</Th>
                    <Th>Status</Th>
                    <Th>Email Sent</Th>
                    <Th style={{ textAlign: "right" }}>Actions</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50/60">
                      <Td>{r.rowNumber}</Td>
                      <Td>{r.firstName} {r.lastName}</Td>
                      <Td style={{ fontFamily: "monospace" }}>{r.matricNumber || "—"}</Td>
                      <Td>{r.email}</Td>
                      <Td>
                        <RowBadge status={r.status} title={r.errorMessage ?? undefined} />
                      </Td>
                      <Td>{r.passwordSent ? "✓" : "—"}</Td>
                      <Td style={{ textAlign: "right" }}>
                        <button
                          onClick={() => onResend(r)}
                          disabled={r.status !== "SUCCESS" || resendingId === r.id}
                          title={r.status !== "SUCCESS" ? "Resend is only available for successful rows" : "Re-queue credential email"}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ background: r.status !== "SUCCESS" ? "#94a3b8" : "#0ea5e9" }}
                        >
                          <Send className="h-3.5 w-3.5" /> {resendingId === r.id ? "Queuing…" : "Resend Credentials"}
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager
            page={rowsPage}
            totalPages={rowsTotalPages}
            total={rowsTotal}
            shown={rows.length}
            disabled={rowsLoading}
            onPrev={() => changeRowsPage(Math.max(1, rowsPage - 1))}
            onNext={() => changeRowsPage(Math.min(rowsTotalPages, rowsPage + 1))}
          />
        </section>
      )}
    </div>
  );
};

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th style={{ padding: "10px 12px", fontSize: 12, textTransform: "uppercase", color: "#475569", textAlign: "left", whiteSpace: "nowrap", ...style }}>
      {children}
    </th>
  );
}

function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "8px 12px", whiteSpace: "nowrap", ...style }}>{children}</td>;
}

function Pager({
  page,
  totalPages,
  total,
  shown,
  disabled,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  total: number;
  shown: number;
  disabled: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50/50 text-sm text-gray-600">
      <div>Showing {shown} of {total}</div>
      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          disabled={page <= 1 || disabled}
          className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50"
        >
          Prev
        </button>
        <span className="font-medium text-gray-900 min-w-[4rem] text-center">Page {page} of {totalPages}</span>
        <button
          onClick={onNext}
          disabled={page >= totalPages || disabled}
          className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg font-medium disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { bg: string; color: string }> = {
    PENDING: { bg: "#e0e7ff", color: "#3730a3" },
    PROCESSING: { bg: "#fef3c7", color: "#92400e" },
    COMPLETED: { bg: "#dcfce7", color: "#166534" },
    FAILED: { bg: "#fee2e2", color: "#991b1b" },
  };
  const m = map[status] ?? { bg: "#f1f5f9", color: "#475569" };
  return (
    <span style={{ background: m.bg, color: m.color, padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
      {status}
    </span>
  );
}

function RowBadge({ status, title }: { status: RowStatus; title?: string }) {
  const map: Record<RowStatus, { bg: string; color: string }> = {
    PENDING: { bg: "#e0e7ff", color: "#3730a3" },
    SUCCESS: { bg: "#dcfce7", color: "#166534" },
    FAILED: { bg: "#fee2e2", color: "#991b1b" },
    SKIPPED: { bg: "#f1f5f9", color: "#475569" },
  };
  const m = map[status] ?? { bg: "#f1f5f9", color: "#475569" };
  return (
    <span title={title} style={{ background: m.bg, color: m.color, padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
      {status}
    </span>
  );
}

export default ImportHistoryPage;
