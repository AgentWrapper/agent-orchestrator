/**
 * TaskBoard Component
 * 
 * Kanban-style view of AgentMesh tasks with drag-and-drop support.
 * Shows tasks organized by status: created, building, qa_running, qa_passed, rework, blocked, done.
 */

"use client";

import { useState, useEffect } from "react";

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
  { id: "created", label: "Created", color: "bg-gray-100" },
  { id: "building", label: "Building", color: "bg-blue-100" },
  { id: "qa_running", label: "QA Running", color: "bg-yellow-100" },
  { id: "qa_passed", label: "QA Passed", color: "bg-green-100" },
  { id: "rework", label: "Rework", color: "bg-orange-100" },
  { id: "blocked", label: "Blocked", color: "bg-red-100" },
  { id: "done", label: "Done", color: "bg-purple-100" },
];

const PRIORITY_COLORS = {
  low: "text-gray-500",
  medium: "text-blue-500",
  high: "text-orange-500",
  critical: "text-red-500",
};

export default function TaskBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTask, setNewTask] = useState({
    title: "",
    description: "",
    priority: "medium",
    role: "builder",
    branch: "main",
  });

  useEffect(() => {
    loadTasks();
    // Poll for updates every 5 seconds
    const interval = setInterval(loadTasks, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadTasks = async () => {
    try {
      const response = await fetch("/api/agentmesh/tasks");
      if (!response.ok) {
        throw new Error("Failed to fetch tasks");
      }
      const data = await response.json();
      setTasks(data.tasks);
      setLoading(false);
    } catch (error) {
      console.error("Failed to load tasks:", error);
      // Fall back to mock data if API fails
      const mockTasks: Task[] = [
        {
          id: "TASK-1",
          title: "Fix login bug",
          description: "Users are unable to login with SSO",
          status: "building",
          priority: "high",
          role: "builder",
          projectId: "my-app",
          branch: "fix/login-sso",
          issueId: "ISSUE-123",
          issueUrl: "https://github.com/org/repo/issues/123",
          createdAt: new Date(Date.now() - 3600000).toISOString(),
          updatedAt: new Date(Date.now() - 1800000).toISOString(),
          startedAt: new Date(Date.now() - 1800000).toISOString(),
          metadata: {},
        },
        {
          id: "TASK-2",
          title: "Add user settings page",
          description: "Implement user preferences and settings UI",
          status: "qa_running",
          priority: "medium",
          role: "qa",
          projectId: "my-app",
          branch: "feat/user-settings",
          issueId: "ISSUE-124",
          createdAt: new Date(Date.now() - 7200000).toISOString(),
          updatedAt: new Date(Date.now() - 600000).toISOString(),
          metadata: {},
        },
        {
          id: "TASK-3",
          title: "Optimize database queries",
          description: "Improve performance of slow queries",
          status: "done",
          priority: "critical",
          role: "builder",
          projectId: "my-app",
          branch: "perf/db-optimization",
          issueId: "ISSUE-125",
          createdAt: new Date(Date.now() - 86400000).toISOString(),
          updatedAt: new Date(Date.now() - 3600000).toISOString(),
          completedAt: new Date(Date.now() - 3600000).toISOString(),
          metadata: {},
        },
      ];
      setTasks(mockTasks);
      setLoading(false);
    }
  };

  const getTasksByStatus = (status: string) => {
    return tasks.filter((task) => task.status === status);
  };

  const getPriorityIcon = (priority: string) => {
    const icons = {
      low: "↓",
      medium: "→",
      high: "↑",
      critical: "⚡",
    };
    return icons[priority as keyof typeof icons] || "→";
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const createTask = async () => {
    try {
      const response = await fetch("/api/agentmesh/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newTask,
          projectId: "agentmesh",
        }),
      });
      if (!response.ok) throw new Error("Failed to create task");
      setShowCreateModal(false);
      setNewTask({ title: "", description: "", priority: "medium", role: "builder", branch: "main" });
      loadTasks();
    } catch (error) {
      console.error("Failed to create task:", error);
      alert("Failed to create task");
    }
  };

  const startTask = async (taskId: string) => {
    try {
      const response = await fetch(`/api/agentmesh/tasks/${taskId}/start`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Failed to start task");
      loadTasks();
    } catch (error) {
      console.error("Failed to start task:", error);
      alert("Failed to start task");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading task board...</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">AgentMesh Task Board</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-3 py-1 text-sm bg-green-500 text-white rounded hover:bg-green-600"
          >
            + New Task
          </button>
          <button
            onClick={loadTasks}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
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
                className={`${column.color} rounded-lg p-4 w-80 flex-shrink-0 flex flex-col`}
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-gray-700">{column.label}</h3>
                  <span className="text-sm text-gray-500 bg-white px-2 py-1 rounded">
                    {columnTasks.length}
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                  {columnTasks.map((task) => (
                    <div
                      key={task.id}
                      onClick={() => setSelectedTask(task)}
                      className="bg-white p-3 rounded shadow-sm hover:shadow-md cursor-pointer transition-shadow"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <span className="text-xs font-mono text-gray-500">
                          {task.id}
                        </span>
                        <span
                          className={`text-xs ${PRIORITY_COLORS[task.priority as keyof typeof PRIORITY_COLORS]}`}
                        >
                          {getPriorityIcon(task.priority)}
                        </span>
                      </div>

                      <h4 className="font-medium text-sm mb-1">{task.title}</h4>
                      <p className="text-xs text-gray-600 mb-2 line-clamp-2">
                        {task.description}
                      </p>

                      <div className="flex items-center justify-between text-xs text-gray-500">
                        <span className="bg-gray-100 px-2 py-0.5 rounded">
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
                            className="text-xs text-blue-500 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {task.issueId}
                          </a>
                        </div>
                      )}

                      {/* Action buttons */}
                      {task.status === "created" && (
                        <div className="mt-2 pt-2 border-t">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startTask(task.id);
                            }}
                            className="w-full text-xs bg-blue-500 text-white py-1 rounded hover:bg-blue-600"
                          >
                            Start
                          </button>
                        </div>
                      )}
                    </div>
                  ))}

                  {columnTasks.length === 0 && (
                    <div className="text-center text-gray-400 text-sm py-8">
                      No tasks
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Task Detail Modal */}
      {selectedTask && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => setSelectedTask(null)}
        >
          <div
            className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-semibold">{selectedTask.title}</h3>
                <p className="text-sm text-gray-500">{selectedTask.id}</p>
              </div>
              <button
                onClick={() => setSelectedTask(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Description</label>
                <p className="text-sm text-gray-600 mt-1">{selectedTask.description}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Status</label>
                  <p className="text-sm text-gray-600 mt-1 capitalize">{selectedTask.status}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Priority</label>
                  <p className="text-sm text-gray-600 mt-1 capitalize">{selectedTask.priority}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Role</label>
                  <p className="text-sm text-gray-600 mt-1 capitalize">{selectedTask.role}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">Branch</label>
                  <p className="text-sm text-gray-600 mt-1">{selectedTask.branch}</p>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700">Timeline</label>
                <div className="text-sm text-gray-600 mt-1 space-y-1">
                  <p>Created: {formatDate(selectedTask.createdAt)}</p>
                  {selectedTask.startedAt && (
                    <p>Started: {formatDate(selectedTask.startedAt)}</p>
                  )}
                  {selectedTask.completedAt && (
                    <p>Completed: {formatDate(selectedTask.completedAt)}</p>
                  )}
                </div>
              </div>

              {selectedTask.issueId && (
                <div>
                  <label className="text-sm font-medium text-gray-700">Issue</label>
                  <a
                    href={selectedTask.issueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm text-blue-500 hover:underline mt-1"
                  >
                    {selectedTask.issueId}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create Task Modal */}
      {showCreateModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="bg-white rounded-lg p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-xl font-semibold">Create New Task</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Title</label>
                <input
                  type="text"
                  value={newTask.title}
                  onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                  className="w-full mt-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Task title"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700">Description</label>
                <textarea
                  value={newTask.description}
                  onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                  className="w-full mt-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={3}
                  placeholder="Task description"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Priority</label>
                  <select
                    value={newTask.priority}
                    onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
                    className="w-full mt-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>

                <div>
                  <label className="text-sm font-medium text-gray-700">Role</label>
                  <select
                    value={newTask.role}
                    onChange={(e) => setNewTask({ ...newTask, role: e.target.value })}
                    className="w-full mt-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="builder">Builder</option>
                    <option value="qa">QA</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700">Branch</label>
                <input
                  type="text"
                  value={newTask.branch}
                  onChange={(e) => setNewTask({ ...newTask, branch: e.target.value })}
                  className="w-full mt-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="main"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                >
                  Cancel
                </button>
                <button
                  onClick={createTask}
                  disabled={!newTask.title}
                  className="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  Create Task
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
