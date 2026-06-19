/**
 * CreateTaskModal
 *
 * Modal form for creating a new AgentMesh task. Extracted from TaskBoard to
 * keep that component under the 400-line limit (C-04). Posts to
 * /api/agentmesh/tasks and notifies the parent to reload on success.
 */

"use client";

import { useState } from "react";

/** Roles must mirror RoleManager in @aoagents/agentmesh-core (CONS-2). */
export const ROLE_OPTIONS = [
  { value: "builder", label: "Builder" },
  { value: "qa", label: "QA Engineer" },
  { value: "planner", label: "Planner" },
  { value: "security_reviewer", label: "Security Reviewer" },
  { value: "docs_writer", label: "Documentation Writer" },
  { value: "release_manager", label: "Release Manager" },
] as const;

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
] as const;

interface CreateTaskModalProps {
  onClose: () => void;
  onCreated: () => void;
}

const INPUT_CLASS =
  "w-full mt-1 px-3 py-2 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]";
const LABEL_CLASS = "text-sm font-medium text-[var(--color-text-secondary)]";

export default function CreateTaskModal({ onClose, onCreated }: CreateTaskModalProps) {
  const [newTask, setNewTask] = useState({
    title: "",
    description: "",
    priority: "medium",
    role: "builder",
    branch: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createTask = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/agentmesh/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newTask, projectId: "agentmesh" }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to create task");
      }
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-[color-mix(in_srgb,var(--color-text-primary)_50%,transparent)] flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-bg-surface)] rounded-lg p-6 max-w-md w-full mx-4 border border-[var(--color-border-default)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-xl font-semibold text-[var(--color-text-primary)]">
            Create New Task
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={LABEL_CLASS} htmlFor="task-title">
              Title
            </label>
            <input
              id="task-title"
              type="text"
              value={newTask.title}
              onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
              className={INPUT_CLASS}
              placeholder="Task title"
            />
          </div>

          <div>
            <label className={LABEL_CLASS} htmlFor="task-description">
              Description
            </label>
            <textarea
              id="task-description"
              value={newTask.description}
              onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
              className={INPUT_CLASS}
              rows={3}
              placeholder="Task description"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={LABEL_CLASS} htmlFor="task-priority">
                Priority
              </label>
              <select
                id="task-priority"
                value={newTask.priority}
                onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
                className={INPUT_CLASS}
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={LABEL_CLASS} htmlFor="task-role">
                Role
              </label>
              <select
                id="task-role"
                value={newTask.role}
                onChange={(e) => setNewTask({ ...newTask, role: e.target.value })}
                className={INPUT_CLASS}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={LABEL_CLASS} htmlFor="task-branch">
              Branch
            </label>
            <input
              id="task-branch"
              type="text"
              value={newTask.branch}
              onChange={(e) => setNewTask({ ...newTask, branch: e.target.value })}
              className={INPUT_CLASS}
              placeholder="Leave blank to auto-generate"
            />
          </div>

          {error && <div className="text-sm text-[var(--color-status-error)]">{error}</div>}

          <div className="flex justify-end gap-2 pt-4">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded bg-[var(--color-bg-subtle)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            >
              Cancel
            </button>
            <button
              onClick={createTask}
              disabled={!newTask.title || submitting}
              className="px-4 py-2 text-sm rounded bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Creating…" : "Create Task"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
