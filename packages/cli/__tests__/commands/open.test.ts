import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExec, mockConfigRef, mockTmux } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockTmux: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
  execSilent: vi.fn(),
  tmux: mockTmux,
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: async () => {
    const output = await mockTmux("list-sessions", "-F", "#{session_name}");
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  },
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: () => mockConfigRef.current,
}));

import { Command } from "commander";
import { registerOpen } from "../../src/commands/open.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockConfigRef.current = {
    dataDir: "/tmp/ao",
    worktreeDir: "/tmp/wt",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/home/user/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
      },
      backend: {
        name: "Backend",
        repo: "org/backend",
        path: "/home/user/backend",
        defaultBranch: "main",
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  program = new Command();
  program.exitOverride();
  registerOpen(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockExec.mockReset();
  mockTmux.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("open command", () => {
  it("opens all sessions when target is 'all'", async () => {
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1\napp-2\nbackend-1";
      return null;
    });

    await program.parseAsync(["node", "test", "open", "all"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 3 sessions");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).toContain("backend-1");
  });

  it("opens all sessions when no target given", async () => {
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    await program.parseAsync(["node", "test", "open"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
  });

  it("opens sessions for a specific project", async () => {
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1\napp-2\nbackend-1";
      return null;
    });

    await program.parseAsync(["node", "test", "open", "my-app"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 2 sessions");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).not.toContain("backend-1");
  });

  it("matches hashed tmux worker session names", async () => {
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "1686e4aaaeaa-app-1\nbackend-1";
      return null;
    });

    await program.parseAsync(["node", "test", "open", "my-app"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
    expect(output).toContain("1686e4aaaeaa-app-1");
    expect(output).not.toContain("backend-1");
  });

  it("opens a single session by name", async () => {
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1\napp-2";
      return null;
    });

    await program.parseAsync(["node", "test", "open", "app-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
    expect(output).toContain("app-1");
  });

  it("rejects unknown target", async () => {
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    await expect(program.parseAsync(["node", "test", "open", "nonexistent"])).rejects.toThrow(
      "process.exit(1)",
    );
  });

  it("passes --new-window flag to open-iterm-tab", async () => {
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    await program.parseAsync(["node", "test", "open", "-w", "app-1"]);

    expect(mockExec).toHaveBeenCalledWith("open-iterm-tab", ["--new-window", "app-1"]);
  });

  it("falls back gracefully when open-iterm-tab fails", async () => {
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });
    mockExec.mockRejectedValue(new Error("command not found"));

    await program.parseAsync(["node", "test", "open", "app-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("http://localhost:3000/projects/my-app/sessions/app-1");
  });

  it("falls back to the owning project for orchestrator sessions", async () => {
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-orchestrator";
      return null;
    });
    mockExec.mockRejectedValue(new Error("command not found"));

    await program.parseAsync(["node", "test", "open", "app-orchestrator"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("http://localhost:3000/projects/my-app/sessions/app-orchestrator");
  });

  it("shows 'No sessions to open' when none exist", async () => {
    mockTmux.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "open", "my-app"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to open");
  });
});
