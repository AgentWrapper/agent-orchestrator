import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import { writeMetadata, readMetadataRaw, updateMetadata } from "../../metadata.js";
import { SessionNotFoundError } from "../../types.js";
import {
  setupTestContext,
  teardownTestContext,
  makeHandle,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;
let tmpDir: string;
let sessionsDir: string;
let mockRuntime: TestContext["mockRuntime"];
let mockAgent: TestContext["mockAgent"];
let mockRegistry: TestContext["mockRegistry"];
let config: TestContext["config"];

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

describe("compact", () => {
  it("rejects unknown session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.compact("app-99")).rejects.toThrow(SessionNotFoundError);
  });

  it("clears claudeSessionUuid and injects AO_SDK_INITIAL_PROMPT (no resume) before restore", async () => {
    const wsPath = join(tmpDir, "ws-app-1-compact");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      role: "orchestrator",
      runtimeHandle: makeHandle("rt-old"),
    });
    // claudeSessionUuid isn't in writeMetadata's allow-list — set it the way
    // production does (the metadata-updater hook / getSessionInfo reconciliation).
    updateMetadata(sessionsDir, "app-1", { claudeSessionUuid: "old-uuid-123" });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.compact("app-1");

    // The fresh host was created WITH the seed and WITHOUT a resume pointer.
    const env = createEnv(0);
    expect(env["AO_SDK_INITIAL_PROMPT"]).toBeTruthy();
    expect(env["AO_SDK_RESUME"]).toBeUndefined();

    // Resume pointer cleared; old uuid preserved for debugging.
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["claudeSessionUuid"]).toBeFalsy();
    expect(meta!["previousClaudeSessionUuid"]).toBe("old-uuid-123");
  });

  it("destroys the live host then restores with force", async () => {
    const wsPath = join(tmpDir, "ws-app-1-compact-live");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "working",
      project: "my-app",
      role: "orchestrator",
      claudeSessionUuid: "live-uuid",
      runtimeHandle: makeHandle("rt-live"),
    });

    // Track host liveness: alive until destroy() is called.
    let hostAlive = true;
    vi.mocked(mockRuntime.destroy).mockImplementation(async () => {
      hostAlive = false;
    });
    vi.mocked(mockRuntime.isAlive).mockImplementation(async () => hostAlive);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.compact("app-1");

    // Live host destroyed first, then a fresh host created by restore().
    expect(mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-live"));
    expect(mockRuntime.create).toHaveBeenCalled();
    expect(createEnv(0)["AO_SDK_INITIAL_PROMPT"]).toBeTruthy();
  });

  it("default seed contains the project's in-flight (non-terminal) sessions, excluding self", async () => {
    // The session being compacted.
    writeMetadata(sessionsDir, "app-1", {
      worktree: join(tmpDir, "ws-app-1-seed"),
      branch: "feat/orch",
      status: "working",
      project: "my-app",
      role: "orchestrator",
      runtimeHandle: makeHandle("rt-1"),
    });
    mkdirSync(join(tmpDir, "ws-app-1-seed"), { recursive: true });

    // A NON-terminal worker — should appear in the seed.
    writeMetadata(sessionsDir, "app-2", {
      worktree: join(tmpDir, "ws-app-2-seed"),
      branch: "feat/inflight",
      status: "working",
      project: "my-app",
      title: "shipping the thing",
      runtimeHandle: makeHandle("rt-2"),
    });
    mkdirSync(join(tmpDir, "ws-app-2-seed"), { recursive: true });

    // A TERMINAL worker — should NOT appear in the seed.
    writeMetadata(sessionsDir, "app-3", {
      worktree: join(tmpDir, "ws-app-3-seed"),
      branch: "feat/done",
      status: "killed",
      project: "my-app",
      title: "already finished",
      runtimeHandle: makeHandle("rt-3"),
    });
    mkdirSync(join(tmpDir, "ws-app-3-seed"), { recursive: true });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.compact("app-1");

    const seed = createEnv(0)["AO_SDK_INITIAL_PROMPT"];
    expect(seed).toContain("In-flight right now in this project:");
    // In-flight worker present (id + its title label).
    expect(seed).toContain("app-2");
    expect(seed).toContain("shipping the thing");
    // Terminal worker absent; self absent from the bulleted list line.
    expect(seed).not.toContain("app-3");
    expect(seed).not.toContain("already finished");
    expect(seed).not.toMatch(/-\s+app-1\s+—/);
    // Durable-state instructions present.
    expect(seed).toContain(".maestro/tasks.md");
  });

  it("uses seedOverride verbatim when provided", async () => {
    const wsPath = join(tmpDir, "ws-app-1-override");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      role: "orchestrator",
      claudeSessionUuid: "old-uuid",
      runtimeHandle: makeHandle("rt-old"),
    });

    const customSeed = "CUSTOM SEED — resume exactly from here, nothing else.";
    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.compact("app-1", customSeed);

    const env = createEnv(0);
    expect(env["AO_SDK_INITIAL_PROMPT"]).toBe(customSeed);
    // The default scaffolding must NOT be present when overridden.
    expect(env["AO_SDK_INITIAL_PROMPT"]).not.toContain("In-flight right now");
  });

  it("is provider-agnostic: a GLM session (no claudeSessionUuid) compacts + seeds without throwing", async () => {
    const wsPath = join(tmpDir, "ws-app-1-glm");
    mkdirSync(wsPath, { recursive: true });
    // A GLM session: model starts with 'glm-', stateless between restarts,
    // NEVER has a claudeSessionUuid. compact must not assume a Claude resume
    // pointer — clearing it is a conditional no-op.
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      role: "orchestrator",
      runtimeHandle: makeHandle("rt-old"),
    });
    updateMetadata(sessionsDir, "app-1", { sessionModel: "glm-4.6" });

    const sm = createSessionManager({ config, registry: mockRegistry });
    // Must not throw despite the absent claudeSessionUuid.
    await expect(sm.compact("app-1")).resolves.toBeDefined();

    // Seeded via AO_SDK_INITIAL_PROMPT (works for the GLM host path too), and
    // still no resume pointer was conjured.
    const env = createEnv(0);
    expect(env["AO_SDK_INITIAL_PROMPT"]).toBeTruthy();
    expect(env["AO_SDK_RESUME"]).toBeUndefined();

    // No claudeSessionUuid existed → nothing to clear, no previous-uuid recorded.
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["claudeSessionUuid"]).toBeFalsy();
    expect(meta!["previousClaudeSessionUuid"]).toBeFalsy();
    // The model override is untouched by compaction.
    expect(meta!["sessionModel"]).toBe("glm-4.6");
  });

  it("one-shot: the seed is consumed so a follow-up restore does NOT re-inject it", async () => {
    const wsPath = join(tmpDir, "ws-app-1-oneshot");
    mkdirSync(wsPath, { recursive: true });
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      role: "orchestrator",
      claudeSessionUuid: "old-uuid",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.compact("app-1");

    // First (compact) restore injected the seed.
    expect(createEnv(0)["AO_SDK_INITIAL_PROMPT"]).toBeTruthy();

    // The transient marker was consumed (cleared) in restore's metadata commit.
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["compactSeed"]).toBeFalsy();

    // A subsequent restore must NOT re-inject the seed.
    vi.mocked(mockRuntime.create).mockClear();
    await sm.restore("app-1", true);
    expect(createEnv(0)["AO_SDK_INITIAL_PROMPT"]).toBeUndefined();
  });
});
