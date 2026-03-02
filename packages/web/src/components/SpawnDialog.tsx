"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSession } from "@/lib/types";
import type { ProjectOption } from "./Dashboard";

interface SpawnDialogProps {
  /** Pre-loaded project list from server (avoids client-side fetch). */
  projects: ProjectOption[];
  /** Called after a session is successfully spawned. */
  onSpawned?: (session: DashboardSession) => void;
}

export function SpawnDialog({ projects, onSpawned }: SpawnDialogProps) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const issueInputRef = useRef<HTMLInputElement>(null);

  // Set default project when projects load and no selection yet
  useEffect(() => {
    if (projects.length > 0 && !projectId) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  const openDialog = useCallback(() => {
    setError(null);
    setIssueId("");
    setOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    if (submitting) return;
    setOpen(false);
  }, [submitting]);

  // Focus the issue input when dialog opens
  useEffect(() => {
    if (open) {
      // Small delay to let the dialog render
      const timer = setTimeout(() => issueInputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDialog();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, closeDialog]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || submitting) return;

    setError(null);
    setSubmitting(true);

    try {
      const body: Record<string, string> = { projectId };
      if (issueId.trim()) {
        body.issueId = issueId.trim();
      }

      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Spawn failed (${res.status})`);
      }

      const data = (await res.json()) as { session?: DashboardSession };
      if (data?.session) {
        onSpawned?.(data.session);
      }
      setOpen(false);
      setIssueId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to spawn session");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="flex items-center gap-1.5 rounded-[7px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Spawn Agent
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDialog();
          }}
        >
          <dialog
            open
            className="relative w-full max-w-[420px] rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-0 shadow-xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-3.5">
              <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                Spawn Agent
              </h2>
              <button
                type="button"
                onClick={closeDialog}
                disabled={submitting}
                className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                aria-label="Close"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="px-5 py-4">
              {/* Project selector */}
              <label className="mb-3 block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Project
                </span>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={submitting}
                  className="w-full rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)] disabled:opacity-50"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id})
                    </option>
                  ))}
                </select>
              </label>

              {/* Issue ID input */}
              <label className="mb-4 block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Issue ID
                  <span className="ml-1 font-normal normal-case tracking-normal text-[var(--color-text-tertiary)]">
                    (optional)
                  </span>
                </span>
                <input
                  ref={issueInputRef}
                  type="text"
                  value={issueId}
                  onChange={(e) => setIssueId(e.target.value)}
                  disabled={submitting}
                  placeholder="e.g. INT-1327 or 42"
                  className="w-full rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none transition-colors focus:border-[var(--color-accent)] disabled:opacity-50"
                />
              </label>

              {/* Error message */}
              {error && (
                <div className="mb-3 rounded-[6px] border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.05)] px-3 py-2 text-[12px] text-[var(--color-status-error)]">
                  {error}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeDialog}
                  disabled={submitting}
                  className="rounded-[6px] px-3 py-1.5 text-[12px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !projectId}
                  className="rounded-[6px] bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {submitting ? "Spawning..." : "Spawn"}
                </button>
              </div>
            </form>
          </dialog>
        </div>
      )}
    </>
  );
}
