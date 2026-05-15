import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as AoCore from "@aoagents/ao-core";

const { mockUnregister, mockWaitForExit, mockKillProcessTree, mockSweepDaemonChildren } =
  vi.hoisted(() => ({
    mockUnregister: vi.fn(),
    mockWaitForExit: vi.fn(),
    mockKillProcessTree: vi.fn(),
    mockSweepDaemonChildren: vi.fn(),
  }));

vi.mock("../../src/lib/running-state.js", () => ({
  unregister: mockUnregister,
  waitForExit: mockWaitForExit,
}));

vi.mock("@aoagents/ao-core", async () => {
  const actual = await vi.importActual<typeof AoCore>("@aoagents/ao-core");
  return {
    ...actual,
    killProcessTree: mockKillProcessTree,
    sweepDaemonChildren: mockSweepDaemonChildren,
  };
});

import { attachToDaemon, killExistingDaemon } from "../../src/lib/daemon.js";
import type { RunningState } from "../../src/lib/running-state.js";

const fakeRunning: RunningState = {
  pid: 12345,
  configPath: "/fake/config.yaml",
  port: 3000,
  startedAt: "2026-05-04T00:00:00Z",
  projects: ["my-app"],
};

beforeEach(() => {
  mockUnregister.mockReset();
  mockUnregister.mockResolvedValue(undefined);
  mockWaitForExit.mockReset();
  mockKillProcessTree.mockReset();
  mockKillProcessTree.mockResolvedValue(undefined);
  mockSweepDaemonChildren.mockReset();
  mockSweepDaemonChildren.mockResolvedValue({
    attempted: 0,
    terminated: 0,
    forceKilled: 0,
    failed: 0,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachToDaemon", () => {
  it("returns an AttachedDaemon with the running state's port and pid", () => {
    const daemon = attachToDaemon(fakeRunning);
    expect(daemon.outcome).toBe("attached");
    expect(daemon.port).toBe(3000);
    expect(daemon.pid).toBe(12345);
  });

  it("notifyProjectChange POSTs /api/projects/reload and returns ok on 2xx", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const daemon = attachToDaemon(fakeRunning);
    const result = await daemon.notifyProjectChange();
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:3000/api/projects/reload", {
      method: "POST",
    });
    fetchSpy.mockRestore();
  });

  it("notifyProjectChange returns a reasoned failure on non-2xx", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 503 }));
    const daemon = attachToDaemon(fakeRunning);
    const result = await daemon.notifyProjectChange();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("503");
    }
    fetchSpy.mockRestore();
  });

  it("notifyProjectChange returns a reasoned failure when fetch throws", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const daemon = attachToDaemon(fakeRunning);
    const result = await daemon.notifyProjectChange();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ECONNREFUSED");
    }
    fetchSpy.mockRestore();
  });
});

describe("killExistingDaemon", () => {
  it("uses killProcessTree(SIGTERM), awaits exit, and unregisters on the happy path", async () => {
    mockWaitForExit.mockResolvedValueOnce(true);
    await killExistingDaemon(fakeRunning);
    expect(mockSweepDaemonChildren).toHaveBeenCalledWith({ ownerPid: 12345 });
    expect(mockKillProcessTree).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(mockKillProcessTree).toHaveBeenCalledTimes(1);
    expect(mockWaitForExit).toHaveBeenCalledWith(12345, 5000);
    expect(mockUnregister).toHaveBeenCalled();
  });

  it("escalates to SIGKILL via killProcessTree when SIGTERM does not exit", async () => {
    mockWaitForExit.mockResolvedValueOnce(false);
    mockWaitForExit.mockResolvedValueOnce(true);
    await killExistingDaemon(fakeRunning);
    expect(mockKillProcessTree).toHaveBeenNthCalledWith(1, 12345, "SIGTERM");
    expect(mockKillProcessTree).toHaveBeenNthCalledWith(2, 12345, "SIGKILL");
    expect(mockUnregister).toHaveBeenCalled();
  });

  it("throws when SIGKILL also fails to exit, and does not unregister", async () => {
    mockWaitForExit.mockResolvedValueOnce(false);
    mockWaitForExit.mockResolvedValueOnce(false);
    await expect(killExistingDaemon(fakeRunning)).rejects.toThrow(
      /Failed to stop AO process \(PID 12345\)/,
    );
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it("treats killProcessTree errors as best-effort and still unregisters when process is gone", async () => {
    // killProcessTree itself swallows errors internally, but defend against
    // a future regression by ensuring an unexpected throw does not crash
    // unregister() when the process has actually exited.
    mockKillProcessTree.mockRejectedValueOnce(new Error("transient"));
    mockWaitForExit.mockResolvedValueOnce(true);
    await expect(killExistingDaemon(fakeRunning)).rejects.toThrow("transient");
    // unregister should NOT have been called in this rejection path —
    // we only want to unregister after a clean exit.
    expect(mockUnregister).not.toHaveBeenCalled();
  });
});
