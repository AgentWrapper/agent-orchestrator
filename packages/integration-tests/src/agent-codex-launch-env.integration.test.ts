import { describe, expect, it } from "vitest";
import type { AgentLaunchConfig } from "@aoagents/ao-core";
import codexPlugin from "@aoagents/ao-plugin-agent-codex";

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-int-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

describe("agent-codex launch/env wiring (integration)", () => {
  const agent = codexPlugin.create();

  it("includes check_for_update_on_startup=false in launch command", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toContain("-c check_for_update_on_startup=false");
  });

  it("preserves update-check override alongside other flags", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        permissions: "default",
        model: "o3-mini",
        prompt: "Do the thing",
      }),
    );
    expect(cmd).toContain("-c check_for_update_on_startup=false");
    expect(cmd).not.toContain("--ask-for-approval");
    expect(cmd).toContain("--model 'o3-mini'");
    expect(cmd).toContain("-c model_reasoning_effort=high");
  });

  it("sets CODEX_DISABLE_UPDATE_CHECK=1 in environment", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["CODEX_DISABLE_UPDATE_CHECK"]).toBe("1");
  });

  it("does not set GH_PATH (injected by session-manager for all agents)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["GH_PATH"]).toBeUndefined();
  });
});
