/**
 * Shows a three-column support matrix for macOS / Linux / Windows.
 * Use at the top of plugin pages to set platform expectations immediately.
 */
import type { ReactNode } from "react";
import { Logo } from "./Logo";

type Status = "full" | "partial" | "none";

export interface PlatformSupportProps {
  macos?: Status;
  linux?: Status;
  windows?: Status;
  note?: ReactNode;
}

const LABEL: Record<Status, string> = {
  full: "Supported",
  partial: "In progress",
  none: "Not supported",
};

const DOT_COLOR: Record<Status, string> = {
  full: "var(--color-accent-amber, #f97316)",
  partial: "var(--color-accent-amber-dim, #a3581b)",
  none: "var(--color-text-muted, #605e5c)",
};

function Cell({ platform, status }: { platform: "macos" | "linux" | "windows"; status: Status }) {
  const logoName = platform === "macos" ? "apple" : platform;
  const title = platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.5rem 0.75rem",
        borderRadius: "0.375rem",
        border: "1px solid var(--color-fd-border)",
        backgroundColor: "var(--color-fd-card)",
        flex: "1 1 0",
        minWidth: 0,
      }}
    >
      <Logo name={logoName} size={18} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-fd-foreground)" }}>
          {title}
        </span>
        <span
          style={{
            fontSize: "0.75rem",
            color: "var(--color-fd-muted-foreground)",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.375rem",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "999px",
              backgroundColor: DOT_COLOR[status],
              display: "inline-block",
            }}
          />
          {LABEL[status]}
        </span>
      </div>
    </div>
  );
}

export function PlatformSupport({
  macos = "full",
  linux = "full",
  windows = "full",
  note,
}: PlatformSupportProps) {
  return (
    <div style={{ margin: "1.25rem 0" }}>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <Cell platform="macos" status={macos} />
        <Cell platform="linux" status={linux} />
        <Cell platform="windows" status={windows} />
      </div>
      {note && (
        <p
          style={{
            margin: "0.5rem 0 0 0",
            fontSize: "0.8125rem",
            color: "var(--color-fd-muted-foreground)",
          }}
        >
          {note}
        </p>
      )}
    </div>
  );
}
