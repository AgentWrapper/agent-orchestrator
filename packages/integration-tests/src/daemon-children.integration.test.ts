import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWindows, killProcessTree } from "@aoagents/ao-core";
import { sleep } from "./helpers/polling.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/index.ts");
const tsxBin = join(repoRoot, "packages/cli/node_modules/.bin/tsx");
const dashboardEntry = join(repoRoot, "packages/web/dist-server/start-all.js");

const canRun = !isWindows() && existsSync(tsxBin) && existsSync(dashboardEntry);

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a free port"));
      });
    });
  });
}

async function readChildPids(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)]);
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "EPERM";
  }
}

describe.skipIf(!canRun)("daemon child reaping (integration)", () => {
  let tmpHome: string;
  let repoPath: string;
  let configPath: string;
  let startPid: number | undefined;
  let port: number;

  beforeEach(async () => {
    tmpHome = await realpath(await mkdtemp(join(tmpdir(), "ao-daemon-int-home-")));
    port = await getFreePort();
    repoPath = join(tmpHome, "repo");
    mkdirSync(repoPath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    writeFileSync(join(repoPath, "README.md"), "# daemon child reaping\n");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });

    configPath = join(repoPath, "agent-orchestrator.yaml");
    writeFileSync(
      configPath,
      ["runtime: process", "agent: claude-code", "workspace: worktree"].join("\n"),
    );

    const globalConfigPath = join(tmpHome, "global-agent-orchestrator.yaml");
    writeFileSync(
      globalConfigPath,
      [
        `port: ${port}`,
        "defaults:",
        "  runtime: process",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  daemon-int:",
        "    displayName: Daemon Integration",
        `    path: ${JSON.stringify(repoPath)}`,
        "    defaultBranch: main",
        "    sessionPrefix: daemon-int",
      ].join("\n"),
    );
    configPath = globalConfigPath;
  }, 30_000);

  afterEach(async () => {
    if (startPid && isAlive(startPid)) {
      await killProcessTree(startPid, "SIGKILL");
    }
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("ao stop terminates children spawned by ao start", async () => {
    const env = {
      ...process.env,
      HOME: tmpHome,
      AO_CALLER_TYPE: "agent",
      AO_CONFIG_PATH: configPath,
      AO_GLOBAL_CONFIG: configPath,
      PORT: String(port),
    };
    const start = spawn(tsxBin, [cliEntry, "start", "--no-orchestrator", "--reap-orphans"], {
      cwd: repoPath,
      env,
      stdio: "ignore",
    });
    startPid = start.pid;
    expect(startPid).toBeTypeOf("number");

    const runningPath = join(tmpHome, ".agent-orchestrator/running.json");
    let runningPid: number | undefined;
    for (let i = 0; i < 100; i++) {
      if (existsSync(runningPath)) {
        const running = JSON.parse(readFileSync(runningPath, "utf-8")) as { pid?: number };
        runningPid = running.pid;
        break;
      }
      await sleep(100);
    }
    expect(runningPid).toBeTypeOf("number");

    const childPids = await readChildPids(runningPid!);
    expect(childPids.length).toBeGreaterThan(0);

    await execFileAsync(tsxBin, [cliEntry, "stop", "--all"], { cwd: repoPath, env, timeout: 20_000 });
    await sleep(5_000);

    const stillAlive = childPids.filter(isAlive);
    expect(stillAlive).toEqual([]);
    expect(isAlive(runningPid!)).toBe(false);
  }, 60_000);
});
