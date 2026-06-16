import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { LoadedConfig, ProjectConfig } from "@aoagents/ao-core";
import {
  DEFAULT_DAEMON_URL,
  DaemonUnreachableError,
  buildProjectPlan,
  buildRewriteConfig,
  isValidRewriteProjectId,
  mapHarness,
  mapPermission,
  resolveDaemonUrl,
  runMigrate,
} from "../../src/lib/migrate.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My Project",
    path: "/repos/my-project",
    defaultBranch: "main",
    sessionPrefix: "mp",
    ...overrides,
  } as ProjectConfig;
}

function loaded(
  projects: Record<string, ProjectConfig>,
  degraded: LoadedConfig["degradedProjects"] = {},
): LoadedConfig {
  return { projects, degradedProjects: degraded } as unknown as LoadedConfig;
}

interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

/** Build a fetch stub from a (path, method) → {status, body} responder. */
function fakeFetch(
  responder: (path: string, method: string, body: unknown) => { status: number; body?: string },
  calls: FakeCall[] = [],
): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body });
    const { status, body: respBody } = responder(path, method, body);
    return {
      status,
      text: async () => respBody ?? "",
    } as Response;
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// resolveDaemonUrl
// ---------------------------------------------------------------------------

describe("resolveDaemonUrl", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.AO_DAEMON_URL;
    delete process.env.AO_PORT;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("prefers the explicit flag and strips a trailing slash", () => {
    expect(resolveDaemonUrl("http://127.0.0.1:9/")).toBe("http://127.0.0.1:9");
  });
  it("falls back to AO_DAEMON_URL", () => {
    process.env.AO_DAEMON_URL = "http://host:1234";
    expect(resolveDaemonUrl()).toBe("http://host:1234");
  });
  it("builds a loopback url from AO_PORT", () => {
    process.env.AO_PORT = "4567";
    expect(resolveDaemonUrl()).toBe("http://127.0.0.1:4567");
  });
  it("uses the rewrite default when nothing is set", () => {
    expect(resolveDaemonUrl()).toBe(DEFAULT_DAEMON_URL);
  });
});

// ---------------------------------------------------------------------------
// isValidRewriteProjectId
// ---------------------------------------------------------------------------

describe("isValidRewriteProjectId", () => {
  it("accepts legacy-style ids (a strict subset of the rewrite grammar)", () => {
    expect(isValidRewriteProjectId("agent-orchestrator")).toBe(true);
    expect(isValidRewriteProjectId("repo_1")).toBe(true);
  });
  it("rejects empty, dot-dot, and path separators", () => {
    expect(isValidRewriteProjectId("")).toBe(false);
    expect(isValidRewriteProjectId(".")).toBe(false);
    expect(isValidRewriteProjectId("a..b")).toBe(false);
    expect(isValidRewriteProjectId("a/b")).toBe(false);
    expect(isValidRewriteProjectId("a\\b")).toBe(false);
    expect(isValidRewriteProjectId(".hidden")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapPermission / mapHarness
// ---------------------------------------------------------------------------

describe("mapPermission", () => {
  it("maps each legacy mode per #247 §3", () => {
    expect(mapPermission("permissionless")).toEqual({ mode: "bypass-permissions", lossy: false });
    expect(mapPermission("skip")).toEqual({ mode: "bypass-permissions", lossy: false });
    expect(mapPermission("auto-edit")).toEqual({ mode: "accept-edits", lossy: false });
    expect(mapPermission("default")).toEqual({ mode: "default", lossy: false });
  });
  it("flags suggest and unknown values as lossy", () => {
    expect(mapPermission("suggest")).toEqual({ mode: "default", lossy: true });
    expect(mapPermission("wat")).toEqual({ mode: "default", lossy: true });
  });
  it("returns null for unset", () => {
    expect(mapPermission(undefined)).toBeNull();
    expect(mapPermission("")).toBeNull();
  });
});

describe("mapHarness", () => {
  it("passes through harnesses the rewrite knows", () => {
    expect(mapHarness("claude-code")).toBe("claude-code");
    expect(mapHarness("codex")).toBe("codex");
    expect(mapHarness("opencode")).toBe("opencode");
  });
  it("returns null for unknown or unset", () => {
    expect(mapHarness("frobnicator")).toBeNull();
    expect(mapHarness(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildRewriteConfig
// ---------------------------------------------------------------------------

describe("buildRewriteConfig", () => {
  it("omits a 'main' default branch and keeps a non-main one", () => {
    const notes: string[] = [];
    expect(buildRewriteConfig(project({ defaultBranch: "main" }), notes)).toBeNull();
    expect(buildRewriteConfig(project({ defaultBranch: "develop" }), [])).toEqual({
      defaultBranch: "develop",
    });
  });

  it("carries env, symlinks, and postCreate verbatim", () => {
    const config = buildRewriteConfig(
      project({
        defaultBranch: "main",
        env: { FOO: "bar" },
        symlinks: [".env"],
        postCreate: ["pnpm i"],
      }),
      [],
    );
    expect(config).toEqual({
      env: { FOO: "bar" },
      symlinks: [".env"],
      postCreate: ["pnpm i"],
    });
  });

  it("remaps the agent permission and notes a lossy suggest", () => {
    const notes: string[] = [];
    const config = buildRewriteConfig(
      project({ agentConfig: { model: "opus", permissions: "suggest" } }),
      notes,
    );
    expect(config).toEqual({ agentConfig: { model: "opus", permissions: "default" } });
    expect(notes.join()).toMatch(/lossily/);
  });

  it("maps worker/orchestrator harness and drops unknown ones with a note", () => {
    const notes: string[] = [];
    const config = buildRewriteConfig(
      project({
        worker: { agent: "codex", agentConfig: { permissions: "auto-edit" } },
        orchestrator: { agent: "frobnicator" },
      }),
      notes,
    );
    expect(config).toEqual({
      worker: { agent: "codex", agentConfig: { permissions: "accept-edits" } },
    });
    expect(notes.join()).toMatch(/frobnicator.*dropped/);
  });

  it("notes project-level fields with no rewrite home", () => {
    const notes: string[] = [];
    buildRewriteConfig(
      project({
        tracker: { provider: "github" } as ProjectConfig["tracker"],
        agentRules: "be nice",
      }),
      notes,
    );
    expect(notes.join()).toMatch(/no rewrite home dropped: tracker, rules/);
  });
});

// ---------------------------------------------------------------------------
// buildProjectPlan
// ---------------------------------------------------------------------------

describe("buildProjectPlan", () => {
  it("uses the legacy id and path, and only sends a name that differs from the id", () => {
    const withName = buildProjectPlan("my-project", project({ name: "Pretty Name" }));
    expect(withName.add).toEqual({
      path: "/repos/my-project",
      projectId: "my-project",
      name: "Pretty Name",
    });

    const nameEqualsId = buildProjectPlan("my-project", project({ name: "my-project" }));
    expect(nameEqualsId.add).toEqual({ path: "/repos/my-project", projectId: "my-project" });
  });
});

// ---------------------------------------------------------------------------
// runMigrate
// ---------------------------------------------------------------------------

describe("runMigrate", () => {
  it("plans without any network calls on a dry run", async () => {
    const calls: FakeCall[] = [];
    const summary = await runMigrate({
      daemonUrl: "http://d",
      dryRun: true,
      config: loaded({ a: project({ defaultBranch: "develop" }) }),
      fetchImpl: fakeFetch(() => ({ status: 500 }), calls),
    });
    expect(calls).toHaveLength(0);
    expect(summary.results[0]).toMatchObject({ outcome: "planned", configApplied: true });
  });

  it("creates a project and applies its config", async () => {
    const calls: FakeCall[] = [];
    const summary = await runMigrate({
      daemonUrl: "http://d",
      dryRun: false,
      config: loaded({ a: project({ defaultBranch: "develop" }) }),
      fetchImpl: fakeFetch((path, method) => {
        if (method === "GET") return { status: 200, body: "[]" };
        if (method === "POST") return { status: 201, body: "{}" };
        if (method === "PUT") return { status: 200, body: "{}" };
        return { status: 500 };
      }, calls),
    });
    expect(summary.results[0]).toMatchObject({ outcome: "created", configApplied: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/projects",
      "POST /api/v1/projects",
      "PUT /api/v1/projects/a/config",
    ]);
  });

  it("skips a project already present in the new system (409)", async () => {
    const summary = await runMigrate({
      daemonUrl: "http://d",
      dryRun: false,
      config: loaded({ a: project() }),
      fetchImpl: fakeFetch((_path, method) =>
        method === "GET" ? { status: 200, body: "[]" } : { status: 409, body: "{}" },
      ),
    });
    expect(summary.results[0]).toMatchObject({ outcome: "skipped-conflict" });
  });

  it("reports the rewrite error envelope on a failed create", async () => {
    const summary = await runMigrate({
      daemonUrl: "http://d",
      dryRun: false,
      config: loaded({ a: project() }),
      fetchImpl: fakeFetch((_path, method) =>
        method === "GET"
          ? { status: 200, body: "[]" }
          : { status: 400, body: JSON.stringify({ error: { code: "NOT_A_GIT_REPO", message: "nope" } }) },
      ),
    });
    expect(summary.results[0]).toMatchObject({ outcome: "error", error: "NOT_A_GIT_REPO: nope" });
  });

  it("keeps a created project even when its config write fails", async () => {
    const summary = await runMigrate({
      daemonUrl: "http://d",
      dryRun: false,
      config: loaded({ a: project({ defaultBranch: "develop" }) }),
      fetchImpl: fakeFetch((_path, method) => {
        if (method === "GET") return { status: 200, body: "[]" };
        if (method === "POST") return { status: 201, body: "{}" };
        return { status: 400, body: JSON.stringify({ error: { code: "INVALID_PROJECT_CONFIG" } }) };
      }),
    });
    expect(summary.results[0]).toMatchObject({ outcome: "created", configApplied: false });
    expect(summary.results[0]!.notes.join()).toMatch(/config write failed/);
  });

  it("reports degraded projects as skipped without calling the daemon", async () => {
    const calls: FakeCall[] = [];
    const summary = await runMigrate({
      daemonUrl: "http://d",
      dryRun: false,
      config: loaded({}, { broken: { projectId: "broken", path: "/x", resolveError: "gone" } }),
      fetchImpl: fakeFetch(() => ({ status: 200, body: "[]" }), calls),
    });
    expect(calls).toHaveLength(0);
    expect(summary.results[0]).toMatchObject({ outcome: "skipped-degraded" });
  });

  it("skips a project whose id fails rewrite validation, without a create call", async () => {
    const calls: FakeCall[] = [];
    const summary = await runMigrate({
      daemonUrl: "http://d",
      dryRun: false,
      config: loaded({ "bad/id": project({ path: "/x" }) }),
      fetchImpl: fakeFetch(() => ({ status: 200, body: "[]" }), calls),
    });
    // Only the liveness probe; no POST for the invalid id.
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(summary.results[0]).toMatchObject({ outcome: "skipped-invalid-id" });
  });

  it("raises DaemonUnreachableError when the probe cannot connect", async () => {
    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      runMigrate({
        daemonUrl: "http://d",
        dryRun: false,
        config: loaded({ a: project() }),
        fetchImpl: throwing,
      }),
    ).rejects.toBeInstanceOf(DaemonUnreachableError);
  });
});
