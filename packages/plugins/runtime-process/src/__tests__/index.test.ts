import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { RuntimeHandle } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mock — must be set up before import
// ---------------------------------------------------------------------------
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { create, manifest, default as defaultExport } from "../index.js";

// ---------------------------------------------------------------------------
// Mock ChildProcess
// ---------------------------------------------------------------------------
class MockChildProcess extends EventEmitter {
  pid = 12345;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdin = {
    writable: true,
    write: vi.fn((_data: string, cb: (err?: Error | null) => void) => {
      cb(null);
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function createMockChild(autoSpawn = true): MockChildProcess {
  const child = new MockChildProcess();
  if (autoSpawn) {
    // Emit "spawn" on next tick so the await in create() resolves
    process.nextTick(() => child.emit("spawn"));
  }
  return child;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "process", data: { pid: 12345 } };
}

function defaultConfig(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "test-session",
    launchCommand: "echo hello",
    workspacePath: "/tmp/workspace",
    environment: { FOO: "bar" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// =========================================================================
// Manifest & exports
// =========================================================================
describe("manifest & exports", () => {
  it("has correct manifest fields", () => {
    expect(manifest).toEqual({
      name: "process",
      slot: "runtime",
      description: "Runtime plugin: child processes",
      version: "0.1.0",
    });
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });

  it("create() returns a runtime with name 'process'", () => {
    const runtime = create();
    expect(runtime.name).toBe("process");
  });
});

// =========================================================================
// runtime.create()
// =========================================================================
describe("create()", () => {
  it("spawns process with shell:true, detached:true, correct cwd and env", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    expect(mockSpawn).toHaveBeenCalledWith(
      "echo hello",
      expect.objectContaining({
        cwd: "/tmp/workspace",
        shell: true,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );

    // Check the env includes the config environment merged with process.env
    const callArgs = mockSpawn.mock.calls[0][1] as { env: Record<string, string> };
    expect(callArgs.env.FOO).toBe("bar");
  });

  it("returns handle with correct id, runtimeName, and pid in data", async () => {
    const child = createMockChild();
    child.pid = 99999;
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig({ sessionId: "my-session" }));

    expect(handle.id).toBe("my-session");
    expect(handle.runtimeName).toBe("process");
    expect(handle.data).toEqual(expect.objectContaining({ pid: 99999 }));
  });

  it("rejects invalid session IDs with special characters", async () => {
    const runtime = create();
    await expect(runtime.create(defaultConfig({ sessionId: "bad session!!" }))).rejects.toThrow(
      /Invalid session ID/,
    );
  });

  it("rejects session ID with dots", async () => {
    const runtime = create();
    await expect(runtime.create(defaultConfig({ sessionId: "bad.session" }))).rejects.toThrow(
      /Invalid session ID/,
    );
  });

  it("rejects session ID with spaces", async () => {
    const runtime = create();
    await expect(runtime.create(defaultConfig({ sessionId: "bad session" }))).rejects.toThrow(
      /Invalid session ID/,
    );
  });

  it("accepts valid session IDs with alphanumeric, hyphens, underscores", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig({ sessionId: "my-session_01" }));
    expect(handle.id).toBe("my-session_01");
  });

  it("rejects duplicate session IDs", async () => {
    const child1 = createMockChild();
    mockSpawn.mockReturnValue(child1);

    const runtime = create();
    await runtime.create(defaultConfig({ sessionId: "dup-session" }));

    // Second call with same ID should throw
    const child2 = createMockChild();
    mockSpawn.mockReturnValue(child2);
    await expect(runtime.create(defaultConfig({ sessionId: "dup-session" }))).rejects.toThrow(
      /already exists/,
    );
  });

  it("cleans up on spawn error", async () => {
    const child = createMockChild(false);
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const createPromise = runtime.create(defaultConfig({ sessionId: "fail-session" }));

    // Emit error on next tick
    process.nextTick(() => child.emit("error", new Error("ENOENT")));

    await expect(createPromise).rejects.toThrow(/Failed to spawn/);

    // After the error, the session ID should be cleaned up from internal map.
    // We can verify by trying to create with the same ID again (should succeed).
    const child2 = createMockChild();
    mockSpawn.mockReturnValue(child2);
    const handle = await runtime.create(defaultConfig({ sessionId: "fail-session" }));
    expect(handle.id).toBe("fail-session");
  });

  it("cleans up when spawn() itself throws synchronously", async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("spawn EACCES");
    });

    const runtime = create();
    await expect(runtime.create(defaultConfig({ sessionId: "sync-fail" }))).rejects.toThrow(
      /Failed to spawn/,
    );

    // Slot should be freed — re-create should work
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const handle = await runtime.create(defaultConfig({ sessionId: "sync-fail" }));
    expect(handle.id).toBe("sync-fail");
  });
});

// =========================================================================
// destroy()
// =========================================================================
describe("destroy()", () => {
  it("kills the process and resolves after exit", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // Simulate exit after SIGTERM
    child.kill.mockImplementation(() => {
      // ignored — process.kill(-pid) is used instead
    });

    // When destroy is called, it sends SIGTERM then waits for exit.
    // We need to emit exit when the process receives the signal.
    const destroyPromise = runtime.destroy(handle);

    // Give the event loop a tick for destroy to register its "exit" listener
    await new Promise((r) => setTimeout(r, 10));
    child.exitCode = 0;
    child.emit("exit", 0, null);

    await destroyPromise;

    // process.kill(-pid, "SIGTERM") should have been called
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");

    killSpy.mockRestore();
  });

  it("does not throw for unknown handle (no-op)", async () => {
    const runtime = create();
    await expect(runtime.destroy(makeHandle("nonexistent"))).resolves.toBeUndefined();
  });

  it("does not attempt kill if process already exited", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    // Simulate the process having exited already
    child.exitCode = 0;

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    await runtime.destroy(handle);

    // Should NOT have called process.kill since process already exited
    expect(killSpy).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("escalates to SIGKILL after 5 second timeout", async () => {
    vi.useFakeTimers();

    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();

    // We need to emit "spawn" manually with fake timers
    const createPromise = runtime.create(defaultConfig({ sessionId: "kill-timeout" }));
    await vi.runAllTimersAsync();
    // "spawn" was scheduled via nextTick in createMockChild, which ran
    const handle = await createPromise;

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const destroyPromise = runtime.destroy(handle);

    // Advance past the 5-second timeout — process never exits
    await vi.advanceTimersByTimeAsync(5100);

    await destroyPromise;

    // Should have called SIGTERM first, then SIGKILL
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");

    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it("falls back to child.kill when process.kill(-pid) throws", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });

    const destroyPromise = runtime.destroy(handle);

    await new Promise((r) => setTimeout(r, 10));
    child.exitCode = 0;
    child.emit("exit", 0, null);

    await destroyPromise;

    // process.kill threw, so child.kill should have been called as fallback
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    killSpy.mockRestore();
  });
});

// =========================================================================
// sendMessage()
// =========================================================================
describe("sendMessage()", () => {
  it("writes message with trailing newline to stdin", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    await runtime.sendMessage(handle, "hello world");

    expect(child.stdin.write).toHaveBeenCalledWith("hello world\n", expect.any(Function));
  });

  it("throws for unknown session", async () => {
    const runtime = create();
    await expect(runtime.sendMessage(makeHandle("nonexistent"), "hello")).rejects.toThrow(
      /No process found/,
    );
  });

  it("throws when stdin is not writable", async () => {
    const child = createMockChild();
    child.stdin.writable = false;
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    await expect(runtime.sendMessage(handle, "hello")).rejects.toThrow(/stdin not writable/);
  });

  it("rejects when stdin.write returns an error", async () => {
    const child = createMockChild();
    child.stdin.write = vi.fn((_data: string, cb: (err?: Error | null) => void) => {
      cb(new Error("write EPIPE"));
    });
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    await expect(runtime.sendMessage(handle, "hello")).rejects.toThrow(/write EPIPE/);
  });
});

// =========================================================================
// getOutput()
// =========================================================================
describe("getOutput()", () => {
  it("returns buffered output lines", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    // Simulate stdout data — lines are newline-terminated
    child.stdout.emit("data", Buffer.from("line1\nline2\nline3\n"));

    const output = await runtime.getOutput(makeHandle(), 50);
    expect(output).toBe("line1\nline2\nline3");
  });

  it("buffers partial lines across chunks", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    // Partial line split across two chunks
    child.stdout.emit("data", Buffer.from("hel"));
    child.stdout.emit("data", Buffer.from("lo\nworld\n"));

    const output = await runtime.getOutput(makeHandle(), 50);
    expect(output).toBe("hello\nworld");
  });

  it("returns only the requested number of lines", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    child.stdout.emit("data", Buffer.from("a\nb\nc\nd\ne\n"));

    const output = await runtime.getOutput(makeHandle(), 2);
    expect(output).toBe("d\ne");
  });

  it("returns empty string for unknown session", async () => {
    const runtime = create();
    const output = await runtime.getOutput(makeHandle("nonexistent"), 50);
    expect(output).toBe("");
  });

  it("captures stderr in the output buffer too", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    child.stderr.emit("data", Buffer.from("error output\n"));

    const output = await runtime.getOutput(makeHandle(), 50);
    expect(output).toBe("error output");
  });

  it("interleaves stdout and stderr", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    child.stdout.emit("data", Buffer.from("out1\n"));
    child.stderr.emit("data", Buffer.from("err1\n"));
    child.stdout.emit("data", Buffer.from("out2\n"));

    const output = await runtime.getOutput(makeHandle(), 50);
    expect(output).toBe("out1\nerr1\nout2");
  });

  it("does not mix partial lines across stdout and stderr", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    // stdout emits a partial line, then stderr emits a full line,
    // then stdout completes its line — they should NOT be concatenated
    child.stdout.emit("data", Buffer.from("hel"));
    child.stderr.emit("data", Buffer.from("error\n"));
    child.stdout.emit("data", Buffer.from("lo\n"));

    const output = await runtime.getOutput(makeHandle(), 50);
    expect(output).toBe("error\nhello");
  });
});

// =========================================================================
// isAlive()
// =========================================================================
describe("isAlive()", () => {
  it("returns true when process is running (exitCode and signalCode null)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    expect(await runtime.isAlive(makeHandle())).toBe(true);
  });

  it("returns false when process has exited", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    child.exitCode = 1;

    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });

  it("returns false when process was signalled", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    child.signalCode = "SIGTERM";

    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });

  it("returns false for unknown session", async () => {
    const runtime = create();
    expect(await runtime.isAlive(makeHandle("nonexistent"))).toBe(false);
  });
});

// =========================================================================
// getMetrics()
// =========================================================================
describe("getMetrics()", () => {
  it("returns uptimeMs for a running session", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();

    await runtime.create(defaultConfig());

    // Small delay to ensure uptime > 0
    await new Promise((r) => setTimeout(r, 10));

    const metrics = await runtime.getMetrics!(makeHandle());
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(5000);
  });

  it("returns uptimeMs for unknown session (uses Date.now as fallback)", async () => {
    const runtime = create();
    const metrics = await runtime.getMetrics!(makeHandle("nonexistent"));
    // When entry is null, createdAt defaults to Date.now(), so uptimeMs is ~0
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(100);
  });
});

// =========================================================================
// getAttachInfo()
// =========================================================================
describe("getAttachInfo()", () => {
  it("returns PID as target when process is running", async () => {
    const child = createMockChild();
    child.pid = 54321;
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    const info = await runtime.getAttachInfo!(makeHandle());
    expect(info.type).toBe("process");
    expect(info.target).toBe("54321");
  });

  it("returns 'no longer running' command when process has exited", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    child.exitCode = 0;

    const info = await runtime.getAttachInfo!(makeHandle());
    expect(info.type).toBe("process");
    expect(info.target).toBe("");
    expect(info.command).toContain("no longer running");
  });

  it("returns 'no longer running' for unknown session", async () => {
    const runtime = create();
    const info = await runtime.getAttachInfo!(makeHandle("nonexistent"));
    expect(info.type).toBe("process");
    expect(info.target).toBe("");
    expect(info.command).toContain("no longer running");
  });

  it("returns 'no longer running' when process was killed by signal", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    child.signalCode = "SIGKILL";

    const info = await runtime.getAttachInfo!(makeHandle());
    expect(info.type).toBe("process");
    expect(info.target).toBe("");
    expect(info.command).toContain("no longer running");
  });
});

// =========================================================================
// Exit handler cleans up internal map
// =========================================================================
describe("exit handler", () => {
  it("removes session from internal map when process exits", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    // Process is alive
    expect(await runtime.isAlive(makeHandle())).toBe(true);

    // Simulate exit
    child.exitCode = 0;
    child.emit("exit", 0, null);

    // After exit, session should be gone from the map
    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });

  it("allows re-creating a session after exit cleanup", async () => {
    const child1 = createMockChild();
    mockSpawn.mockReturnValue(child1);

    const runtime = create();
    await runtime.create(defaultConfig({ sessionId: "reuse-me" }));

    // Simulate exit
    child1.exitCode = 0;
    child1.emit("exit", 0, null);

    // Re-create with same ID should work
    const child2 = createMockChild();
    mockSpawn.mockReturnValue(child2);
    const handle = await runtime.create(defaultConfig({ sessionId: "reuse-me" }));
    expect(handle.id).toBe("reuse-me");
  });
});

// =========================================================================
// Output buffer truncation
// =========================================================================
describe("output buffer truncation", () => {
  it("truncates output buffer to MAX_OUTPUT_LINES (1000)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    // Generate 1200 newline-terminated lines
    const lines = Array.from({ length: 1200 }, (_, i) => `line-${i}`).join("\n") + "\n";
    child.stdout.emit("data", Buffer.from(lines));

    // Request all lines — should be capped at 1000
    const output = await runtime.getOutput(makeHandle(), 2000);
    const outputLines = output.split("\n");
    expect(outputLines.length).toBeLessThanOrEqual(1000);
    // Should contain the last line
    expect(outputLines[outputLines.length - 1]).toBe("line-1199");
    // Should NOT contain the first lines (they were truncated)
    expect(output).not.toContain("line-0\n");
  });
});

// =========================================================================
// Per-instance isolation
// =========================================================================
describe("per-instance isolation", () => {
  it("each create() call gets its own isolated processes map", async () => {
    const child1 = createMockChild();
    child1.pid = 11111;

    const runtime1 = create();
    const runtime2 = create();

    mockSpawn.mockReturnValue(child1);
    await runtime1.create(defaultConfig({ sessionId: "session-a" }));

    const child2 = createMockChild();
    child2.pid = 99999;
    mockSpawn.mockReturnValue(child2);
    await runtime2.create(defaultConfig({ sessionId: "session-a" }));

    // Both runtimes can have the same session ID independently
    expect(await runtime1.isAlive(makeHandle("session-a"))).toBe(true);
    expect(await runtime2.isAlive(makeHandle("session-a"))).toBe(true);
  });
});
