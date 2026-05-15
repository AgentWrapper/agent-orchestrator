import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

import { preventIdleSleep } from "../../src/lib/prevent-sleep.js";

// Store original platform descriptor for safe restoration
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

beforeEach(() => {
  mockSpawn.mockReset();
});

afterEach(() => {
  restorePlatform();
});

describe("preventIdleSleep", () => {
  describe("on macOS", () => {
    beforeEach(() => {
      setPlatform("darwin");
    });

    it("spawns caffeinate with correct arguments", () => {
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      const handle = preventIdleSleep();

      expect(mockSpawn).toHaveBeenCalledWith(
        "caffeinate",
        ["-i", "-w", String(process.pid)],
        { stdio: "ignore", detached: true },
      );
      expect(mockChild.unref).toHaveBeenCalled();
      expect(handle).not.toBeNull();
    });

    it("spawns caffeinate with custom pid", () => {
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      const customPid = 12345;
      preventIdleSleep(customPid);

      expect(mockSpawn).toHaveBeenCalledWith(
        "caffeinate",
        ["-i", "-w", String(customPid)],
        { stdio: "ignore", detached: true },
      );
    });

    it("returns handle with release function", () => {
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      const handle = preventIdleSleep();

      expect(handle).not.toBeNull();
      expect(handle?.release).toBeInstanceOf(Function);
    });

    it("release function kills the caffeinate process", () => {
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      const handle = preventIdleSleep();
      handle?.release();

      expect(mockChild.kill).toHaveBeenCalled();
    });

    it("release function handles errors silently", () => {
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn().mockImplementation(() => {
          throw new Error("Process already dead");
        }),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      const handle = preventIdleSleep();

      // Should not throw
      expect(() => handle?.release()).not.toThrow();
    });

    it("registers error handler for spawn failures", () => {
      const onMock = vi.fn();
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: onMock,
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      preventIdleSleep();

      expect(onMock).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("returns null when spawn fails synchronously (no pid)", () => {
      const mockChild = {
        pid: undefined,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      const handle = preventIdleSleep();

      expect(handle).toBeNull();
      expect(mockChild.unref).not.toHaveBeenCalled();
    });
  });

  describe("on Linux", () => {
    beforeEach(() => {
      setPlatform("linux");
    });

    it("spawns systemd-inhibit with --what=idle --mode=block and a pid watchdog", () => {
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      const handle = preventIdleSleep(12345);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = mockSpawn.mock.calls[0]!;
      expect(cmd).toBe("systemd-inhibit");
      expect(args).toEqual([
        "--what=idle",
        "--who=Agent Orchestrator",
        "--why=Active agent session running",
        "--mode=block",
        "sh",
        "-c",
        "while kill -0 12345 2>/dev/null; do sleep 5; done",
      ]);
      expect(opts).toEqual({ stdio: "ignore", detached: true });
      expect(mockChild.unref).toHaveBeenCalled();
      expect(handle).not.toBeNull();
    });

    it("defaults to current process pid", () => {
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      preventIdleSleep();

      const args = mockSpawn.mock.calls[0]![1] as string[];
      expect(args[args.length - 1]).toBe(
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 5; done`,
      );
    });

    it("release function group-kills systemd-inhibit and its sh watchdog", () => {
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);
      const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      const handle = preventIdleSleep();
      handle?.release();

      // killProcessTree signals the negative PID so the whole group dies in
      // one shot — the sh watchdog can't linger up to 5s as an orphan.
      expect(processKillSpy).toHaveBeenCalledWith(-9999, "SIGTERM");
      expect(mockChild.kill).not.toHaveBeenCalled();
      processKillSpy.mockRestore();
    });

    it("release falls back to direct-PID kill if group-kill throws", async () => {
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);
      // killProcessTree's POSIX path tries process.kill(-pid) first, then
      // falls back to process.kill(pid) if the group-kill throws. Throw only
      // for the negative-PID call so we can assert the fallback is exercised.
      const processKillSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((pid: number) => {
          if (pid < 0) throw new Error("ESRCH");
          return true;
        });

      const handle = preventIdleSleep();
      expect(() => handle?.release()).not.toThrow();
      // release() is fire-and-forget around an async helper; flush the
      // microtask queue so the inner try/catch runs before we assert.
      await Promise.resolve();

      expect(processKillSpy).toHaveBeenCalledWith(-9999, "SIGTERM");
      expect(processKillSpy).toHaveBeenCalledWith(9999, "SIGTERM");
      expect(mockChild.kill).not.toHaveBeenCalled();
      processKillSpy.mockRestore();
    });

    it("returns null when systemd-inhibit is missing (no pid)", () => {
      const mockChild = {
        pid: undefined,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      const handle = preventIdleSleep();

      expect(handle).toBeNull();
      expect(mockChild.unref).not.toHaveBeenCalled();
    });

    it("registers async error handler for ENOENT on non-systemd systems", () => {
      const onMock = vi.fn();
      const mockChild = {
        pid: 9999,
        unref: vi.fn(),
        on: onMock,
        kill: vi.fn(),
      } as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      preventIdleSleep();

      expect(onMock).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("swallows async ENOENT error when systemd-inhibit is missing (pid undefined)", async () => {
      // Real EventEmitter so emit("error") goes through Node's listener machinery.
      // Without a registered listener, this would propagate as an uncaught
      // exception and crash AO on hosts where systemd-inhibit is absent.
      const emitter = new EventEmitter();
      const mockChild = Object.assign(emitter, {
        pid: undefined,
        unref: vi.fn(),
        kill: vi.fn(),
      }) as unknown as ChildProcess;
      mockSpawn.mockReturnValue(mockChild);

      const handle = preventIdleSleep();

      expect(handle).toBeNull();
      // The error listener must be attached BEFORE the pid check so the
      // async ENOENT that fires after we return is swallowed.
      expect(() => emitter.emit("error", new Error("spawn ENOENT"))).not.toThrow();
    });
  });

  describe("on unsupported platforms", () => {
    it("returns null on Windows", () => {
      setPlatform("win32");

      const handle = preventIdleSleep();

      expect(handle).toBeNull();
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});
