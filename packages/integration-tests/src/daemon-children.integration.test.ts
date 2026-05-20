import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDaemonChildrenRegistry,
  getDaemonChildren,
  isWindows,
  killProcessTree,
  registerDaemonChild,
} from "@aoagents/ao-core";
import { sleep } from "./helpers/polling.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const cliEntry = join(repoRoot, "packages", "cli", "dist", "index.js");

const canRun = !isWindows() && existsSync(cliEntry);

function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "EPERM";
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function requirePid(child: ChildProcess, role: string): number {
  expect(child.pid, `${role} pid`).toBeTypeOf("number");
  return child.pid as number;
}

function spawnSleeper(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 30_000)"], {
    stdio: "ignore",
  });
}

async function waitForChildExit(
  child: ChildProcess,
  pid: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (childHasExited(child) || !isAlive(pid)) return true;

  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(timeoutMs),
  ]);

  return childHasExited(child) || !isAlive(pid);
}

async function terminateChild(child: ChildProcess | undefined): Promise<void> {
  const pid = child?.pid;
  if (!child || typeof pid !== "number") return;
  if (isAlive(pid)) {
    await killProcessTree(pid, "SIGKILL");
  }
  await waitForChildExit(child, pid, 2_000);
}

function writeFakeRunningState(home: string, daemonPid: number): void {
  const stateDir = join(home, ".agent-orchestrator");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "running.json"),
    JSON.stringify(
      {
        pid: daemonPid,
        configPath: join(home, "agent-orchestrator.yaml"),
        port: 0,
        startedAt: new Date().toISOString(),
        projects: ["daemon-int"],
      },
      null,
      2,
    ),
  );
}

describe.skipIf(!canRun)("daemon child reaping (integration)", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let daemonParent: ChildProcess | undefined;
  let registeredChild: ChildProcess | undefined;

  beforeEach(async () => {
    tmpHome = await realpath(await mkdtemp(join(tmpdir(), "ao-daemon-int-home-")));
    originalHome = process.env["HOME"];
    originalUserProfile = process.env["USERPROFILE"];
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    clearDaemonChildrenRegistry();
  }, 30_000);

  afterEach(async () => {
    await terminateChild(registeredChild);
    await terminateChild(daemonParent);
    clearDaemonChildrenRegistry();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = originalUserProfile;
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("ao stop --all terminates registered daemon children without starting the dashboard", async () => {
    daemonParent = spawnSleeper();
    registeredChild = spawnSleeper();

    const daemonPid = requirePid(daemonParent, "daemon parent");
    const childPid = requirePid(registeredChild, "registered child");

    registerDaemonChild({
      pid: childPid,
      parentPid: daemonPid,
      role: "test-dashboard",
      command: "node dummy-dashboard.js",
    });
    writeFakeRunningState(tmpHome, daemonPid);

    const env = {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      AO_CALLER_TYPE: "agent",
    };

    const { stdout } = await execFileAsync(process.execPath, [cliEntry, "stop", "--all"], {
      cwd: tmpHome,
      env,
      timeout: 20_000,
    });

    expect(stdout).toContain("Swept 1 registered daemon child");
    const [registeredChildExited, daemonParentExited] = await Promise.all([
      waitForChildExit(registeredChild, childPid),
      waitForChildExit(daemonParent, daemonPid),
    ]);
    expect(registeredChildExited).toBe(true);
    expect(daemonParentExited).toBe(true);
    expect(getDaemonChildren()).toEqual([]);
  }, 30_000);
});
