import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync } from "node:fs";
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
let mockRuntime: ReturnType<typeof ctx>["mockRuntime"];
let mockAgent: ReturnType<typeof ctx>["mockAgent"];
let mockRegistry: ReturnType<typeof ctx>["mockRegistry"];
let config: ReturnType<typeof ctx>["config"];

// TypeScript helper to get value type of TestContext
type ContextValue<K extends keyof TestContext> = TestContext[K];

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
