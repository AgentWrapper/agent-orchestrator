/**
 * Tests for resolve-project.ts activity-event instrumentation (issue #1654).
 *
 * Covers MUST emits:
 *   - cli.project_resolve_failed (clone failure inside fromUrl)
 *   - cli.config_recovery_failed (registerFlatConfig returns null)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as AoCore from "@aoagents/ao-core";

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AoCore>();
  return {
    ...actual,
    recordActivityEvent: vi.fn(),
    // resolveCloneTarget points to a tmp dir; isRepoAlreadyCloned forces the
    // clone path so cloneRepo is invoked (and can throw).
    resolveCloneTarget: () => "/tmp/__ao_test_clone_target__",
    isRepoAlreadyCloned: () => false,
    loadConfig: () => ({
      configPath: "/tmp/__ao_test_global_config__",
      projects: {},
    }),
  };
});

vi.mock("../../src/lib/startup-preflight.js", () => ({
  ensureGit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  findFreePort: vi.fn().mockResolvedValue(3000),
}));

vi.mock("../../src/lib/shell.js", () => ({
  git: vi.fn().mockResolvedValue({ stdout: "" }),
}));

import { resolveOrCreateProject } from "../../src/lib/resolve-project.js";

const recordedEvents = (): Array<Record<string, unknown>> =>
  vi.mocked(AoCore.recordActivityEvent).mock.calls.map((c) => c[0] as Record<string, unknown>);

describe("resolve-project — activity events", () => {
  beforeEach(() => {
    vi.mocked(AoCore.recordActivityEvent).mockClear();
  });

  it("emits cli.project_resolve_failed when cloneRepo throws (URL into running daemon)", async () => {
    const cloneRepo = vi.fn(
      async (_parsed: AoCore.ParsedRepoUrl, _target: string, _cwd: string) => {
        throw new Error("network down");
      },
    );

    await expect(
      resolveOrCreateProject(
        "https://github.com/foo/bar",
        {
          addProjectToConfig: vi.fn(),
          autoCreateConfig: vi.fn(),
          resolveProject: vi.fn(),
          resolveProjectByRepo: vi.fn(),
          registerFlatConfig: vi.fn().mockResolvedValue(null),
          cloneRepo,
        },
        // targetGlobalRegistry: true → exercises fromUrlIntoGlobal
        { targetGlobalRegistry: true },
      ),
    ).rejects.toThrow(/Failed to clone/);

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.project_resolve_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          ownerRepo: "foo/bar",
          errorMessage: "network down",
        }),
      }),
    );
  });

  it("emits cli.config_recovery_failed when registerFlatConfig returns null", async () => {
    // Trigger fromCwdOrId via undefined arg; if loadConfig() throws something
    // other than ConfigNotFoundError, the recovery path runs and asks
    // registerFlatConfig to fix it.
    //
    // Here we force the recovery path to fail by stubbing the deps so that:
    //   1. autoCreateConfig is not invoked (fromCwdOrId only calls it when
    //      loadConfig throws ConfigNotFoundError — we trigger a different
    //      error so the registerFlatConfig branch runs).
    //   2. registerFlatConfig returns null (recovery fails).
    //
    // We can't easily make the real loadConfig() throw a non-ConfigNotFoundError
    // synchronously, so instead we patch findConfigFile via the mocked module
    // surface. The simplest, robust approach: simulate the public call shape
    // and assert that whenever `registerFlatConfig` returns null, the event
    // fires at the call site. To do that we drive the function with a
    // controlled cwd that lacks a parseable config but has a config file
    // present — replicated by stubbing findConfigFile in @aoagents/ao-core.

    // Reach into the same module mock by re-mocking findConfigFile + loadConfig.
    vi.doMock("@aoagents/ao-core", async (importOriginal) => {
      const actual = await importOriginal<typeof AoCore>();
      return {
        ...actual,
        recordActivityEvent: vi.mocked(AoCore.recordActivityEvent),
        // findConfigFile returns a path so the recovery branch runs.
        findConfigFile: () => "/tmp/__ao_test_flat_config__",
        // loadConfig throws a generic Error (not ConfigNotFoundError) so the
        // catch block falls into the registerFlatConfig recovery branch.
        loadConfig: () => {
          throw new Error("malformed config");
        },
      };
    });

    vi.resetModules();
    const { resolveOrCreateProject: resolveOrCreateProjectReloaded } =
      await import("../../src/lib/resolve-project.js");
    // Re-grab the mock so cleared calls inside the doMock factory don't get lost.
    const { recordActivityEvent: reloadedRecord } = await import("@aoagents/ao-core");
    vi.mocked(reloadedRecord).mockClear();

    await expect(
      resolveOrCreateProjectReloaded(
        undefined,
        {
          addProjectToConfig: vi.fn(),
          autoCreateConfig: vi.fn(),
          resolveProject: vi.fn(),
          resolveProjectByRepo: vi.fn(),
          registerFlatConfig: vi.fn().mockResolvedValue(null),
          cloneRepo: vi.fn(),
        },
        {},
      ),
    ).rejects.toThrow(/malformed config/);

    const events = vi.mocked(reloadedRecord).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.config_recovery_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          configPath: "/tmp/__ao_test_flat_config__",
          errorMessage: "malformed config",
        }),
      }),
    );

    vi.doUnmock("@aoagents/ao-core");
  });
});
