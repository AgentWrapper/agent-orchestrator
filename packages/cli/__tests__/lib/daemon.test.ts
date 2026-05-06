import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockUnregister, mockWaitForExit, mockProcessKill } = vi.hoisted(() => ({
  mockUnregister: vi.fn(),
  mockWaitForExit: vi.fn(),
  mockProcessKill: vi.fn(),
}));

vi.mock("../../src/lib/running-state.js", () => ({
  unregister: mockUnregister,
  waitForExit: mockWaitForExit,
}));

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
  mockProcessKill.mockReset();
  // Spy is installed per-test and restored in afterEach so the mocked
  // process.kill cannot leak into sibling test files when Vitest reuses
  // worker threads.
  vi.spyOn(process, "kill").mockImplementation(((
    pid: number,
    signal?: string | number,
  ) => {
    mockProcessKill(pid, signal);
    return true;
  }) as typeof process.kill);
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
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/projects/reload",
      { method: "POST" },
    );
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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));
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
  it("SIGTERMs the daemon, awaits exit, and unregisters on the happy path", async () => {
    mockWaitForExit.mockResolvedValueOnce(true);
    await killExistingDaemon(fakeRunning);
    expect(mockProcessKill).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(mockProcessKill).toHaveBeenCalledTimes(1);
    expect(mockWaitForExit).toHaveBeenCalledWith(12345, 5000);
    expect(mockUnregister).toHaveBeenCalled();
  });

  it("escalates to SIGKILL when SIGTERM does not exit within the timeout", async () => {
    mockWaitForExit.mockResolvedValueOnce(false);
    mockWaitForExit.mockResolvedValueOnce(true);
    await killExistingDaemon(fakeRunning);
    expect(mockProcessKill).toHaveBeenNthCalledWith(1, 12345, "SIGTERM");
    expect(mockProcessKill).toHaveBeenNthCalledWith(2, 12345, "SIGKILL");
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

  it("treats already-dead processes as success (process.kill throws ESRCH)", async () => {
    mockProcessKill.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    mockWaitForExit.mockResolvedValueOnce(true);
    await expect(killExistingDaemon(fakeRunning)).resolves.toBeUndefined();
    expect(mockUnregister).toHaveBeenCalled();
  });
});
