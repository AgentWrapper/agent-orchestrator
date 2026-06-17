/**
 * Task Manager
 * 
 * Manages the task board with SQLite persistence.
 * Handles task CRUD operations and status transitions.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Task, TaskId, TaskStatus, TaskPriority } from "./types.js";

const DatabaseAvailable = Database !== undefined;

export class TaskManager {
  private db: Database.Database | null;
  private storagePath: string;
  private inMemoryTasks: Map<TaskId, Task>;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.inMemoryTasks = new Map();
    this.ensureStorageDir();
    
    if (DatabaseAvailable) {
      this.db = new Database(join(storagePath, "tasks.db"));
      this.initializeSchema();
    } else {
      this.db = null;
      console.warn("[TaskManager] better-sqlite3 not available, using in-memory storage");
    }
  }

  private ensureStorageDir(): void {
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true });
    }
  }

  private initializeSchema(): void {
    if (!this.db) return;
    
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        role TEXT NOT NULL,
        assignee TEXT,
        projectId TEXT NOT NULL,
        branch TEXT NOT NULL,
        issueId TEXT,
        issueUrl TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        startedAt TEXT,
        completedAt TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId);
      CREATE INDEX IF NOT EXISTS idx_tasks_role ON tasks(role);
    `);
  }

  create(task: Omit<Task, "id" | "createdAt" | "updatedAt">): Task {
    const id = this.generateTaskId();
    const now = new Date().toISOString();
    
    const newTask: Task = {
      ...task,
      id,
      createdAt: now,
      updatedAt: now,
    };

    if (this.db) {
      const stmt = this.db.prepare(`
        INSERT INTO tasks (
          id, title, description, status, priority, role, assignee,
          projectId, branch, issueId, issueUrl, createdAt, updatedAt,
          startedAt, completedAt, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        newTask.id,
        newTask.title,
        newTask.description,
        newTask.status,
        newTask.priority,
        newTask.role,
        newTask.assignee || null,
        newTask.projectId,
        newTask.branch,
        newTask.issueId || null,
        newTask.issueUrl || null,
        newTask.createdAt,
        newTask.updatedAt,
        newTask.startedAt || null,
        newTask.completedAt || null,
        JSON.stringify(newTask.metadata)
      );
    } else {
      this.inMemoryTasks.set(id, newTask);
    }

    return newTask;
  }

  get(taskId: TaskId): Task | null {
    if (this.db) {
      const stmt = this.db.prepare("SELECT * FROM tasks WHERE id = ?");
      const row = stmt.get(taskId) as any;
      
      if (!row) return null;
      
      return this.rowToTask(row);
    } else {
      return this.inMemoryTasks.get(taskId) || null;
    }
  }

  list(filters?: {
    status?: TaskStatus;
    projectId?: string;
    role?: string;
    assignee?: string;
  }): Task[] {
    if (this.db) {
      let query = "SELECT * FROM tasks WHERE 1=1";
      const params: any[] = [];

      if (filters?.status) {
        query += " AND status = ?";
        params.push(filters.status);
      }
      if (filters?.projectId) {
        query += " AND projectId = ?";
        params.push(filters.projectId);
      }
      if (filters?.role) {
        query += " AND role = ?";
        params.push(filters.role);
      }
      if (filters?.assignee) {
        query += " AND assignee = ?";
        params.push(filters.assignee);
      }

      query += " ORDER BY createdAt DESC";

      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as any[];
      
      return rows.map(row => this.rowToTask(row));
    } else {
      let tasks = Array.from(this.inMemoryTasks.values());
      
      if (filters?.status) {
        tasks = tasks.filter(t => t.status === filters.status);
      }
      if (filters?.projectId) {
        tasks = tasks.filter(t => t.projectId === filters.projectId);
      }
      if (filters?.role) {
        tasks = tasks.filter(t => t.role === filters.role);
      }
      if (filters?.assignee) {
        tasks = tasks.filter(t => t.assignee === filters.assignee);
      }
      
      return tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
  }

  update(taskId: TaskId, updates: Partial<Omit<Task, "id" | "createdAt">>): Task | null {
    const existing = this.get(taskId);
    if (!existing) return null;

    const updated: Task = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    if (this.db) {
      const stmt = this.db.prepare(`
        UPDATE tasks SET
          title = ?, description = ?, status = ?, priority = ?, role = ?,
          assignee = ?, projectId = ?, branch = ?, issueId = ?, issueUrl = ?,
          updatedAt = ?, startedAt = ?, completedAt = ?, metadata = ?
        WHERE id = ?
      `);

      stmt.run(
        updated.title,
        updated.description,
        updated.status,
        updated.priority,
        updated.role,
        updated.assignee || null,
        updated.projectId,
        updated.branch,
        updated.issueId || null,
        updated.issueUrl || null,
        updated.updatedAt,
        updated.startedAt || null,
        updated.completedAt || null,
        JSON.stringify(updated.metadata),
        taskId
      );
    } else {
      this.inMemoryTasks.set(taskId, updated);
    }

    return updated;
  }

  delete(taskId: TaskId): boolean {
    if (this.db) {
      const stmt = this.db.prepare("DELETE FROM tasks WHERE id = ?");
      const result = stmt.run(taskId);
      return result.changes > 0;
    } else {
      return this.inMemoryTasks.delete(taskId);
    }
  }

  transitionStatus(taskId: TaskId, newStatus: TaskStatus): Task | null {
    const task = this.get(taskId);
    if (!task) return null;

    const updates: Partial<Task> = { status: newStatus };

    // Update timestamps based on status transitions
    if (newStatus === "building" && !task.startedAt) {
      updates.startedAt = new Date().toISOString();
    }
    if (newStatus === "done" && !task.completedAt) {
      updates.completedAt = new Date().toISOString();
    }

    return this.update(taskId, updates);
  }

  private generateTaskId(): string {
    return `TASK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      role: row.role,
      assignee: row.assignee || undefined,
      projectId: row.projectId,
      branch: row.branch,
      issueId: row.issueId || undefined,
      issueUrl: row.issueUrl || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt || undefined,
      completedAt: row.completedAt || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    };
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
