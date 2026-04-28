import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { RuntimeHandle } from "@aoagents/ao-core";

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => "test-uuid-1234",
  };
});

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
}));

const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;
const expectedZellijOptions = { timeout: 5_000 };

function mockZellijSuccess(stdout = "") {
  mockExecFileCustom.mockResolvedValueOnce({ stdout, stderr: "" });
}

function mockZellijError(message: string) {
  mockExecFileCustom.mockRejectedValueOnce(new Error(message));
}

function makeHandle(
  id = "test-session",
  paneId = "terminal_1",
  createdAt = 1000,
  zellijSessionName?: string,
): RuntimeHandle {
  return {
    id,
    runtimeName: "zellij",
    data: {
      paneId,
      createdAt,
      workspacePath: "/tmp/workspace",
      ...(zellijSessionName ? { zellijSessionName } : {}),
    },
  };
}

import zellijPlugin, { manifest, create } from "../index.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileCustom.mockReset();
});

describe("manifest", () => {
  it("has name 'zellij' and slot 'runtime'", () => {
    expect(manifest.name).toBe("zellij");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Runtime plugin: Zellij sessions");
  });

  it("default export includes manifest and create", () => {
    expect(zellijPlugin.manifest).toBe(manifest);
    expect(zellijPlugin.create).toBe(create);
  });
});

describe("create()", () => {
  it("returns a Runtime with name 'zellij'", () => {
    const runtime = create();
    expect(runtime.name).toBe("zellij");
  });
});

describe("runtime.create()", () => {
  it("creates a background Zellij session and starts a command pane", async () => {
    const runtime = create();

    mockZellijSuccess("");
    mockZellijSuccess("");
    mockZellijSuccess("terminal_7\n");

    const handle = await runtime.create({
      sessionId: "test-session",
      workspacePath: "/tmp/workspace",
      launchCommand: "echo hello",
      environment: { FOO: "bar" },
    });

    expect(handle).toEqual({
      id: "test-session",
      runtimeName: "zellij",
      data: expect.objectContaining({
        paneId: "terminal_7",
        workspacePath: "/tmp/workspace",
      }),
    });

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      1,
      "zellij",
      ["list-sessions", "--short", "--no-formatting"],
      expectedZellijOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "zellij",
      ["attach", "--create-background", "test-session"],
      expectedZellijOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "zellij",
      [
        "--session",
        "test-session",
        "run",
        "--name",
        "test-session",
        "--cwd",
        "/tmp/workspace",
        "--",
        "bash",
        expect.stringContaining("ao-zellij-launch-test-uuid-1234.sh"),
      ],
      expectedZellijOptions,
    );
  });

  it("writes environment exports and launch command to a temp script", async () => {
    const runtime = create();

    mockZellijSuccess("");
    mockZellijSuccess("");
    mockZellijSuccess("terminal_1\n");

    await runtime.create({
      sessionId: "env-session",
      workspacePath: "/tmp/ws",
      launchCommand: "codex exec test",
      environment: { FOO: "bar baz", QUOTED: "it's ok" },
    });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("ao-zellij-launch-test-uuid-1234.sh"),
      expect.stringContaining("export FOO='bar baz'"),
      { encoding: "utf-8", mode: 0o700 },
    );
    const script = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(script).toContain("export QUOTED='it'\\''s ok'");
    expect(script).toContain("codex exec test");
  });

  it("uses a short deterministic Zellij session name for long AO session IDs", async () => {
    const runtime = create();
    const sessionId = "ao-inttest-zellij-1234567890";

    mockZellijSuccess("");
    mockZellijSuccess("");
    mockZellijSuccess("terminal_1\n");

    const handle = await runtime.create({
      sessionId,
      workspacePath: "/tmp/ws",
      launchCommand: "echo hi",
      environment: {},
    });

    const zellijSessionName = handle.data.zellijSessionName as string;
    expect(handle.id).toBe(sessionId);
    expect(zellijSessionName).toMatch(/^ao-ao-intte-[a-f0-9]{12}$/);
    expect(zellijSessionName.length).toBeLessThanOrEqual(25);
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "zellij",
      ["attach", "--create-background", zellijSessionName],
      expectedZellijOptions,
    );
  });

  it("rejects invalid session IDs", async () => {
    const runtime = create();

    await expect(
      runtime.create({
        sessionId: "bad session",
        workspacePath: "/tmp/ws",
        launchCommand: "echo hi",
        environment: {},
      }),
    ).rejects.toThrow(/Invalid session ID/);
  });

  it("rejects invalid environment names", async () => {
    const runtime = create();

    mockZellijSuccess("");
    mockZellijSuccess("");
    mockZellijSuccess("");

    await expect(
      runtime.create({
        sessionId: "bad-env",
        workspacePath: "/tmp/ws",
        launchCommand: "echo hi",
        environment: { "BAD-NAME": "value" },
      }),
    ).rejects.toThrow(/Invalid environment variable name/);

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "zellij",
      ["kill-session", "bad-env"],
      expectedZellijOptions,
    );
  });

  it("rejects duplicate session IDs", async () => {
    const runtime = create();

    mockZellijSuccess("dup-session\n");

    await expect(
      runtime.create({
        sessionId: "dup-session",
        workspacePath: "/tmp/ws",
        launchCommand: "echo hi",
        environment: {},
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("cleans up the session if pane launch fails", async () => {
    const runtime = create();

    mockZellijSuccess("");
    mockZellijSuccess("");
    mockZellijError("run failed");
    mockZellijSuccess("");

    await expect(
      runtime.create({
        sessionId: "fail-session",
        workspacePath: "/tmp/ws",
        launchCommand: "bad-command",
        environment: {},
      }),
    ).rejects.toThrow('Failed to start Zellij pane for session "fail-session"');

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "zellij",
      ["kill-session", "fail-session"],
      expectedZellijOptions,
    );
  });

  it("throws when pane id cannot be parsed", async () => {
    const runtime = create();

    mockZellijSuccess("");
    mockZellijSuccess("");
    mockZellijSuccess("unexpected\n");
    mockZellijSuccess("");

    await expect(
      runtime.create({
        sessionId: "parse-fail",
        workspacePath: "/tmp/ws",
        launchCommand: "echo hi",
        environment: {},
      }),
    ).rejects.toThrow(/Could not parse Zellij pane id/);
  });
});

describe("runtime.destroy()", () => {
  it("kills the Zellij session", async () => {
    const runtime = create();
    mockZellijSuccess("");

    await runtime.destroy(makeHandle("dead-session"));

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "zellij",
      ["kill-session", "dead-session"],
      expectedZellijOptions,
    );
  });

  it("uses stored Zellij session name when present", async () => {
    const runtime = create();
    mockZellijSuccess("");

    await runtime.destroy(makeHandle("long-ao-session-id", "terminal_1", 1000, "ao-short-name"));

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "zellij",
      ["kill-session", "ao-short-name"],
      expectedZellijOptions,
    );
  });

  it("is idempotent", async () => {
    const runtime = create();
    mockZellijError("not found");

    await expect(runtime.destroy(makeHandle("missing"))).resolves.toBeUndefined();
  });
});

describe("runtime.sendMessage()", () => {
  it("clears input, pastes the message, and sends Enter", async () => {
    const runtime = create();
    mockZellijSuccess("");
    mockZellijSuccess("");
    mockZellijSuccess("");

    await runtime.sendMessage(makeHandle("msg-session", "terminal_4"), "hello world");

    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      1,
      "zellij",
      ["--session", "msg-session", "action", "send-keys", "--pane-id", "terminal_4", "Ctrl u"],
      expectedZellijOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      2,
      "zellij",
      [
        "--session",
        "msg-session",
        "action",
        "paste",
        "--pane-id",
        "terminal_4",
        "--",
        "hello world",
      ],
      expectedZellijOptions,
    );
    expect(mockExecFileCustom).toHaveBeenNthCalledWith(
      3,
      "zellij",
      ["--session", "msg-session", "action", "send-keys", "--pane-id", "terminal_4", "Enter"],
      expectedZellijOptions,
    );
  });

  it("throws when handle is missing a pane id", async () => {
    const runtime = create();
    await expect(runtime.sendMessage(makeHandle("msg-session", ""), "hello")).rejects.toThrow(
      /Missing Zellij pane id/,
    );
  });
});

describe("runtime.getOutput()", () => {
  it("dumps scrollback for the pane and returns the requested line count", async () => {
    const runtime = create();
    mockZellijSuccess("line1\nline2\nline3\n");

    const output = await runtime.getOutput(makeHandle("out-session", "terminal_2"), 2);

    expect(output).toBe("line2\nline3");
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "zellij",
      ["--session", "out-session", "action", "dump-screen", "--pane-id", "terminal_2", "--full"],
      expectedZellijOptions,
    );
  });

  it("returns empty output on dump failure", async () => {
    const runtime = create();
    mockZellijError("dump failed");

    await expect(runtime.getOutput(makeHandle("out-session"))).resolves.toBe("");
  });
});

describe("runtime.isAlive()", () => {
  it("returns true when the session is listed", async () => {
    const runtime = create();
    mockZellijSuccess("other\nalive-session\n");

    expect(await runtime.isAlive(makeHandle("alive-session"))).toBe(true);
  });

  it("returns false when the session is not listed", async () => {
    const runtime = create();
    mockZellijSuccess("other\n");

    expect(await runtime.isAlive(makeHandle("missing-session"))).toBe(false);
  });
});

describe("runtime.getMetrics()", () => {
  it("returns uptime", async () => {
    const runtime = create();
    const metrics = await runtime.getMetrics!(
      makeHandle("metrics-session", "terminal_1", Date.now() - 10),
    );

    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runtime.getAttachInfo()", () => {
  it("returns a Zellij attach command", async () => {
    const runtime = create();
    const info = await runtime.getAttachInfo!(makeHandle("attach-session"));

    expect(info).toEqual({
      type: "zellij",
      target: "attach-session",
      command: "zellij attach attach-session",
    });
  });
});
