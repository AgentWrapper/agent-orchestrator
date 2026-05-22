"use client";

import type { DashboardSession } from "@/lib/types";

interface AgentMemoryEntry {
  attempt: number;
  agentId: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "failed" | "stuck" | "killed";
  tried: string;
  failedAt?: string;
  nextSteps?: string;
  outputDigest?: string;
}

const STATUS_STYLES: Record<AgentMemoryEntry["status"], { dot: string; label: string }> = {
  completed: { dot: "bg-[var(--color-success)]", label: "Completed" },
  failed: { dot: "bg-[var(--color-danger)]", label: "Failed" },
  stuck: { dot: "bg-[var(--color-warning)]", label: "Stuck" },
  killed: { dot: "bg-[var(--color-text-tertiary)]", label: "Killed" },
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

interface AgentMemoryPanelProps {
  session: DashboardSession;
}

export function AgentMemoryPanel({ session }: AgentMemoryPanelProps) {
  const raw = session.metadata?.agentMemoryLog;
  if (!raw) return null;

  const entries: AgentMemoryEntry[] = (() => {
    try {
      return JSON.parse(raw) as AgentMemoryEntry[];
    } catch {
      return [];
    }
  })();

  if (entries.length === 0) return null;

  return (
    <div className="mt-6 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-[var(--color-text-tertiary)]"
        >
          <path d="M12 8v4l3 3" />
          <circle cx="12" cy="12" r="9" />
        </svg>
        <span className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text-tertiary)]">
          Agent memory — {entries.length} attempt{entries.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="space-y-3">
        {entries.map((entry) => {
          const style = STATUS_STYLES[entry.status] ?? STATUS_STYLES.failed;
          return (
            <div
              key={entry.attempt}
              className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${style.dot} flex-shrink-0`}
                />
                <span className="text-[12px] font-medium text-[var(--color-text-primary)]">
                  Attempt #{entry.attempt}
                </span>
                <span className="text-[11px] text-[var(--color-text-tertiary)]">
                  {style.label}
                </span>
                <span className="ml-auto text-[11px] text-[var(--color-text-tertiary)]">
                  {formatTime(entry.startedAt)} – {formatTime(entry.finishedAt)}
                </span>
              </div>

              <div className="space-y-1.5 text-[12px]">
                <div>
                  <span className="text-[var(--color-text-tertiary)]">Tried: </span>
                  <span className="text-[var(--color-text-secondary)]">{entry.tried}</span>
                </div>

                {entry.failedAt && (
                  <div>
                    <span className="text-[var(--color-text-tertiary)]">Failed at: </span>
                    <span className="text-[var(--color-danger-text,var(--color-text-secondary))]">
                      {entry.failedAt}
                    </span>
                  </div>
                )}

                {entry.nextSteps && (
                  <div>
                    <span className="text-[var(--color-text-tertiary)]">Next steps: </span>
                    <span className="text-[var(--color-text-secondary)]">{entry.nextSteps}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
