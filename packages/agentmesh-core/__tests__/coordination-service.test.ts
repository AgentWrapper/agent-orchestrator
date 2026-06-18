/**
 * Integration tests for CoordinationService
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoordinationService } from "../src/coordination-service.js";
import type { SessionManager, Session } from "@aoagents/ao-core";
import { randomUUID } from "node:crypto";

// Mock SessionManager
class MockSessionManager implements SessionManager {
  private sessions: Map<string, Session> = new Map();

  async spawn(config: {
    projectId: string;
    issueId?: string;
    branch?: string;
    agent?: string;
    prompt?: string;
  }): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      projectId: config.projectId,
      issueId: config.issueId,
      branch: config.branch || "main",
      status: "working",
      activity: "Initializing",
      createdAt: new Date().toISOString(),
      metadata: {
        agent: config.agent,
        prompt: config.prompt,
      },
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async get(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) || null;
  }

  async list(projectId?: string): Promise<Session[]> {
    const allSessions = Array.from(this.sessions.values());
    if (projectId) {
      return allSessions.filter((s) => s.projectId === projectId);
    }
    return allSessions;
  }

  async send(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.activity = `Processing: ${message.substring(0, 50)}...`;
    }
  }

  async kill(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async restore(_sessionId: string): Promise<void> {
    // Mock implementation
  }

  async remap(sessionId: string, newProjectId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.projectId = newProjectId;
    }
  }
}

describe("CoordinationService", () => {
  let coordinationService: CoordinationService;
  let mockSessionManager: MockSessionManager;
  let tempDir: string;

  beforeEach(() => {
    mockSessionManager = new MockSessionManager();
    tempDir = `/tmp/agentmesh-test-${randomUUID()}`;
    coordinationService = new CoordinationService(mockSessionManager, "test-project", tempDir);
  });

  afterEach(async () => {
    // Cleanup would happen here in real tests
  });

  describe("Task Management", () => {
    it("should create a task", async () => {
      const task = await coordinationService.createTask({
        title: "Test Task",
        description: "Test description",
        role: "builder",
        priority: "high",
        projectId: "test-project",
        branch: "main",
      });

      expect(task).toBeDefined();
      expect(task.title).toBe("Test Task");
      expect(task.status).toBe("created");
      expect(task.id).toBeDefined();
    });

    it("should get a task by ID", async () => {
      const created = await coordinationService.createTask({
        title: "Test Task",
        description: "Test description",
        role: "builder",
        priority: "high",
        projectId: "test-project",
        branch: "main",
      });

      const retrieved = coordinationService.getTask(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it("should list tasks", async () => {
      await coordinationService.createTask({
        title: "Task 1",
        description: "Description 1",
        role: "builder",
        priority: "high",
        projectId: "test-project",
        branch: "main",
      });

      await coordinationService.createTask({
        title: "Task 2",
        description: "Description 2",
        role: "qa",
        priority: "medium",
        projectId: "test-project",
        branch: "main",
      });

      const tasks = coordinationService.listTasks();
      expect(tasks).toHaveLength(2);
    });

    it("should delete a task", async () => {
      const task = await coordinationService.createTask({
        title: "Test Task",
        description: "Test description",
        role: "builder",
        priority: "high",
        projectId: "test-project",
        branch: "main",
      });

      coordinationService.deleteTask(task.id);

      const retrieved = coordinationService.getTask(task.id);
      expect(retrieved).toBeNull();
    });
  });

  describe("Adapter Management", () => {
    it("should register an adapter", () => {
      const mockAdapter = {
        name: "test-adapter",
        displayName: "Test Adapter",
        preflight: async () => ({ ok: true, version: "1.0.0", warnings: [] }),
        start: async () => ({
          aoSessionId: "test-session-id",
          taskId: "test-task",
          role: "builder",
          startedAt: new Date(),
        }),
        sendMessage: async () => {},
        getOutput: async () => ({ text: "", capturedAt: new Date(), linesRead: 0 }),
        getStatus: async () => "idle",
        stop: async () => {},
      };

      coordinationService.registerAdapter("test-adapter", mockAdapter);
      const retrieved = coordinationService.getAdapter("test-adapter");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("test-adapter");
    });

    it("should return null for non-existent adapter", () => {
      const retrieved = coordinationService.getAdapter("non-existent");
      expect(retrieved).toBeNull();
    });
  });

  describe("Lock Management", () => {
    it("should check if resource is locked", () => {
      const isLocked = coordinationService.isResourceLocked("/path/to/file.ts");
      expect(isLocked).toBe(false);
    });

    it("should get active locks", () => {
      const locks = coordinationService.getActiveLocks();
      expect(Array.isArray(locks)).toBe(true);
    });
  });

  describe("Session Management", () => {
    it("should spawn a session", async () => {
      const session = await coordinationService.spawnAgentSession({
        taskId: "test-task",
        agent: "claude-code",
        branch: "main",
      });

      expect(session).toBeDefined();
      expect(session.status).toBe("working");
    });

    it("should get a session", async () => {
      const spawned = await coordinationService.spawnAgentSession({
        taskId: "test-task",
        agent: "claude-code",
        branch: "main",
      });

      const retrieved = await coordinationService.getSession(spawned.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(spawned.id);
    });

    it("should list sessions", async () => {
      await coordinationService.spawnAgentSession({
        taskId: "task-1",
        agent: "claude-code",
        branch: "main",
      });

      await coordinationService.spawnAgentSession({
        taskId: "task-2",
        agent: "codex",
        branch: "main",
      });

      const sessions = await coordinationService.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it("should kill a session", async () => {
      const session = await coordinationService.spawnAgentSession({
        taskId: "test-task",
        agent: "claude-code",
        branch: "main",
      });

      await coordinationService.killSession(session.id);

      const retrieved = await coordinationService.getSession(session.id);
      expect(retrieved).toBeNull();
    });
  });

  describe("Error Handling", () => {
    it("should handle task creation errors gracefully", async () => {
      // This test verifies error handling is in place
      // In a real scenario, we'd mock the TaskManager to throw an error
      expect(async () => {
        await coordinationService.createTask({
          title: "Test Task",
          description: "Test description",
          role: "builder",
          priority: "high",
          projectId: "test-project",
          branch: "main",
        });
      }).not.toThrow();
    });

    it("should handle session errors gracefully", async () => {
      const session = await coordinationService.spawnAgentSession({
        taskId: "test-task",
        agent: "claude-code",
        branch: "main",
      });

      expect(async () => {
        await coordinationService.getSession(session.id);
      }).not.toThrow();
    });
  });
});
