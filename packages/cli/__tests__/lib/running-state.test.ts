import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const testHome = join(process.cwd(), ".tmp-running-state-home");

vi.mock("node:os", () => ({
  homedir: () => testHome,
}));

describe("running-state", () => {
  beforeEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
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
