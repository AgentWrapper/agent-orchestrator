"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";

export interface Orchestrator {
  id: string;
  projectId: string;
  projectName: string;
  status: string;
  activity: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
}

interface OrchestratorSelectorProps {
  orchestrators: Orchestrator[];
  projectId: string;
  projectName: string;
  error: string | null;
}

function formatRelativeTime(isoDate: string | null): string {
  if (!isoDate) return "Unknown";
  const date = new Date(isoDate);
  const timestamp = date.getTime();
  // Guard against invalid dates (NaN) and future timestamps
  if (!Number.isFinite(timestamp)) return "Unknown";
  const now = new Date();
  const diffMs = now.getTime() - timestamp;
  // Handle future timestamps
  if (diffMs < 0) return "Just now";
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case "working":
      return "var(--color-status-working)";
    case "spawning":
      return "var(--color-status-attention)";
    case "pr_open":
    case "review_pending":
    case "approved":
    case "mergeable":
      return "var(--color-status-ready)";
    case "ci_failed":
    case "changes_requested":
      return "var(--color-status-error)";
    case "merged":
    case "done":
    case "killed":
    case "terminated":
      return "var(--color-text-tertiary)";
    default:
      return "var(--color-text-secondary)";
  }
}

function getActivityLabel(activity: string | null): string {
  if (!activity) return "";
  switch (activity) {
    case "active":
      return "Active";
    case "ready":
      return "Ready";
    case "idle":
      return "Idle";
    case "waiting_input":
      return "Waiting";
    case "blocked":
      return "Blocked";
    case "exited":
      return "Exited";
    default:
      return activity;
  }
}

export function OrchestratorSelector({
  orchestrators,
  projectId,
  projectName,
  error,
}: OrchestratorSelectorProps) {
  const router = useRouter();
  const [isSpawning, setIsSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const spawnLockRef = useRef(false);

  const handleSpawnNew = async () => {
    // Synchronous re-entrancy guard: React state updates are async,
    // so two clicks before rerender would fire two POSTs without this.
    if (spawnLockRef.current) return;
    spawnLockRef.current = true;
    setIsSpawning(true);
    setSpawnError(null);

    try {
      const response = await fetch("/api/orchestrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to spawn orchestrator");
      }

      const data = await response.json();
      router.push(projectSessionPath(projectId, data.orchestrator.id));
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : "Failed to spawn orchestrator");
    } finally {
      setIsSpawning(false);
      spawnLockRef.current = false;
    }
  };

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--color-bg-base)]">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Error</h1>
          <p className="mt-2 text-[var(--color-text-secondary)]">{error}</p>
          <Link
            href="/"
            className="orchestrator-btn mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg-base)]">
      {/* Header */}
      <header className="nav-glass sticky top-0 z-10 border-b border-[var(--color-border-subtle)] px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
              {projectName}
            </h1>
            <p className="text-sm text-[var(--color-text-secondary)]">Project orchestrator</p>
          </div>
          <Link
            href={projectDashboardPath(projectId)}
            className="text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            Dashboard
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-3xl">
          {/* Info banner */}
          <div className="mb-6 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4">
            <p className="text-sm text-[var(--color-text-secondary)]">
              AO keeps one main orchestrator per project. Opening or spawning here reuses that
              canonical session instead of creating another duplicate.
            </p>
          </div>

          {/* Existing orchestrators */}
          <div className="mb-6">
            <h2 className="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">
              Main Session
            </h2>
            <div className="space-y-2">
              {orchestrators.map((orch) => (
                <Link
                  key={orch.id}
                  href={projectSessionPath(orch.projectId, orch.id)}
                  className={cn(
                    "flex items-center justify-between rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4",
                    "transition-all hover:border-[var(--color-border-default)] hover:shadow-sm",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: getStatusColor(orch.status) }}
                    />
                    <div>
                      <div className="font-medium text-[var(--color-text-primary)]">{orch.id}</div>
                      <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                        <span className="capitalize">{orch.status.replace(/_/g, " ")}</span>
                        {orch.activity && (
                          <>
                            <span className="text-[var(--color-text-tertiary)]">&middot;</span>
                            <span>{getActivityLabel(orch.activity)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right text-xs text-[var(--color-text-tertiary)]">
                    <div>Created {formatRelativeTime(orch.createdAt)}</div>
                    {orch.lastActivityAt && (
                      <div>Active {formatRelativeTime(orch.lastActivityAt)}</div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Start new section */}
          <div className="border-t border-[var(--color-border-subtle)] pt-6">
            <h2 className="mb-3 text-sm font-medium text-[var(--color-text-secondary)]">
              Open Orchestrator
            </h2>
            <button
              type="button"
              onClick={handleSpawnNew}
              disabled={isSpawning}
              className={cn(
                "orchestrator-btn w-full px-4 py-3 text-sm font-medium",
                "disabled:cursor-wait disabled:opacity-70",
              )}
            >
              {isSpawning ? (
                <span className="flex items-center justify-center gap-2">
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Opening orchestrator...
                </span>
              ) : (
                "Open Orchestrator"
              )}
            </button>
            {spawnError && (
              <p className="mt-2 text-sm text-[var(--color-status-error)]">{spawnError}</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
