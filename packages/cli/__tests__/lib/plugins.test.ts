import { describe, it, expect } from "vitest";
import {
  getAgent,
  getAgentByName,
  getAgentByNameFromRegistry,
  getSCMFromRegistry,
} from "../../src/lib/plugins.js";
import type { Agent, OrchestratorConfig, PluginRegistry, SCM } from "@aoagents/ao-core";

function makeConfig(
  defaultAgent: string,
  projects?: Record<string, { agent?: string; scm?: { plugin: string } }>,
): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: defaultAgent, workspace: "worktree", notifiers: [] },
    projects: Object.fromEntries(
      Object.entries(projects ?? { app: {} }).map(([id, p]) => [
        id,
        { name: id, repo: "", path: "", defaultBranch: "main", ...p },
      ]),
    ),
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as OrchestratorConfig;
}

function makeRegistry(entries: {
  agent?: Record<string, Agent>;
  scm?: Record<string, SCM>;
}): PluginRegistry {
  return {
    register: () => {},
    get: (slot, name) => {
      if (slot === "agent") return (entries.agent?.[name] ?? null) as Agent | null;
      if (slot === "scm") return (entries.scm?.[name] ?? null) as SCM | null;
      return null;
    },
    list: () => [],
    loadBuiltins: async () => {},
    loadFromConfig: async () => {},
  };
}

describe("getAgent", () => {
  it("returns claude-code agent by default", () => {
    const config = makeConfig("claude-code");
    const agent = getAgent(config);
    expect(agent.name).toBe("claude-code");
  });

  it("returns codex agent when project overrides agent", () => {
    const config = makeConfig("claude-code", { myapp: { agent: "codex" } });
    const agent = getAgent(config, "myapp");
    expect(agent.name).toBe("codex");
  });

  it("throws on unknown agent name", () => {
    const config = makeConfig("nonexistent");
    expect(() => getAgent(config)).toThrow("Unknown agent plugin: nonexistent");
  });

  it("falls back to config default when project has no agent override", () => {
    const config = makeConfig("aider", { myapp: {} });
    const agent = getAgent(config, "myapp");
    expect(agent.name).toBe("aider");
  });

  it("falls back to config default when projectId does not exist", () => {
    const config = makeConfig("claude-code");
    const agent = getAgent(config, "nonexistent-project");
    expect(agent.name).toBe("claude-code");
  });
});

describe("getAgentByName", () => {
  it("returns agent for claude-code", () => {
    expect(getAgentByName("claude-code").name).toBe("claude-code");
  });

  it("returns agent for codex", () => {
    expect(getAgentByName("codex").name).toBe("codex");
  });

  it("returns agent for aider", () => {
    expect(getAgentByName("aider").name).toBe("aider");
  });

  it("returns agent for opencode", () => {
    expect(getAgentByName("opencode").name).toBe("opencode");
  });

  it("returns agent for kimicode", () => {
    expect(getAgentByName("kimicode").name).toBe("kimicode");
  });

  it("throws on unknown name", () => {
    expect(() => getAgentByName("unknown")).toThrow("Unknown agent plugin: unknown");
  });
});

describe("registry-backed resolution", () => {
  it("returns an agent from the shared registry", () => {
    const registry = makeRegistry({
      agent: {
        goose: {
          name: "goose",
          processName: "goose",
          instructions: "",
          launch: async () => {
            throw new Error("not implemented");
          },
          detectActivity: () => "idle",
          getSessionInfo: async () => null,
        } as unknown as Agent,
      },
    });

    expect(getAgentByNameFromRegistry(registry, "goose").name).toBe("goose");
  });

  it("returns an scm plugin from the shared registry", () => {
    const registry = makeRegistry({
      scm: {
        gitlab: {
          name: "gitlab",
          getPR: async () => null,
          detectPR: async () => null,
          getPRState: async () => "open",
          getReviewDecision: async () => null,
          getPendingComments: async () => 0,
          getAutomatedComments: async () => [],
          getCIChecks: async () => [],
          getCISummary: async () => null,
          getReviews: async () => [],
          getMergeability: async () => ({
            mergeable: true,
            ciPassing: true,
            approved: true,
            noConflicts: true,
            blockers: [],
          }),
          mergePR: async () => {},
          closePR: async () => {},
        } as unknown as SCM,
      },
    });
    const config = makeConfig("claude-code", {
      myapp: { agent: "claude-code", scm: { plugin: "gitlab" } },
    });

    expect(getSCMFromRegistry(registry, config, "myapp").name).toBe("gitlab");
  });
});
