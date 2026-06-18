import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockStartBuilder = vi.fn();

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    coordinationService: {
      startBuilder: mockStartBuilder,
    },
  })),
}));

import { POST as startTaskPOST } from "@/app/api/agentmesh/tasks/[id]/start/route";

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

describe("POST /api/agentmesh/tasks/:id/start", () => {
  beforeEach(() => {
    mockStartBuilder.mockReset();
  });

  it("starts a task when the request has no body", async () => {
    const res = await startTaskPOST(makeRequest("/api/agentmesh/tasks/task-123/start", {
      method: "POST",
    }), {
      params: Promise.resolve({ id: "task-123" }),
    });

    expect(res.status).toBe(200);
    expect(mockStartBuilder).toHaveBeenCalledWith("task-123");
    await expect(res.json()).resolves.toMatchObject({
      taskId: "task-123",
      status: "building",
    });
  });

  it("returns 500 when builder startup fails", async () => {
    mockStartBuilder.mockRejectedValueOnce(new Error("boom"));

    const res = await startTaskPOST(makeRequest("/api/agentmesh/tasks/task-123/start", {
      method: "POST",
    }), {
      params: Promise.resolve({ id: "task-123" }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to start task" });
  });
});
