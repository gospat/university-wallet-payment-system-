import React from "react";

/**
 * ConfirmDeleteModal — Module 3 TR-16.
 * Shows a confirmation dialog. 409/403 errors surfaced as alerts outside.
 */
interface Props {
  open: boolean;
  title?: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}
export default function ConfirmDeleteModal({
  open,
  title = "Confirm delete",
  body = "This action is permanent. Are you sure you want to continue?",
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = true,
  onCancel,
  onConfirm,
  busy,
}: Props) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: 20,
          width: "min(460px, 92vw)",
          borderRadius: 8,
          boxShadow: "0 18px 45px rgba(0,0,0,0.2)",
        }}
      >
        <h3 style={{ margin: "0 0 8px", color: "#111827" }}>{title}</h3>
        <div style={{ color: "#374151", marginBottom: 20 }}>{body}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            style={btnStyle("ghost")}
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            style={btnStyle(danger ? "danger" : "primary")}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function btnStyle(variant: "primary" | "ghost" | "danger"): React.CSSProperties {
  const base: React.CSSProperties = {
    minWidth: 88,
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid transparent",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
  };
  if (variant === "primary")
    return { ...base, background: "#2563eb", color: "#fff" };
  if (variant === "danger")
    return { ...base, background: "#dc2626", color: "#fff" };
  return { ...base, background: "#fff", color: "#374151", borderColor: "#d1d5db" };
}
