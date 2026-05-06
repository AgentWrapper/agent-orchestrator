import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { RuntimeHandle } from "@aoagents/ao-core";

// Mock node:child_process with custom promisify support
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  // promisify(execFile) checks for a custom promisify symbol. Set it so
  // await execFileAsync(...) returns { stdout, stderr } properly.
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

// Mock node:crypto for deterministic UUIDs
vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

// Mock node:fs for writeFileSync / unlinkSync
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Get reference to the promisify-custom mock — this is what the plugin actually calls
const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;
const expectedTmuxOptions = { timeout: 5_000 };

/** Queue a successful tmux command with the given stdout. */
function mockTmuxSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed tmux command. */
function mockTmuxError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

/** Create a RuntimeHandle for testing. */
function makeHandle(id: string, createdAt?: number): RuntimeHandle {
  return {
    id,
    runtimeName: "tmux",
    data: {
      createdAt: createdAt ?? 1000,
      workspacePath: "/tmp/workspace",
    },
  };
}

// Import after mocks are set up
import tmuxPlugin, { manifest, create } from "../index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("manifest", () => {
  it("has name 'tmux' and slot 'runtime'", () => {
    expect(manifest.name).toBe("tmux");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: tmux sessions");
  });

  it("default export includes manifest and create", () => {
    expect(tmuxPlugin.manifest).toBe(manifest);
    expect(tmuxPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'tmux'", () => {
    const runtime = create();
    expect(runtime.name).toBe("tmux");
  });
});

describe("runtime.create()", () => {
  it("calls new-session with correct args", async () => {
    const runtime = create();

    // 1: new-session, 2: send-keys (launch command)
    mockTmuxSuccess();
    mockTmuxSuccess();

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "echo hello",
      environment: {},
    });

    expect(handle.id).toBe("test-session");
    expect(handle.runtimeName).toBe("tmux");
    expect(handle.data.workspacePath).toBe("/tmp/workspace");

    // First call: new-session
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["new-session", "-d", "-s", "test-session", "-c", "/tmp/workspace"],
      expectedTmuxOptions,
    );
  });

  it("includes -e KEY=VALUE flags for environment variables", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "env-session",
      workspacePath: "/tmp/ws",
      launchCommand: "bash",
      environment: { AO_SESSION: "env-session", FOO: "bar" },
    });

    // First call: new-session with env args
    const firstCallArgs = mockExecFileCustom.mock.calls[0];
    const args = firstCallArgs[1] as string[];
    expect(args).toContain("-e");
    expect(args).toContain("AO_SESSION=env-session");
    expect(args).toContain("FOO=bar");
  });

  it("sends launch command via send-keys", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "launch-test",
      workspacePath: "/tmp/ws",
      launchCommand: "claude --session abc",
      environment: {},
    });

    // Second call: send-keys with the launch command
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "launch-test", "claude --session abc", "Enter"],
      expectedTmuxOptions,
    );
  });

  it("uses a temp launch script for long launch commands", async () => {
    const runtime = create();
    const longCommand = "x".repeat(250);

    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "launch-long",
      workspacePath: "/tmp/ws",
      launchCommand: longCommand,
      environment: {},
    });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-launch-test-uuid-1234.sh"),
      expect.stringContaining(longCommand),
      { encoding: "utf-8", mode: 0o700 },
    );

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "tmux",
      [
        "send-keys",
        "-t",
        "launch-long",
        "-l",
        expect.stringContaining("bash "),
      ],
      expectedTmuxOptions,
    );

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "tmux",
      ["send-keys", "-t", "launch-long", "Enter"],
      expectedTmuxOptions,
    );
  });

  it("cleans up session if send-keys fails", async () => {
    const runtime = create();

    // 1: new-session succeeds
    mockTmuxSuccess();
    // 2: send-keys fails
    mockTmuxError("send-keys failed");
    // 3: kill-session (cleanup attempt)
    mockTmuxSuccess();

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/ws",
        launchCommand: "bad-command",
        environment: {},
      }),
    ).rejects.toThrow('Failed to send launch command to session "fail-session"');

    // Verify kill-session was called for cleanup
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["kill-session", "-t", "fail-session"],
      expectedTmuxOptions,
    );
  });

  it("rejects invalid session IDs with special characters", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad session!",
        workspacePath: "/tmp/ws",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow('Invalid session ID "bad session!"');
  });

  it("rejects session IDs with dots", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad.session",
        workspacePath: "/tmp/ws",
        launchCommand: "echo",
        environment: {},
      }),
    ).rejects.toThrow("Invalid session ID");
  });

  it("accepts valid session IDs with hyphens and underscores", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();

    const handle = await runtime.create({
      sessionId: "valid-session_123",
      workspacePath: "/tmp/ws",
      launchCommand: "echo",
      environment: {},
    });

    expect(handle.id).toBe("valid-session_123");
  });

  it("handles no environment (undefined)", async () => {
    const runtime = create();

    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.create({
      sessionId: "no-env",
      workspacePath: "/tmp/ws",
      launchCommand: "echo hi",
    } as any);

    // First call should not contain -e flags
    const firstCallArgs = mockExecFileCustom.mock.calls[0][1] as string[];
    expect(firstCallArgs).toEqual(["new-session", "-d", "-s", "no-env", "-c", "/tmp/ws"]);
  });
});

describe("runtime.destroy()", () => {
  it("calls kill-session with the handle id", async () => {
    const runtime = create();
    const handle = makeHandle("destroy-test");

    mockTmuxSuccess();

    await runtime.destroy(handle);

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["kill-session", "-t", "destroy-test"],
      expectedTmuxOptions,
    );
  });

  it("does not throw if session is already gone", async () => {
    const runtime = create();
    const handle = makeHandle("already-dead");

    mockTmuxError("session not found: already-dead");

    // Should not throw
    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("sends short text with send-keys -l (literal) + Enter", async () => {
    const runtime = create();
    const handle = makeHandle("msg-short");

    // 1: send-keys C-u (clear), 2: send-keys -l text, 3: send-keys Enter
    mockTmuxSuccess();
    mockTmuxSuccess();
    mockTmuxSuccess();

    await runtime.sendMessage(handle, "hello world");

    expect(mockExecFileCustom).toHaveBeenCalledTimes(3);

    // Call 0: Clear partial input
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      1,
      "tmux",
      ["send-keys", "-t", "msg-short", "C-u"],
      expectedTmuxOptions,
    );

    // Call 1: Literal text
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "tmux",
      ["send-keys", "-t", "msg-short", "-l", "hello world"],
      expectedTmuxOptions,
    );

    // Call 2: Enter
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "tmux",
      ["send-keys", "-t", "msg-short", "Enter"],
      expectedTmuxOptions,
    );
  });

  it("uses load-buffer + paste-buffer for long text (> 200 chars)", async () => {
    const runtime = create();
    const handle = makeHandle("msg-long");
    const longText = "x".repeat(250);

    // 1: C-u, 2: load-buffer, 3: paste-buffer, 4: unlinkSync (sync), 5: delete-buffer, 6: Enter
    mockTmuxSuccess(); // C-u
    mockTmuxSuccess(); // load-buffer
    mockTmuxSuccess(); // paste-buffer
    mockTmuxSuccess(); // delete-buffer (finally block)
    mockTmuxSuccess(); // Enter

    await runtime.sendMessage(handle, longText);

    expect(mockExecFileCustom).toHaveBeenCalledTimes(5);

    // Call 0: clear
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      1,
      "tmux",
      ["send-keys", "-t", "msg-long", "C-u"],
      expectedTmuxOptions,
    );

    // Call 1: load-buffer with named buffer
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "tmux",
      [
        "load-buffer",
        "-b",
        "ao-test-uuid-1234",
        expect.stringContaining("ao-send-test-uuid-1234.txt"),
      ],
      expectedTmuxOptions,
    );

    // Call 2: paste-buffer
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "tmux",
      ["paste-buffer", "-b", "ao-test-uuid-1234", "-t", "msg-long", "-d"],
      expectedTmuxOptions,
    );

    // Verify writeFileSync was called with the message
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
      longText,
      { encoding: "utf-8", mode: 0o600 },
    );

    // Verify unlinkSync was called for cleanup
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
    );
  });

  it("uses load-buffer for multiline text", async () => {
    const runtime = create();
    const handle = makeHandle("msg-multi");

    mockTmuxSuccess(); // C-u
    mockTmuxSuccess(); // load-buffer
    mockTmuxSuccess(); // paste-buffer
    mockTmuxSuccess(); // delete-buffer (finally)
    mockTmuxSuccess(); // Enter

    await runtime.sendMessage(handle, "line1\nline2\nline3");

    // Should use buffer path, not send-keys -l
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "tmux",
      [
        "load-buffer",
        "-b",
        "ao-test-uuid-1234",
        expect.stringContaining("ao-send-test-uuid-1234.txt"),
      ],
      expectedTmuxOptions,
    );

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
      "line1\nline2\nline3",
      { encoding: "utf-8", mode: 0o600 },
    );
  });

  it("cleans up buffer and temp file on paste failure", async () => {
    const runtime = create();
    const handle = makeHandle("msg-fail");
    const longText = "y".repeat(250);

    mockTmuxSuccess(); // C-u
    mockTmuxSuccess(); // load-buffer succeeds
    mockTmuxError("paste-buffer failed"); // paste-buffer fails
    // finally block:
    // unlinkSync is sync (mocked)
    mockTmuxSuccess(); // delete-buffer in finally
    // After finally, the error propagates — no Enter call

    await expect(runtime.sendMessage(handle, longText)).rejects.toThrow("paste-buffer failed");

    // unlinkSync should still be called for temp file cleanup
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-send-test-uuid-1234.txt"),
    );

    // delete-buffer should be called in finally block
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["delete-buffer", "-b", "ao-test-uuid-1234"],
      expectedTmuxOptions,
    );
  });
});

describe("runtime.getOutput()", () => {
  it("calls capture-pane with correct args and default lines", async () => {
    const runtime = create();
    const handle = makeHandle("output-test");

    mockTmuxSuccess("some output\nfrom tmux");

    const output = await runtime.getOutput(handle);

    expect(output).toBe("some output\nfrom tmux");
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "output-test", "-p", "-S", "-50"],
      expectedTmuxOptions,
    );
  });

  it("passes custom line count", async () => {
    const runtime = create();
    const handle = makeHandle("output-custom");

    mockTmuxSuccess("output");

    await runtime.getOutput(handle, 100);

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "output-custom", "-p", "-S", "-100"],
      expectedTmuxOptions,
    );
  });

  it("returns empty string on error", async () => {
    const runtime = create();
    const handle = makeHandle("output-err");

    mockTmuxError("session not found");

    const output = await runtime.getOutput(handle);

    expect(output).toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when has-session succeeds", async () => {
    const runtime = create();
    const handle = makeHandle("alive-test");

    mockTmuxSuccess();

    const alive = await runtime.isAlive(handle);

    expect(alive).toBe(true);
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["has-session", "-t", "alive-test"],
      expectedTmuxOptions,
    );
  });

  it("returns false when has-session fails", async () => {
    const runtime = create();
    const handle = makeHandle("dead-test");

    mockTmuxError("session not found");

    const alive = await runtime.isAlive(handle);

    expect(alive).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptimeMs based on createdAt", async () => {
    const runtime = create();
    const now = Date.now();
    const handle = makeHandle("metrics-test", now - 5000);

    const metrics = await runtime.getMetrics!(handle);

    // uptimeMs should be approximately 5000ms (allow some wiggle room)
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(metrics.uptimeMs).toBeLessThan(6000);
  });

  it("handles missing createdAt by using Date.now()", async () => {
    const runtime = create();
    const handle: RuntimeHandle = {
      id: "metrics-no-created",
      runtimeName: "tmux",
      data: {},
    };

    const metrics = await runtime.getMetrics!(handle);

    // uptimeMs should be very close to 0 since createdAt defaults to Date.now()
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(1000);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns tmux type and attach command", async () => {
    const runtime = create();
    const handle = makeHandle("attach-test");

    const info = await runtime.getAttachInfo!(handle);

    expect(info).toEqual({
      type: "tmux",
      target: "attach-test",
      command: "tmux attach -t attach-test",
    });
  });
});

describe("runtime.preflight()", () => {
  it("resolves when `tmux -V` succeeds", async () => {
    mockTmuxSuccess("tmux 3.4");
    const runtime = create();
    await expect(runtime.preflight!({} as never)).resolves.toBeUndefined();
    expect(mockExecFileCustom).toHaveBeenCalledWith("tmux", ["-V"], expectedTmuxOptions);
  });

  it("throws with platform-specific install hint when tmux is missing", async () => {
    mockTmuxError("ENOENT");
    const runtime = create();
    const err = (await runtime.preflight!({} as never).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("tmux is not installed");
    expect(err.message).toContain("Install it:");
    // Hint must include something runnable for the host platform.
    if (process.platform === "darwin") expect(err.message).toContain("brew install tmux");
    else if (process.platform === "win32") expect(err.message).toContain("WSL");
    else expect(err.message).toMatch(/apt install tmux|dnf install tmux/);
  });
});
