import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { recordActivityEvent } from "../activity-events.js";
import { saveGlobalConfig, type GlobalConfig } from "../global-config.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

function makeGlobalConfig(projects: GlobalConfig["projects"] = {}): GlobalConfig {
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects,
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };
}

describe("activity events: config loading", () => {
  let tempRoot: string;
  let configPath: string;
  let originalHome: string | undefined;
  let originalGlobalConfig: string | undefined;

  beforeEach(() => {
    tempRoot = join(
      tmpdir(),
      `ao-config-events-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    configPath = join(tempRoot, ".agent-orchestrator", "config.yaml");
    mkdirSync(tempRoot, { recursive: true });
    originalHome = process.env["HOME"];
    originalGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    process.env["HOME"] = tempRoot;
    process.env["AO_GLOBAL_CONFIG"] = configPath;
    vi.mocked(recordActivityEvent).mockClear();
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
    if (originalGlobalConfig === undefined) {
      delete process.env["AO_GLOBAL_CONFIG"];
    } else {
      process.env["AO_GLOBAL_CONFIG"] = originalGlobalConfig;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("emits config.project_resolve_failed for unresolved projects without a specific config event", () => {
    const projectPath = join(tempRoot, "old-format");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(
      join(projectPath, "agent-orchestrator.yaml"),
      ["projects:", "  old-format:", "    path: .", ""].join("\n"),
    );

    saveGlobalConfig(
      makeGlobalConfig({
        "old-format": {
          projectId: "old-format",
          path: projectPath,
          displayName: "Old format",
          defaultBranch: "main",
          sessionPrefix: "old-format",
        },
      }),
      configPath,
    );

    loadConfig(configPath);

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "config",
        kind: "config.project_resolve_failed",
        projectId: "old-format",
      }),
    );
  });

  it("does not emit config.project_resolve_failed for malformed local yaml", () => {
    const projectPath = join(tempRoot, "malformed");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "agent-orchestrator.yaml"), "tracker: [\n");

    saveGlobalConfig(
      makeGlobalConfig({
        malformed: {
          projectId: "malformed",
          path: projectPath,
          displayName: "Malformed",
          defaultBranch: "main",
          sessionPrefix: "malformed",
        },
      }),
      configPath,
    );

    loadConfig(configPath);

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "config",
        kind: "config.project_malformed",
        projectId: "malformed",
      }),
    );
    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.kind === "config.project_resolve_failed")).toBeUndefined();
  });

  it("does not emit config.project_resolve_failed for healthy projects", () => {
    const projectPath = join(tempRoot, "clean");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(
      join(projectPath, "agent-orchestrator.yaml"),
      ["agent: codex", "runtime: tmux", "workspace: worktree", ""].join("\n"),
    );

    saveGlobalConfig(
      makeGlobalConfig({
        clean: {
          projectId: "clean",
          path: projectPath,
          displayName: "Clean",
          defaultBranch: "main",
          sessionPrefix: "clean",
        },
      }),
      configPath,
    );

    loadConfig(configPath);

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.kind === "config.project_resolve_failed")).toBeUndefined();
  });

  it("emits config.project_malformed for unparseable local yaml", () => {
    const projectPath = join(tempRoot, "malformed");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "agent-orchestrator.yaml"), "tracker: [\n");

    saveGlobalConfig(
      makeGlobalConfig({
        malformed: {
          projectId: "malformed",
          path: projectPath,
          displayName: "Malformed",
          defaultBranch: "main",
          sessionPrefix: "malformed",
        },
      }),
      configPath,
    );

    loadConfig(configPath);

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "config",
        kind: "config.project_malformed",
        projectId: "malformed",
      }),
    );
  });

  it("emits config.project_invalid for schema-invalid local yaml", () => {
    const projectPath = join(tempRoot, "invalid");
    mkdirSync(projectPath, { recursive: true });
    // Valid YAML but fails LocalProjectConfigSchema (numeric agent isn't a string)
    writeFileSync(join(projectPath, "agent-orchestrator.yaml"), "agent: 123\n");

    saveGlobalConfig(
      makeGlobalConfig({
        invalid: {
          projectId: "invalid",
          path: projectPath,
          displayName: "Invalid",
          defaultBranch: "main",
          sessionPrefix: "invalid",
        },
      }),
      configPath,
    );

    loadConfig(configPath);

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "config",
        kind: "config.project_invalid",
        projectId: "invalid",
      }),
    );
    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.kind === "config.project_resolve_failed")).toBeUndefined();
  });
});
