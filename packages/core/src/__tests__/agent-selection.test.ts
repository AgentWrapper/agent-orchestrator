import { describe, it, expect } from "vitest";
import { resolveAgentSelection } from "../agent-selection.js";
import type { DefaultPlugins, ProjectConfig } from "../types.js";

const baseDefaults: DefaultPlugins = {
  runtime: "tmux",
  agent: "claude-code",
  workspace: "worktree",
  notifiers: ["desktop"],
};

const projectWithDefaults: ProjectConfig = {
  name: "My App",
  repo: "org/my-app",
  path: "/tmp/my-app",
  defaultBranch: "main",
  sessionPrefix: "app",
  agentConfig: {
    permissions: "suggest",
    model: "claude-default-model",
    subagent: "project-default-subagent",
  },
};

describe("resolveAgentSelection persisted* inputs (issue #1475)", () => {
  it("persistedPermissions overrides the project default", () => {
    const selection = resolveAgentSelection({
      role: "worker",
      project: projectWithDefaults,
      defaults: baseDefaults,
      persistedPermissions: "permissionless",
    });

    expect(selection.permissions).toBe("permissionless");
    expect(selection.agentConfig.permissions).toBe("permissionless");
  });

  it("persistedModel overrides the project default", () => {
    const selection = resolveAgentSelection({
      role: "worker",
      project: projectWithDefaults,
      defaults: baseDefaults,
      persistedModel: "claude-spawned-model",
    });

    expect(selection.model).toBe("claude-spawned-model");
    expect(selection.agentConfig.model).toBe("claude-spawned-model");
  });

  it("persistedSubagent overrides the project default", () => {
    const selection = resolveAgentSelection({
      role: "worker",
      project: projectWithDefaults,
      defaults: baseDefaults,
      persistedSubagent: "librarian",
    });

    expect(selection.subagent).toBe("librarian");
    expect(selection.agentConfig["subagent"]).toBe("librarian");
  });

  it("falls back to project defaults when persisted values are undefined (legacy session)", () => {
    const selection = resolveAgentSelection({
      role: "worker",
      project: projectWithDefaults,
      defaults: baseDefaults,
    });

    expect(selection.permissions).toBe("suggest");
    expect(selection.model).toBe("claude-default-model");
    expect(selection.subagent).toBe("project-default-subagent");
  });

  it("normalizes persistedPermissions (string from metadata) before applying", () => {
    // metadata is always raw strings on disk; the persisted permissions value
    // must round-trip through normalizeAgentPermissionMode the same way
    // project config does, otherwise non-canonical values silently drop.
    const selection = resolveAgentSelection({
      role: "worker",
      project: projectWithDefaults,
      defaults: baseDefaults,
      persistedPermissions: "permissionless",
    });

    expect(selection.permissions).toBe("permissionless");
  });

  it("orchestrator role honors persistedPermissions at resolution time (session-manager enforces permissionless separately)", () => {
    // The forced-permissionless rule for orchestrators is applied in
    // session-manager when building agentLaunchConfig / projectConfigForLaunch.
    // resolveAgentSelection itself just resolves; it does not enforce the
    // orchestrator override, so persistedPermissions must flow through.
    const selection = resolveAgentSelection({
      role: "orchestrator",
      project: projectWithDefaults,
      defaults: baseDefaults,
      persistedPermissions: "auto-edit",
    });

    expect(selection.permissions).toBe("auto-edit");
  });
});
