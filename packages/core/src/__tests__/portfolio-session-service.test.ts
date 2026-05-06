import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectSessionsDir } from "../paths.js";
import { getPortfolioSessionCounts, listPortfolioSessions } from "../portfolio-session-service.js";
import type { PortfolioProject } from "../types.js";

function writeSessionFile(projectId: string, sessionId: string, data: Record<string, string>): void {
  const sessionsDir = getProjectSessionsDir(projectId);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${sessionId}.json`), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

describe("portfolio-session-service", () => {
  let tempRoot: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `ao-portfolio-sessions-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });
    oldHome = process.env["HOME"];
    process.env["HOME"] = tempRoot;
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("lists worker sessions and excludes orchestrators, disabled projects, and degraded projects", async () => {
    const activeProject: PortfolioProject = {
      id: "docs",
      name: "Docs",
      configPath: "/tmp/global-config.yaml",
      configProjectKey: "docs",
      repoPath: "/tmp/docs",
      sessionPrefix: "docs",
      source: "config",
      enabled: true,
      pinned: false,
      lastSeenAt: new Date().toISOString(),
    };
    const disabledProject: PortfolioProject = {
      ...activeProject,
      id: "api",
      name: "API",
      enabled: false,
    };
    const degradedProject: PortfolioProject = {
      ...activeProject,
      id: "web",
      name: "Web",
      resolveError: "bad config",
    };

    writeSessionFile("docs", "docs-1", {
      status: "working",
      project: "docs",
      branch: "feat/docs",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    writeSessionFile("docs", "docs-2", {
      status: "merged",
      project: "docs",
      branch: "feat/merged",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    writeSessionFile("docs", "docs-orchestrator-1", {
      status: "working",
      project: "docs",
      role: "orchestrator",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    writeSessionFile("api", "api-1", {
      status: "working",
      project: "api",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    writeSessionFile("web", "web-1", {
      status: "working",
      project: "web",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const sessions = await listPortfolioSessions([activeProject, disabledProject, degradedProject]);

    expect(sessions.map((entry) => entry.session.id).sort()).toEqual(["docs-1", "docs-2"]);
    expect(sessions.every((entry) => entry.project.id === "docs")).toBe(true);
  });

  it("counts active sessions without counting orchestrators or terminal sessions as active", async () => {
    const project: PortfolioProject = {
      id: "docs",
      name: "Docs",
      configPath: "/tmp/global-config.yaml",
      configProjectKey: "docs",
      repoPath: "/tmp/docs",
      sessionPrefix: "docs",
      source: "config",
      enabled: true,
      pinned: false,
      lastSeenAt: new Date().toISOString(),
    };
    const degraded: PortfolioProject = {
      ...project,
      id: "broken",
      resolveError: "bad config",
    };

    writeSessionFile("docs", "docs-1", { status: "working", project: "docs" });
    writeSessionFile("docs", "docs-2", { status: "done", project: "docs" });
    writeSessionFile("docs", "docs-orchestrator-1", { status: "working", project: "docs", role: "orchestrator" });

    const counts = await getPortfolioSessionCounts([project, degraded]);

    expect(counts["docs"]).toEqual({ total: 2, active: 1 });
    expect(counts["broken"]).toEqual({ total: 0, active: 0 });
  });
});
