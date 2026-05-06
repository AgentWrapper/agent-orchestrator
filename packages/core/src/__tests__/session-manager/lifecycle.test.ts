import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createSessionManager } from "../../session-manager.js";
import {
  writeMetadata,
  readMetadataRaw,
  updateMetadata,
} from "../../metadata.js";
import { getProjectSessionsDir, getProjectWorktreesDir } from "../../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Workspace,
  Tracker,
  SCM,
} from "../../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "../test-utils.js";
import { installMockOpencode, installMockOpencodeWithNotFoundDelete } from "./opencode-helpers.js";

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

describe("kill", () => {
  it("destroys runtime, workspace, and keeps terminated metadata", async () => {
    const managedWorktree = join(
      getProjectWorktreesDir("my-app"),
      "app-1",
    );
    writeMetadata(sessionsDir, "app-1", {
      worktree: managedWorktree,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-1");

    expect(mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-1"));
    expect(mockWorkspace.destroy).toHaveBeenCalledWith(managedWorktree);
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!["status"]).toMatch(/killed|terminated/);
  });

  it("does not destroy workspace paths outside managed roots", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-1");

    expect(mockWorkspace.destroy).not.toHaveBeenCalled();
  });

  it("destroys workspace under legacy ~/.worktrees root", async () => {
    const legacyWorktree = join(homedir(), ".worktrees", "my-app", "app-1");
    writeMetadata(sessionsDir, "app-1", {
      worktree: legacyWorktree,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-1");

    expect(mockWorkspace.destroy).toHaveBeenCalledWith(legacyWorktree);
  });

  it("never destroys workspace equal to project path", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: config.projects["my-app"]!.path,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-1");

    expect(mockWorkspace.destroy).not.toHaveBeenCalled();
  });

  it("does not destroy workspace when worktree resolves to project path", async () => {
    const projectPath = config.projects["my-app"]?.path;
    if (!projectPath) throw new Error("missing project path");

    writeMetadata(sessionsDir, "app-1", {
      worktree: `${projectPath}/`,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-1");

    expect(mockWorkspace.destroy).not.toHaveBeenCalled();
  });

  it("throws for nonexistent session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.kill("nonexistent")).rejects.toThrow("not found");
  });

  it("tolerates runtime destroy failure", async () => {
    const failRuntime: Runtime = {
      ...mockRuntime,
      destroy: vi.fn().mockRejectedValue(new Error("already gone")),
    };
    const registryWithFail: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return failRuntime;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithFail });
    // Should not throw even though runtime.destroy fails
    await expect(sm.kill("app-1")).resolves.toEqual({
      cleaned: true,
      alreadyTerminated: false,
    });
  });

  it("does not purge mapped OpenCode session on default kill", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-kill-default.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_keep",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-1");

    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("purges mapped OpenCode session when requested", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-kill-purge.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_purge",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-1", { purgeOpenCode: true });

    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_purge");
  });

  it("skips purge when mapped OpenCode session id is invalid", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-kill-invalid.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses bad id",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-1", { purgeOpenCode: true });

    expect(existsSync(deleteLogPath)).toBe(false);
  }, 15000);
});

describe("cleanup", () => {
  it("kills sessions with closed PRs", async () => {
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("closed"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/repo/pull/10",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
    expect(result.skipped).toHaveLength(0);
  });

  it("deletes mapped OpenCode session during cleanup for closed PRs", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("closed"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_cleanup",
      pr: "https://github.com/org/repo/pull/10",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_cleanup");
  });

  it("treats missing mapped OpenCode session as already cleaned for closed PRs", async () => {
    const mockBin = installMockOpencodeWithNotFoundDelete(tmpDir, "[]");
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("closed"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getMergeability: vi.fn(),
    };

    const registryWithSCM: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_missing",
      pr: "https://github.com/org/repo/pull/10",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
    expect(result.errors).toEqual([]);
  });

  it("deletes mapped OpenCode session from terminated killed sessions", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-archived.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-6", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_archived",
      runtimeHandle: makeHandle("rt-6"),
    });
    updateMetadata(sessionsDir, "app-6", {
      lifecycle: JSON.stringify({ session: { state: "terminated", terminatedAt: new Date().toISOString() } }),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-6");
    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_archived");
  }, 15_000);

  it("does not skip terminated cleanup for matching session IDs in other projects", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-archived-cross-project.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    const project2Path = join(tmpDir, "my-app-2");
    const configWithSecondProject: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app-2": {
          name: "My App 2",
          repo: "org/my-app-2",
          path: project2Path,
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "github" },
          tracker: { plugin: "github" },
        },
      },
    };
    const sessionsDir2 = getProjectSessionsDir("my-app-2");
    mkdirSync(sessionsDir2, { recursive: true });

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/project-1",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    writeMetadata(sessionsDir2, "app-1", {
      worktree: "/tmp/project-2",
      branch: "main",
      status: "killed",
      project: "my-app-2",
      agent: "opencode",
      opencodeSessionId: "ses_archived_project2",
      runtimeHandle: makeHandle("rt-2"),
    });
    updateMetadata(sessionsDir2, "app-1", {
      lifecycle: JSON.stringify({ session: { state: "terminated", terminatedAt: new Date().toISOString() } }),
    });

    const sm = createSessionManager({ config: configWithSecondProject, registry: mockRegistry });
    const result = await sm.cleanup();

    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_archived_project2");
    expect(result.killed).toContain("my-app-2:app-1");
    expect(result.skipped).toContain("my-app:app-1");
  });

  it("skips invalid terminated OpenCode session ids during cleanup", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-archived-invalid.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-8", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses bad id",
      runtimeHandle: makeHandle("rt-8"),
    });
    updateMetadata(sessionsDir, "app-8", {
      lifecycle: JSON.stringify({ session: { state: "terminated", terminatedAt: new Date().toISOString() } }),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const result = await sm.cleanup();

    expect(result.killed).not.toContain("app-8");
    expect(result.errors).toEqual([]);
    expect(result.skipped).toContain("app-8");
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("does not delete terminated OpenCode sessions in cleanup dry-run", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-archived-dry-run.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-7", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_archived_dry_run",
      runtimeHandle: makeHandle("rt-7"),
    });
    updateMetadata(sessionsDir, "app-7", {
      lifecycle: JSON.stringify({ session: { state: "terminated", terminatedAt: new Date().toISOString() } }),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const result = await sm.cleanup(undefined, { dryRun: true });

    expect(result.killed).toContain("app-7");
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("skips sessions without merged PRs or completed issues", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const result = await sm.cleanup();

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toContain("app-1");
  });

  it("skips orchestrator sessions by role metadata", async () => {
    const deadRuntime: Runtime = {
      ...mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return deadRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    // Session with role=orchestrator but a name that does NOT end in "-orchestrator"
    // so only the role metadata check can protect it (not the name fallback)
    writeMetadata(sessionsDir, "app-99", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: makeHandle("rt-orch"),
    });

    const sm = createSessionManager({ config, registry: registryWithDead });
    const result = await sm.cleanup();

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toContain("app-99");
  });

  it("skips orchestrator sessions by name fallback (no role metadata)", async () => {
    const deadRuntime: Runtime = {
      ...mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return deadRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    // Pre-existing orchestrator session without role field
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-orch"),
    });

    const sm = createSessionManager({ config, registry: registryWithDead });
    const result = await sm.cleanup();

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toContain("app-orchestrator");
  });

  it("never cleans the canonical orchestrator session even with stale worker-like metadata", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    const deadRuntime: Runtime = {
      ...mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const mockSCM: SCM = {
      name: "mock-scm",
      detectPR: vi.fn(),
      getPRState: vi.fn().mockResolvedValue("merged"),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getMergeability: vi.fn(),
    };
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-42",
        title: "Issue",
        description: "",
        url: "https://example.com/INT-42",
        state: "closed",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(true),
      issueUrl: vi.fn().mockReturnValue("https://example.com/INT-42"),
      branchName: vi.fn().mockReturnValue("feat/INT-42"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };
    const registryWithSignals: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return deadRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "scm") return mockSCM;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: "/tmp",
      branch: "main",
      status: "ci_failed",
      project: "my-app",
      issue: "INT-42",
      pr: "https://github.com/org/repo/pull/10",
      agent: "opencode",
      opencodeSessionId: "ses_orchestrator_active",
      runtimeHandle: makeHandle("rt-orchestrator"),
    });

    const sm = createSessionManager({ config, registry: registryWithSignals });
    const result = await sm.cleanup();

    expect(result.killed).not.toContain("app-orchestrator");
    expect(result.skipped).toContain("app-orchestrator");
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("never cleans terminated orchestrator mappings even when metadata looks stale", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-archived-orchestrator.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: "/tmp",
      branch: "main",
      status: "killed",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_orchestrator_archived",
      pr: "https://github.com/org/repo/pull/88",
      runtimeHandle: makeHandle("rt-orchestrator"),
    });
    updateMetadata(sessionsDir, "app-orchestrator", {
      lifecycle: JSON.stringify({ session: { state: "terminated", terminatedAt: new Date().toISOString() } }),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const result = await sm.cleanup();

    expect(result.killed).not.toContain("app-orchestrator");
    expect(result.skipped).toContain("app-orchestrator");
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("kills sessions with dead runtimes", async () => {
    const deadRuntime: Runtime = {
      ...mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return deadRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithDead });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
  });
});
