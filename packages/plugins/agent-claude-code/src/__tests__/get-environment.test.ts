import { describe, it, expect } from "vitest";
import { create } from "../index.js";
import type { AgentLaunchConfig } from "@aoagents/ao-core";

/**
 * getEnvironment is the bridge between the resolved per-session model
 * (agentLaunchConfig.model) and the SDK runtime, which reads AO_SDK_MODEL from
 * config.environment. These tests pin that mapping so worker model routing
 * actually reaches the running host.
 */
function makeLaunchConfig(overrides: Partial<AgentLaunchConfig>): AgentLaunchConfig {
  return {
    sessionId: "app-1",
    projectConfig: { name: "app", path: "/repos/app" },
    ...overrides,
  } as AgentLaunchConfig;
}

describe("claude-code getEnvironment — model routing", () => {
  it("maps config.model to AO_SDK_MODEL", () => {
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig({ model: "sonnet" }));
    expect(env["AO_SDK_MODEL"]).toBe("sonnet");
  });

  it("pins the sonnet alias to Claude Sonnet 5 for the Claude SDK", () => {
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig({ model: "sonnet" }));
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBe("claude-sonnet-5");
  });

  it("passes an arbitrary full model id through unchanged (extensible)", () => {
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig({ model: "claude-sonnet-4-5" }));
    expect(env["AO_SDK_MODEL"]).toBe("claude-sonnet-4-5");
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBeUndefined();
  });

  it("omits AO_SDK_MODEL when no model is set (account default)", () => {
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig({}));
    expect(env["AO_SDK_MODEL"]).toBeUndefined();
  });
});

describe("claude-code getEnvironment — persistent system prompt", () => {
  it("maps config.systemPromptFile to AO_SDK_SYSTEM_PROMPT_FILE", () => {
    const agent = create();
    const env = agent.getEnvironment(
      makeLaunchConfig({ systemPromptFile: "/proj/worker-prompt-app-1.md" }),
    );
    expect(env["AO_SDK_SYSTEM_PROMPT_FILE"]).toBe("/proj/worker-prompt-app-1.md");
  });

  it("omits AO_SDK_SYSTEM_PROMPT_FILE when no systemPromptFile is set", () => {
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig({}));
    expect(env["AO_SDK_SYSTEM_PROMPT_FILE"]).toBeUndefined();
  });

  it("keeps persona (system prompt file) separate from the turn-1 task prompt", () => {
    const agent = create();
    const env = agent.getEnvironment(
      makeLaunchConfig({
        systemPromptFile: "/proj/worker-prompt-app-1.md",
        prompt: "Work on issue #42",
      }),
    );
    // Persona persists via the system prompt file; the task is the one-shot turn-1.
    expect(env["AO_SDK_SYSTEM_PROMPT_FILE"]).toBe("/proj/worker-prompt-app-1.md");
    expect(env["AO_SDK_INITIAL_PROMPT"]).toBe("Work on issue #42");
  });
});
