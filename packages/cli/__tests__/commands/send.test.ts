import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockTmux, mockExec } = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockExec: vi.fn(),
}));

const { mockConfigRef, mockSessionManager } = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    get: vi.fn(),
    send: vi.fn(),
  },
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: mockTmux,
  exec: mockExec,
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: vi.fn(),
}));

vi.mock("../../src/lib/session-utils.js", () => ({
  findProjectForSession: () => null,
}));

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: () => {
    if (!mockConfigRef.current) {
      throw new Error("no config");
    }
    return mockConfigRef.current;
  },
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
  getPluginRegistry: async () => ({
    // Return a minimal Agent stub for any lookup so registry-based agent
    // resolution succeeds in tests without pulling in real plugin packages.
    get: vi.fn(() => ({
      getActivityState: async () => null,
    })),
    list: vi.fn(),
    register: vi.fn(),
  }),
}));

import { Command } from "commander";
import { registerSend } from "../../src/commands/send.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  program = new Command();
  program.exitOverride();
  registerSend(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  mockTmux.mockReset();
  mockExec.mockReset();
  mockSessionManager.get.mockReset();
  mockSessionManager.send.mockReset();
  mockConfigRef.current = null;
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
  vi.useRealTimers();
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
});

describe("send command", () => {
  describe("session existence check", () => {
    it("exits with error when session does not exist", async () => {
      mockTmux.mockResolvedValue(null); // has-session fails

      await expect(
        program.parseAsync(["node", "test", "send", "nonexistent", "hello"]),
      ).rejects.toThrow("process.exit(1)");

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
    });
  });

  describe("tmux fallback delivery", () => {
    it("confirms delivery when terminal output changes after send", async () => {
      let afterSend = false;
      mockTmux.mockImplementation(async (...args: string[]) => {
        if (args[0] === "has-session") return "";
        if (args[0] === "capture-pane") {
          return afterSend ? "processing message..." : "❯ ";
        }
        return "";
      });
      mockExec.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === "send-keys" && args.includes("Enter")) {
          afterSend = true;
        }
        return { stdout: "", stderr: "" };
      });

      await program.parseAsync(["node", "test", "send", "my-session", "hello", "world"]);

      expect(mockExec).toHaveBeenCalledWith("tmux", [
        "send-keys",
        "-t",
        "my-session",
        "-l",
        "hello world",
      ]);
      expect(mockExec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "my-session", "Enter"]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Message sent and processing"),
      );
    });

    it("detects queued message state", async () => {
      let afterSend = false;
      mockTmux.mockImplementation(async (...args: string[]) => {
        if (args[0] === "has-session") return "";
        if (args[0] === "capture-pane") {
          return afterSend ? "Output\nPress up to edit queued messages" : "❯ ";
        }
        return "";
      });
      mockExec.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === "send-keys" && args.includes("Enter")) {
          afterSend = true;
        }
        return { stdout: "", stderr: "" };
      });

      await program.parseAsync(["node", "test", "send", "my-session", "hello"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Message queued"));
    });
  });

  describe("message delivery", () => {
    it("uses load-buffer for long messages", async () => {
      mockTmux.mockImplementation(async (...args: string[]) => {
        if (args[0] === "has-session") return "";
        if (args[0] === "capture-pane") return "❯ ";
        return "";
      });

      const longMsg = "x".repeat(250);
      await program.parseAsync(["node", "test", "send", "my-session", longMsg]);

      expect(mockExec).toHaveBeenCalledWith("tmux", expect.arrayContaining(["load-buffer"]));
      expect(mockExec).toHaveBeenCalledWith("tmux", expect.arrayContaining(["paste-buffer"]));
    });

    it("uses send-keys for short messages", async () => {
      mockTmux.mockImplementation(async (...args: string[]) => {
        if (args[0] === "has-session") return "";
        if (args[0] === "capture-pane") return "❯ ";
        return "";
      });

      await program.parseAsync(["node", "test", "send", "my-session", "short", "msg"]);

      expect(mockExec).toHaveBeenCalledWith("tmux", [
        "send-keys",
        "-t",
        "my-session",
        "-l",
        "short msg",
      ]);
    });

    it("clears partial input before sending", async () => {
      mockTmux.mockImplementation(async (...args: string[]) => {
        if (args[0] === "has-session") return "";
        if (args[0] === "capture-pane") return "❯ ";
        return "";
      });

      await program.parseAsync(["node", "test", "send", "my-session", "hello"]);

      expect(mockExec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "my-session", "C-u"]);
    });
  });

  describe("session manager integration", () => {
    function makeConfig(): Record<string, unknown> {
      return {
        configPath: "/tmp/agent-orchestrator.yaml",
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: [],
        },
        projects: {
          "my-app": {
            name: "My App",
            sessionPrefix: "app",
            path: "/tmp/my-app",
            defaultBranch: "main",
            repo: "org/my-app",
            agent: "claude-code",
            runtime: "tmux",
          },
        },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
    }

    it("routes AO sessions through SessionManager.send", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue({
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "idle",
        branch: null,
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: { id: "tmux-target-1", runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { agent: "opencode" },
      });
      mockSessionManager.send.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "send", "app-1", "hello", "opencode"]);

      expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "hello opencode");
      expect(mockExec).not.toHaveBeenCalledWith(
        "tmux",
        expect.arrayContaining(["send-keys", "-l", "hello opencode"]),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Message sent and processing"),
      );
    });

    it("skips tmux checks for non-tmux AO sessions and still uses lifecycle send", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue({
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: null,
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: { id: "proc-1", runtimeName: "process", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { agent: "opencode" },
      });
      mockSessionManager.send.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "send", "app-1", "hello"]);

      expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "hello");
      expect(mockTmux).not.toHaveBeenCalledWith("has-session", "-t", expect.any(String));
    });

    it("fails loudly when lifecycle delivery fails for an AO session", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue({
        id: "app-1",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        branch: null,
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: { id: "tmux-target-1", runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { agent: "opencode" },
      });
      mockSessionManager.send.mockRejectedValue(
        new Error("Cannot send to session app-1: session is not running (restore timed out)"),
      );

      await expect(
        program.parseAsync(["node", "test", "send", "app-1", "hello"]),
      ).rejects.toThrow("process.exit(1)");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Cannot send to session app-1: session is not running"),
      );
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Message sent and processing"),
      );
    });

    it("passes file contents through SessionManager.send for AO sessions", async () => {
      mockConfigRef.current = makeConfig();
      mockSessionManager.get.mockResolvedValue({
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "idle",
        branch: null,
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: { id: "tmux-target-1", runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { agent: "opencode" },
      });
      mockSessionManager.send.mockResolvedValue(undefined);

      const filePath = join(tmpdir(), `ao-send-message-${Date.now()}.txt`);
      writeFileSync(filePath, "from file");

      try {
        await program.parseAsync(["node", "test", "send", "app-1", "--file", filePath]);
      } finally {
        rmSync(filePath, { force: true });
      }

      expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "from file");
    });
  });
});
