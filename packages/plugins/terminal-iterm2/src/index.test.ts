import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { createInitialCanonicalLifecycle, createActivitySignal, type Session } from "@aoagents/ao-core";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:os", () => ({
  platform: vi.fn(() => "darwin"),
}));

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { manifest, create, escapeAppleScript } from "./index.js";

const mockExecFile = execFile as unknown as Mock;
const mockPlatform = platform as unknown as Mock;

function makeSession(overrides: Partial<Session> = {}): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date());
  lifecycle.session.state = "working";
  lifecycle.session.reason = "task_in_progress";
  lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
  lifecycle.runtime.state = "alive";
  lifecycle.runtime.reason = "process_running";
  return {
    id: "app-1",
    projectId: "my-project",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
    lifecycle,
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/workspace",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function simulateOsascript(stdout: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string) => void) => {
      cb(null, stdout);
    },
  );
}

function simulateOsascriptSequence(results: string[]) {
  let callIndex = 0;
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string) => void) => {
      const result = results[callIndex] ?? "NOT_FOUND";
      callIndex++;
      cb(null, result);
    },
  );
}

describe("terminal-iterm2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPlatform.mockReturnValue("darwin");
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("iterm2");
      expect(manifest.slot).toBe("terminal");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("escapeAppleScript", () => {
    it("escapes double quotes", () => {
      expect(escapeAppleScript('hello "world"')).toBe('hello \\"world\\"');
    });

    it("escapes backslashes", () => {
      expect(escapeAppleScript("path\\to\\file")).toBe("path\\\\to\\\\file");
    });

    it("escapes both backslashes and quotes together", () => {
      expect(escapeAppleScript('a\\b"c')).toBe('a\\\\b\\"c');
    });

    it("returns plain strings unchanged", () => {
      expect(escapeAppleScript("hello-world_123")).toBe("hello-world_123");
    });
  });

  describe("create", () => {
    it("returns a terminal with name 'iterm2'", () => {
      const terminal = create();
      expect(terminal.name).toBe("iterm2");
    });
  });

  describe("openSession", () => {
    it("uses session.id as session name by default", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      await terminal.openSession(makeSession({ id: "backend-5" }));

      expect(mockExecFile).toHaveBeenCalledTimes(2);
      const newTabScript = mockExecFile.mock.calls[1][1][1] as string;
      expect(newTabScript).toContain("backend-5");
    });

    it("uses runtimeHandle.id when available", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      await terminal.openSession(
        makeSession({
          id: "app-1",
          runtimeHandle: { id: "tmux-session-42", runtimeName: "tmux", data: {} },
        }),
      );

      const newTabScript = mockExecFile.mock.calls[1][1][1] as string;
      expect(newTabScript).toContain("tmux-session-42");
      expect(newTabScript).not.toContain("app-1");
    });

    it("reuses existing tab when found", async () => {
      simulateOsascript("FOUND\n");
      const terminal = create();
      await terminal.openSession(makeSession());

      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("opens new tab when not found", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      await terminal.openSession(makeSession());

      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("escapes special chars in session name for AppleScript", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      await terminal.openSession(makeSession({ id: 'session"with"quotes' }));

      const findScript = mockExecFile.mock.calls[0][1][1] as string;
      expect(findScript).toContain('session\\"with\\"quotes');
      expect(findScript).not.toContain('session"with"quotes');

      const openScript = mockExecFile.mock.calls[1][1][1] as string;
      expect(openScript).toContain('session\\"with\\"quotes');
    });
  });

  describe("AppleScript commands", () => {
    it("findAndSelectExistingTab checks session name and selects", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      await terminal.openSession(makeSession({ id: "my-session" }));

      const findScript = mockExecFile.mock.calls[0][1][1] as string;
      expect(findScript).toContain('tell application "iTerm2"');
      expect(findScript).toContain("name of aSession");
      expect(findScript).not.toContain("profile name of aSession");
      expect(findScript).toContain('"my-session"');
      expect(findScript).toContain("select aWindow");
      expect(findScript).toContain("select aTab");
    });

    it("openNewTab creates tab and attaches to tmux with shell-safe quoting", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      await terminal.openSession(makeSession({ id: "app-7" }));

      const openScript = mockExecFile.mock.calls[1][1][1] as string;
      expect(openScript).toContain("create tab with default profile");
      expect(openScript).toContain('set name to "app-7"');
      expect(openScript).toContain("tmux attach -t 'app-7'");
    });

    it("shell-escapes session names with single quotes in tmux command", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      await terminal.openSession(makeSession({ id: "it's-a-test" }));

      const openScript = mockExecFile.mock.calls[1][1][1] as string;
      // Single quotes in the session name should be shell-escaped then AppleScript-escaped.
      // Shell escape: 'it'\''s-a-test'  →  AppleScript escape doubles the backslash: 'it'\\''s-a-test'
      expect(openScript).toContain("tmux attach -t 'it'\\\\''s-a-test'");
    });

    it("always calls osascript as the command", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      await terminal.openSession(makeSession());

      for (const call of mockExecFile.mock.calls) {
        expect(call[0]).toBe("osascript");
        expect(call[1][0]).toBe("-e");
      }
    });
  });

  describe("openAll", () => {
    it("does nothing for empty session list", async () => {
      const terminal = create();
      await terminal.openAll([]);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("opens tabs for each session", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      const sessions = [makeSession({ id: "app-1" }), makeSession({ id: "app-2" })];

      const promise = terminal.openAll(sessions);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(300);
      await promise;

      // 2 sessions * 2 calls each (find + open) = 4
      expect(mockExecFile).toHaveBeenCalledTimes(4);
    });

    it("skips opening tabs for existing sessions", async () => {
      simulateOsascriptSequence(["FOUND\n", "NOT_FOUND\n", ""]);
      const terminal = create();
      const sessions = [makeSession({ id: "existing-1" }), makeSession({ id: "new-1" })];

      const promise = terminal.openAll(sessions);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(300);
      await promise;

      // existing-1: 1 call (find=FOUND), new-1: 2 calls (find=NOT_FOUND + open)
      expect(mockExecFile).toHaveBeenCalledTimes(3);
    });
  });

  describe("platform guard", () => {
    it("openSession is a no-op on non-macOS", async () => {
      mockPlatform.mockReturnValue("linux");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const terminal = create();
      await terminal.openSession(makeSession());
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("only available on macOS"));
      warnSpy.mockRestore();
    });

    it("isSessionOpen returns false on non-macOS", async () => {
      mockPlatform.mockReturnValue("win32");
      const terminal = create();
      const result = await terminal.isSessionOpen!(makeSession());
      expect(result).toBe(false);
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe("isSessionOpen", () => {
    it("returns true when tab exists", async () => {
      simulateOsascript("FOUND\n");
      const terminal = create();
      const result = await terminal.isSessionOpen!(makeSession({ id: "app-1" }));
      expect(result).toBe(true);
    });

    it("returns false when tab does not exist", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = create();
      const result = await terminal.isSessionOpen!(makeSession({ id: "app-1" }));
      expect(result).toBe(false);
    });

    it("returns false when osascript fails", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string) => void) => {
          cb(new Error("osascript failed"), "");
        },
      );
      const terminal = create();
      const result = await terminal.isSessionOpen!(makeSession());
      expect(result).toBe(false);
    });

    it("does NOT select the tab (no side effect)", async () => {
      simulateOsascript("FOUND\n");
      const terminal = create();
      await terminal.isSessionOpen!(makeSession({ id: "check-only" }));

      // isSessionOpen uses hasExistingTab which does NOT contain select commands
      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).not.toContain("select aWindow");
      expect(script).not.toContain("select aTab");
      // Uses session name, not profile name
      expect(script).toContain("name of aSession");
      expect(script).not.toContain("profile name");
    });
  });
});
