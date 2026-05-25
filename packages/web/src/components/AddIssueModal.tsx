"use client";

import { useState, useEffect, useCallback } from "react";

interface AddIssueModalProps {
  open: boolean;
  onClose: () => void;
  projects: Array<{ id: string; name: string }>;
  activeProjectId?: string;
}

export function AddIssueModal({ open, onClose, projects, activeProjectId }: AddIssueModalProps) {
  const [projectId, setProjectId] = useState(activeProjectId ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [addToBacklog, setAddToBacklog] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setProjectId(activeProjectId ?? projects[0]?.id ?? "");
      setTitle("");
      setDescription("");
      setAddToBacklog(false);
      setError(null);
    }
  }, [open, activeProjectId, projects]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: title.trim(), description, addToBacklog }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to create issue");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue");
    } finally {
      setSubmitting(false);
    }
  }, [projectId, title, description, addToBacklog, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.4)]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Create issue"
    >
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] p-5 shadow-xl">
        <h2 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">New Issue</h2>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)]"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              autoFocus
              placeholder="Brief description"
              className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional details\u2026"
              className="w-full resize-none rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]"
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={addToBacklog}
              onChange={(e) => setAddToBacklog(e.target.checked)}
              className="rounded"
            />
            <span className="text-xs text-[var(--color-text-secondary)]">Add to backlog</span>
          </label>
        </div>

        {error && (
          <div className="mt-3 text-xs text-red-500">{error}</div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!title.trim() || submitting}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {submitting ? "Creating\u2026" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
