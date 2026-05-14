import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecFile, mockKillProcessTree } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockKillProcessTree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("@aoagents/ao-core", () => ({
  killProcessTree: mockKillProcessTree,
}));

import {
  exec,
  execSilent,
  tmux,
  git,
  gh,
  getTmuxSessions,
  getTmuxActivity,
  forwardSignalsToChild,
} from "../../src/lib/shell.js";

function makeFakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

beforeEach(() => {
  mockExecFile.mockReset();
});

function mockSuccess(stdout: string, stderr = ""): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr });
    },
  );
}

function mockFailure(message = "command failed"): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      cb(new Error(message));
    },
  );
}

describe("exec", () => {
  it("returns stdout and stderr trimmed", async () => {
    mockSuccess("  hello world  \n", "  stderr output  \n");
    const result = await exec("echo", ["hello"]);
    expect(result.stdout).toBe("  hello world");
    expect(result.stderr).toBe("  stderr output");
  });

  it("passes cwd and env options", async () => {
    mockSuccess("ok");
    await exec("cmd", ["arg"], { cwd: "/tmp", env: { FOO: "bar" } });
    expect(mockExecFile).toHaveBeenCalledWith(
      "cmd",
      ["arg"],
      expect.objectContaining({ cwd: "/tmp" }),
      expect.any(Function),
    );
    const opts = mockExecFile.mock.calls[0][2];
    expect(opts.env).toMatchObject({ FOO: "bar" });
  });

  it("throws on command failure", async () => {
    mockFailure("bad command");
    await expect(exec("bad", [])).rejects.toThrow("bad command");
  });
});

describe("execSilent", () => {
  it("returns stdout on success", async () => {
    mockSuccess("output\n");
    const result = await execSilent("cmd", []);
    expect(result).toBe("output");
  });

  it("returns null on failure", async () => {
    mockFailure();
    const result = await execSilent("cmd", []);
    expect(result).toBeNull();
  });
});

describe("tmux", () => {
  it("delegates to execSilent with tmux command", async () => {
    mockSuccess("session-1\n");
    const result = await tmux("list-sessions");
    expect(mockExecFile).toHaveBeenCalledWith(
      "tmux",
      ["list-sessions"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(result).toBe("session-1");
  });

  it("returns null on failure", async () => {
    mockFailure();
    const result = await tmux("bad-cmd");
    expect(result).toBeNull();
  });
});

describe("git", () => {
  it("returns stdout on success", async () => {
    mockSuccess("main\n");
    const result = await git(["branch", "--show-current"]);
    expect(result).toBe("main");
  });

  it("returns null on failure", async () => {
    mockFailure();
    const result = await git(["status"]);
    expect(result).toBeNull();
  });

  it("passes cwd argument", async () => {
    mockSuccess("ok");
    await git(["status"], "/my/repo");
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ cwd: "/my/repo" }),
      expect.any(Function),
    );
  });
});

describe("gh", () => {
  it("returns stdout on success", async () => {
    mockSuccess("MERGED\n");
    const result = await gh(["pr", "view"]);
    expect(result).toBe("MERGED");
  });

  it("returns null on failure", async () => {
    mockFailure();
    const result = await gh(["pr", "view"]);
    expect(result).toBeNull();
  });
});

describe("getTmuxSessions", () => {
  it("parses newline-separated session names", async () => {
    mockSuccess("app-1\napp-2\nother-3\n");
    const result = await getTmuxSessions();
    expect(result).toEqual(["app-1", "app-2", "other-3"]);
  });

  it("returns empty array when tmux fails", async () => {
    mockFailure();
    const result = await getTmuxSessions();
    expect(result).toEqual([]);
  });

  it("filters out empty lines", async () => {
    mockSuccess("app-1\n\napp-2\n");
    const result = await getTmuxSessions();
    expect(result).toEqual(["app-1", "app-2"]);
  });
});

describe("getTmuxActivity", () => {
  it("parses unix timestamp and converts to milliseconds", async () => {
    mockSuccess("1700000000\n");
    const result = await getTmuxActivity("session-1");
    expect(result).toBe(1700000000000);
  });

  it("returns null on failure", async () => {
    mockFailure();
    const result = await getTmuxActivity("session-1");
    expect(result).toBeNull();
  });

  it("returns null for non-numeric output", async () => {
    mockSuccess("not-a-number\n");
    const result = await getTmuxActivity("session-1");
    expect(result).toBeNull();
  });
});

describe("forwardSignalsToChild", () => {
  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    mockKillProcessTree.mockClear();
  });

  it("registers SIGINT and SIGTERM listeners on the process", () => {
    const child = makeFakeChild();
    const before = process.listenerCount("SIGINT");
    forwardSignalsToChild(1234, child);
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
  });

  it("is idempotent — calling twice for the same child registers only one handler per signal", () => {
    const child = makeFakeChild();
    const before = process.listenerCount("SIGINT");
    forwardSignalsToChild(1234, child);
    forwardSignalsToChild(1234, child);
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
  });

  it("allows independent registration for different child objects", () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    const before = process.listenerCount("SIGINT");
    forwardSignalsToChild(1234, childA);
    forwardSignalsToChild(5678, childB);
    expect(process.listenerCount("SIGINT")).toBe(before + 2);
    expect(process.listenerCount("SIGTERM")).toBe(before + 2);
  });

  it("removes SIGTERM handler when SIGINT fires", () => {
    const child = makeFakeChild();
    forwardSignalsToChild(1234, child);
    const sigtermBefore = process.listenerCount("SIGTERM");
    process.emit("SIGINT");
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore - 1);
    expect(mockKillProcessTree).toHaveBeenCalledWith(1234, "SIGTERM");
  });

  it("removes SIGINT handler when SIGTERM fires", () => {
    const child = makeFakeChild();
    forwardSignalsToChild(1234, child);
    const sigintBefore = process.listenerCount("SIGINT");
    process.emit("SIGTERM");
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore - 1);
    expect(mockKillProcessTree).toHaveBeenCalledWith(1234, "SIGTERM");
  });

  it("removes both signal handlers when child exits normally", () => {
    const child = makeFakeChild();
    forwardSignalsToChild(1234, child);
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    child.emit("exit", 0, null);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore - 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore - 1);
  });
});
