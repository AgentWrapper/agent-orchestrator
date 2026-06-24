import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSessionManager } from "../../session-manager.js";
import type { Agent, AgentLimits } from "../../types.js";
import {
  setupTestContext,
  teardownTestContext,
  createMockPlugins,
  createMockRegistry,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;

beforeEach(() => {
  ctx = setupTestContext();
});

afterEach(() => {
  teardownTestContext(ctx);
});

describe("getAgentLimits", () => {
  it("returns undefined when the active agent declares no limits (nothing breaks)", () => {
    // The default mock agent has no `limits` field.
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    expect(sm.getAgentLimits("my-app")).toBeUndefined();
  });

  it("returns undefined for an unknown project", () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    expect(sm.getAgentLimits("does-not-exist")).toBeUndefined();
  });

  it("returns the active agent's declared limits", () => {
    const limits: AgentLimits = {
      contextTokens: 1_000_000,
      maxRequestBytes: 33_554_432,
      maxFileBytes: 524_288_000,
      supportedFileTypes: ["pdf", "png", "txt"],
    };
    const { runtime, agent, workspace } = createMockPlugins();
    const agentWithLimits: Agent = { ...agent, limits };
    const registry = createMockRegistry({ runtime, agent: agentWithLimits, workspace });

    const sm = createSessionManager({ config: ctx.config, registry });
    expect(sm.getAgentLimits("my-app")).toEqual(limits);
  });
});
