/**
 * TaskBoard Component
 *
 * Kanban-style view of AgentMesh tasks.
 * Shows tasks organized by status: created, building, qa_running, qa_passed, rework, blocked, done.
 */

"use client";

import { useState, useEffect } from "react";
import { Skeleton } from "./Skeleton";
import CreateTaskModal from "./CreateTaskModal";

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  role: string;
  assignee?: string;
  projectId: string;
  branch: string;
  issueId?: string;
  issueUrl?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
}

const STATUS_COLUMNS = [
  { id: "created", label: "Created", color: "bg-[var(--color-tint-neutral)]" },
  { id: "building", label: "Building", color: "bg-[var(--color-tint-blue)]" },
  { id: "qa_running", label: "QA Running", color: "bg-[var(--color-tint-yellow)]" },
  { id: "qa_passed", label: "QA Passed", color: "bg-[var(--color-tint-green)]" },
  { id: "rework", label: "Rework", color: "bg-[var(--color-tint-orange)]" },
  { id: "blocked", label: "Blocked", color: "bg-[var(--color-tint-red)]" },
  { id: "done", label: "Done", color: "bg-[var(--color-tint-violet)]" },
];

const PRIORITY_COLORS = {
  low: "text-[var(--color-text-tertiary)]",
  medium: "text-[var(--color-accent-blue)]",
  high: "text-[var(--color-accent-orange)]",
  critical: "text-[var(--color-status-error)]",
};

export default function TaskBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    loadTasks();
    // AgentMesh tasks are not part of the session SSE stream, so the board
    // polls its own endpoint. This is a deliberate second 5s timer alongside
    // useSessionEvents; matched to the 5s SSE cadence to keep request volume
    // predictable (see PERF-1 in the pre-launch checklist).
    const interval = setInterval(loadTasks, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadTasks = async () => {
    try {
      const response = await fetch("/api/agentmesh/tasks");
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to fetch tasks");
      }
      const data = await response.json();
      setTasks(data.tasks ?? []);
      setLoadError(null);
      setLoading(false);
    } catch (error) {
      console.error("Failed to load tasks:", error);
      setLoadError(error instanceof Error ? error.message : "Failed to load tasks");
      setLoading(false);
    }
  };

  const getTasksByStatus = (status: string) => tasks.filter((task) => task.status === status);

  const getPriorityIcon = (priority: string) => {
    const icons = { low: "↓", medium: "→", high: "↑", critical: "⚡" };
    return icons[priority as keyof typeof icons] || "→";
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const startTask = async (taskId: string) => {
    try {
      const response = await fetch(`/api/agentmesh/tasks/${taskId}/start`, { method: "POST" });
      if (!response.ok) throw new Error("Failed to start task");
      loadTasks();
    } catch (error) {
      console.error("Failed to start task:", error);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col" aria-busy="true">
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-7 w-32" />
        </div>
        <div className="flex gap-4 flex-1 min-w-max">
          {STATUS_COLUMNS.slice(0, 4).map((column) => (
            <div key={column.id} className={`${column.color} rounded-lg p-4 w-80 flex-shrink-0`}>
              <Skeleton className="h-5 w-24 mb-3" />
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-[var(--color-status-error)] font-medium mb-2">
            Failed to load tasks
          </div>
          <div className="text-sm text-[var(--color-text-tertiary)]">{loadError}</div>
          <button
            onClick={loadTasks}
            className="mt-4 px-3 py-1 text-sm rounded bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">
          AgentMesh Task Board
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-3 py-1 text-sm rounded bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)]"
          >
            + New Task
          </button>
          <button
            onClick={loadTasks}
            className="px-3 py-1 text-sm rounded bg-[var(--color-bg-subtle)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-x-auto">
        <div className="flex gap-4 h-full min-w-max">
          {STATUS_COLUMNS.map((column) => {
            const columnTasks = getTasksByStatus(column.id);
            return (
              <div
                key={column.id}
                data-column-id={column.id}
                className={`${column.color} rounded-lg p-4 w-80 flex-shrink-0 flex flex-col`}
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-[var(--color-text-secondary)]">
                    {column.label}
                  </h3>
                  <span className="text-sm text-[var(--color-text-tertiary)] bg-[var(--color-bg-surface)] px-2 py-1 rounded">
                    {columnTasks.length}
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                  {columnTasks.map((task) => (
                    <div
                      key={task.id}
                      onClick={() => setSelectedTask(task)}
                      className="bg-[var(--color-bg-surface)] p-3 rounded shadow-sm hover:shadow-md cursor-pointer transition-shadow border border-[var(--color-border-subtle)]"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <span className="text-xs font-mono text-[var(--color-text-tertiary)]">
                          {task.id}
                        </span>
                        <span
                          className={`text-xs ${PRIORITY_COLORS[task.priority as keyof typeof PRIORITY_COLORS] ?? "text-[var(--color-text-tertiary)]"}`}
                        >
                          {getPriorityIcon(task.priority)}
                        </span>
                      </div>

                      <h4 className="font-medium text-sm mb-1 text-[var(--color-text-primary)]">
                        {task.title}
                      </h4>
                      <p className="text-xs text-[var(--color-text-secondary)] mb-2 line-clamp-2">
                        {task.description}
                      </p>

                      <div className="flex items-center justify-between text-xs text-[var(--color-text-tertiary)]">
                        <span className="bg-[var(--color-bg-subtle)] px-2 py-0.5 rounded">
                          {task.role}
                        </span>
                        <span>{formatDate(task.updatedAt)}</span>
                      </div>

                      {task.issueId && (
                        <div className="mt-2">
                          <a
                            href={task.issueUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[var(--color-accent)] hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {task.issueId}
                          </a>
                        </div>
                      )}

                      {task.status === "created" && (
                        <div className="mt-2 pt-2 border-t border-[var(--color-border-subtle)]">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startTask(task.id);
                            }}
                            className="w-full text-xs rounded bg-[var(--color-accent)] text-[var(--color-text-inverse)] py-1 hover:bg-[var(--color-accent-hover)]"
                          >
                            Start
                          </button>
                        </div>
                      )}
                    </div>
                  ))}

                  {columnTasks.length === 0 && (
                    <div className="text-center text-[var(--color-text-muted)] text-sm py-8">
                      No tasks
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selectedTask && (
        <div
          className="fixed inset-0 bg-[color-mix(in_srgb,var(--color-text-primary)_50%,transparent)] flex items-center justify-center z-50"
          onClick={() => setSelectedTask(null)}
        >
          <div
            className="bg-[var(--color-bg-surface)] rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto border border-[var(--color-border-default)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-semibold text-[var(--color-text-primary)]">
                  {selectedTask.title}
                </h3>
                <p className="text-sm text-[var(--color-text-tertiary)]">{selectedTask.id}</p>
              </div>
              <button
                onClick={() => setSelectedTask(null)}
                aria-label="Close"
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                  Description
                </label>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  {selectedTask.description}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {(
                  [
                    ["Status", selectedTask.status],
                    ["Priority", selectedTask.priority],
                    ["Role", selectedTask.role],
                    ["Branch", selectedTask.branch],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                      {label}
                    </label>
                    <p className="text-sm text-[var(--color-text-secondary)] mt-1 capitalize">
                      {value}
                    </p>
                  </div>
                ))}
              </div>

              <div>
                <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                  Timeline
                </label>
                <div className="text-sm text-[var(--color-text-secondary)] mt-1 space-y-1">
                  <p>Created: {formatDate(selectedTask.createdAt)}</p>
                  {selectedTask.startedAt && <p>Started: {formatDate(selectedTask.startedAt)}</p>}
                  {selectedTask.completedAt && (
                    <p>Completed: {formatDate(selectedTask.completedAt)}</p>
                  )}
                </div>
              </div>

              {selectedTask.issueId && (
                <div>
                  <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                    Issue
                  </label>
                  <a
                    href={selectedTask.issueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm text-[var(--color-accent)] hover:underline mt-1"
                  >
                    {selectedTask.issueId}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showCreateModal && (
        <CreateTaskModal onClose={() => setShowCreateModal(false)} onCreated={loadTasks} />
      )}
    </div>
  );
}
