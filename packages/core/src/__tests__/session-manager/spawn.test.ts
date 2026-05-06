import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import { validateConfig } from "../../config.js";
import { getWorkspaceAgentsMdPath } from "../../opencode-agents-md.js";
import {
  buildLifecycleMetadataPatch,
  createInitialCanonicalLifecycle,
} from "../../lifecycle-state.js";
import {
  writeMetadata,
  readMetadata,
  readMetadataRaw,
} from "../../metadata.js";
import { getProjectWorktreesDir } from "../../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Workspace,
  Tracker,
} from "../../types.js";
import {
  setupTestContext,
  teardownTestContext,
  makeHandle,
  type TestContext,
} from "../test-utils.js";
import { installMockOpencode, installMockGit } from "./opencode-helpers.js";

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
  ({
    tmpDir,
    sessionsDir,
    mockRuntime,
    mockAgent,
    mockWorkspace,
    mockRegistry,
    config,
    originalPath,
  } = ctx);
});

afterEach(() => {
  teardownTestContext(ctx);
});

describe("spawn", () => {
  it("creates a session with workspace, runtime, and agent", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.id).toBe("app-1");
    expect(session.status).toBe("spawning");
    expect(session.projectId).toBe("my-app");
    expect(session.runtimeHandle).toEqual(makeHandle("rt-1"));

    // Verify workspace was created with V2 worktreeDir
    expect(mockWorkspace.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "my-app",
        worktreeDir: expect.stringContaining("projects/my-app/worktrees"),
      }),
    );
    // Verify agent launch command was requested
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
    // Verify runtime was created
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("forwards AO_AGENT_GH_TRACE into spawned agent runtime env when configured", async () => {
    const previousTrace = process.env["AO_AGENT_GH_TRACE"];
    process.env["AO_AGENT_GH_TRACE"] = "/tmp/agent-gh-trace-test.jsonl";

    try {
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.spawn({ projectId: "my-app" });

      expect(mockRuntime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: expect.objectContaining({
            AO_AGENT_GH_TRACE: "/tmp/agent-gh-trace-test.jsonl",
          }),
        }),
      );
    } finally {
      if (previousTrace === undefined) delete process.env["AO_AGENT_GH_TRACE"];
      else process.env["AO_AGENT_GH_TRACE"] = previousTrace;
    }
  });

  it("uses issue ID to derive branch name", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(session.branch).toBe("feat/INT-100");
    expect(session.issueId).toBe("INT-100");
  });

  it("prefers tracker-provided Issue.branchName over tracker.branchName()", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({ branchName: "ABC-1234" }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("custom/INT-100-my-feature"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("ABC-1234");
  });

  it("uses tracker.branchName when Issue omits branchName", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-100",
        title: "T",
        description: "",
        url: "https://tracker.test/INT-100",
        state: "open",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("custom/INT-100-my-feature"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("custom/INT-100-my-feature");
    expect(mockTracker.branchName).toHaveBeenCalledWith("INT-100", expect.anything());
  });

  it("falls back to tracker.branchName when Issue.branchName is not git-safe", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-100",
        title: "T",
        description: "",
        url: "https://tracker.test/INT-100",
        state: "open",
        labels: [],
        branchName: "bad branch with spaces",
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("feat/INT-100");
  });

  it("sanitizes free-text issueId into a valid branch slug", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "fix login bug" });

    expect(session.branch).toBe("feat/fix-login-bug");
  });

  it("preserves casing for branch-safe issue IDs without tracker", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-9999" });

    expect(session.branch).toBe("feat/INT-9999");
  });

  it("sanitizes issueId with special characters", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({
      projectId: "my-app",
      issueId: "Fix: user can't login (SSO)",
    });

    expect(session.branch).toBe("feat/fix-user-can-t-login-sso");
  });

  it("truncates long slugs to 60 characters", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({
      projectId: "my-app",
      issueId:
        "this is a very long issue description that should be truncated to sixty characters maximum",
    });

    expect(session.branch!.replace("feat/", "").length).toBeLessThanOrEqual(60);
  });

  it("does not leave trailing dash after truncation", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    // Craft input where the 60th char falls on a word boundary (dash)
    const session = await sm.spawn({
      projectId: "my-app",
      issueId: "ab ".repeat(30), // "ab ab ab ..." → "ab-ab-ab-..." truncated at 60
    });

    const slug = session.branch!.replace("feat/", "");
    expect(slug).not.toMatch(/-$/);
    expect(slug).not.toMatch(/^-/);
  });

  it("falls back to sessionId when issueId sanitizes to empty string", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "!!!" });

    // Slug is empty after sanitization, falls back to sessionId
    expect(session.branch).toMatch(/^feat\/app-\d+$/);
  });

  it("sanitizes issueId containing '..' (invalid in git branch names)", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "foo..bar" });

    // '..' is invalid in git refs, so it should be slugified
    expect(session.branch).toBe("feat/foo-bar");
  });

  it("uses tracker.branchName when tracker is available", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({}),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("custom/INT-100-my-feature"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("custom/INT-100-my-feature");
  });

  it("increments session numbers correctly", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    // Pre-create some metadata to simulate existing sessions
    writeMetadata(sessionsDir, "app-3", { worktree: "/tmp", branch: "b", status: "working" });
    writeMetadata(sessionsDir, "app-7", { worktree: "/tmp", branch: "b", status: "working" });

    const session = await sm.spawn({ projectId: "my-app" });
    expect(session.id).toBe("app-8");
  });

  it("does not reuse a killed session branch on recreate", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const first = await sm.spawn({ projectId: "my-app" });
    expect(first.id).toBe("app-1");
    expect(first.branch).toBe("session/app-1");

    await sm.kill(first.id);

    const second = await sm.spawn({ projectId: "my-app" });
    expect(second.id).toBe("app-2");
    expect(second.branch).toBe("session/app-2");
  });

  it("skips remote session branches when allocating a fresh session id", async () => {
    const mockGitBin = installMockGit(tmpDir, ["session/app-22"]);
    process.env.PATH = `${mockGitBin}:${originalPath ?? ""}`;
    mkdirSync(config.projects["my-app"]!.path, { recursive: true });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.id).toBe("app-23");
    expect(session.branch).toBe("session/app-23");
  });

  it("writes metadata file", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    const meta = readMetadata(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("spawning");
    expect(meta!.project).toBe("my-app");
    expect(meta!.issue).toBe("INT-42");
  });

  it("reuses OpenCode session mapping by issue when available", async () => {
    const opencodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return opencodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    config = {
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

    writeMetadata(sessionsDir, "app-9", {
      worktree: "/tmp/old",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      createdAt: "2026-01-01T00:00:00.000Z",
      opencodeSessionId: "ses_existing",
    });

    const sm = createSessionManager({ config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_existing" }),
        }),
      }),
    );

    const metadata = readMetadataRaw(sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBe("ses_existing");
  });

  it("reuses most recent session-id candidate without relying on timestamps", async () => {
    const opencodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return opencodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    config = {
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

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/old-no-ts",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_invalid_ts",
    });

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/new-with-ts",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_valid_newer",
    });

    const sm = createSessionManager({ config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_valid_newer" }),
        }),
      }),
    );

    const metadata = readMetadataRaw(sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBe("ses_valid_newer");
  });

  it("does not reuse issue mapping when opencodeIssueSessionStrategy is ignore", async () => {
    const opencodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return opencodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    config = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "opencode",
          opencodeIssueSessionStrategy: "ignore",
        },
      },
    };

    writeMetadata(sessionsDir, "app-9", {
      worktree: "/tmp/old",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_existing",
    });

    const sm = createSessionManager({ config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.not.objectContaining({ opencodeSessionId: expect.any(String) }),
        }),
      }),
    );

    const metadata = readMetadataRaw(sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBeUndefined();
  });

  it("deletes old issue mappings and starts fresh when opencodeIssueSessionStrategy is delete", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-issue.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return opencodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    config = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "opencode",
          opencodeIssueSessionStrategy: "delete",
        },
      },
    };

    writeMetadata(sessionsDir, "app-8", {
      worktree: "/tmp/old1",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_old_1",
    });
    writeMetadata(sessionsDir, "app-9", {
      worktree: "/tmp/old2",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_old_2",
    });

    const sm = createSessionManager({ config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_old_1");
    expect(deleteLog).toContain("session delete ses_old_2");

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.not.objectContaining({ opencodeSessionId: expect.any(String) }),
        }),
      }),
    );

    const metadata = readMetadataRaw(sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBeUndefined();
  }, 15_000);

  it("throws for unknown project", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.spawn({ projectId: "nonexistent" })).rejects.toThrow("Unknown project");
  });

  it("throws when runtime plugin is missing", async () => {
    const emptyRegistry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockReturnValue(null),
    };

    const sm = createSessionManager({ config, registry: emptyRegistry });
    await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("not found");
  });

  describe("agent override", () => {
    let mockCodexAgent: Agent;
    let registryWithMultipleAgents: PluginRegistry;

    beforeEach(() => {
      mockCodexAgent = {
        name: "codex",
        processName: "codex",
        getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
        getEnvironment: vi.fn().mockReturnValue({ CODEX_VAR: "1" }),
        detectActivity: vi.fn().mockReturnValue("active"),
        getActivityState: vi.fn().mockResolvedValue(null),
        isProcessRunning: vi.fn().mockResolvedValue(true),
        getSessionInfo: vi.fn().mockResolvedValue(null),
      };

      registryWithMultipleAgents = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string, name: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") {
            if (name === "mock-agent") return mockAgent;
            if (name === "codex") return mockCodexAgent;
            return null;
          }
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };
    });

    it("uses overridden agent when spawnConfig.agent is provided", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app", agent: "codex" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(mockAgent.getLaunchCommand).not.toHaveBeenCalled();
    });

    it("throws when agent override plugin is not found", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await expect(sm.spawn({ projectId: "my-app", agent: "nonexistent" })).rejects.toThrow(
        "Agent plugin 'nonexistent' not found",
      );
    });

    it("uses default agent when no override specified", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app" });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
      expect(mockCodexAgent.getLaunchCommand).not.toHaveBeenCalled();
    });

    it("persists agent name in metadata when override is used", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app", agent: "codex" });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta).not.toBeNull();
      expect(meta!["agent"]).toBe("codex");
    });

    it("persists default agent name in metadata when no override", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app" });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta).not.toBeNull();
      expect(meta!["agent"]).toBe("mock-agent");
    });

    it("uses project worker agent when configured and no spawn override is provided", async () => {
      const configWithWorkerAgent: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "mock-agent",
            worker: {
              agent: "codex",
            },
          },
        },
      };

      const sm = createSessionManager({
        config: configWithWorkerAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawn({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(mockAgent.getLaunchCommand).not.toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-1")?.["agent"]).toBe("codex");
    });

    it("uses defaults worker agent when project agent is not set", async () => {
      const configWithDefaultWorkerAgent: OrchestratorConfig = {
        ...config,
        defaults: {
          ...config.defaults,
          worker: {
            agent: "codex",
          },
        },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: undefined,
          },
        },
      };

      const sm = createSessionManager({
        config: configWithDefaultWorkerAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawn({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-1")?.["agent"]).toBe("codex");
    });

    it("readMetadata returns agent field (typed SessionMetadata)", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app", agent: "codex" });

      const meta = readMetadata(sessionsDir, "app-1");
      expect(meta).not.toBeNull();
      expect(meta!.agent).toBe("codex");
    });
  });

  it("forwards configured subagent to spawn launch when no override is provided", async () => {
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

    const sm = createSessionManager({
      config: configWithSubagent,
      registry: mockRegistry,
    });
    await sm.spawn({ projectId: "my-app" });

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: "oracle" }),
    );
  });

  it("prefers spawn subagent override over configured subagent", async () => {
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

    const sm = createSessionManager({
      config: configWithSubagent,
      registry: mockRegistry,
    });
    await sm.spawn({ projectId: "my-app", subagent: "librarian" });

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: "librarian" }),
    );
  });

  it("validates issue exists when issueId provided", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-100",
        title: "Test issue",
        description: "Test description",
        url: "https://linear.app/test/issue/INT-100",
        state: "open",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue("https://linear.app/test/issue/INT-100"),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue("Work on INT-100"),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockTracker.getIssue).toHaveBeenCalledWith("INT-100", config.projects["my-app"]);
    expect(session.issueId).toBe("INT-100");
  });

  it("persists issueTitle to metadata during spawn", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-200",
        title: "Add dark mode support",
        description: "Implement dark mode toggle",
        url: "https://linear.app/test/issue/INT-200",
        state: "open",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue("https://linear.app/test/issue/INT-200"),
      branchName: vi.fn().mockReturnValue("feat/INT-200"),
      generatePrompt: vi.fn().mockResolvedValue("Work on INT-200"),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-200" });

    // Verify issueTitle is persisted to metadata file and can be read back
    const metadata = readMetadata(sessionsDir, session.id);
    expect(metadata).not.toBeNull();
    expect(metadata!.issueTitle).toBe("Add dark mode support");
  });

  it("succeeds with ad-hoc issue string when tracker returns IssueNotFoundError", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("Issue INT-9999 not found")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-9999"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    // Ad-hoc issue string should succeed — IssueNotFoundError is gracefully ignored
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-9999" });

    expect(session.issueId).toBe("INT-9999");
    expect(session.branch).toBe("feat/INT-9999");
    // tracker.branchName and generatePrompt should NOT be called when issue wasn't resolved
    expect(mockTracker.branchName).not.toHaveBeenCalled();
    expect(mockTracker.generatePrompt).not.toHaveBeenCalled();
    // Workspace and runtime should still be created
    expect(mockWorkspace.create).toHaveBeenCalled();
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("succeeds with ad-hoc free-text when tracker returns 'invalid issue format'", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("invalid issue format: fix login bug")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue(""),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "fix login bug" });

    expect(session.issueId).toBe("fix login bug");
    expect(session.branch).toBe("feat/fix-login-bug");
    expect(mockTracker.branchName).not.toHaveBeenCalled();
    expect(mockWorkspace.create).toHaveBeenCalled();
  });

  it("fails on tracker auth errors", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("Unauthorized")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    await expect(sm.spawn({ projectId: "my-app", issueId: "INT-100" })).rejects.toThrow(
      "Failed to fetch issue",
    );

    // Should not create workspace or runtime when auth fails
    expect(mockWorkspace.create).not.toHaveBeenCalled();
    expect(mockRuntime.create).not.toHaveBeenCalled();
  });

  it("spawns without issue tracking when no issueId provided", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.issueId).toBeNull();
    // Uses session/{sessionId} to avoid conflicts with default branch
    expect(session.branch).toMatch(/^session\/app-\d+$/);
    expect(session.branch).not.toBe("main");
  });

  it("sends prompt post-launch when agent.promptDelivery is 'post-launch'", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return postLaunchAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });
    await vi.advanceTimersByTimeAsync(5_000);
    await spawnPromise;

    // Prompt should be sent via runtime.sendMessage, not included in launch command
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.stringContaining("Fix the bug"),
    );
    vi.useRealTimers();
  });

  it("writes worker system prompt to file and passes only explicit task prompt to agent", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawn({
      projectId: "my-app",
      issueId: "INT-1343",
      prompt: "Focus on the API layer only.",
    });

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "app-1",
        systemPromptFile: expect.stringContaining("worker-prompt-app-1.md"),
        prompt: expect.stringContaining("Focus on the API layer only."),
      }),
    );

    const callArgs = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    expect(callArgs.prompt).toContain("Focus on the API layer only.");
    expect(callArgs.prompt).not.toContain("## Task");
    expect(callArgs.prompt).not.toContain("## Project Context");
    expect(callArgs.prompt).not.toContain("Session Lifecycle");

    const promptFile = callArgs.systemPromptFile!;
    expect(existsSync(promptFile)).toBe(true);
    const systemPrompt = readFileSync(promptFile, "utf-8");
    expect(systemPrompt).toContain("Session Lifecycle");
    expect(systemPrompt).toContain("## Project Context");
    expect(systemPrompt).toContain("## Task");
    expect(systemPrompt).toContain("Work on issue: INT-1343");
    expect(systemPrompt).not.toContain("## Additional Instructions");
  });

  it("injects OPENCODE_CONFIG for OpenCode workers", async () => {
    const workspacePath = join(tmpDir, "opencode-worker-ws");
    vi.mocked(mockWorkspace.create).mockResolvedValueOnce({
      path: workspacePath,
      branch: "feat/INT-1343",
      sessionId: "app-1",
      projectId: "my-app",
    });

    const opencodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
    };
    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return opencodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };
    const configWithOpenCode: OrchestratorConfig = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          opencodeIssueSessionStrategy: "ignore",
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

    await sm.spawn({
      projectId: "my-app",
      issueId: "INT-1343",
      prompt: "Focus on the API layer only.",
    });

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
    expect(opencodeConfig.instructions).toHaveLength(1);
    expect(opencodeConfig.instructions[0]).toContain("worker-prompt-app-1.md");

    const systemPromptPath = opencodeConfig.instructions[0]!;
    expect(readFileSync(systemPromptPath, "utf-8")).toContain("Work on issue: INT-1343");
    expect(readFileSync(systemPromptPath, "utf-8")).not.toContain("## Additional Instructions");

    const agentsMdPath = getWorkspaceAgentsMdPath(workspacePath);
    expect(existsSync(agentsMdPath)).toBe(false);
  });

  it("does not send prompt post-launch when agent.promptDelivery is not set", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    // Default agent (no promptDelivery) should NOT trigger sendMessage for prompt
    expect(mockRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send a post-launch message when no task prompt is available", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return postLaunchAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app" });
    await vi.advanceTimersByTimeAsync(5_000);
    const session = await spawnPromise;

    expect(mockRuntime.sendMessage).not.toHaveBeenCalled();
    expect(session.metadata.promptDelivered).toBeUndefined();
    vi.useRealTimers();
  });

  it("sends a minimal post-launch task for issue-only spawns", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return postLaunchAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app", issueId: "INT-1343" });
    await vi.advanceTimersByTimeAsync(5_000);
    const session = await spawnPromise;

    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      "Work on issue: INT-1343",
    );
    expect(session.metadata.promptDelivered).toBe("true");

    const callArgs = vi.mocked(postLaunchAgent.getLaunchCommand).mock.calls[0][0];
    expect(callArgs.prompt).toBe("Work on issue: INT-1343");
    expect(callArgs.systemPromptFile).toContain("worker-prompt-app-1.md");

    const systemPrompt = readFileSync(callArgs.systemPromptFile!, "utf-8");
    expect(systemPrompt).toContain("## Task");
    expect(systemPrompt).toContain("Work on issue: INT-1343");
    vi.useRealTimers();
  });

  it("does not destroy session when post-launch prompt delivery fails", async () => {
    vi.useFakeTimers();
    const failingRuntime: Runtime = {
      ...mockRuntime,
      sendMessage: vi.fn().mockRejectedValue(new Error("tmux send failed")),
    };
    const postLaunchAgent = {
      ...mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithFailingSend: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return failingRuntime;
        if (slot === "agent") return postLaunchAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithFailingSend });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });
    // With retry logic (3 attempts at 3s, 6s, 9s delays before each attempt), need to advance 18s for all retries
    await vi.advanceTimersByTimeAsync(18_000);
    const session = await spawnPromise;

    // Session should still be returned successfully despite sendMessage failure
    expect(session.id).toBe("app-1");
    expect(session.status).toBe("spawning");
    // Runtime should NOT have been destroyed
    expect(failingRuntime.destroy).not.toHaveBeenCalled();
    // Verify promptDelivered is set to false in metadata
    expect(session.metadata.promptDelivered).toBe("false");
    vi.useRealTimers();
  }, 30_000);

  it("waits before sending post-launch prompt", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return postLaunchAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    // Advance only 2s — not enough, message should not have been sent yet
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockRuntime.sendMessage).not.toHaveBeenCalled();

    // Advance the remaining 1s — now the first attempt should fire (3s total = 3000 * 1)
    await vi.advanceTimersByTimeAsync(1_000);
    await spawnPromise;
    expect(mockRuntime.sendMessage).toHaveBeenCalled();
    vi.useRealTimers();
  }, 20_000);

  describe("rollback on failure", () => {
    it("cleans up reserved metadata when workspace creation fails", async () => {
      (mockWorkspace.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("workspace creation failed"),
      );
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow(
        "workspace creation failed",
      );

      expect(readMetadataRaw(sessionsDir, "app-1")).toBeNull();
      expect(mockRuntime.create).not.toHaveBeenCalled();
    });

    it("destroys the worktree and cleans metadata when runtime creation fails", async () => {
      // Workspace path must be inside the project's managed worktrees root so
      // shouldDestroyWorkspacePath() permits destroy. Mock paths under tmpDir
      // would be skipped as out-of-tree (correct, but not the path we want to
      // characterize here).
      const worktreePath = join(getProjectWorktreesDir("my-app"), "app-1");
      (mockWorkspace.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        path: worktreePath,
        branch: "session/app-1",
        sessionId: "app-1",
        projectId: "my-app",
      });
      (mockRuntime.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("runtime creation failed"),
      );
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow(
        "runtime creation failed",
      );

      expect(mockWorkspace.destroy).toHaveBeenCalledWith(worktreePath);
      expect(readMetadataRaw(sessionsDir, "app-1")).toBeNull();
    });

    it("destroys runtime and worktree when post-launch setup fails", async () => {
      const worktreePath = join(getProjectWorktreesDir("my-app"), "app-1");
      (mockWorkspace.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        path: worktreePath,
        branch: "session/app-1",
        sessionId: "app-1",
        projectId: "my-app",
      });
      const postLaunchError = new Error("post-launch setup failed");
      const agentWithPostLaunch: typeof mockAgent = {
        ...mockAgent,
        postLaunchSetup: vi.fn().mockRejectedValueOnce(postLaunchError),
      };
      const registryWithPostLaunch: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return agentWithPostLaunch;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };
      const sm = createSessionManager({ config, registry: registryWithPostLaunch });

      await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("post-launch setup failed");

      expect(mockRuntime.destroy).toHaveBeenCalled();
      expect(mockWorkspace.destroy).toHaveBeenCalledWith(worktreePath);
      expect(readMetadataRaw(sessionsDir, "app-1")).toBeNull();
    });

    it("destroys the worktree and cleans metadata when workspace.postCreate fails", async () => {
      const worktreePath = join(getProjectWorktreesDir("my-app"), "app-1");
      const workspaceWithPostCreate: typeof mockWorkspace = {
        ...mockWorkspace,
        create: vi.fn().mockResolvedValueOnce({
          path: worktreePath,
          branch: "session/app-1",
          sessionId: "app-1",
          projectId: "my-app",
        }),
        postCreate: vi.fn().mockRejectedValueOnce(new Error("postCreate hook failed")),
      };
      const registryWithPostCreate: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return mockAgent;
          if (slot === "workspace") return workspaceWithPostCreate;
          return null;
        }),
      };
      const sm = createSessionManager({ config, registry: registryWithPostCreate });

      await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("postCreate hook failed");

      expect(workspaceWithPostCreate.destroy).toHaveBeenCalledWith(worktreePath);
      expect(readMetadataRaw(sessionsDir, "app-1")).toBeNull();
      // Runtime should not have been created since postCreate failed before runtime.create.
      expect(mockRuntime.create).not.toHaveBeenCalled();
    });

    it("still cleans subsequent resources when one cleanup step throws", async () => {
      const worktreePath = join(getProjectWorktreesDir("my-app"), "app-1");
      (mockWorkspace.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        path: worktreePath,
        branch: "session/app-1",
        sessionId: "app-1",
        projectId: "my-app",
      });
      // workspace.destroy throws during rollback — metadata cleanup must still run
      (mockWorkspace.destroy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("destroy failed"),
      );
      (mockRuntime.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("runtime creation failed"),
      );
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow(
        "runtime creation failed",
      );

      // Even though workspace.destroy threw, metadata must have been cleaned up.
      expect(readMetadataRaw(sessionsDir, "app-1")).toBeNull();
    });
  });

  describe("displayName derivation", () => {
    it("persists the issue title as displayName when tracker returns one", async () => {
      const mockTracker: Tracker = {
        name: "mock-tracker",
        getIssue: vi.fn().mockResolvedValue({
          id: "INT-100",
          title: "Refactor session manager to use flat metadata files",
          description: "",
          url: "https://tracker.test/INT-100",
          state: "open",
          labels: [],
        }),
        isCompleted: vi.fn().mockResolvedValue(false),
        issueUrl: vi.fn().mockReturnValue(""),
        branchName: vi.fn().mockReturnValue("feat/INT-100"),
        generatePrompt: vi.fn().mockResolvedValue(""),
      };
      const registryWithTracker: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return mockAgent;
          if (slot === "workspace") return mockWorkspace;
          if (slot === "tracker") return mockTracker;
          return null;
        }),
      };

      const sm = createSessionManager({ config, registry: registryWithTracker });
      await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta?.["displayName"]).toBe("Refactor session manager to use flat metadata files");
    });

    it("persists the first line of a user prompt as displayName when there is no issue", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.spawn({
        projectId: "my-app",
        prompt:
          "Add rate limiting to /api/upload\n\nUse a sliding-window counter keyed by IP.",
      });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta?.["displayName"]).toBe("Add rate limiting to /api/upload");
    });

    it("truncates long displayName values with an ellipsis", async () => {
      const longPrompt =
        "Implement a comprehensive rate-limiter that supports sliding windows, token buckets, and per-route overrides with distributed counters";
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.spawn({ projectId: "my-app", prompt: longPrompt });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta?.["displayName"]).toBeDefined();
      expect(meta!["displayName"].length).toBeLessThanOrEqual(80);
      expect(meta!["displayName"].endsWith("…")).toBe(true);
    });

    it("truncates on code-point boundaries without splitting surrogate pairs", async () => {
      // Place a 4-byte emoji (2 UTF-16 code units) right where a naive
      // `slice(0, 79)` would split it, producing a lone surrogate.
      const prompt = "a".repeat(78) + "😀" + "b".repeat(20);
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.spawn({ projectId: "my-app", prompt });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      const displayName = meta?.["displayName"];
      expect(displayName).toBeDefined();
      expect(displayName!.endsWith("…")).toBe(true);
      // No lone surrogates — every code unit belongs to a valid code point.
      for (const ch of displayName!) {
        expect(ch.codePointAt(0)).toBeGreaterThan(0);
      }
      // Round-trip through UTF-8 should be lossless (no U+FFFD replacement).
      expect(Buffer.from(displayName!, "utf8").toString("utf8")).toBe(displayName);
    });

    it("does not write displayName when there is no issue or prompt", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.spawn({ projectId: "my-app" });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta?.["displayName"]).toBeUndefined();
    });
  });

  describe("spawnOrchestrator", () => {
    it("throws when no workspace plugin is configured", async () => {
      const registryNoWorkspace: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return mockAgent;
          return null; // no workspace plugin
        }),
      };
      const sm = createSessionManager({ config, registry: registryNoWorkspace });

      await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
        "spawnOrchestrator requires a workspace plugin",
      );

      // Reserved session metadata should be cleaned up
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")).toBeNull();
      expect(mockRuntime.create).not.toHaveBeenCalled();
    });

    it("creates orchestrator session with correct ID", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      const session = await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(session.id).toBe("app-orchestrator");
      expect(session.status).toBe("working");
      expect(session.projectId).toBe("my-app");
      expect(session.branch).toBe("orchestrator/app-orchestrator");
      expect(session.issueId).toBeNull();
      expect(session.workspacePath).toBe("/tmp/ws");
    });

    it("creates a worktree with an orchestrator branch", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockWorkspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "app-orchestrator",
          branch: "orchestrator/app-orchestrator",
          projectId: "my-app",
        }),
      );
    });

    it("uses the worktree path returned by the workspace plugin", async () => {
      const worktreePath = join(tmpDir, "orchestrator-ws");
      (mockWorkspace.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        path: worktreePath,
        branch: "orchestrator/app-orchestrator",
        sessionId: "app-orchestrator",
        projectId: "my-app",
      });
      const sm = createSessionManager({ config, registry: mockRegistry });

      const session = await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(session.workspacePath).toBe(worktreePath);
      expect(session.branch).toBe("orchestrator/app-orchestrator");
    });

    it("adopts an existing managed orchestrator worktree instead of creating a fresh one", async () => {
      const adoptedPath = join(tmpDir, "legacy-orchestrator-ws");
      (mockWorkspace.findManagedWorkspace as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        path: adoptedPath,
        branch: "orchestrator/app-orchestrator",
        sessionId: "app-orchestrator",
        projectId: "my-app",
      });
      const sm = createSessionManager({ config, registry: mockRegistry });

      const session = await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(session.workspacePath).toBe(adoptedPath);
      expect(mockWorkspace.findManagedWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "my-app",
          sessionId: "app-orchestrator",
          branch: "orchestrator/app-orchestrator",
        }),
      );
      expect(mockWorkspace.create).not.toHaveBeenCalled();
    });

    it("writes metadata with proper fields", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({ projectId: "my-app" });

      const meta = readMetadata(sessionsDir, "app-orchestrator");
      expect(meta).not.toBeNull();
      expect(meta!.status).toBe("working");
      expect(meta!.project).toBe("my-app");
      expect(meta!.branch).toBe("orchestrator/app-orchestrator");
      expect(meta!.tmuxName).toBeDefined();
      expect(meta!.runtimeHandle).toBeDefined();
    });

    it("writes metadata with worktree path and orchestrator role", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({ projectId: "my-app" });

      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["role"]).toBe("orchestrator");
      expect(meta?.["branch"]).toBe("orchestrator/app-orchestrator");
      expect(meta?.["status"]).toBe("working");
      expect(meta?.["project"]).toBe("my-app");
    });

    it("ensureOrchestrator returns the canonical session on repeated calls", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      const s1 = await sm.ensureOrchestrator({ projectId: "my-app" });
      const s2 = await sm.ensureOrchestrator({ projectId: "my-app" });

      expect(s1.id).toBe("app-orchestrator");
      expect(s2.id).toBe("app-orchestrator");
      expect(mockWorkspace.create).toHaveBeenCalledTimes(1);
    });

    it("ensureOrchestrator coalesces concurrent creation calls", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      const [s1, s2] = await Promise.all([
        sm.ensureOrchestrator({ projectId: "my-app" }),
        sm.ensureOrchestrator({ projectId: "my-app" }),
      ]);

      expect(s1.id).toBe("app-orchestrator");
      expect(s2.id).toBe("app-orchestrator");
      expect(mockWorkspace.create).toHaveBeenCalledTimes(1);
      expect(mockRuntime.create).toHaveBeenCalledTimes(1);
    });

    it("ensureOrchestrator replaces the canonical session for delete strategy", async () => {
      const configWithDelete: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"]!,
            orchestratorSessionStrategy: "delete",
          },
        },
      };
      writeMetadata(sessionsDir, "app-orchestrator", {
        role: "orchestrator",
        project: "my-app",
        status: "working",
        branch: "orchestrator/app-orchestrator",
        worktree: join(tmpDir, "old-orchestrator"),
        runtimeHandle: makeHandle("old-rt"),
      });
      const sm = createSessionManager({ config: configWithDelete, registry: mockRegistry });

      const session = await sm.ensureOrchestrator({ projectId: "my-app" });

      expect(session.id).toBe("app-orchestrator");
      expect(mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("old-rt"));
      expect(mockWorkspace.create).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "app-orchestrator" }),
      );
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")?.["status"]).toBe("working");
    });

    it("ensureOrchestrator ignores numbered legacy orchestrators and creates the canonical session", async () => {
      writeMetadata(sessionsDir, "app-orchestrator-5", {
        role: "orchestrator",
        project: "my-app",
        status: "working",
        branch: "orchestrator/app-orchestrator-5",
        worktree: join(tmpDir, "legacy-orchestrator"),
      });
      const sm = createSessionManager({ config, registry: mockRegistry });

      const session = await sm.ensureOrchestrator({ projectId: "my-app" });

      expect(session.id).toBe("app-orchestrator");
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")).not.toBeNull();
      expect(readMetadataRaw(sessionsDir, "app-orchestrator-5")).not.toBeNull();
      expect(mockWorkspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "app-orchestrator",
          branch: "orchestrator/app-orchestrator",
        }),
      );
    });

    it("ensureOrchestrator fails clearly when canonical session is done and non-restorable", async () => {
      const lifecycle = createInitialCanonicalLifecycle("orchestrator");
      lifecycle.session.state = "done";
      lifecycle.session.reason = "research_complete";
      lifecycle.session.completedAt = new Date().toISOString();
      lifecycle.runtime.state = "exited";
      lifecycle.runtime.reason = "process_missing";
      const doneWorktree = join(tmpDir, "done-orchestrator");
      mkdirSync(doneWorktree, { recursive: true });
      writeMetadata(sessionsDir, "app-orchestrator", {
        role: "orchestrator",
        project: "my-app",
        status: "done",
        branch: "orchestrator/app-orchestrator",
        worktree: doneWorktree,
        ...buildLifecycleMetadataPatch(lifecycle),
      });
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.ensureOrchestrator({ projectId: "my-app" })).rejects.toThrow(
        'canonical orchestrator session is terminal with status "done"',
      );
      expect(mockWorkspace.create).not.toHaveBeenCalled();
    });

    it("cleans up reserved metadata on workspace creation failure", async () => {
      (mockWorkspace.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("workspace creation failed"),
      );
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
        "workspace creation failed",
      );

      // Reserved session file should be cleaned up
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")).toBeNull();
    });

    it("destroys the worktree and metadata when runtime creation fails", async () => {
      const worktreePath = join(tmpDir, "orchestrator-ws-rt-fail");
      (mockWorkspace.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        path: worktreePath,
        branch: "orchestrator/app-orchestrator",
        sessionId: "app-orchestrator",
        projectId: "my-app",
      });
      (mockRuntime.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("runtime creation failed"),
      );
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
        "runtime creation failed",
      );

      expect(mockWorkspace.destroy).toHaveBeenCalledWith(worktreePath);
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")).toBeNull();
    });

    it("keeps an adopted worktree in place when runtime creation fails", async () => {
      const adoptedPath = join(tmpDir, "adopted-orchestrator-ws");
      (mockWorkspace.findManagedWorkspace as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        path: adoptedPath,
        branch: "orchestrator/app-orchestrator",
        sessionId: "app-orchestrator",
        projectId: "my-app",
      });
      (mockRuntime.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("runtime creation failed"),
      );
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
        "runtime creation failed",
      );

      expect(mockWorkspace.destroy).not.toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")).toBeNull();
    });

    it("destroys the worktree when post-launch setup fails", async () => {
      const worktreePath = join(tmpDir, "orchestrator-ws-postlaunch-fail");
      (mockWorkspace.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        path: worktreePath,
        branch: "orchestrator/app-orchestrator",
        sessionId: "app-orchestrator",
        projectId: "my-app",
      });
      const postLaunchError = new Error("post-launch setup failed");
      const agentWithPostLaunch: typeof mockAgent = {
        ...mockAgent,
        postLaunchSetup: vi.fn().mockRejectedValueOnce(postLaunchError),
      };
      const registryWithPostLaunch: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return agentWithPostLaunch;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };
      const sm = createSessionManager({ config, registry: registryWithPostLaunch });

      await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
        "post-launch setup failed",
      );

      expect(mockRuntime.destroy).toHaveBeenCalled();
      expect(mockWorkspace.destroy).toHaveBeenCalledWith(worktreePath);
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")).toBeNull();
    });

    it("deletes previous OpenCode orchestrator sessions before starting", async () => {
      const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator.log");
      const mockBin = installMockOpencode(
        tmpDir,
        JSON.stringify([
          { id: "ses_old", title: "AO:app-orchestrator", updated: "2025-01-01T00:00:00.000Z" },
          { id: "ses_new", title: "AO:app-orchestrator", updated: "2025-01-02T00:00:00.000Z" },
        ]),
        deleteLogPath,
      );
      process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

      const opencodeAgent: Agent = {
        ...mockAgent,
        name: "opencode",
      };
      const registryWithOpenCode: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return opencodeAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };

      const configWithDelete: OrchestratorConfig = {
        ...config,
        defaults: { ...config.defaults, agent: "opencode" },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "opencode",
            orchestratorSessionStrategy: "delete",
          },
        },
      };

      const sm = createSessionManager({ config: configWithDelete, registry: registryWithOpenCode });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      const deleteLog = readFileSync(deleteLogPath, "utf-8");
      expect(deleteLog).toContain("session delete ses_old");
      expect(deleteLog).toContain("session delete ses_new");

      expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "app-orchestrator",
          projectConfig: expect.objectContaining({
            agentConfig: expect.not.objectContaining({ opencodeSessionId: expect.any(String) }),
          }),
        }),
      );

      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["agent"]).toBe("opencode");
      expect(meta?.["opencodeSessionId"]).toBeUndefined();
    });

    it("discovers and persists OpenCode session id by title when strategy is reuse", async () => {
      const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator-reuse-discovery.log");
      const mockBin = installMockOpencode(
        tmpDir,
        JSON.stringify([
          {
            id: "ses_discovered_orchestrator",
            title: "AO:app-orchestrator",
            updated: 1_772_777_000_000,
          },
        ]),
        deleteLogPath,
      );
      process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

      const opencodeAgent: Agent = {
        ...mockAgent,
        name: "opencode",
      };
      const registryWithOpenCode: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return opencodeAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };

      const configWithReuse: OrchestratorConfig = {
        ...config,
        defaults: { ...config.defaults, agent: "opencode" },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "opencode",
            orchestratorSessionStrategy: "reuse",
          },
        },
      };

      const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["opencodeSessionId"]).toBe("ses_discovered_orchestrator");
    });

    it("reuses mapped OpenCode session id when strategy is reuse and opencode lists it by title", async () => {
      const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator-reuse-restart.log");
      const mockBin = installMockOpencode(
        tmpDir,
        JSON.stringify([
          {
            id: "ses_existing",
            title: "AO:app-orchestrator",
            updated: 1_772_777_000_000,
          },
        ]),
        deleteLogPath,
      );
      process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

      const opencodeAgent: Agent = {
        ...mockAgent,
        name: "opencode",
      };
      const registryWithOpenCode: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return opencodeAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };

      const configWithReuse: OrchestratorConfig = {
        ...config,
        defaults: { ...config.defaults, agent: "opencode" },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "opencode",
            orchestratorSessionStrategy: "reuse",
          },
        },
      };

      const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          projectConfig: expect.objectContaining({
            agentConfig: expect.objectContaining({ opencodeSessionId: "ses_existing" }),
          }),
        }),
      );
      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["opencodeSessionId"]).toBe("ses_existing");
    });

    it("discovers OpenCode mapping by title when no archived mapping exists for new session id", async () => {
      const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator-reuse-title-fallback.log");
      const mockBin = installMockOpencode(
        tmpDir,
        JSON.stringify([
          { id: "ses_existing", title: "AO:app-orchestrator", updated: 1_772_777_000_000 },
        ]),
        deleteLogPath,
      );
      process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

      const opencodeAgent: Agent = {
        ...mockAgent,
        name: "opencode",
      };
      const registryWithOpenCode: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return opencodeAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };

      const configWithReuse: OrchestratorConfig = {
        ...config,
        defaults: { ...config.defaults, agent: "opencode" },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "opencode",
            orchestratorSessionStrategy: "reuse",
          },
        },
      };

      const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          projectConfig: expect.objectContaining({
            agentConfig: expect.objectContaining({ opencodeSessionId: "ses_existing" }),
          }),
        }),
      );
    });

    it("reuses OpenCode session by title when orchestrator mapping is missing", async () => {
      const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator-reuse-title.log");
      const mockBin = installMockOpencode(
        tmpDir,
        JSON.stringify([
          { id: "ses_title_match", title: "AO:app-orchestrator", updated: 1_772_777_000_000 },
        ]),
        deleteLogPath,
      );
      process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

      const opencodeAgent: Agent = {
        ...mockAgent,
        name: "opencode",
      };
      const registryWithOpenCode: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return opencodeAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };

      const configWithReuse: OrchestratorConfig = {
        ...config,
        defaults: { ...config.defaults, agent: "opencode" },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "opencode",
            orchestratorSessionStrategy: "reuse",
          },
        },
      };

      const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          projectConfig: expect.objectContaining({
            agentConfig: expect.objectContaining({ opencodeSessionId: "ses_title_match" }),
          }),
        }),
      );
      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["opencodeSessionId"]).toBe("ses_title_match");
    });

    it("calls agent.setupWorkspaceHooks on worktree path", async () => {
      const agentWithHooks: Agent = {
        ...mockAgent,
        setupWorkspaceHooks: vi.fn().mockResolvedValue(undefined),
      };
      const registryWithHooks: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return agentWithHooks;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };

      const sm = createSessionManager({ config, registry: registryWithHooks });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(agentWithHooks.setupWorkspaceHooks).toHaveBeenCalledWith(
        "/tmp/ws",
        expect.objectContaining({ dataDir: sessionsDir }),
      );
    });

    it("calls runtime.create with proper config", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockRuntime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: "/tmp/ws",
          launchCommand: "mock-agent --start",
        }),
      );
    });

    it("forwards AO_AGENT_GH_TRACE into orchestrator runtime env when configured", async () => {
      const previousTrace = process.env["AO_AGENT_GH_TRACE"];
      process.env["AO_AGENT_GH_TRACE"] = "/tmp/orchestrator-gh-trace-test.jsonl";

      try {
        const sm = createSessionManager({ config, registry: mockRegistry });
        await sm.spawnOrchestrator({ projectId: "my-app" });

        expect(mockRuntime.create).toHaveBeenCalledWith(
          expect.objectContaining({
            environment: expect.objectContaining({
              AO_AGENT_GH_TRACE: "/tmp/orchestrator-gh-trace-test.jsonl",
              AO_CALLER_TYPE: "orchestrator",
            }),
          }),
        );
      } finally {
        if (previousTrace === undefined) delete process.env["AO_AGENT_GH_TRACE"];
        else process.env["AO_AGENT_GH_TRACE"] = previousTrace;
      }
    });

    it("does not persist orchestratorSessionReused metadata on newly created sessions", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({ projectId: "my-app" });

      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["orchestratorSessionReused"]).toBeUndefined();
    });

    it("uses orchestratorModel when configured", async () => {
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

      const sm = createSessionManager({
        config: configWithOrchestratorModel,
        registry: mockRegistry,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({ model: "orchestrator-model" }),
      );
    });

    it("keeps orchestrator launch permissionless even when shared config sets permissions", async () => {
      const configWithSharedPermissions: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agentConfig: {
              permissions: "suggest",
            },
          },
        },
      };

      const sm = createSessionManager({
        config: configWithSharedPermissions,
        registry: mockRegistry,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          permissions: "permissionless",
          projectConfig: expect.objectContaining({
            agentConfig: expect.objectContaining({ permissions: "permissionless" }),
          }),
        }),
      );
    });

    it("uses project orchestrator agent when configured", async () => {
      const mockCodexAgent: Agent = {
        ...mockAgent,
        name: "codex",
        processName: "codex",
        getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
        getEnvironment: vi.fn().mockReturnValue({ CODEX_VAR: "1" }),
      };
      const registryWithMultipleAgents: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string, name: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "workspace") return mockWorkspace;
          if (slot === "agent") {
            if (name === "codex") return mockCodexAgent;
            if (name === "mock-agent") return mockAgent;
          }
          return null;
        }),
      };
      const configWithOrchestratorAgent: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "mock-agent",
            orchestrator: {
              agent: "codex",
            },
          },
        },
      };

      const sm = createSessionManager({
        config: configWithOrchestratorAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(mockAgent.getLaunchCommand).not.toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")?.["agent"]).toBe("codex");
    });

    it("uses defaults orchestrator agent when project agent is not set", async () => {
      const mockCodexAgent: Agent = {
        ...mockAgent,
        name: "codex",
        processName: "codex",
        getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
        getEnvironment: vi.fn().mockReturnValue({ CODEX_VAR: "1" }),
      };
      const registryWithMultipleAgents: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string, name: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "workspace") return mockWorkspace;
          if (slot === "agent") {
            if (name === "codex") return mockCodexAgent;
            if (name === "mock-agent") return mockAgent;
          }
          return null;
        }),
      };
      const configWithDefaultOrchestratorAgent: OrchestratorConfig = {
        ...config,
        defaults: {
          ...config.defaults,
          orchestrator: {
            agent: "codex",
          },
        },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: undefined,
          },
        },
      };

      const sm = createSessionManager({
        config: configWithDefaultOrchestratorAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")?.["agent"]).toBe("codex");
    });

    it("keeps shared worker permissions when role-specific config only overrides model", async () => {
      const configWithSharedPermissions: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agentConfig: {
              permissions: "suggest",
            },
            worker: {
              agentConfig: {
                model: "worker-model",
              },
            },
          },
        },
      };

      const validatedConfig = validateConfig(configWithSharedPermissions);
      validatedConfig.configPath = config.configPath;
      const sm = createSessionManager({
        config: validatedConfig,
        registry: mockRegistry,
      });
      await sm.spawn({ projectId: "my-app" });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({ permissions: "suggest", model: "worker-model" }),
      );
    });

    it("uses role-specific orchestratorModel when configured", async () => {
      const configWithRoleOrchestratorModel: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agentConfig: {
              model: "worker-model",
              orchestratorModel: "shared-orchestrator-model",
            },
            orchestrator: {
              agentConfig: {
                orchestratorModel: "role-orchestrator-model",
              },
            },
          },
        },
      };

      const sm = createSessionManager({
        config: configWithRoleOrchestratorModel,
        registry: mockRegistry,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({ model: "role-orchestrator-model" }),
      );
    });

    it("forwards configured subagent to orchestrator launch", async () => {
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

      const sm = createSessionManager({
        config: configWithSubagent,
        registry: mockRegistry,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({ subagent: "oracle" }),
      );
    });

    it("writes system prompt to file and passes systemPromptFile to agent", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({
        projectId: "my-app",
        systemPrompt: "You are the orchestrator.",
      });

      // Should pass systemPromptFile (not inline systemPrompt) to avoid tmux truncation
      expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "app-orchestrator",
          systemPromptFile: expect.stringContaining("orchestrator-prompt-app-orchestrator.md"),
        }),
      );

      // Verify the file was actually written
      const callArgs = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
      const promptFile = callArgs.systemPromptFile!;
      expect(existsSync(promptFile)).toBe(true);
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(promptFile, "utf-8")).toBe("You are the orchestrator.");
    });

    it("persists displayName derived from the orchestrator system prompt", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({
        projectId: "my-app",
        systemPrompt: "Audit test coverage for session-manager and open PRs for gaps",
      });

      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["displayName"]).toBe(
        "Audit test coverage for session-manager and open PRs for gaps",
      );
    });

    it("omits displayName when no system prompt is supplied", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({ projectId: "my-app" });

      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["displayName"]).toBeUndefined();
    });

    it("writes the orchestrator AGENTS.md block for OpenCode orchestrators", async () => {
      const opencodeAgent: Agent = {
        ...mockAgent,
        name: "opencode",
      };
      const registryWithOpenCode: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return opencodeAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };
      const configWithOpenCode: OrchestratorConfig = {
        ...config,
        defaults: { ...config.defaults, agent: "opencode" },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "opencode",
            orchestratorSessionStrategy: "ignore",
          },
        },
      };

      const sm = createSessionManager({
        config: configWithOpenCode,
        registry: registryWithOpenCode,
      });

      await sm.spawnOrchestrator({
        projectId: "my-app",
        systemPrompt: "You are the orchestrator.",
      });

      const agentsMdPath = getWorkspaceAgentsMdPath("/tmp/ws");
      expect(existsSync(agentsMdPath)).toBe(true);
      const written = readFileSync(agentsMdPath, "utf-8");
      expect(written).toContain("<!-- AO_ORCHESTRATOR_PROMPT_START -->");
      expect(written).toContain("## Agent Orchestrator");
      expect(written).toContain("You are the orchestrator.");

      expect(mockRuntime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: expect.not.objectContaining({
            OPENCODE_CONFIG: expect.any(String),
          }),
        }),
      );
    }, 15_000);

    it("throws for unknown project", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.spawnOrchestrator({ projectId: "nonexistent" })).rejects.toThrow(
        "Unknown project",
      );
    });

    it("throws when runtime plugin is missing", async () => {
      const emptyRegistry: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockReturnValue(null),
      };

      const sm = createSessionManager({ config, registry: emptyRegistry });

      await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow("not found");
    });

    it("returns session with runtimeHandle", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      const session = await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(session.runtimeHandle).toEqual(makeHandle("rt-1"));
    });

  });
});
