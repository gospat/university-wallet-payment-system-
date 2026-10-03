import React from "react";

type AlertVariant = "info" | "success" | "warning" | "danger";
interface Props {
  variant?: AlertVariant;
  title?: string;
  children: React.ReactNode;
  onClose?: () => void;
}

const variants: Record<AlertVariant, { bg: string; border: string; text: string }> = {
  info: { bg: "#dbeafe", border: "#93c5fd", text: "#1e3a8a" },
  success: { bg: "#dcfce7", border: "#86efac", text: "#14532d" },
  warning: { bg: "#fef3c7", border: "#fcd34d", text: "#92400e" },
  danger: { bg: "#fee2e2", border: "#fca5a5", text: "#7f1d1d" },
};

export default function Alert({
  variant = "info",
  title,
  children,
  onClose,
}: Props) {
  const v = variants[variant];
  return (
    <div
      role="alert"
      style={{
        background: v.bg,
        border: `1px solid ${v.border}`,
        color: v.text,
        borderRadius: 8,
        padding: "10px 14px",
        marginBottom: 12,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      <div>
        {title && <div style={{ fontWeight: 700, marginBottom: 2 }}>{title}</div>}
        <div>{children}</div>
      </div>
      {onClose && (
        <button
          type="button"
          aria-label="Close"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 16,
            color: "inherit",
            opacity: 0.7,
          }}
          onClick={onClose}
        >
          ×
        </button>
      )}
    </div>
  );
}
