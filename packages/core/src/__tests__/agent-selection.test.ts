import { describe, expect, it } from "vitest";
import { resolveAgentSelection, type SessionRole } from "../agent-selection.js";
import type { DefaultPlugins, ProjectConfig } from "../types.js";

const defaults: DefaultPlugins = {
  runtime: "tmux",
  agent: "codex",
  workspace: "worktree",
  notifiers: [],
};

function makeProject(): ProjectConfig {
  return {
    name: "App",
    path: "/tmp/app",
    defaultBranch: "main",
    sessionPrefix: "app",
    agentConfig: {
      model: "openai/gpt-5.3-codex",
      reasoningEffort: "medium",
      roleModels: {
        planner: {
          model: "openai/gpt-5.5",
          reasoningEffort: "high",
        },
        worker: {
          model: "openai/gpt-5.4-mini",
          reasoningEffort: "minimal",
        },
        reviewer: {
          model: "openai/gpt-5.5",
          reasoningEffort: "high",
        },
      },
    },
    worker: {
      agentConfig: {
        model: "openai/gpt-5.3-codex",
        reasoningEffort: "low",
      },
    },
  };
}

function select(role: SessionRole, prompt?: string) {
  return resolveAgentSelection({
    role,
    project: makeProject(),
    defaults,
    prompt,
  });
}

describe("resolveAgentSelection role model overlay", () => {
  it("selects planner config for Role: Planner worker prompts", () => {
    const selection = select("worker", "Role: Planner\nPlan work");

    expect(selection.model).toBe("openai/gpt-5.5");
    expect(selection.reasoningEffort).toBe("high");
    expect(selection.agentConfig.model).toBe("openai/gpt-5.5");
  });

  it("selects reviewer config for Role: Reviewer worker prompts", () => {
    const selection = select("worker", "Role: Reviewer\nReview work");

    expect(selection.model).toBe("openai/gpt-5.5");
    expect(selection.reasoningEffort).toBe("high");
  });

  it("uses normal worker config when no prompt role is present", () => {
    const selection = select("worker", "Fix issue");

    expect(selection.model).toBe("openai/gpt-5.3-codex");
    expect(selection.reasoningEffort).toBe("low");
  });

  it("selects roleModels.worker for Role: Worker prompts", () => {
    const selection = select("worker", "Role: Worker\nImplement work");

    expect(selection.model).toBe("openai/gpt-5.4-mini");
    expect(selection.reasoningEffort).toBe("minimal");
  });
});
