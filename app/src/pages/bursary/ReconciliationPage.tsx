import React, { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/utils/api";
import { Permissions } from "@/types/permissions";
import { useAuth } from "@/hooks/useAuth";
import { RequirePermission } from "@/components/RequireAuth";
import Alert from "@/components/Alert";
import {
  BarChart,
  Bar,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
  ResponsiveContainer,
} from "recharts";

interface SummaryT {
  totalCollected: number;
  totalSettled: number;
  pendingSettlement: number;
  unmatchedCount: number;
  exceptionsCount: number;
  byDayLast7Days: Array<{ date: string; amount: number }>;
  meta?: any;
}
interface ExceptionRow {
  id: string;
  type: string;
  reference: string;
  amount: number;
  date: string;
  studentId: number | null;
  receiptId: number | null;
  resolveUrl: string | null;
}

/**
 * Module 1 — Reconciliation Dashboard page.
 * VIEW_RECONCILIATION permission gate (Bursary and Admin have this).
 *
 * Contains:
 *   1. 4 stat cards: Collected, Settled, Pending, Exceptions.
 *   2. Last 7 day bar chart (recharts) OR list of amounts.
 *   3. Unmatched Exceptions table with "Resolve" CTA linking to receipt using resolveUrl.
 */
export default function ReconciliationPage() {
  const { hasPermission } = useAuth();
  const [summary, setSummary] = useState<SummaryT | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [s, e] = await Promise.all([
        api.get<SummaryT>("/bursary/reconciliation/summary").then((r: { data: SummaryT }) => r.data),
        api.get<{ data: ExceptionRow[] }>("/bursary/reconciliation/exceptions?size=100").then((r: { data: { data: ExceptionRow[] } }) => r.data),
      ]);
      setSummary(s);
      setExceptions(e.data ?? []);
    } catch (err0: any) {
      setErr(err0?.response?.data?.error ?? "Failed to load reconciliation data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const chartData = useMemo(
    () =>
      summary?.byDayLast7Days.map((d) => ({
        date: d.date.slice(5),
        amount: Number(d.amount),
      })) ?? [],
    [summary]
  );

  if (!hasPermission(Permissions.VIEW_RECONCILIATION)) {
    return (
      <RequirePermission permission={Permissions.VIEW_RECONCILIATION}>
        <div />
      </RequirePermission>
    );
  }

  return (
    <div>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Bursary → Reconciliation</h1>
        <p style={{ color: "#6b7280", marginTop: 4 }}>
          Session <strong>{summary?.meta?.currentSession ?? "—"}</strong>; generated at{" "}
          <span style={{ fontFamily: "monospace" }}>{summary?.meta?.generatedAt ?? "—"}</span>
        </p>
      </header>
      {err && (
        <Alert variant="danger" onClose={() => setErr(null)}>
          {err}
        </Alert>
      )}
      {loading && <div style={{ color: "#6b7280" }}>Loading…</div>}

      {summary && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 14,
            marginBottom: 22,
          }}
        >
          <StatCard
            title="Total Collected"
            value={`₦ ${fmtN(summary.totalCollected)}`}
            hint="All successful transactions"
            tone="blue"
          />
          <StatCard
            title="Total Settled"
            value={`₦ ${fmtN(summary.totalSettled)}`}
            hint="Settlements with SETTLED status"
            tone="green"
          />
          <StatCard
            title="Pending Settlement"
            value={`₦ ${fmtN(summary.pendingSettlement)}`}
            hint="Collected − Settled"
            tone="amber"
          />
          <StatCard
            title="Exceptions"
            value={`${summary.exceptionsCount}`}
            hint={`${summary.unmatchedCount} unmatched (pending TXs + unmatched webhooks)`}
            tone="red"
          />
        </div>
      )}

      <section style={{ background: "#fff", padding: 16, border: "1px solid #e5e7eb", borderRadius: 10, marginBottom: 22 }}>
        <h3 style={{ marginTop: 0 }}>Last 7 Days — Successful Transactions</h3>
        {chartData.length > 0 ? (
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="amount" fill="#2563eb" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <ul>
            {(summary?.byDayLast7Days ?? []).map((d) => (
              <li key={d.date} style={{ listStyle: "disc inside" }}>
                {d.date} — ₦ {fmtN(d.amount)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Unmatched / Exceptions ({exceptions.length})</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                <Th>Date</Th>
                <Th>Reference</Th>
                <Th>Type</Th>
                <Th style={{ textAlign: "right" }}>Amount</Th>
                <Th style={{ textAlign: "right" }}>Resolve</Th>
              </tr>
            </thead>
            <tbody>
              {exceptions.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 14, color: "#6b7280" }}>
                    No unmatched rows.
                  </td>
                </tr>
              )}
              {exceptions.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <Td>{new Date(r.date).toLocaleDateString()}</Td>
                  <Td style={{ fontFamily: "monospace" }}>{r.reference}</Td>
                  <Td>
                    <span
                      style={{
                        background: r.type.includes("EXCEPTION") ? "#fee2e2" : "#fef3c7",
                        color: r.type.includes("EXCEPTION") ? "#991b1b" : "#92400e",
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {r.type}
                    </span>
                  </Td>
                  <Td style={{ textAlign: "right", fontFamily: "monospace" }}>₦ {fmtN(r.amount)}</Td>
                  <Td style={{ textAlign: "right" }}>
                    {r.resolveUrl ? (
                      <a
                        href={r.resolveUrl}
                        style={{
                          textDecoration: "none",
                          background: "#2563eb",
                          color: "#fff",
                          padding: "6px 10px",
                          borderRadius: 6,
                          fontWeight: 600,
                          fontSize: 13,
                        }}
                      >
                        Resolve → Receipt
                      </a>
                    ) : (
                      <button
                        disabled
                        title="No receipt linked"
                        style={{
                          padding: "6px 10px",
                          background: "#f1f5f9",
                          color: "#94a3b8",
                          border: "none",
                          borderRadius: 6,
                          cursor: "not-allowed",
                          fontWeight: 600,
                          fontSize: 13,
                        }}
                      >
                        Resolve
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function fmtN(n: number | string): string {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th style={{ padding: "10px 12px", fontSize: 12, textTransform: "uppercase", color: "#475569", ...style }}>
      {children}
    </th>
  );
}
function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "10px 12px", ...style }}>{children}</td>;
}

function StatCard({
  title,
  value,
  hint,
  tone,
}: {
  title: string;
  value: React.ReactNode;
  hint?: string;
  tone: "blue" | "green" | "amber" | "red";
}) {
  const tones: Record<string, { border: string; accent: string }> = {
    blue: { border: "1px solid #bfdbfe", accent: "#1d4ed8" },
    green: { border: "1px solid #bbf7d0", accent: "#15803d" },
    amber: { border: "1px solid #fde68a", accent: "#b45309" },
    red: { border: "1px solid #fecaca", accent: "#b91c1c" },
  };
  const t = tones[tone];
  return (
    <div style={{ background: "#fff", padding: 16, borderRadius: 10, border: t.border }}>
      <div style={{ color: t.accent, fontSize: 12, fontWeight: 700, textTransform: "uppercase" }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 26, fontWeight: 700, color: "#0f172a" }}>{value}</div>
      {hint && <div style={{ marginTop: 4, color: "#64748b", fontSize: 12 }}>{hint}</div>}
    </div>
  );
}
