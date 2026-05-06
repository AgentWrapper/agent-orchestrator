/**
 * Integration tests for terminal-iterm2.
 *
 * Mocks ONLY the I/O boundary: node:child_process and node:os.
 * Everything else runs for real: AppleScript generation, escaping chains, tab reuse logic.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:os", () => ({
  platform: vi.fn(() => "darwin"),
}));

import { execFile } from "node:child_process";
import { platform } from "node:os";

const mockExecFile = execFile as unknown as Mock;
const mockPlatform = platform as unknown as Mock;

import iterm2Plugin from "@aoagents/ao-plugin-terminal-iterm2";
import { makeSession } from "./helpers/event-factory.js";

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

describe("terminal-iterm2 integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPlatform.mockReturnValue("darwin");
  });

  describe("escaping chain integrity", () => {
    it("handles double quotes, backslashes, and single quotes simultaneously in session name", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = iterm2Plugin.create();

      const nastyName = `it's-a-"test"\\session`;
      await terminal.openSession(makeSession({ id: nastyName }));

      // Call 0: findAndSelectExistingTab
      const findScript = mockExecFile.mock.calls[0][1][1] as string;
      // AppleScript escaping: " -> \" and \ -> \\
      expect(findScript).toContain('it\'s-a-\\"test\\"\\\\session');

      // Call 1: openNewTab
      const openScript = mockExecFile.mock.calls[1][1][1] as string;
      // AppleScript escaping in set name
      expect(openScript).toContain('set name to "it\'s-a-\\"test\\"\\\\session"');
      // Shell escaping then AppleScript escaping in tmux command:
      // Shell: 'it'\''s-a-"test"\session' -> AppleScript doubles backslashes
      expect(openScript).toContain("tmux attach -t 'it'\\\\''s-a-\\\"test\\\"\\\\session'");
    });
  });

  describe("tab reuse logic", () => {
    it("FOUND response -> no openNewTab call (only 1 execFile call)", async () => {
      simulateOsascript("FOUND\n");
      const terminal = iterm2Plugin.create();
      await terminal.openSession(makeSession());

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      // Should be the findAndSelectExistingTab call only
      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain("select aWindow");
      expect(script).toContain("select aTab");
    });

    it("NOT_FOUND response -> openNewTab call (2 execFile calls)", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = iterm2Plugin.create();
      await terminal.openSession(makeSession());

      expect(mockExecFile).toHaveBeenCalledTimes(2);
      const openScript = mockExecFile.mock.calls[1][1][1] as string;
      expect(openScript).toContain("create tab with default profile");
    });

    it("runtimeHandle.id takes precedence over session.id", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = iterm2Plugin.create();
      await terminal.openSession(
        makeSession({
          id: "app-1",
          runtimeHandle: { id: "tmux-session-42", runtimeName: "tmux", data: {} },
        }),
      );

      const findScript = mockExecFile.mock.calls[0][1][1] as string;
      expect(findScript).toContain("tmux-session-42");
      expect(findScript).not.toContain('"app-1"');
    });
  });

  describe("isSessionOpen no side effects", () => {
    it("script contains no select commands", async () => {
      simulateOsascript("FOUND\n");
      const terminal = iterm2Plugin.create();
      await terminal.isSessionOpen!(makeSession({ id: "check-only" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).not.toContain("select aWindow");
      expect(script).not.toContain("select aTab");
      // It should still check name
      expect(script).toContain("name of aSession");
      expect(script).toContain('"check-only"');
    });

    it("returns true when FOUND", async () => {
      simulateOsascript("FOUND\n");
      const terminal = iterm2Plugin.create();
      const result = await terminal.isSessionOpen!(makeSession());
      expect(result).toBe(true);
    });

    it("returns false when NOT_FOUND", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = iterm2Plugin.create();
      const result = await terminal.isSessionOpen!(makeSession());
      expect(result).toBe(false);
    });

    it("returns false when osascript throws", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string) => void) => {
          cb(new Error("script error"), "");
        },
      );
      const terminal = iterm2Plugin.create();
      const result = await terminal.isSessionOpen!(makeSession());
      expect(result).toBe(false);
    });
  });

  describe("platform guard", () => {
    it("openSession is no-op on non-macOS and warns", async () => {
      mockPlatform.mockReturnValue("linux");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const terminal = iterm2Plugin.create();
      await terminal.openSession(makeSession());

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("only available on macOS"));
      warnSpy.mockRestore();
    });

    it("openAll is no-op on non-macOS", async () => {
      mockPlatform.mockReturnValue("win32");
      const terminal = iterm2Plugin.create();
      await terminal.openAll([makeSession()]);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("isSessionOpen returns false on non-macOS", async () => {
      mockPlatform.mockReturnValue("linux");
      const terminal = iterm2Plugin.create();
      const result = await terminal.isSessionOpen!(makeSession());
      expect(result).toBe(false);
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe("openAll full pipeline", () => {
    it("opens tabs for each session with delay between operations", async () => {
      simulateOsascript("NOT_FOUND\n");
      const terminal = iterm2Plugin.create();
      const sessions = [makeSession({ id: "s1" }), makeSession({ id: "s2" })];

      const promise = terminal.openAll(sessions);

      // Process first session
      await vi.advanceTimersByTimeAsync(300);
      // Process second session
      await vi.advanceTimersByTimeAsync(300);
      await promise;

      // 2 sessions * 2 calls each (find + open) = 4
      expect(mockExecFile).toHaveBeenCalledTimes(4);
    });

    it("skips existing sessions and opens only new ones", async () => {
      simulateOsascriptSequence(["FOUND\n", "NOT_FOUND\n", ""]);
      const terminal = iterm2Plugin.create();
      const sessions = [makeSession({ id: "existing" }), makeSession({ id: "new-one" })];

      const promise = terminal.openAll(sessions);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(300);
      await promise;

      // existing: 1 call (find=FOUND), new-one: 2 calls (find + open)
      expect(mockExecFile).toHaveBeenCalledTimes(3);
    });
  });
});
