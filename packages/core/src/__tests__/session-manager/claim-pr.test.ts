import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import {
  writeMetadata,
  readMetadataRaw,
} from "../../metadata.js";
import {
  type OrchestratorConfig,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type Workspace,
  type SCM,
} from "../../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "../test-utils.js";

let ctx: TestContext;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

beforeEach(() => {
  ctx = setupTestContext();
  ({ sessionsDir, mockRuntime, mockAgent, mockWorkspace, mockRegistry, config } = ctx);
});

afterEach(() => {
  teardownTestContext(ctx);
});

describe("claimPR", () => {
  function makeSCM(overrides: Partial<SCM> = {}): SCM {
    return {
      name: "mock-scm",
      detectPR: vi.fn(),
      resolvePR: vi.fn().mockResolvedValue({
        number: 42,
        url: "https://github.com/org/my-app/pull/42",
        title: "Existing PR",
        owner: "org",
        repo: "my-app",
        branch: "feat/existing-pr",
        baseBranch: "main",
        isDraft: false,
      }),
      assignPRToCurrentUser: vi.fn().mockResolvedValue(undefined),
      checkoutPR: vi.fn().mockResolvedValue(true),
      getPRState: vi.fn().mockResolvedValue("open"),
      getPRSummary: vi.fn(),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getMergeability: vi.fn(),
      ...overrides,
    };
  }

  function registryWithSCM(mockSCM: SCM): PluginRegistry {
    return {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, _name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };
  }

  it("claims an open PR and updates session metadata", async () => {
    const mockSCM = makeSCM();

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/old-branch",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-2"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    expect(result.pr.number).toBe(42);
    expect(result.branchChanged).toBe(true);

    expect(mockSCM.resolvePR).toHaveBeenCalledWith("42", config.projects["my-app"]);
    expect(mockSCM.checkoutPR).toHaveBeenCalledWith(result.pr, "/tmp/ws-app-2");

    const raw = readMetadataRaw(sessionsDir, "app-2");
    expect(raw).toMatchObject({
      branch: "feat/existing-pr",
      status: "pr_open",
      pr: "https://github.com/org/my-app/pull/42",
    });
    expect(raw!["prAutoDetect"]).toBeUndefined();
  });

  it("consolidates ownership by disabling PR auto-detect on the previous session", async () => {
    const mockSCM = makeSCM();

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "review_pending",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-1"),
    });

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/other-work",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-2"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    expect(result.takenOverFrom).toEqual(["app-1"]);

    const previous = readMetadataRaw(sessionsDir, "app-1");
    expect(previous!["pr"]).toBeUndefined();
    expect(previous!["prAutoDetect"]).toBe("false");
    expect(previous!["status"]).toBe("working");
  });

  it("ignores legacy orchestrator metadata when claiming a PR", async () => {
    const mockSCM = makeSCM();

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: config.projects["my-app"]!.path,
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-orch"),
    });

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/other-work",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-2"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    expect(result.takenOverFrom).toEqual([]);
    expect(readMetadataRaw(sessionsDir, "app-2")!["pr"]).toBe(
      "https://github.com/org/my-app/pull/42",
    );
  });

  it("repairs legacy orchestrator PR metadata and stale duplicate PR attachments on read", async () => {
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: config.projects["my-app"]!.path,
      branch: "main",
      status: "merged",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-orch"),
    });

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "review_pending",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-1"),
    });

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-2"),
    });

    const staleTime = new Date("2026-01-01T00:00:00.000Z");
    const freshTime = new Date("2026-01-02T00:00:00.000Z");
    utimesSync(join(sessionsDir, "app-1.json"), staleTime, staleTime);
    utimesSync(join(sessionsDir, "app-2.json"), freshTime, freshTime);

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list();

    expect(sessions).toHaveLength(3);

    const orchestrator = readMetadataRaw(sessionsDir, "app-orchestrator");
    expect(orchestrator!["role"]).toBe("orchestrator");
    expect(orchestrator!["pr"]).toBeUndefined();
    expect(orchestrator!["prAutoDetect"]).toBe("false");
    expect(orchestrator!["status"]).toBe("working");

    const staleWorker = readMetadataRaw(sessionsDir, "app-1");
    expect(staleWorker!["pr"]).toBeUndefined();
    expect(staleWorker!["prAutoDetect"]).toBe("false");
    expect(staleWorker!["status"]).toBe("working");

    const activeWorker = readMetadataRaw(sessionsDir, "app-2");
    expect(activeWorker!["pr"]).toBe("https://github.com/org/my-app/pull/42");
    expect(activeWorker!["status"]).toBe("pr_open");
  });

  it("repairs stale duplicate PR attachments before claim conflict checks", async () => {
    const mockSCM = makeSCM();

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "review_pending",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-1"),
    });
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-2"),
    });
    writeMetadata(sessionsDir, "app-3", {
      worktree: "/tmp/ws-app-3",
      branch: "feat/other-work",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-3"),
    });

    const staleTime = new Date("2026-01-01T00:00:00.000Z");
    const freshTime = new Date("2026-01-02T00:00:00.000Z");
    utimesSync(join(sessionsDir, "app-1.json"), staleTime, staleTime);
    utimesSync(join(sessionsDir, "app-2.json"), freshTime, freshTime);

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-3", "42");

    expect(result.takenOverFrom).toEqual(["app-2"]);

    const staleWorker = readMetadataRaw(sessionsDir, "app-1");
    expect(staleWorker!["pr"]).toBeUndefined();
    expect(staleWorker!["prAutoDetect"]).toBe("false");

    const activeWorker = readMetadataRaw(sessionsDir, "app-2");
    expect(activeWorker!["pr"]).toBeUndefined();
    expect(activeWorker!["prAutoDetect"]).toBe("false");

    const claimant = readMetadataRaw(sessionsDir, "app-3");
    expect(claimant!["pr"]).toBe("https://github.com/org/my-app/pull/42");
  });

  it("automatically consolidates ownership when another session tracks the PR", async () => {
    const mockSCM = makeSCM();

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-1"),
    });

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/other-work",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-2"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    expect(result.takenOverFrom).toContain("app-1");
    expect(result.pr.number).toBe(42);

    const app2 = readMetadataRaw(sessionsDir, "app-2");
    expect(app2!["pr"]).toBe("https://github.com/org/my-app/pull/42");
    expect(app2!["status"]).toBe("pr_open");

    const app1 = readMetadataRaw(sessionsDir, "app-1");
    expect(app1!["pr"] ?? "").toBe("");
    expect(app1!["status"]).toBe("working");
  });

  it("keeps AO metadata updated even if GitHub assignment fails", async () => {
    const mockSCM = makeSCM({
      assignPRToCurrentUser: vi.fn().mockRejectedValue(new Error("permission denied")),
    });

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/old-branch",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-2"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42", { assignOnGithub: true });

    expect(result.githubAssigned).toBe(false);
    expect(result.githubAssignmentError).toContain("permission denied");

    const raw = readMetadataRaw(sessionsDir, "app-2");
    expect(raw!["pr"]).toBe("https://github.com/org/my-app/pull/42");
    expect(raw!["status"]).toBe("pr_open");
  });

  // RULE B: One session may own multiple PRs sequentially (switching ownership)
  it("allows same session to claim different PRs sequentially without rejection", async () => {
    const mockSCM = makeSCM({
      resolvePR: vi
        .fn()
        .mockResolvedValueOnce({
          number: 42,
          url: "https://github.com/org/my-app/pull/42",
          title: "First PR",
          owner: "org",
          repo: "my-app",
          branch: "feat/first-pr",
          baseBranch: "main",
          isDraft: false,
        })
        .mockResolvedValueOnce({
          number: 99,
          url: "https://github.com/org/my-app/pull/99",
          title: "Second PR",
          owner: "org",
          repo: "my-app",
          branch: "feat/second-pr",
          baseBranch: "main",
          isDraft: false,
        }),
      checkoutPR: vi.fn().mockResolvedValue(true),
    });

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/initial",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });

    // Claim first PR
    const result1 = await sm.claimPR("app-1", "42");
    expect(result1.pr.number).toBe(42);
    expect(result1.takenOverFrom).toEqual([]);

    let raw = readMetadataRaw(sessionsDir, "app-1");
    expect(raw!["pr"]).toBe("https://github.com/org/my-app/pull/42");

    // Claim second PR (switches ownership, no rejection)
    const result2 = await sm.claimPR("app-1", "99");
    expect(result2.pr.number).toBe(99);
    expect(result2.takenOverFrom).toEqual([]);

    raw = readMetadataRaw(sessionsDir, "app-1");
    expect(raw!["pr"]).toBe("https://github.com/org/my-app/pull/99");
    expect(raw!["branch"]).toBe("feat/second-pr");
  });

  // Idempotent re-claim by same owner
  it("handles idempotent re-claim of same PR by same session", async () => {
    const mockSCM = makeSCM();

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });

    // Re-claim same PR - should succeed without consolidation
    const result = await sm.claimPR("app-1", "42");
    expect(result.pr.number).toBe(42);
    expect(result.takenOverFrom).toEqual([]);

    const raw = readMetadataRaw(sessionsDir, "app-1");
    expect(raw!["pr"]).toBe("https://github.com/org/my-app/pull/42");
  });

  // Stale/dead prior owner handoff
  it("consolidates from stale/dead prior owner regardless of status", async () => {
    const mockSCM = makeSCM();

    // Prior owner in "spawning" state (stuck/dead)
    writeMetadata(sessionsDir, "app-stale", {
      worktree: "/tmp/ws-app-stale",
      branch: "feat/existing-pr",
      status: "spawning", // Stuck in spawning
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-stale"),
    });

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/other",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-2"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    // Consolidation happens regardless of prior owner's status
    expect(result.takenOverFrom).toContain("app-stale");
    expect(result.pr.number).toBe(42);

    // Prior owner is displaced
    const staleRaw = readMetadataRaw(sessionsDir, "app-stale");
    expect(staleRaw!["pr"] ?? "").toBe("");
    expect(staleRaw!["status"]).toBe("spawning"); // Status unchanged (not a PR-tracking status)
  });

  // RULE A: Exclusive PR->agent mapping - explicit test
  it("ensures exclusive PR ownership (only one active owner per PR)", async () => {
    const mockSCM = makeSCM();

    // First session owns the PR
    writeMetadata(sessionsDir, "app-owner", {
      worktree: "/tmp/ws-owner",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-owner"),
    });

    // Second session wants to claim the same PR
    writeMetadata(sessionsDir, "app-new", {
      worktree: "/tmp/ws-new",
      branch: "feat/other",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-new"),
    });

    const sm = createSessionManager({ config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-new", "42");

    // New owner succeeds, old owner is displaced
    expect(result.takenOverFrom).toEqual(["app-owner"]);

    const newOwner = readMetadataRaw(sessionsDir, "app-new");
    expect(newOwner!["pr"]).toBe("https://github.com/org/my-app/pull/42");

    const oldOwner = readMetadataRaw(sessionsDir, "app-owner");
    expect(oldOwner!["pr"] ?? "").toBe("");
  });
});
