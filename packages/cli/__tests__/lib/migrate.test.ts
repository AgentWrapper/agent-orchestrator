import { describe, it, expect } from "vitest";
import type { ProjectConfig } from "@aoagents/ao-core";
import {
  buildProjectPlan,
  buildRewriteConfig,
  isValidRewriteProjectId,
  mapHarness,
  mapPermission,
} from "../../src/lib/migrate.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My Project",
    path: "/repos/my-project",
    defaultBranch: "main",
    // Empty by default so per-field assertions stay focused; a dedicated test
    // covers sessionPrefix carry-over.
    sessionPrefix: "",
    ...overrides,
  } as ProjectConfig;
}

// ---------------------------------------------------------------------------
// isValidRewriteProjectId
// ---------------------------------------------------------------------------

describe("isValidRewriteProjectId", () => {
  it("accepts legacy-style ids (a strict subset of the rewrite grammar)", () => {
    expect(isValidRewriteProjectId("agent-orchestrator")).toBe(true);
    expect(isValidRewriteProjectId("repo_1")).toBe(true);
  });
  it("rejects empty, dot-dot, and path separators", () => {
    expect(isValidRewriteProjectId("")).toBe(false);
    expect(isValidRewriteProjectId(".")).toBe(false);
    expect(isValidRewriteProjectId("a..b")).toBe(false);
    expect(isValidRewriteProjectId("a/b")).toBe(false);
    expect(isValidRewriteProjectId("a\\b")).toBe(false);
    expect(isValidRewriteProjectId(".hidden")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapPermission / mapHarness
// ---------------------------------------------------------------------------

describe("mapPermission", () => {
  it("maps each legacy mode per #247 §3", () => {
    expect(mapPermission("permissionless")).toEqual({ mode: "bypass-permissions", lossy: false });
    expect(mapPermission("skip")).toEqual({ mode: "bypass-permissions", lossy: false });
    expect(mapPermission("auto-edit")).toEqual({ mode: "accept-edits", lossy: false });
    expect(mapPermission("default")).toEqual({ mode: "default", lossy: false });
  });
  it("flags suggest and unknown values as lossy", () => {
    expect(mapPermission("suggest")).toEqual({ mode: "default", lossy: true });
    expect(mapPermission("wat")).toEqual({ mode: "default", lossy: true });
  });
  it("returns null for unset", () => {
    expect(mapPermission(undefined)).toBeNull();
    expect(mapPermission("")).toBeNull();
  });
});

describe("mapHarness", () => {
  it("passes through harnesses the rewrite knows", () => {
    expect(mapHarness("claude-code")).toBe("claude-code");
    expect(mapHarness("codex")).toBe("codex");
    expect(mapHarness("opencode")).toBe("opencode");
    expect(mapHarness("cursor")).toBe("cursor");
  });
  it("returns null for unknown or unset", () => {
    expect(mapHarness("frobnicator")).toBeNull();
    expect(mapHarness(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildRewriteConfig
// ---------------------------------------------------------------------------

describe("buildRewriteConfig", () => {
  it("omits a 'main' default branch and keeps a non-main one", () => {
    const notes: string[] = [];
    expect(buildRewriteConfig(project({ defaultBranch: "main" }), notes)).toBeNull();
    expect(buildRewriteConfig(project({ defaultBranch: "develop" }), [])).toEqual({
      defaultBranch: "develop",
    });
  });

  it("carries a non-empty sessionPrefix", () => {
    expect(buildRewriteConfig(project({ sessionPrefix: "app" }), [])).toEqual({
      sessionPrefix: "app",
    });
  });

  it("carries env, symlinks, and postCreate verbatim", () => {
    const config = buildRewriteConfig(
      project({
        defaultBranch: "main",
        env: { FOO: "bar" },
        symlinks: [".env"],
        postCreate: ["pnpm i"],
      }),
      [],
    );
    expect(config).toEqual({
      env: { FOO: "bar" },
      symlinks: [".env"],
      postCreate: ["pnpm i"],
    });
  });

  it("remaps the agent permission and notes a lossy suggest", () => {
    const notes: string[] = [];
    const config = buildRewriteConfig(
      project({ agentConfig: { model: "opus", permissions: "suggest" } }),
      notes,
    );
    expect(config).toEqual({ agentConfig: { model: "opus", permissions: "default" } });
    expect(notes.join()).toMatch(/lossily/);
  });

  it("maps worker/orchestrator harness and drops unknown ones with a note", () => {
    const notes: string[] = [];
    const config = buildRewriteConfig(
      project({
        worker: { agent: "codex", agentConfig: { permissions: "auto-edit" } },
        orchestrator: { agent: "frobnicator" },
      }),
      notes,
    );
    expect(config).toEqual({
      worker: { agent: "codex", agentConfig: { permissions: "accept-edits" } },
    });
    expect(notes.join()).toMatch(/frobnicator.*dropped/);
  });

  it("notes project-level fields with no rewrite home", () => {
    const notes: string[] = [];
    buildRewriteConfig(
      project({
        tracker: { provider: "github" } as ProjectConfig["tracker"],
        agentRules: "be nice",
      }),
      notes,
    );
    expect(notes.join()).toMatch(/no rewrite home dropped: tracker, rules/);
  });
});

// ---------------------------------------------------------------------------
// buildProjectPlan
// ---------------------------------------------------------------------------

describe("buildProjectPlan", () => {
  it("uses the legacy id and path, and only sends a name that differs from the id", () => {
    const withName = buildProjectPlan("my-project", project({ name: "Pretty Name" }));
    expect(withName.add).toEqual({
      path: "/repos/my-project",
      projectId: "my-project",
      name: "Pretty Name",
    });

    const nameEqualsId = buildProjectPlan("my-project", project({ name: "my-project" }));
    expect(nameEqualsId.add).toEqual({ path: "/repos/my-project", projectId: "my-project" });
  });

  it("captures the config blob and its notes on the plan", () => {
    const plan = buildProjectPlan("p", project({ defaultBranch: "develop" }));
    expect(plan.config).toEqual({ defaultBranch: "develop" });
    expect(plan.notes).toEqual([]);
  });
});
