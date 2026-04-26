"use client";

import type { DashboardSession } from "@/lib/types";
import { useAggregatedTerminalConnection } from "@/lib/terminal-connection-store";
import { TerminalToggleIcon } from "@/components/icons/TerminalToggleIcon";

interface CompactTopBarProps {
  session: DashboardSession;
  collapsed: boolean[];
  toggleCollapsed: (index: number) => void;
  verticalLayout: boolean;
  onToggleVertical: () => void;
  onToggleSidebar?: () => void;
}

const activityMeta: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-status-working)" },
  ready: { label: "Ready", color: "var(--color-status-ready)" },
  idle: { label: "Idle", color: "var(--color-status-idle)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-status-attention)" },
  blocked: { label: "Blocked", color: "var(--color-status-error)" },
  exited: { label: "Exited", color: "var(--color-status-error)" },
};

export function CompactTopBar({
  session,
  collapsed,
  toggleCollapsed,
  verticalLayout,
  onToggleVertical,
  onToggleSidebar,
}: CompactTopBarProps) {
  const meta = (session.activity && activityMeta[session.activity]) || {
    label: session.activity ?? "unknown",
    color: "var(--color-text-secondary)",
  };
  const { reconnecting } = useAggregatedTerminalConnection();

  return (
    <div className="compact-top-bar relative">
      {reconnecting && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[2px] overflow-hidden"
          aria-hidden
        >
          <div className="compact-top-bar__reconnect-bar h-full w-1/3 bg-[var(--color-accent)]" />
        </div>
      )}
      <div className="compact-top-bar__left">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="compact-top-bar__sidebar-toggle"
            aria-label="Toggle file panel"
            title="Toggle file panel"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <line x1="2" y1="4" x2="14" y2="4" />
              <line x1="2" y1="8" x2="14" y2="8" />
              <line x1="2" y1="12" x2="14" y2="12" />
            </svg>
          </button>
        )}

        <div className="compact-top-bar__info">
          <div className="compact-top-bar__row1">
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>
              {session.id}
            </span>
            <span style={{ color: "var(--color-border-subtle)" }}>·</span>
            <div style={{ display: "flex", alignItems: "center", gap: "4px", color: "var(--color-text-secondary)", fontSize: "11px" }}>
              <span style={{ color: meta.color, fontSize: "8px" }}>●</span>
              <span>{meta.label}</span>
            </div>
          </div>
          {(session.branch || session.pr) && (
            <div className="compact-top-bar__row2">
              {session.branch && (
                <span
                  className="compact-top-bar__branch"
                  onClick={() => { if (session.branch) navigator.clipboard.writeText(session.branch); }}
                  title="Click to copy"
                >
                  {session.branch}
                </span>
              )}
              {session.pr && (
                <>
                  <span className="compact-top-bar__pr-info">
                    <a href={session.pr.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-accent)", textDecoration: "none", whiteSpace: "nowrap" }}>
                      PR #{session.pr.number}
                    </a>
                    {session.pr.additions !== undefined && session.pr.deletions !== undefined && (
                      <span style={{ color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                        {" "}+{session.pr.additions} -{session.pr.deletions}
                      </span>
                    )}
                  </span>
                  {session.pr.ciStatus && (
                    <span
                      className="compact-top-bar__ci"
                      style={{
                        color:
                          session.pr.ciStatus === "passing"
                            ? "var(--color-status-ready)"
                            : session.pr.ciStatus === "failing"
                              ? "var(--color-status-error)"
                              : "var(--color-status-idle)",
                      }}
                    >
                      CI {session.pr.ciStatus === "passing" ? "✓" : session.pr.ciStatus === "failing" ? "✗" : "◌"}
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
        {[
          { idx: 0, icon: "📁", label: "Files", shortcut: "⌘⇧F" },
          { idx: 1, icon: "📄", label: "Preview", shortcut: "⌘⇧P" },
          { idx: 2, icon: <TerminalToggleIcon />, label: "Terminal", shortcut: "⌘⇧Z" },
        ].map(({ idx, icon, label, shortcut }) => {
          const active = !collapsed[idx];
          return (
            <button
              key={idx}
              type="button"
              className="compact-top-bar__pane-toggle"
              onClick={() => toggleCollapsed(idx)}
              title={`Toggle ${label} (${shortcut})`}
              style={{
                background: "none",
                border: "none",
                borderBottom: active ? "2px solid var(--color-accent)" : "2px solid transparent",
                cursor: "pointer",
                padding: "6px 8px 4px",
                color: active ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
                opacity: active ? 1 : 0.5,
                transition: "all 0.15s",
                marginBottom: "-1px",
              }}
            >
              <span className="compact-top-bar__pane-toggle-icon">{icon}</span>
            </button>
          );
        })}
        <div style={{ width: "1px", height: "16px", background: "var(--color-border-subtle)", margin: "0 4px" }} />
        <button
          onClick={onToggleVertical}
          title={`Toggle layout — ${verticalLayout ? "Horizontal layout" : "Vertical layout"}`}
          style={{
            background: "none",
            border: "none",
            borderBottom: "2px solid transparent",
            cursor: "pointer",
            padding: "6px 8px 4px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-text-secondary)",
            transition: "all 0.15s",
            marginBottom: "-1px",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            {verticalLayout ? (
              <>
                <rect x="1" y="1" width="14" height="14" rx="1.5" />
                <line x1="1" y1="6" x2="15" y2="6" />
                <line x1="1" y1="11" x2="15" y2="11" />
              </>
            ) : (
              <>
                <rect x="1" y="1" width="14" height="14" rx="1.5" />
                <line x1="1" y1="8" x2="15" y2="8" />
              </>
            )}
          </svg>
        </button>
      </div>
    </div>
  );
}
