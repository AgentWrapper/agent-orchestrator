import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import {
  writeMetadata,
  readMetadataRaw,
  updateMetadata,
} from "../../metadata.js";
import {
  SessionNotFoundError,
} from "../../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "../test-utils.js";

let ctx: TestContext;
let tmpDir: string;
let sessionsDir: string;
// TypeScript helper to get the value type of a TestContext field. `ctx` is a
// TestContext OBJECT (not a function), so `ReturnType<typeof ctx>` is invalid —
// index into TestContext directly instead.
type ContextValue<K extends keyof TestContext> = TestContext[K];
let mockRuntime: ContextValue<"mockRuntime">;
let mockAgent: ContextValue<"mockAgent">;
let mockRegistry: ContextValue<"mockRegistry">;
let config: ContextValue<"config">;

beforeEach(() => {
  ctx = setupTestContext();
  tmpDir = ctx.tmpDir;
  sessionsDir = ctx.sessionsDir;
  mockRuntime = ctx.mockRuntime;
  mockAgent = ctx.mockAgent;
  mockRegistry = ctx.mockRegistry;
  config = ctx.config;
});

afterEach(() => {
  teardownTestContext(ctx);
});

/** Pull the `environment` object the runtime was created with on the Nth call. */
function createEnv(nth = 0): Record<string, string> {
  const call = vi.mocked(mockRuntime.create).mock.calls[nth];
  return (call?.[0] as { environment: Record<string, string> }).environment;
}

describe("setModel", () => {
  it("rejects empty model string", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.setModel("app-1", "")).rejects.toThrow("model must not be empty");
    await expect(sm.setModel("app-1", "   ")).rejects.toThrow("model must not be empty");
  });

  it("rejects unknown session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.setModel("app-99", "claude-sonnet-4-5")).rejects.toThrow(
      SessionNotFoundError,
    );
  });

  it("persists sessionModel to metadata", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-persist");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.setModel("app-1", "claude-haiku-4-5");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["sessionModel"]).toBe("claude-haiku-4-5");
  });

  it("uses sessionModel when restoring after setModel on a terminal session", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-restore");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.setModel("app-1", "claude-haiku-4-5");

    // getLaunchCommand was called with the new model as part of restore()
    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
  });

  it("clears incompatible SDK resume metadata when switching from Claude to GPT", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-cross-driver");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });
    updateMetadata(sessionsDir, "app-1", {
      sessionModel: "sonnet",
      claudeSessionUuid: "claude-prev",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.setModel("app-1", "gpt-5.5");

    expect(createEnv(0)["AO_SDK_RESUME"]).toBeUndefined();

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["sessionModel"]).toBe("gpt-5.5");
    expect(meta!["claudeSessionUuid"]).toBeFalsy();
    expect(meta!["previousClaudeSessionUuid"]).toBe("claude-prev");
  });

  it("restores GPT sessions from codexThreadId instead of a stale Claude UUID", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-gpt-resume");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });
    updateMetadata(sessionsDir, "app-1", {
      sessionModel: "gpt-5.5",
      claudeSessionUuid: "claude-stale",
      codexThreadId: "codex-thread-1",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.restore("app-1", true);

    expect(createEnv(0)["AO_SDK_RESUME"]).toBe("codex-thread-1");
  });

  it("does not re-persist stale Claude metadata on a GPT/Codex session", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-gpt-metadata");
    mkdirSync(wsPath, { recursive: true });
    const sessionInfoPath = join(tmpDir, "codex-session.json");
    writeFileSync(
      sessionInfoPath,
      JSON.stringify({ sdkSessionId: "codex-thread-2", model: "gpt-5.5" }),
      "utf-8",
    );
    vi.mocked(mockRuntime.create).mockResolvedValue({
      id: "rt-new",
      runtimeName: "mock",
      data: { sessionInfoPath },
    });
    vi.mocked(mockAgent.getSessionInfo).mockResolvedValue({
      summary: null,
      agentSessionId: "claude-stale",
      metadata: { claudeSessionUuid: "claude-stale" },
    });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });
    updateMetadata(sessionsDir, "app-1", {
      sessionModel: "sonnet",
      claudeSessionUuid: "claude-prev",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.setModel("app-1", "gpt-5.5");
    await sm.get("app-1");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["sessionModel"]).toBe("gpt-5.5");
    expect(meta!["codexThreadId"]).toBe("codex-thread-2");
    expect(meta!["claudeSessionUuid"]).toBeFalsy();
    expect(meta!["previousClaudeSessionUuid"]).toBe("claude-prev");
  });

  it("trusts runtime-sdk session info when persisted sessionModel is stale Claude", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-gpt-runtime-wins");
    mkdirSync(wsPath, { recursive: true });
    const sessionInfoPath = join(tmpDir, "codex-runtime-wins-session.json");
    writeFileSync(
      sessionInfoPath,
      JSON.stringify({ sdkSessionId: "codex-thread-runtime", model: "gpt-5.5" }),
      "utf-8",
    );
    vi.mocked(mockAgent.getSessionInfo).mockResolvedValue({
      summary: null,
      agentSessionId: "claude-stale",
      metadata: {
        sessionModel: "opus",
        claudeSessionUuid: "claude-stale",
      },
    });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "working",
      project: "my-app",
      runtimeHandle: {
        ...makeHandle("rt-live"),
        data: {
          ...makeHandle("rt-live").data,
          sessionInfoPath,
        },
      },
    });
    updateMetadata(sessionsDir, "app-1", {
      sessionModel: "opus",
      claudeSessionUuid: "claude-stale",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.get("app-1");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["sessionModel"]).toBe("gpt-5.5");
    expect(meta!["codexThreadId"]).toBe("codex-thread-runtime");
    expect(meta!["claudeSessionUuid"]).toBeFalsy();
  });

  it("preserves SDK resume metadata when switching within the same runtime driver", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-same-driver");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });
    updateMetadata(sessionsDir, "app-1", {
      sessionModel: "sonnet",
      claudeSessionUuid: "claude-prev",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.setModel("app-1", "opus");

    expect(createEnv(0)["AO_SDK_RESUME"]).toBe("claude-prev");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["sessionModel"]).toBe("opus");
    expect(meta!["claudeSessionUuid"]).toBe("claude-prev");
    expect(meta!["previousClaudeSessionUuid"]).toBeFalsy();
  });

  it("destroys live host before restoring on a working session", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-live");
    mkdirSync(wsPath, { recursive: true });

    // Write a "working" session (live runtime)
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-live"),
    });

    // Make the mock track host liveness: alive until destroy() is called
    let hostAlive = true;
    vi.mocked(mockRuntime.destroy).mockImplementation(async () => {
      hostAlive = false;
    });
    vi.mocked(mockRuntime.isAlive).mockImplementation(async () => hostAlive);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.setModel("app-1", "claude-sonnet-4-5");

    // Verify the live host was destroyed first
    expect(mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-live"));

    // Verify a new host was created (restore ran)
    expect(mockRuntime.create).toHaveBeenCalled();

    // Verify the new model was forwarded to the agent
    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-5" }),
    );

    // Verify sessionModel persists in metadata
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["sessionModel"]).toBe("claude-sonnet-4-5");
  });

  it("sessionModel survives engine restart (a subsequent restore also uses it)", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-survives");
    mkdirSync(wsPath, { recursive: true });

    // Simulate: setModel was called earlier, metadata already has sessionModel
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });
    updateMetadata(sessionsDir, "app-1", { sessionModel: "claude-haiku-4-5" });

    const sm = createSessionManager({ config, registry: mockRegistry });
    // A plain restore() should also pick up the persisted sessionModel
    await sm.restore("app-1");

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
  });

  it("sessionModel overrides project-level agentConfig.model", async () => {
    const wsPath = join(tmpDir, "ws-app-1-sm-override");
    mkdirSync(wsPath, { recursive: true });

    const configWithModel = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agentConfig: { model: "project-level-model" },
        },
      },
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config: configWithModel, registry: mockRegistry });
    await sm.setModel("app-1", "session-override-model");

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "session-override-model" }),
    );
  });
});
