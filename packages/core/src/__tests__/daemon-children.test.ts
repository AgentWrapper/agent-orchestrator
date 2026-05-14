import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __getDaemonChildrenRegistryFile,
  clearDaemonChildrenRegistry,
  detectAoOrphansFromPsOutput,
  getDaemonChildren,
  registerDaemonChild,
  spawnManagedDaemonChild,
  sweepDaemonChildren,
  unregisterDaemonChild,
} from "../daemon-children.js";

function isProcessAliveForTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "EPERM";
  }
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

describe("daemon child registry", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ao-daemon-children-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = tmpHome;
    clearDaemonChildrenRegistry();
  });

  afterEach(() => {
    clearDaemonChildrenRegistry();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("writes, reads, and unregisters daemon child pids", () => {
    registerDaemonChild({
      pid: process.pid,
      parentPid: process.pid,
      role: "dashboard",
      command: "node dist-server/start-all.js",
    });

    expect(getDaemonChildren()).toEqual([
      expect.objectContaining({
        pid: process.pid,
        parentPid: process.pid,
        role: "dashboard",
        command: "node dist-server/start-all.js",
      }),
    ]);

    const raw = JSON.parse(readFileSync(__getDaemonChildrenRegistryFile(), "utf-8")) as unknown[];
    expect(raw).toHaveLength(1);

    unregisterDaemonChild(process.pid);
    expect(getDaemonChildren()).toEqual([]);
  });

  it("sweeps only children owned by the requested daemon pid", async () => {
    const targetChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });
    const otherChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });

    try {
      expect(targetChild.pid).toBeTypeOf("number");
      expect(otherChild.pid).toBeTypeOf("number");
      const targetPid = targetChild.pid as number;
      const otherPid = otherChild.pid as number;

      registerDaemonChild({
        pid: targetPid,
        parentPid: 111,
        role: "owned-by-target",
        command: "node target.js",
      });
      registerDaemonChild({
        pid: otherPid,
        parentPid: 222,
        role: "owned-by-other-daemon",
        command: "node other.js",
      });

      const result = await sweepDaemonChildren({ ownerPid: 111, graceMs: 1_000 });

      expect(result.attempted).toBe(1);
      expect(isProcessAliveForTest(otherPid)).toBe(true);
      expect(getDaemonChildren()).toContainEqual(
        expect.objectContaining({
          pid: otherPid,
          parentPid: 222,
          role: "owned-by-other-daemon",
        }),
      );
    } finally {
      targetChild.kill("SIGKILL");
      otherChild.kill("SIGKILL");
      await waitForChildExit(targetChild);
      await waitForChildExit(otherChild);
    }
  });

  it("spawnManagedDaemonChild makes registry tracking the default for daemon spawns", async () => {
    const child = spawnManagedDaemonChild(
      "test-child",
      process.execPath,
      ["-e", "setTimeout(() => {}, 30_000)"],
      { stdio: "ignore" },
    );

    expect(child.pid).toBeTypeOf("number");
    expect(getDaemonChildren()).toContainEqual(
      expect.objectContaining({
        pid: child.pid,
        role: "test-child",
        parentPid: process.pid,
        command: `${process.execPath} -e setTimeout(() => {}, 30_000)`,
      }),
    );

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    expect(getDaemonChildren()).not.toContainEqual(expect.objectContaining({ pid: child.pid }));
  });
});

describe("AO orphan detection", () => {
  it("detects PPID=1 AO dashboard, websocket, and lifecycle processes", () => {
    const output = [
      "  90350      1 node next-server (v15.5.15)",
      "  90351      1 node /opt/homebrew/lib/node_modules/@aoagents/ao-web/dist-server/start-all.js",
      "  47457      1 node /opt/homebrew/lib/node_modules/@aoagents/ao-web@0.2.4/dist-server/start-all.js",
      "  47458      1 node @aoagents/ao-web@0.2.4 dist-server/start-all.js",
      "  47575      1 node /opt/homebrew/lib/node_modules/@aoagents/ao-web@0.2.4/dist-server/terminal-websocket.js",
      "  47580      1 node /opt/homebrew/lib/node_modules/@aoagents/ao-web@0.2.4/dist-server/direct-terminal-ws.js",
      "   9914      1 node /opt/homebrew/bin/ao lifecycle-worker codex-startup-factory",
      "  22222   3333 node /opt/homebrew/bin/ao lifecycle-worker not-an-orphan",
      "  44444      1 node unrelated-server.js",
    ].join("\n");

    expect(detectAoOrphansFromPsOutput(output)).toEqual([
      expect.objectContaining({ pid: 90350, role: "next-server" }),
      expect.objectContaining({ pid: 90351, role: "ao-web" }),
      expect.objectContaining({ pid: 47457, role: "ao-web" }),
      expect.objectContaining({ pid: 47458, role: "ao-web" }),
      expect.objectContaining({ pid: 47575, role: "ao-web" }),
      expect.objectContaining({ pid: 47580, role: "ao-web" }),
      expect.objectContaining({ pid: 9914, role: "lifecycle-worker" }),
    ]);
  });
});
