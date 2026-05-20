import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { NextRequest } from "next/server";
import { recordActivityEvent, registerProjectInGlobalConfig } from "@aoagents/ao-core";

vi.mock("@aoagents/ao-core", async () => {
  const actual = await vi.importActual("@aoagents/ao-core");
  return {
    ...(actual as Record<string, unknown>),
    recordActivityEvent: vi.fn(),
  };
});

const invalidatePortfolioServicesCache = vi.fn();
const getServices = vi.fn();

vi.mock("@/lib/services", () => ({
  invalidatePortfolioServicesCache,
  getServices,
}));

function makeRequest(method: string, url: string, body?: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "Content-Type": "application/json" } : undefined,
  });
}

const recorded = vi.mocked(recordActivityEvent);

describe("Activity events — project mutation routes", () => {
  let oldGlobalConfig: string | undefined;
  let oldConfigPath: string | undefined;
  let oldHome: string | undefined;
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    vi.resetModules();
    recorded.mockClear();
    invalidatePortfolioServicesCache.mockReset();
    getServices.mockReset();
    getServices.mockResolvedValue({
      registry: { get: vi.fn().mockReturnValue(null) },
      sessionManager: {
        list: vi.fn().mockResolvedValue([]),
        kill: vi.fn().mockResolvedValue(undefined),
      },
    });
    oldGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    oldConfigPath = process.env["AO_CONFIG_PATH"];
    oldHome = process.env["HOME"];
    tempRoot = mkdtempSync(path.join(tmpdir(), "ao-activity-projects-"));
    configPath = path.join(tempRoot, "config.yaml");
    process.env["AO_GLOBAL_CONFIG"] = configPath;
    process.env["AO_CONFIG_PATH"] = configPath;
    process.env["HOME"] = tempRoot;
  });

  afterEach(() => {
    if (oldGlobalConfig === undefined) delete process.env["AO_GLOBAL_CONFIG"];
    else process.env["AO_GLOBAL_CONFIG"] = oldGlobalConfig;
    if (oldConfigPath === undefined) delete process.env["AO_CONFIG_PATH"];
    else process.env["AO_CONFIG_PATH"] = oldConfigPath;
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("POST /api/projects emits api.project_added on success", async () => {
    const repoDir = path.join(tempRoot, "demo-add");
    mkdirSync(repoDir, { recursive: true });
    execSync("git init -q", { cwd: repoDir });

    const { POST } = await import("@/app/api/projects/route");
    const res = await POST(
      makeRequest("POST", "http://localhost:3000/api/projects", {
        path: repoDir,
        projectId: "demo-add",
        name: "Demo Add",
      }),
    );

    expect(res.status).toBe(201);
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        kind: "api.project_added",
      }),
    );
  });

  it("PATCH /api/projects/:id emits api.project_updated with changed keys (not values)", async () => {
    const repoDir = path.join(tempRoot, "demo-patch");
    mkdirSync(repoDir, { recursive: true });
    const effectiveId = registerProjectInGlobalConfig("demo-patch", "Demo Patch", repoDir);

    const { PATCH } = await import("@/app/api/projects/[id]/route");
    const res = await PATCH(
      makeRequest("PATCH", `http://localhost:3000/api/projects/${effectiveId}`, {
        agent: "codex",
        runtime: "tmux",
        someUnknownField: "do-not-record",
      }),
      { params: Promise.resolve({ id: effectiveId }) },
    );

    expect(res.status).toBe(200);
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        kind: "api.project_updated",
        projectId: effectiveId,
        data: expect.objectContaining({
          changedKeys: expect.arrayContaining(["agent", "runtime"]),
        }),
      }),
    );

    // Ensure no value content (e.g. "codex", "tmux") leaked into the event payload
    const calls = recorded.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === "api.project_updated",
    );
    expect(calls[0]?.[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          changedKeys: ["agent", "runtime"],
        }),
      }),
    );
    for (const [event] of calls) {
      const json = JSON.stringify(event);
      expect(json).not.toContain("codex");
      expect(json).not.toContain('"tmux"');
      expect(json).not.toContain("someUnknownField");
      expect(json).not.toContain("do-not-record");
    }
  });

  it("DELETE /api/projects/:id emits api.project_removed on success", async () => {
    const repoDir = path.join(tempRoot, "demo-delete");
    mkdirSync(repoDir, { recursive: true });
    const effectiveId = registerProjectInGlobalConfig("demo-delete", "Demo Delete", repoDir);

    const { DELETE } = await import("@/app/api/projects/[id]/route");
    const res = await DELETE(
      makeRequest("DELETE", `http://localhost:3000/api/projects/${effectiveId}`),
      { params: Promise.resolve({ id: effectiveId }) },
    );

    expect(res.status).toBe(200);
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        kind: "api.project_removed",
        projectId: effectiveId,
      }),
    );
  });
});
