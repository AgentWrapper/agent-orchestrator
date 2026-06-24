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

  it("passes an arbitrary full model id through unchanged (extensible)", () => {
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig({ model: "claude-sonnet-4-5" }));
    expect(env["AO_SDK_MODEL"]).toBe("claude-sonnet-4-5");
  });

  it("omits AO_SDK_MODEL when no model is set (account default)", () => {
    const agent = create();
    const env = agent.getEnvironment(makeLaunchConfig({}));
    expect(env["AO_SDK_MODEL"]).toBeUndefined();
  });
});
