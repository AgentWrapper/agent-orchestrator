import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readFileSync,
  utimesSync,
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
  Workspace,
  RuntimeHandle,
  Session,
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

describe("list", () => {
  it("lists sessions from metadata", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/w1",
      branch: "feat/a",
      status: "working",
      project: "my-app",
    });
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/w2",
      branch: "feat/b",
      status: "pr_open",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list();

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id).sort()).toEqual(["app-1", "app-2"]);
  });

  it("does not backfill role onto foreign bare-id orchestrator records (issue #1048)", async () => {
    // Regression guard for PR #1075 review comment: a legacy record whose id
    // is `{projectId}-orchestrator` (pre-numbered scheme, wrong prefix) must
    // NOT get `role: orchestrator` stamped by the repair-on-read path. If it
    // did, the record would then pass isOrchestratorSession() via the
    // role-metadata branch and leak into the dashboard with an id that
    // doesn't match the canonical `{prefix}-orchestrator-N` shape — which
    // was the root cause of the dashboard/CLI id divergence in issue #1048.
    writeMetadata(sessionsDir, "my-app-orchestrator", {
      worktree: config.projects["my-app"]!.path,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-legacy-bare"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.list("my-app");

    // After list(), the record on disk must still have no role metadata.
    const raw = readMetadataRaw(sessionsDir, "my-app-orchestrator");
    expect(raw).not.toBeNull();
    expect(raw!["role"]).toBeUndefined();
  });

  it("preserves lastActivityAt when read-time repair rewrites metadata", async () => {
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: config.projects["my-app"]!.path,
      branch: "main",
      status: "merged",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: makeHandle("rt-orch"),
    });

    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(join(sessionsDir, "app-orchestrator.json"), oldTime, oldTime);

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list("my-app");
    const orchestrator = sessions.find((session) => session.id === "app-orchestrator");

    expect(orchestrator).toBeDefined();
    expect(orchestrator!.lastActivityAt.getTime()).toBe(oldTime.getTime());

    const repaired = readMetadataRaw(sessionsDir, "app-orchestrator");
    expect(repaired!["pr"]).toBeUndefined();
    expect(repaired!["prAutoDetect"]).toBe("false");
    expect(repaired!["status"]).toBe("working");
  });

  it("persists canonical lifecycle payloads for legacy session metadata on read", async () => {
    writeMetadata(sessionsDir, "app-legacy", {
      worktree: "/tmp/legacy",
      branch: "feat/legacy",
      status: "working",
      project: "my-app",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const oldTime = new Date("2026-01-02T00:00:00.000Z");
    utimesSync(join(sessionsDir, "app-legacy.json"), oldTime, oldTime);

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list("my-app");
    const legacy = sessions.find((session) => session.id === "app-legacy");

    expect(legacy).toBeDefined();
    expect(legacy!.lastActivityAt.getTime()).toBe(oldTime.getTime());

    const repaired = readMetadataRaw(sessionsDir, "app-legacy");
    expect(repaired?.["lifecycle"]).toBeTruthy();

    const payload = JSON.parse(repaired!["lifecycle"]);
    expect(payload.session.startedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(payload.session.lastTransitionAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("filters by project ID", async () => {
    // In hash-based architecture, each project has its own directory
    // so filtering is implicit. This test verifies list(projectId) only
    // returns sessions from that project's directory.
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list("my-app");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("app-1");
  });

  it("preserves owning project ID for legacy metadata missing the project field", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list("my-app");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectId).toBe("my-app");
  });

  it("clears enrichment timeout when enrichment completes quickly", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list();

    expect(sessions).toHaveLength(1);
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("marks dead runtimes as killed", async () => {
    const deadRuntime: Runtime = {
      ...mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return deadRuntime;
        if (slot === "agent") return mockAgent;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithDead });
    const sessions = await sm.list();

    expect(sessions[0].status).toBe("killed");
    expect(sessions[0].activity).toBe("exited");
  });

  it("detects activity using agent-native mechanism", async () => {
    const agentWithState: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    };
    const registryWithState: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithState;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({
      config,
      registry: registryWithState,
    });
    const sessions = await sm.list();

    // Verify getActivityState was called
    expect(agentWithState.getActivityState).toHaveBeenCalled();
    // Verify activity state was set
    expect(sessions[0].activity).toBe("active");
  });

  it.each(["claude-code", "codex", "aider", "opencode"])(
    "uses tmuxName fallback handle for %s activity detection when runtimeHandle is missing",
    async (agentName: string) => {
      const expectedTmuxName = "hash-app-1";
      const selectedAgent: Agent = {
        ...mockAgent,
        name: agentName,
        getActivityState: vi.fn().mockImplementation(async (session: Session) => {
          return {
            state: session.runtimeHandle?.id === expectedTmuxName ? "active" : "exited",
          };
        }),
      };
      const registryWithNamedAgents: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string, name: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent" && name === agentName) return selectedAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };

      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp",
        branch: "a",
        status: "working",
        project: "my-app",
        agent: agentName,
        tmuxName: expectedTmuxName,
        ...(agentName === "opencode" ? { opencodeSessionId: "ses_existing_mapping" } : {}),
      });

      const sm = createSessionManager({ config, registry: registryWithNamedAgents });
      const sessions = await sm.list("my-app");

      expect(sessions).toHaveLength(1);
      expect(sessions[0].runtimeHandle?.id).toBe(expectedTmuxName);
      expect(sessions[0].activity).toBe("active");
      expect(selectedAgent.getActivityState).toHaveBeenCalled();
    },
  );

  it("uses tmuxName fallback handle for runtime liveness checks when runtimeHandle is missing", async () => {
    const expectedTmuxName = "hash-app-1";
    const deadRuntime: Runtime = {
      ...mockRuntime,
      isAlive: vi
        .fn()
        .mockImplementation(async (handle: RuntimeHandle) => handle.id !== expectedTmuxName),
    };
    const agentWithSpy: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    };
    const registryWithDeadRuntime: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return deadRuntime;
        if (slot === "agent") return agentWithSpy;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      tmuxName: expectedTmuxName,
    });

    const sm = createSessionManager({ config, registry: registryWithDeadRuntime });
    const sessions = await sm.list("my-app");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].runtimeHandle?.id).toBe(expectedTmuxName);
    expect(sessions[0].status).toBe("killed");
    expect(sessions[0].activity).toBe("exited");
    expect(agentWithSpy.getActivityState).not.toHaveBeenCalled();
  });

  it("keeps existing activity when getActivityState throws", async () => {
    const agentWithError: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockRejectedValue(new Error("detection failed")),
    };
    const registryWithError: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithError;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithError });
    const sessions = await sm.list();

    // Should keep null (absent) when getActivityState fails
    expect(sessions[0].activity).toBeNull();
    expect(sessions[0].activitySignal.state).toBe("probe_failure");
  });

  it("keeps existing activity when getActivityState returns null", async () => {
    const agentWithNull: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue(null),
    };
    const registryWithNull: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithNull;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithNull });
    const sessions = await sm.list();

    // null = "I don't know" — activity stays null (absent)
    expect(agentWithNull.getActivityState).toHaveBeenCalled();
    expect(sessions[0].activity).toBeNull();
    expect(sessions[0].activitySignal.state).toBe("null");
  });

  it("marks terminal fallback-free stale activity explicitly when timing is missing", async () => {
    const agentWithIdleNoTimestamp: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "idle" }),
    };
    const registryWithStaleSignal: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithIdleNoTimestamp;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithStaleSignal });
    const sessions = await sm.list();

    expect(sessions[0].activity).toBe("idle");
    expect(sessions[0].activitySignal.state).toBe("stale");
  });

  it("updates lastActivityAt when detection timestamp is newer", async () => {
    const newerTimestamp = new Date(Date.now() + 60_000); // 1 minute in the future
    const agentWithTimestamp: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active", timestamp: newerTimestamp }),
    };
    const registryWithTimestamp: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithTimestamp;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithTimestamp });
    const sessions = await sm.list();

    expect(sessions[0].activity).toBe("active");
    // lastActivityAt should be updated to the detection timestamp
    expect(sessions[0].lastActivityAt).toEqual(newerTimestamp);
  });

  it("does not downgrade lastActivityAt when detection timestamp is older", async () => {
    const olderTimestamp = new Date(0); // epoch — definitely older than session creation
    const agentWithOldTimestamp: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active", timestamp: olderTimestamp }),
    };
    const registryWithOldTimestamp: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithOldTimestamp;
        return null;
      }),
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: registryWithOldTimestamp });
    const sessions = await sm.list();

    expect(sessions[0].activity).toBe("active");
    // lastActivityAt should NOT be downgraded to the older detection timestamp
    expect(sessions[0].lastActivityAt.getTime()).toBeGreaterThan(olderTimestamp.getTime());
  });
});

describe("get", () => {
  it("returns session by ID", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      pr: "https://github.com/org/repo/pull/42",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.get("app-1");

    expect(session).not.toBeNull();
    expect(session!.id).toBe("app-1");
    expect(session!.pr).not.toBeNull();
    expect(session!.pr!.number).toBe(42);
    expect(session!.pr!.url).toBe("https://github.com/org/repo/pull/42");
  });

  it("detects activity using agent-native mechanism", async () => {
    const agentWithState: Agent = {
      ...mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "idle" }),
    };
    const registryWithState: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return agentWithState;
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

    const sm = createSessionManager({
      config,
      registry: registryWithState,
    });
    const session = await sm.get("app-1");

    // Verify getActivityState was called
    expect(agentWithState.getActivityState).toHaveBeenCalled();
    // Verify activity state was set
    expect(session!.activity).toBe("idle");
  });

  it("returns null for nonexistent session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    expect(await sm.get("nonexistent")).toBeNull();
  });

  it("assigns owning project ID when loading legacy metadata without project", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.get("app-1");

    expect(session).not.toBeNull();
    expect(session?.projectId).toBe("my-app");
  });

  it("auto-discovers and persists OpenCode session mapping when missing", async () => {
    const deleteLogPath = join(tmpDir, "opencode-get-remap.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        {
          id: "ses_get_discovered",
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
    const session = await sm.get("app-1");

    expect(session).not.toBeNull();
    expect(session?.metadata["opencodeSessionId"]).toBe("ses_get_discovered");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_get_discovered");
  });

  it("reuses a single OpenCode session list lookup when multiple unmapped sessions are listed", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-list-shared.log");
    const listLogPath = join(tmpDir, "opencode-list-shared.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        { id: "ses_get_discovered_1", title: "AO:app-1" },
        { id: "ses_get_discovered_2", title: "AO:app-2" },
      ]),
      deleteLogPath,
      0,
      listLogPath,
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
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-2"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list();

    expect(sessions).toHaveLength(2);
    expect(readMetadataRaw(sessionsDir, "app-1")?.["opencodeSessionId"]).toBe(
      "ses_get_discovered_1",
    );
    expect(readMetadataRaw(sessionsDir, "app-2")?.["opencodeSessionId"]).toBe(
      "ses_get_discovered_2",
    );

    const listInvocations = readFileSync(listLogPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(listInvocations).toHaveLength(1);
  });

  it("preserves arbitrary metadata flags on loaded sessions", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      prAutoDetect: false,
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.get("app-1");

    expect(session).not.toBeNull();
    expect(session!.metadata["prAutoDetect"]).toBe("false");
  });
});
