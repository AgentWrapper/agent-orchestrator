import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import { getWorkspaceAgentsMdPath } from "../../opencode-agents-md.js";
import { getProjectDir } from "../../paths.js";
import {
  writeMetadata,
  readMetadataRaw,
  updateMetadata,
} from "../../metadata.js";
import {
  SessionNotRestorableError,
  WorkspaceMissingError,
  type OrchestratorConfig,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type Workspace,
} from "../../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "../test-utils.js";
import { installMockOpencode } from "./opencode-helpers.js";

let ctx: TestContext;
let tmpDir: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;
let originalPath: string | undefined;

beforeEach(() => {
  ctx = setupTestContext();
  ({ tmpDir, sessionsDir, mockRuntime, mockAgent, mockWorkspace, mockRegistry, config, originalPath } = ctx);
});

afterEach(() => {
  teardownTestContext(ctx);
});

describe("restore", () => {
  it("restores a killed session with existing workspace", async () => {
    // Create a workspace directory that exists
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      issue: "TEST-1",
      pr: "https://github.com/org/my-app/pull/10",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.id).toBe("app-1");
    expect(restored.status).toBe("pr_open");
    expect(restored.activity).toBe("active");
    expect(restored.workspacePath).toBe(wsPath);
    expect(restored.branch).toBe("feat/TEST-1");
    expect(restored.runtimeHandle).toEqual(makeHandle("rt-1"));
    expect(restored.restoredAt).toBeInstanceOf(Date);

    // Verify old runtime was destroyed before creating new one
    expect(mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-old"));
    expect(mockRuntime.create).toHaveBeenCalled();
    // Verify metadata was updated (not rewritten)
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("pr_open");
    expect(meta!["restoredAt"]).toBeDefined();
    // Verify original fields are preserved
    expect(meta!["issue"]).toBe("TEST-1");
    expect(meta!["pr"]).toBe("https://github.com/org/my-app/pull/10");
    expect(meta!["createdAt"]).toBe("2025-01-01T00:00:00.000Z");
  });

  it("forwards AO_AGENT_GH_TRACE into restored agent runtime env when configured", async () => {
    const wsPath = join(tmpDir, "ws-app-1-trace");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const previousTrace = process.env["AO_AGENT_GH_TRACE"];
    process.env["AO_AGENT_GH_TRACE"] = "/tmp/restored-agent-gh-trace-test.jsonl";

    try {
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.restore("app-1");

      expect(mockRuntime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: expect.objectContaining({
            AO_AGENT_GH_TRACE: "/tmp/restored-agent-gh-trace-test.jsonl",
            AO_CALLER_TYPE: "agent",
          }),
        }),
      );
    } finally {
      if (previousTrace === undefined) delete process.env["AO_AGENT_GH_TRACE"];
      else process.env["AO_AGENT_GH_TRACE"] = previousTrace;
    }
  });

  it("continues restore even if old runtime destroy fails", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    // Make destroy throw — should not block restore
    const failingRuntime = {
      ...mockRuntime,
      destroy: vi.fn().mockRejectedValue(new Error("session not found")),
      create: vi.fn().mockResolvedValue(makeHandle("rt-new")),
    };

    const registryWithFailingDestroy: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return failingRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: registryWithFailingDestroy });
    const restored = await sm.restore("app-1");

    expect(restored.status).toBe("working");
    expect(failingRuntime.destroy).toHaveBeenCalled();
    expect(failingRuntime.create).toHaveBeenCalled();
  });

  it("recreates workspace when missing and plugin supports restore", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    // DO NOT create the directory — it's missing

    const mockWorkspaceWithRestore: Workspace = {
      ...mockWorkspace,
      exists: vi.fn().mockResolvedValue(false),
      restore: vi.fn().mockResolvedValue({
        path: wsPath,
        branch: "feat/TEST-1",
        sessionId: "app-1",
        projectId: "my-app",
      }),
    };

    const registryWithRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspaceWithRestore;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "terminated",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: registryWithRestore });
    const restored = await sm.restore("app-1");

    expect(restored.id).toBe("app-1");
    expect(mockWorkspaceWithRestore.restore).toHaveBeenCalled();
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("allows restoring merged sessions", async () => {
    const ws = "/tmp/mock-ws/app-1";
    writeMetadata(sessionsDir, "app-1", {
      worktree: ws,
      branch: "main",
      status: "merged",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return {
          ...mockWorkspace,
          exists: vi.fn().mockResolvedValue(true),
          restore: vi.fn().mockResolvedValue({ path: ws, branch: "main", sessionId: "app-1", projectId: "my-app" }),
        };
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry });
    const restored = await sm.restore("app-1");
    expect(restored.id).toBe("app-1");
  });

  it("throws SessionNotRestorableError for working sessions", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);
  });

  it("throws WorkspaceMissingError when workspace gone and no restore method", async () => {
    const wsPath = join(tmpDir, "nonexistent-ws");

    const mockWorkspaceNoRestore: Workspace = {
      ...mockWorkspace,
      exists: vi.fn().mockResolvedValue(false),
      // No restore method
    };

    const registryNoRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspaceNoRestore;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: registryNoRestore });
    await expect(sm.restore("app-1")).rejects.toThrow(WorkspaceMissingError);
  });

  it("restores a terminated session with existing metadata", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      issue: "TEST-1",
      pr: "https://github.com/org/my-app/pull/10",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeHandle: makeHandle("rt-old"),
    });
    updateMetadata(sessionsDir, "app-1", {
      lifecycle: JSON.stringify({ session: { state: "terminated", terminatedAt: new Date().toISOString() } }),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.id).toBe("app-1");
    expect(restored.status).toBe("pr_open");
    expect(restored.branch).toBe("feat/TEST-1");
    expect(restored.workspacePath).toBe(wsPath);

    // Verify metadata is preserved
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!["issue"]).toBe("TEST-1");
    expect(meta!["pr"]).toBe("https://github.com/org/my-app/pull/10");
  });

  it("preserves displayName when restoring terminated session", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      issue: "TEST-1",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeHandle: makeHandle("rt-old"),
      displayName: "Refactor session manager to use flat metadata files",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.restore("app-1");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!["displayName"]).toBe(
      "Refactor session manager to use flat metadata files",
    );
  });

  it("throws for nonexistent session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("nonexistent")).rejects.toThrow("not found");
  });

  it("throws SessionNotRestorableError when OpenCode mapping is missing", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });
    const deleteLogPath = join(tmpDir, "opencode-restore-validation.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);
  });

  it("throws SessionNotRestorableError for non-restorable terminated session", async () => {
    const wsPath = join(tmpDir, "ws-app-archive-non-restorable");
    mkdirSync(wsPath, { recursive: true });

    // A "working" session that isn't actually running is not restorable
    // because restore only works on terminal statuses
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_archive_valid",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);
  });

  it("re-discovers OpenCode mapping when stored mapping is invalid", async () => {
    const wsPath = join(tmpDir, "ws-app-restore-invalid-map");
    mkdirSync(wsPath, { recursive: true });
    const deleteLogPath = join(tmpDir, "opencode-restore-invalid-remap.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        {
          id: "ses_restore_discovered",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses bad id",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.status).toBe("working");
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_restore_discovered");
  }, 15000);

  it("uses orchestratorModel when restoring orchestrator sessions", async () => {
    const wsPath = join(tmpDir, "ws-app-orchestrator-restore");
    mkdirSync(wsPath, { recursive: true });

    const configWithOrchestratorModel: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agentConfig: {
            model: "worker-model",
            orchestratorModel: "orchestrator-model",
          },
        },
      },
    };

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: wsPath,
      branch: "main",
      status: "killed",
      project: "my-app",
      role: "orchestrator",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({
      config: configWithOrchestratorModel,
      registry: mockRegistry,
    });
    await sm.restore("app-orchestrator");

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "orchestrator-model" }),
    );
  });

  it("forwards configured subagent when restoring sessions", async () => {
    const wsPath = join(tmpDir, "ws-app-restore-subagent");
    mkdirSync(wsPath, { recursive: true });

    const configWithSubagent: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agentConfig: {
            subagent: "oracle",
          },
        },
      },
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-SUBAGENT",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config: configWithSubagent, registry: mockRegistry });
    await sm.restore("app-1");

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: "oracle" }),
    );
  });

  it("uses getRestoreCommand when available", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    const mockAgentWithRestore: Agent = {
      ...mockAgent,
      getRestoreCommand: vi.fn().mockResolvedValue("claude --resume abc123"),
    };

    const registryWithAgentRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgentWithRestore;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "errored",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: registryWithAgentRestore });
    await sm.restore("app-1");

    expect(mockAgentWithRestore.getRestoreCommand).toHaveBeenCalled();
    // Verify runtime.create was called with the restore command
    const createCall = (mockRuntime.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.launchCommand).toBe("claude --resume abc123");
  });

  it("falls back to getLaunchCommand when getRestoreCommand returns null", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    const mockAgentWithNullRestore: Agent = {
      ...mockAgent,
      getRestoreCommand: vi.fn().mockResolvedValue(null),
    };

    const registryWithNullRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgentWithNullRestore;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: registryWithNullRestore });
    await sm.restore("app-1");

    expect(mockAgentWithNullRestore.getRestoreCommand).toHaveBeenCalled();
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
    const createCall = (mockRuntime.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.launchCommand).toBe("mock-agent --start");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["restoreFallbackReason"]).toBe("mock-agent.getRestoreCommand returned null");
  });

  it("does not launch a fresh chat when a native-restore agent cannot build restore command", async () => {
    const wsPath = join(tmpDir, "ws-app-native-restore-missing");
    mkdirSync(wsPath, { recursive: true });

    const mockNativeRestoreAgent: Agent = {
      ...mockAgent,
      name: "codex",
      getRestoreCommand: vi.fn().mockResolvedValue(null),
    };

    const registryWithNativeRestoreAgent: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockNativeRestoreAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: registryWithNativeRestoreAgent });

    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);
    expect(mockRuntime.create).not.toHaveBeenCalled();
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["restoreFallbackReason"]).toBe("codex.getRestoreCommand returned null");
  });

  it("clears restore fallback reason when getRestoreCommand succeeds", async () => {
    const wsPath = join(tmpDir, "ws-app-restore-clears-fallback");
    mkdirSync(wsPath, { recursive: true });

    const mockAgentWithRestore: Agent = {
      ...mockAgent,
      getRestoreCommand: vi.fn().mockResolvedValue("claude --resume abc123"),
    };

    const registryWithAgentRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgentWithRestore;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
      restoreFallbackReason: "previous fallback",
    });

    const sm = createSessionManager({ config, registry: registryWithAgentRestore });
    await sm.restore("app-1");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["restoreFallbackReason"]).toBeUndefined();
  });

  it("normalizes agent metadata empty strings in memory like metadata persistence", async () => {
    const wsPath = join(tmpDir, "ws-app-agent-metadata-normalize");
    mkdirSync(wsPath, { recursive: true });

    const mockAgentWithMetadata: Agent = {
      ...mockAgent,
      getSessionInfo: vi.fn().mockResolvedValue({
        summary: null,
        agentSessionId: "native-1",
        metadata: {
          codexThreadId: "thread-1",
          restoreFallbackReason: "",
        },
      }),
    };

    const registryWithAgentMetadata: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgentWithMetadata;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
      restoreFallbackReason: "previous fallback",
    });

    const sm = createSessionManager({ config, registry: registryWithAgentMetadata });
    const restored = await sm.restore("app-1");

    expect(restored.metadata["codexThreadId"]).toBe("thread-1");
    expect(restored.metadata["restoreFallbackReason"]).toBeUndefined();
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["codexThreadId"]).toBe("thread-1");
    expect(meta!["restoreFallbackReason"]).toBeUndefined();
  });

  it("clears restore fallback reason when agent has no restore command", async () => {
    const wsPath = join(tmpDir, "ws-app-no-restore-clears-fallback");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
      restoreFallbackReason: "previous fallback",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.restore("app-1");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["restoreFallbackReason"]).toBeUndefined();
  });

  it("does not inject OPENCODE_CONFIG when restoring OpenCode orchestrators", async () => {
    const wsPath = join(tmpDir, "ws-app-orchestrator-opencode-restore");
    mkdirSync(wsPath, { recursive: true });
    writeFileSync(getWorkspaceAgentsMdPath(wsPath), "## Agent Orchestrator\n", "utf-8");

    const mockOpenCodeAgentWithRestore: Agent = {
      ...mockAgent,
      name: "opencode",
      getRestoreCommand: vi.fn().mockResolvedValue("opencode --session 'ses_restore'"),
    };

    const registryWithOpenCodeRestore: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockOpenCodeAgentWithRestore;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: wsPath,
      branch: "main",
      status: "killed",
      project: "my-app",
      role: "orchestrator",
      agent: "opencode",
      opencodeSessionId: "ses_restore",
      runtimeHandle: makeHandle("rt-old"),
    });

    const configWithOpenCode: OrchestratorConfig = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "opencode",
        },
      },
    };

    const sm = createSessionManager({
      config: configWithOpenCode,
      registry: registryWithOpenCodeRestore,
    });
    await sm.restore("app-orchestrator");

    expect(mockRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.not.objectContaining({
          OPENCODE_CONFIG: expect.any(String),
        }),
      }),
    );
  });

  it("re-materializes AGENTS.md for restored OpenCode orchestrators", async () => {
    const wsPath = join(tmpDir, "ws-app-orchestrator-opencode-agentsmd");
    mkdirSync(wsPath, { recursive: true });

    const projectDir = getProjectDir("my-app");
    mkdirSync(projectDir, { recursive: true });
    const promptFile = join(projectDir, "orchestrator-prompt-app-orchestrator.md");
    const promptContent = "You are the AO orchestrator. Delegate tasks.";
    writeFileSync(promptFile, promptContent, "utf-8");

    const agentsMdPath = getWorkspaceAgentsMdPath(wsPath);
    expect(existsSync(agentsMdPath)).toBe(false);

    const mockOpenCodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
      getRestoreCommand: vi.fn().mockResolvedValue("opencode --session 'ses_restore'"),
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockOpenCodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: wsPath,
      branch: "main",
      status: "killed",
      project: "my-app",
      role: "orchestrator",
      agent: "opencode",
      opencodeSessionId: "ses_restore",
      runtimeHandle: makeHandle("rt-old"),
    });

    const configWithOpenCode: OrchestratorConfig = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "opencode",
        },
      },
    };

    const sm = createSessionManager({
      config: configWithOpenCode,
      registry: registryWithOpenCode,
    });
    await sm.restore("app-orchestrator");

    expect(existsSync(agentsMdPath)).toBe(true);
    const written = readFileSync(agentsMdPath, "utf-8");
    expect(written).toContain(promptContent);
    expect(written).toContain("<!-- AO_ORCHESTRATOR_PROMPT_START -->");
  });

  it("injects OPENCODE_CONFIG for restored OpenCode workers", async () => {
    const wsPath = join(tmpDir, "ws-app-worker-opencode-agentsmd");
    mkdirSync(wsPath, { recursive: true });

    const baseDir = getProjectDir("my-app");
    mkdirSync(baseDir, { recursive: true });
    const promptFile = join(baseDir, "worker-prompt-app-1.md");
    const promptContent = "Work on issue: TEST-1\nFix the failing tests.";
    writeFileSync(promptFile, promptContent, "utf-8");

    const mockOpenCodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
      getRestoreCommand: vi.fn().mockResolvedValue("opencode --session 'ses_restore'"),
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockOpenCodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_restore",
      runtimeHandle: makeHandle("rt-old"),
    });

    const configWithOpenCode: OrchestratorConfig = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          worker: {
            agent: "opencode",
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithOpenCode,
      registry: registryWithOpenCode,
    });
    await sm.restore("app-1");

    expect(mockRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          OPENCODE_CONFIG: expect.stringContaining("opencode-config-app-1.json"),
        }),
      }),
    );
    const runtimeCreateCall = vi.mocked(mockRuntime.create).mock.calls[0][0];
    const opencodeConfigPath = runtimeCreateCall.environment.OPENCODE_CONFIG;
    expect(opencodeConfigPath).toBeTruthy();
    expect(existsSync(opencodeConfigPath)).toBe(true);
    const opencodeConfig = JSON.parse(readFileSync(opencodeConfigPath, "utf-8")) as {
      instructions: string[];
    };
    expect(opencodeConfig.instructions).toEqual([promptFile]);
    expect(existsSync(getWorkspaceAgentsMdPath(wsPath))).toBe(false);
  });

  it("preserves original createdAt/issue/PR metadata", async () => {
    const wsPath = join(tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    const originalCreatedAt = "2024-06-15T10:00:00.000Z";
    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-42",
      status: "killed",
      project: "my-app",
      issue: "TEST-42",
      pr: "https://github.com/org/my-app/pull/99",
      summary: "Implementing feature X",
      createdAt: originalCreatedAt,
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.restore("app-1");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["createdAt"]).toBe(originalCreatedAt);
    expect(meta!["issue"]).toBe("TEST-42");
    expect(meta!["pr"]).toBe("https://github.com/org/my-app/pull/99");
    expect(meta!["summary"]).toBe("Implementing feature X");
    expect(meta!["branch"]).toBe("feat/TEST-42");
  });

  it("does not overwrite restored status/runtime metadata when postLaunchSetup is a no-op", async () => {
    const wsPath = join(tmpDir, "ws-app-post-launch-noop");
    mkdirSync(wsPath, { recursive: true });

    const agentWithNoopPostLaunch: Agent = {
      ...mockAgent,
      postLaunchSetup: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNoopPostLaunch: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithNoopPostLaunch;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-77",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: registryWithNoopPostLaunch });
    await sm.restore("app-1");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("working");
    expect(meta!["runtimeHandle"]).toBe(JSON.stringify(makeHandle("rt-1")));
    expect(meta!["restoredAt"]).toBeDefined();
  });

  it("persists only metadata updates produced by postLaunchSetup", async () => {
    const wsPath = join(tmpDir, "ws-app-post-launch-metadata");
    mkdirSync(wsPath, { recursive: true });

    const agentWithMetadataUpdate: Agent = {
      ...mockAgent,
      postLaunchSetup: vi.fn().mockImplementation(async (session) => {
        session.metadata = {
          ...session.metadata,
          opencodeSessionId: "ses_from_post_launch",
        };
      }),
    };

    const registryWithMetadataUpdate: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithMetadataUpdate;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-78",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
    });

    const sm = createSessionManager({ config, registry: registryWithMetadataUpdate });
    await sm.restore("app-1");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["status"]).toBe("working");
    expect(meta!["runtimeHandle"]).toBe(JSON.stringify(makeHandle("rt-1")));
    expect(meta!["opencodeSessionId"]).toBe("ses_from_post_launch");
  });
});
