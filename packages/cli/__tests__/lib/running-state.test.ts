import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as fsModule from "node:fs";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const testHome = join(process.cwd(), ".tmp-running-state-home");

const { mockFsyncSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockFsyncSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => testHome,
}));

// Wrap node:fs so we can observe fsyncSync calls without breaking ESM
// namespace immutability (vi.spyOn on a node:fs export errors out).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return {
    ...actual,
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      mockFsyncSync(...args);
      return actual.fsyncSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const override = mockWriteFileSync(...args);
      if (override === "throw") {
        throw new Error("synthetic disk-full");
      }
      return actual.writeFileSync(...args);
    },
  };
});

describe("running-state", () => {
  beforeEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
    // The hoisted node:fs wrappers persist across tests; reset their
    // implementations so a previous test's mockImplementation can't
    // leak into the next.
    mockFsyncSync.mockReset();
    mockWriteFileSync.mockReset();
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("keeps running.json when the pid probe returns EPERM", async () => {
    const runningState = await import("../../src/lib/running-state.js");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted") as Error & { code?: string };
      error.code = "EPERM";
      throw error;
    });

    await runningState.register({
      pid: 424242,
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 4321,
      startedAt: new Date("2026-04-19T00:00:00.000Z").toISOString(),
      projects: ["my-app"],
    });

    const state = await runningState.getRunning();
    const stateFile = join(testHome, ".agent-orchestrator", "running.json");

    expect(state).toEqual({
      pid: 424242,
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 4321,
      startedAt: new Date("2026-04-19T00:00:00.000Z").toISOString(),
      projects: ["my-app"],
    });
    expect(existsSync(stateFile)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(424242, 0);
  });

  it("writeLastStop fsyncs the temp file before renaming so the record survives SIGKILL (issue #1743)", async () => {
    mockFsyncSync.mockClear();
    const runningState = await import("../../src/lib/running-state.js");

    await runningState.writeLastStop({
      stoppedAt: "2026-05-08T17:53:15.909Z",
      projectId: "my-app",
      sessionIds: ["app-1", "app-2"],
    });

    const lastStopFile = join(testHome, ".agent-orchestrator", "last-stop.json");
    expect(existsSync(lastStopFile)).toBe(true);
    expect(JSON.parse(readFileSync(lastStopFile, "utf-8"))).toEqual({
      stoppedAt: "2026-05-08T17:53:15.909Z",
      projectId: "my-app",
      sessionIds: ["app-1", "app-2"],
    });
    expect(mockFsyncSync).toHaveBeenCalled();
  });

  it("writeLastStop leaves no temp file behind when the write itself throws", async () => {
    // Match on the payload so the synthetic failure only fires on the
    // data write, not the lockfile metadata write that fires first.
    const marker = "marker-1743-disk-full";
    mockWriteFileSync.mockImplementation((_fd: number, content: string) =>
      typeof content === "string" && content.includes(marker) ? "throw" : undefined,
    );
    const runningState = await import("../../src/lib/running-state.js");

    await expect(
      runningState.writeLastStop({
        stoppedAt: "2026-05-08T17:53:15.909Z",
        projectId: marker,
        sessionIds: ["app-1"],
      }),
    ).rejects.toThrow("synthetic disk-full");

    const stateDir = join(testHome, ".agent-orchestrator");
    const stale = existsSync(stateDir)
      ? readdirSync(stateDir).filter((n) => n.startsWith("last-stop.json.tmp."))
      : [];
    expect(stale).toEqual([]);
    expect(existsSync(join(stateDir, "last-stop.json"))).toBe(false);
  });

  it("readLastStop round-trips otherProjects through writeLastStop", async () => {
    const runningState = await import("../../src/lib/running-state.js");

    await runningState.writeLastStop({
      stoppedAt: "2026-05-08T17:53:15.909Z",
      projectId: "my-app",
      sessionIds: ["app-1"],
      otherProjects: [{ projectId: "other-app", sessionIds: ["other-1", "other-2"] }],
    });

    const read = await runningState.readLastStop();
    expect(read).toEqual({
      stoppedAt: "2026-05-08T17:53:15.909Z",
      projectId: "my-app",
      sessionIds: ["app-1"],
      otherProjects: [{ projectId: "other-app", sessionIds: ["other-1", "other-2"] }],
    });
  });

  // Greptile P1 on PR #1780: after the user decides on a previous stop,
  // we leave an empty marker on disk so the fallback in `ao start` doesn't
  // surface the same sessions on the next invocation.
  it("markLastStopAcknowledged writes a present but empty marker readable by readLastStop", async () => {
    const runningState = await import("../../src/lib/running-state.js");

    await runningState.markLastStopAcknowledged("my-app");

    const lastStopFile = join(testHome, ".agent-orchestrator", "last-stop.json");
    expect(existsSync(lastStopFile)).toBe(true);

    const read = await runningState.readLastStop();
    expect(read).not.toBeNull();
    expect(read?.projectId).toBe("my-app");
    expect(read?.sessionIds).toEqual([]);
    expect(read?.otherProjects).toBeUndefined();
    expect(typeof read?.stoppedAt).toBe("string");
  });

  it("keeps startup locks alive when the pid probe returns EPERM", async () => {
    const runningState = await import("../../src/lib/running-state.js");
    const lockDir = join(testHome, ".agent-orchestrator");
    const lockFile = join(lockDir, "startup.lock");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted") as Error & { code?: string };
      error.code = "EPERM";
      throw error;
    });

    const release = await runningState.acquireStartupLock(100);

    await expect(runningState.acquireStartupLock(100)).rejects.toThrow(
      `Could not acquire startup lock (${lockFile})`,
    );
    expect(readFileSync(lockFile, "utf-8")).toContain(`"pid":${process.pid}`);

    release();
    expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
  });
});
