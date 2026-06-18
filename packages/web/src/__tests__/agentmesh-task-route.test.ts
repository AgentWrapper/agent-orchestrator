import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockCreateTask = vi.fn();

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: {
      projects: {
        agentmesh: {
          defaultBranch: "main",
        },
      },
    },
    coordinationService: {
      createTask: mockCreateTask,
    },
  })),
}));

import { POST as createTaskPOST } from "@/app/api/agentmesh/tasks/route";

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

describe("POST /api/agentmesh/tasks", () => {
  beforeEach(() => {
    mockCreateTask.mockReset();
    mockCreateTask.mockImplementation(async (config) => ({
      id: "task-123",
      status: "created",
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...config,
    }));
  });

  it("generates a worker branch when the request omits one", async () => {
    const res = await createTaskPOST(makeRequest("/api/agentmesh/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "Live smoke task",
        description: "task",
        projectId: "agentmesh",
      }),
      headers: { "Content-Type": "application/json" },
    }));

    expect(res.status).toBe(200);
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "agentmesh",
        branch: expect.stringMatching(/^task\/live-smoke-task-/),
      }),
    );
  });

  it("preserves a custom branch name", async () => {
    const res = await createTaskPOST(makeRequest("/api/agentmesh/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "Live smoke task",
        description: "task",
        projectId: "agentmesh",
        branch: "feat/live-smoke",
      }),
      headers: { "Content-Type": "application/json" },
    }));

    expect(res.status).toBe(200);
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "feat/live-smoke",
      }),
    );
  });
});
