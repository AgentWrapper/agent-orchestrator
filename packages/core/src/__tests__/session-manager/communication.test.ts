import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import {
  writeMetadata,
  readMetadataRaw,
} from "../../metadata.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
} from "../../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "../test-utils.js";
import { installMockOpencode, installMockOpencodeSequence } from "./opencode-helpers.js";

let ctx: TestContext;
let tmpDir: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;
let originalPath: string | undefined;

beforeEach(() => {
  ctx = setupTestContext();
  ({ tmpDir, sessionsDir, mockRuntime, mockAgent, mockRegistry, config, originalPath } = ctx);
});

afterEach(() => {
  teardownTestContext(ctx);
});

describe("send", () => {
  it("sends message via runtime.sendMessage and confirms delivery", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });
    vi.mocked(mockRuntime.getOutput).mockResolvedValueOnce("before").mockResolvedValueOnce("after");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "Fix the CI failures");

    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(makeHandle("rt-1"), "Fix the CI failures");
  });

  it("restores a dead session before sending the message", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "working",
      project: "my-app",
      issue: "TEST-1",
      runtimeHandle: makeHandle("rt-old"),
    });

    vi.mocked(mockRuntime.isAlive).mockImplementation(async (handle) => handle.id !== "rt-old");
    vi.mocked(mockAgent.isProcessRunning).mockImplementation(
      async (handle) => handle.id !== "rt-old",
    );
    vi.mocked(mockRuntime.create).mockResolvedValue(makeHandle("rt-restored"));
    vi.mocked(mockRuntime.getOutput)
      .mockResolvedValueOnce("restored prompt")
      .mockResolvedValueOnce("before send")
      .mockResolvedValueOnce("after send");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "Please fix the review comments");

    expect(mockRuntime.create).toHaveBeenCalled();
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-restored"),
      "Please fix the review comments",
    );
  });

  it("throws when a killed session cannot be restored to a ready state for delivery", async () => {
    vi.useFakeTimers();
    try {
      const wsPath = join(tmpDir, "ws-app-1");
      mkdirSync(wsPath, { recursive: true });

      writeMetadata(sessionsDir, "app-1", {
        worktree: wsPath,
        branch: "feat/TEST-1",
        status: "killed",
        project: "my-app",
        issue: "TEST-1",
        runtimeHandle: makeHandle("rt-old"),
      });

      vi.mocked(mockRuntime.isAlive).mockImplementation(async (handle) => handle.id !== "rt-restored");
      vi.mocked(mockAgent.isProcessRunning).mockImplementation(
        async (handle) => handle.id !== "rt-restored",
      );
      vi.mocked(mockRuntime.create).mockResolvedValue(makeHandle("rt-restored"));
      vi.mocked(mockRuntime.getOutput).mockResolvedValue("");
      vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");

      const sm = createSessionManager({ config, registry: mockRegistry });
      const sendPromise = sm.send("app-1", "hello");
      const rejection = expect(sendPromise).rejects.toThrow(
        "Cannot send to session app-1: session is not running",
      );

      await vi.runAllTimersAsync();
      await rejection;
      expect(mockRuntime.sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for spawning sessions to become interactive before considering restore", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockAgent.isProcessRunning)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    vi.mocked(mockRuntime.getOutput)
      .mockResolvedValueOnce("Bootstrapping OpenCode...")
      .mockResolvedValueOnce("OpenCode ready")
      .mockResolvedValueOnce("OpenCode ready")
      .mockResolvedValueOnce("OpenCode ready")
      .mockResolvedValueOnce("processed message");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "wait until interactive");

    expect(mockRuntime.create).not.toHaveBeenCalled();
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-1"),
      "wait until interactive",
    );
  });

  it("resolves when delivery cannot be confirmed (message already sent)", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });
    vi.mocked(mockRuntime.getOutput).mockResolvedValue("steady output");
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");

    const sm = createSessionManager({ config, registry: mockRegistry });
    // Should resolve without throwing — the message was already sent via
    // sendMessage, so unconfirmed delivery is treated as a soft success
    // to avoid duplicate dispatches on the next poll cycle.
    await expect(sm.send("app-1", "Fix the CI failures")).resolves.toBeUndefined();
    expect(mockRuntime.sendMessage).toHaveBeenCalled();
  });

  it("resolves on restored session when confirmation never flips (soft success)", async () => {
    // Regression test: on a restored session (post-#1074 fix), if
    // sendMessage fires but the confirmation heuristics never flip,
    // send() must still resolve — otherwise the lifecycle-manager's
    // dispatch-hash never updates and the message re-sends next poll,
    // reintroducing the duplicate-message bug that 77685a5 removed.
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "working",
      project: "my-app",
      issue: "TEST-1",
      runtimeHandle: makeHandle("rt-old"),
    });

    // rt-old is dead → restore kicks in → rt-restored is ready
    vi.mocked(mockRuntime.isAlive).mockImplementation(async (handle) => handle.id !== "rt-old");
    vi.mocked(mockAgent.isProcessRunning).mockImplementation(
      async (handle) => handle.id !== "rt-old",
    );
    vi.mocked(mockRuntime.create).mockResolvedValue(makeHandle("rt-restored"));
    // Steady output — confirmation heuristics will never flip
    vi.mocked(mockRuntime.getOutput).mockResolvedValue("steady output");
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.send("app-1", "retry after restore")).resolves.toBeUndefined();
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-restored"),
      "retry after restore",
    );
  });

  it("throws for nonexistent session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.send("nope", "hello")).rejects.toThrow("not found");
  });

  it("falls back to session ID as runtime handle when no runtimeHandle stored", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });
    vi.mocked(mockRuntime.getOutput).mockResolvedValueOnce("before").mockResolvedValueOnce("after");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "hello");

    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      { id: "app-1", runtimeName: "mock", data: {} },
      "hello",
    );
  });

  it("auto-discovers OpenCode mapping before sending when missing", async () => {
    const deleteLogPath = join(tmpDir, "opencode-send-remap.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        {
          id: "ses_send_discovered",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-1"),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockRuntime.getOutput).mockResolvedValueOnce("before").mockResolvedValue("after");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "hello");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_send_discovered");
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(makeHandle("rt-1"), "hello");
  });

  it("re-discovers OpenCode mapping before sending when stored mapping is invalid", async () => {
    const deleteLogPath = join(tmpDir, "opencode-send-remap-invalid.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        {
          id: "ses_send_discovered_valid",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses bad id",
      runtimeHandle: makeHandle("rt-1"),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockRuntime.getOutput).mockResolvedValueOnce("before").mockResolvedValue("after");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "hello");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_send_discovered_valid");
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(makeHandle("rt-1"), "hello");
  });

  it("confirms OpenCode delivery from session updated timestamps", async () => {
    const deleteLogPath = join(tmpDir, "opencode-send-confirmation.log");
    const listLogPath = join(tmpDir, "opencode-send-confirmation-list.log");
    const mockBin = installMockOpencodeSequence(
      tmpDir,
      [
        JSON.stringify([
          {
            id: "ses_send_confirmed",
            title: "AO:app-1",
            updated: "2026-01-01T00:00:00.000Z",
          },
        ]),
        JSON.stringify([
          {
            id: "ses_send_confirmed",
            title: "AO:app-1",
            updated: "2026-01-01T00:00:05.000Z",
          },
        ]),
      ],
      deleteLogPath,
      listLogPath,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_send_confirmed",
      runtimeHandle: makeHandle("rt-1"),
    });

    vi.mocked(mockRuntime.getOutput).mockResolvedValue("steady output");
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");

    const sm = createSessionManager({ config, registry: mockRegistry });
    const startedAt = Date.now();
    await sm.send("app-1", "confirm via updated timestamp");
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(5_000);
    expect(readFileSync(listLogPath, "utf-8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-1"),
      "confirm via updated timestamp",
    );
  });

  it("does not confirm OpenCode delivery from timestamp visibility alone", async () => {
    const deleteLogPath = join(tmpDir, "opencode-send-no-false-positive.log");
    const listLogPath = join(tmpDir, "opencode-send-no-false-positive-list.log");
    const mockBin = installMockOpencodeSequence(
      tmpDir,
      [
        "[]",
        JSON.stringify([
          {
            id: "ses_send_visibility_only",
            title: "AO:app-1",
            updated: "2026-01-01T00:00:00.000Z",
          },
        ]),
      ],
      deleteLogPath,
      listLogPath,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_send_visibility_only",
      runtimeHandle: makeHandle("rt-1"),
    });

    vi.mocked(mockRuntime.getOutput).mockResolvedValue("steady output");
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");

    const sm = createSessionManager({ config, registry: mockRegistry });
    const startedAt = Date.now();
    await sm.send("app-1", "do not confirm on visibility");
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(2_000);
    expect(readFileSync(listLogPath, "utf-8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-1"),
      "do not confirm on visibility",
    );
  }, 10000);
});

describe("remap", () => {
  it("returns persisted OpenCode session id", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-1"),
      opencodeSessionId: "ses_remap",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const mapped = await sm.remap("app-1");

    expect(mapped).toBe("ses_remap");
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_remap");
  });

  it("refreshes mapping when force remap is requested", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-force-remap.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        {
          id: "ses_fresh",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-1"),
      opencodeSessionId: "ses_stale",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const mapped = await sm.remap("app-1", true);

    expect(mapped).toBe("ses_fresh");
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_fresh");
  });

  it("uses a longer discovery timeout for explicit remap operations", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-slow-remap.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        {
          id: "ses_slow_discovery",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
      3,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const mapped = await sm.remap("app-1", true);

    expect(mapped).toBe("ses_slow_discovery");
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_slow_discovery");
  }, 20000);

  it("throws when OpenCode session id mapping is missing", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-missing-remap.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.remap("app-1")).rejects.toThrow("mapping is missing");
  });

  it("discovers mapping by AO session title and persists it", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-remap.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        {
          id: "ses_discovered",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const mapped = await sm.remap("app-1");

    expect(mapped).toBe("ses_discovered");
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_discovered");
  });

  it("falls back to title discovery when persisted mapping is invalid", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-remap-invalid.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        {
          id: "ses_discovered_valid",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-1"),
      opencodeSessionId: "ses bad id",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const mapped = await sm.remap("app-1");

    expect(mapped).toBe("ses_discovered_valid");
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_discovered_valid");
  });

  it("uses the project agent fallback when metadata does not persist the agent name", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-remap-project-agent.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        {
          id: "ses_project_agent",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    config.projects["my-app"] = {
      ...config.projects["my-app"]!,
      agent: "opencode",
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const mapped = await sm.remap("app-1");

    expect(mapped).toBe("ses_project_agent");
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_project_agent");
  });
});
