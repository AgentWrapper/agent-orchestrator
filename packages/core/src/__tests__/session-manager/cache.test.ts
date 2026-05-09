import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSessionManager } from "../../session-manager.js";
import { writeMetadata } from "../../metadata.js";
import type { Agent, OrchestratorConfig, PluginRegistry } from "../../types.js";
import {
  setupTestContext,
  teardownTestContext,
  makeHandle,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;
let sessionsDir: string;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

beforeEach(() => {
  ctx = setupTestContext();
  ({ sessionsDir, mockAgent, mockRegistry, config } = ctx);
});

afterEach(() => {
  teardownTestContext(ctx);
});

describe("listCached", () => {
  it("returns same sessions as list() on first call (cold cache)", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/w1",
      branch: "feat/a",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const direct = await sm.list();
    const cached = await sm.listCached();

    expect(cached.map((s) => s.id)).toEqual(direct.map((s) => s.id));
  });

  it("serves from cache on second call without re-reading disk", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/w1",
      branch: "feat/a",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });

    // Warm the cache
    const first = await sm.listCached();
    expect(first).toHaveLength(1);

    // Write a second session to disk — cache should NOT see it
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/w2",
      branch: "feat/b",
      status: "working",
      project: "my-app",
    });

    const second = await sm.listCached();
    // Still 1 — served from cache, disk write not reflected
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("app-1");
  });

  it("serves stale data immediately after TTL expires and refreshes in background", async () => {
    vi.useFakeTimers();
    try {
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/w1",
        branch: "feat/a",
        status: "working",
        project: "my-app",
      });

      const sm = createSessionManager({ config, registry: mockRegistry });

      // Warm the cache at t=0
      vi.setSystemTime(new Date(0));
      const first = await sm.listCached();
      expect(first).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(0);

      // Add a session to disk while cache is warm
      writeMetadata(sessionsDir, "app-2", {
        worktree: "/tmp/w2",
        branch: "feat/b",
        status: "working",
        project: "my-app",
      });

      // Advance time past 35s TTL
      vi.setSystemTime(new Date(36_000));
      const afterExpiry = await sm.listCached();
      // Stale-while-revalidate: the caller gets the old snapshot immediately.
      expect(afterExpiry).toHaveLength(1);

      // The background refresh then updates the cache for the next caller.
      await vi.waitFor(async () => {
        expect(await sm.listCached()).toHaveLength(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a metadata snapshot on cold cache without waiting for stalled enrichment", async () => {
    vi.useFakeTimers();
    try {
      const agentWithStuckState: Agent = {
        ...mockAgent,
        getActivityState: vi.fn(() => new Promise<null>(() => {})),
        getSessionInfo: vi.fn().mockResolvedValue(null),
      };
      const registryWithStuckState: PluginRegistry = {
        ...mockRegistry,
        get: vi
          .fn()
          .mockImplementation((slot: Parameters<PluginRegistry["get"]>[0], name: string) => {
            if (slot === "agent") return agentWithStuckState;
            return mockRegistry.get(slot, name);
          }),
      };

      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/w1",
        branch: "feat/a",
        status: "working",
        project: "my-app",
        runtimeHandle: makeHandle("rt-1"),
      });

      const sm = createSessionManager({ config, registry: registryWithStuckState });
      const cached = await sm.listCached();

      expect(cached).toHaveLength(1);
      expect(cached[0]!.id).toBe("app-1");
      expect(cached[0]!.activity).toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(agentWithStuckState.getActivityState).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(12_100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reflects new session immediately after spawn (cache invalidated)", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    // Warm cache with empty list
    const empty = await sm.listCached();
    expect(empty).toHaveLength(0);

    // Spawn invalidates cache
    await sm.spawn({
      projectId: "my-app",
      prompt: "fix bug",
    });

    // listCached must now hit disk and find the new session
    const afterSpawn = await sm.listCached();
    expect(afterSpawn).toHaveLength(1);
  });

  it("reflects session status change immediately after kill (cache invalidated)", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/w1",
      branch: "feat/a",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });

    // Warm cache
    const before = await sm.listCached();
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("working");

    // Kill invalidates cache
    await sm.kill("app-1");

    // listCached must hit disk and see the session is now terminated
    const after = await sm.listCached();
    expect(after).toHaveLength(1);
    expect(after[0].status).toMatch(/killed|terminated/);
  });

  it("explicit invalidateCache() forces the next listCached to re-read disk", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/w1",
      branch: "feat/a",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });

    // Warm the cache
    const first = await sm.listCached();
    expect(first).toHaveLength(1);

    // Simulate an external mutation (e.g. lifecycle-manager writing metadata
    // directly via the imported updateMetadata) followed by the required
    // invalidateCache() call.
    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/w2",
      branch: "feat/b",
      status: "working",
      project: "my-app",
    });
    sm.invalidateCache();

    // Next call must re-read disk and pick up app-2
    const after = await sm.listCached();
    expect(after).toHaveLength(2);
  });

  it("filters by projectId when provided", async () => {
    // Add second project to config
    const multiConfig: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "other-app": {
          name: "Other App",
          repo: "org/other-app",
          path: ctx.tmpDir + "/other-app",
          defaultBranch: "main",
          sessionPrefix: "other",
          scm: { plugin: "github" },
        },
      },
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/w1",
      branch: "feat/a",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManager({ config: multiConfig, registry: mockRegistry });

    // Warm full cache (no projectId → all projects)
    const all = await sm.listCached();
    expect(all.some((s) => s.projectId === "my-app")).toBe(true);

    // Filtered call uses the cached data
    const filtered = await sm.listCached("my-app");
    expect(filtered.every((s) => s.projectId === "my-app")).toBe(true);
  });
});
