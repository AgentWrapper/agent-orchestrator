/**
 * Storage Utilities
 *
 * Manages AgentMesh storage directory structure and paths.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentMeshStorage as AgentMeshStorageInterface } from "./types.js";

export class AgentMeshStorage {
  private basePath: string;
  private projectId: string;

  constructor(projectId: string, basePath?: string) {
    this.projectId = projectId;
    this.basePath = basePath || join(homedir(), ".agentmesh");
    this.ensureStorage();
  }

  private ensureStorage(): void {
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }

    const projectPath = this.getProjectPath();
    if (!existsSync(projectPath)) {
      mkdirSync(projectPath, { recursive: true });
    }

    const tasksPath = this.getTasksPath();
    if (!existsSync(tasksPath)) {
      mkdirSync(tasksPath, { recursive: true });
    }
  }

  getProjectPath(): string {
    return join(this.basePath, this.projectId);
  }

  getTasksPath(): string {
    return join(this.getProjectPath(), "tasks");
  }

  getMessagesPath(): string {
    return join(this.getProjectPath(), "messages.jsonl");
  }

  getTimelinePath(): string {
    return join(this.getProjectPath(), "timeline.jsonl");
  }

  getDatabasePath(): string {
    return join(this.getTasksPath(), "tasks.db");
  }

  getStorage(): AgentMeshStorageInterface {
    return {
      taskDir: this.getTasksPath(),
      messageLog: this.getMessagesPath(),
      timelineLog: this.getTimelinePath(),
      databasePath: this.getDatabasePath(),
    };
  }

  /**
   * Clean up storage for a project
   */
  cleanup(): void {
    // This would recursively remove the project directory
    // For now, just a placeholder
  }
}
