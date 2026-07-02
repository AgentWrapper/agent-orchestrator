import { describe, it, expect, beforeEach } from "vitest";
import type { AgentLaunchConfig, ProjectConfig } from "@composio/ao-core";
import { manifest, create, detect, toCursorProjectPath } from "./index.js";

function makeProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test-project",
    repo: "owner/repo",
    path: "/test/path",
    defaultBranch: "main",
    sessionPrefix: "test",
    ...overrides,
  };
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "test-session",
    projectConfig: makeProjectConfig(),
    ...overrides,
  };
}

describe("Cursor Agent Plugin", () => {
  describe("manifest", () => {
    it("should have correct manifest properties", () => {
      expect(manifest.name).toBe("cursor");
      expect(manifest.slot).toBe("agent");
      expect(manifest.description).toBe("Agent plugin: Cursor AI CLI");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.displayName).toBe("Cursor");
    });
  });

  describe("create()", () => {
    it("should create a Cursor agent", () => {
      const agent = create();
      expect(agent.name).toBe("cursor");
      expect(agent.processName).toBe("cursor");
      expect(agent.promptDelivery).toBe("post-launch");
    });

    it("should return a launch command with --agent flag", () => {
      const agent = create();
      const command = agent.getLaunchCommand(makeLaunchConfig());
      expect(command).toContain("cursor");
      expect(command).toContain("--agent");
    });

    it("should include model in launch command when specified", () => {
      const agent = create();
      const command = agent.getLaunchCommand(
        makeLaunchConfig({ model: "claude-3-5-sonnet" }),
      );
      expect(command).toContain("--model");
      expect(command).toContain("claude-3-5-sonnet");
    });

    it("should include skip permissions flag when permissionless mode", () => {
      const agent = create();
      const command = agent.getLaunchCommand(
        makeLaunchConfig({ permissions: "permissionless" }),
      );
      expect(command).toContain("--dangerously-skip-permissions");
    });
  });

  describe("detectActivity()", () => {
    it("should return idle for empty output", () => {
      const agent = create();
      expect(agent.detectActivity("")).toBe("idle");
      expect(agent.detectActivity("   ")).toBe("idle");
    });

    it("should return idle for prompt lines", () => {
      const agent = create();
      expect(agent.detectActivity("❯ ")).toBe("idle");
      expect(agent.detectActivity("> ")).toBe("idle");
      expect(agent.detectActivity("$ ")).toBe("idle");
    });

    it("should return waiting_input for confirmation prompts", () => {
      const agent = create();
      expect(agent.detectActivity("Do you want to proceed? (Y/n)")).toBe("waiting_input");
      expect(agent.detectActivity("Allow file write? (Y)es (N)o")).toBe("waiting_input");
    });

    it("should return active for other output", () => {
      const agent = create();
      expect(agent.detectActivity("Thinking...")).toBe("active");
      expect(agent.detectActivity("Reading file...")).toBe("active");
    });
  });

  describe("toCursorProjectPath()", () => {
    it("should normalize paths for Cursor's project directory", () => {
      expect(toCursorProjectPath("/Users/dev/project")).toBe("Users-dev-project");
      expect(toCursorProjectPath("/home/user/.worktrees/ao")).toBe("home-user--worktrees-ao");
    });

    it("should handle Windows-style paths", () => {
      expect(toCursorProjectPath("C:\\Users\\dev\\project")).toBe("C-Users-dev-project");
    });
  });

  describe("getEnvironment()", () => {
    it("should set AO_SESSION_ID", () => {
      const agent = create();
      const env = agent.getEnvironment(makeLaunchConfig({ sessionId: "test-123" }));
      expect(env["AO_SESSION_ID"]).toBe("test-123");
    });

    it("should set AO_ISSUE_ID when issueId is provided", () => {
      const agent = create();
      const env = agent.getEnvironment(
        makeLaunchConfig({ sessionId: "test-123", issueId: "issue-456" }),
      );
      expect(env["AO_ISSUE_ID"]).toBe("issue-456");
    });
  });

  describe("detect()", () => {
    it("should be a function", () => {
      expect(typeof detect).toBe("function");
    });
  });
});
