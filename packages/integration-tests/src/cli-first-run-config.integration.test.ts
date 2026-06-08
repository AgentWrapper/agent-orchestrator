import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWindows, loadConfig } from "@aoagents/ao-core";
import { isTmuxAvailable } from "./helpers/tmux.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/index.ts");
const tsxBin = join(repoRoot, "packages/cli/node_modules/.bin/tsx");
const tmuxOk = await isTmuxAvailable();
const canRun = !isWindows() && existsSync(tsxBin) && tmuxOk;

describe.skipIf(!canRun)("CLI first-run config generation (integration)", () => {
  let tmpHome: string;
  let repoPath: string;
  let globalConfigPath: string;
  let originalHome: string | undefined;
  let originalAoGlobalConfig: string | undefined;
  let originalAoConfigPath: string | undefined;

  beforeEach(async () => {
    tmpHome = await realpath(await mkdtemp(join(tmpdir(), "ao-first-run-int-")));
    repoPath = join(tmpHome, "first-run-repo");
    globalConfigPath = join(tmpHome, "global-agent-orchestrator.yaml");

    originalHome = process.env["HOME"];
    originalAoGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    originalAoConfigPath = process.env["AO_CONFIG_PATH"];
    process.env["HOME"] = tmpHome;
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;
    delete process.env["AO_CONFIG_PATH"];

    mkdirSync(repoPath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    await execFileAsync("git", ["branch", "-M", "main"], { cwd: repoPath });
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "https://github.com/ComposioHQ/ao-first-run-fixture.git"],
      { cwd: repoPath },
    );
    writeFileSync(join(repoPath, "README.md"), "# first-run integration\n");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });
  }, 30_000);

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalAoGlobalConfig === undefined) delete process.env["AO_GLOBAL_CONFIG"];
    else process.env["AO_GLOBAL_CONFIG"] = originalAoGlobalConfig;
    if (originalAoConfigPath === undefined) delete process.env["AO_CONFIG_PATH"];
    else process.env["AO_CONFIG_PATH"] = originalAoConfigPath;
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it("generates flat local config that resolves to the global project identity", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      AO_GLOBAL_CONFIG: globalConfigPath,
    };
    delete env["AO_CONFIG_PATH"];
    env["AO_CALLER_TYPE"] = "agent";

    await execFileAsync(
      tsxBin,
      [cliEntry, "start", "--no-dashboard", "--no-orchestrator", "--no-restore"],
      { cwd: repoPath, env, timeout: 60_000 },
    );

    const localConfigPath = join(repoPath, "agent-orchestrator.yaml");
    expect(existsSync(localConfigPath)).toBe(true);
    expect(existsSync(globalConfigPath)).toBe(true);

    const localConfig = readFileSync(localConfigPath, "utf-8");
    expect(localConfig).not.toMatch(/^projects:/m);
    expect(localConfig).toMatch(/^runtime:/m);
    expect(localConfig).toMatch(/^agent:/m);
    expect(localConfig).toMatch(/^workspace: worktree$/m);

    const fromLocal = loadConfig(localConfigPath);
    const fromGlobal = loadConfig(globalConfigPath);
    const projectIds = Object.keys(fromGlobal.projects);
    expect(projectIds).toHaveLength(1);

    const projectId = projectIds[0]!;
    expect(projectId).toMatch(/^first-run-repo_[a-f0-9]{10}$/);
    expect(projectId).not.toBe("first-run-repo");
    expect(Object.keys(fromLocal.projects)).toEqual([projectId]);
    expect(fromLocal.projects[projectId].path).toBe(repoPath);
    expect(fromGlobal.projects[projectId].path).toBe(repoPath);
  }, 90_000);
});
