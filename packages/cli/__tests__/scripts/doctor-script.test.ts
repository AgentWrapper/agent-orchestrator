import { describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(packageRoot, "src", "assets", "scripts", "ao-doctor.sh");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createFakeBinary(binDir: string, name: string, body: string): void {
  writeExecutable(join(binDir, name), `#!/bin/bash\nset -e\n${body}\n`);
}

function createHealthyRepo(tempRoot: string): string {
  const fakeRepo = join(tempRoot, "repo");
  mkdirSync(join(fakeRepo, "node_modules"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "ao", "bin"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "core", "dist"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "cli", "dist"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "web"), { recursive: true });
  writeFileSync(join(fakeRepo, "packages", "core", "dist", "index.js"), "export {};\n");
  writeFileSync(join(fakeRepo, "packages", "cli", "dist", "index.js"), "export {};\n");
  writeFileSync(
    join(fakeRepo, "packages", "ao", "bin", "ao.js"),
    '#!/usr/bin/env node\nconsole.log("0.1.0");\n',
  );
  chmodSync(join(fakeRepo, "packages", "ao", "bin", "ao.js"), 0o755);
  return fakeRepo;
}

function createHealthyPackageInstall(tempRoot: string): string {
  const fakeInstall = join(tempRoot, "package-install");
  mkdirSync(join(fakeInstall, "dist", "assets", "scripts"), { recursive: true });
  writeFileSync(
    join(fakeInstall, "package.json"),
    JSON.stringify({ name: "@aoagents/ao-cli", version: "0.2.5" }, null, 2),
  );
  writeFileSync(join(fakeInstall, "dist", "index.js"), 'console.log("0.2.5");\n');
  writeFileSync(join(fakeInstall, "dist", "assets", "scripts", "ao-doctor.sh"), "#!/bin/bash\n");
  writeFileSync(join(fakeInstall, "dist", "assets", "scripts", "ao-update.sh"), "#!/bin/bash\n");
  return fakeInstall;
}

function createHealthyPath(binDir: string): void {
  createFakeBinary(
    binDir,
    "node",
    'if [ "$1" = "--version" ]; then\n  printf "v20.11.1\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "git",
    'if [ "$1" = "--version" ]; then\n  printf "git version 2.43.0\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "pnpm",
    'if [ "$1" = "--version" ]; then\n  printf "9.15.4\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "npm",
    'if [ "$1" = "bin" ]; then\n  printf "/tmp/npm-bin\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "tmux",
    'if [ "$1" = "-V" ]; then\n  printf "tmux 3.4\\n"\n  exit 0\nfi\nif [ "$1" = "list-sessions" ]; then\n  exit 1\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "gh",
    'if [ "$1" = "--version" ]; then\n  printf "gh version 2.50.0\\n"\n  exit 0\nfi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(binDir, "ao", 'printf "/fake/ao\\n" >/dev/null\nexit 0');
}

describe("ao-doctor.sh", () => {
  it("reports a healthy install as PASS", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-script-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      configPath,
      [`dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`, "projects: {}"].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:/bin:/usr/bin`,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(result.stdout).toContain("Environment looks healthy");
  });

  it("applies safe fixes for missing launcher, missing dirs, and stale temp files when grep output is colored", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-fix-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);
    createFakeBinary(binDir, "grep", 'exec /usr/bin/grep --color=always "$@"');
    rmSync(join(binDir, "ao"), { force: true });

    const npmLog = join(tempRoot, "npm.log");
    createFakeBinary(
      binDir,
      "npm",
      `printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}\nif [ "$1" = "bin" ]; then\n  printf "/tmp/npm-bin\\n"\nfi\nexit 0`,
    );

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    const commentedDataDir = `${dataDir} # session metadata`;
    const commentedWorktreeDir = `${worktreeDir} # ephemeral worktrees`;
    writeFileSync(
      configPath,
      [`dataDir: ${commentedDataDir}`, `worktreeDir: ${commentedWorktreeDir}`, "projects: {}"].join(
        "\n",
      ),
    );

    const tmpRoot = join(tempRoot, "tmp-root");
    mkdirSync(tmpRoot, { recursive: true });
    const staleFile = join(tmpRoot, "ao-stale.tmp");
    writeFileSync(staleFile, "stale\n");
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleFile, oldTimestamp, oldTimestamp);

    const result = spawnSync("bash", [scriptPath, "--fix"], {
      env: {
        ...process.env,
        PATH: `${binDir}:/bin:/usr/bin`,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
        AO_DOCTOR_TMP_ROOT: tmpRoot,
      },
      encoding: "utf8",
    });

    const npmCommands = readFileSync(npmLog, "utf8");
    const staleStillExists = existsSync(staleFile);
    const dataDirExists = existsSync(dataDir);
    const worktreeDirExists = existsSync(worktreeDir);
    const commentedDataDirExists = existsSync(commentedDataDir);
    const commentedWorktreeDirExists = existsSync(commentedWorktreeDir);
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FIXED");
    expect(npmCommands).toContain("link --force");
    expect(result.stdout).toContain("launcher");
    expect(result.stdout).toContain("stale temp files");
    expect(staleStillExists).toBe(false);
    expect(dataDirExists).toBe(true);
    expect(worktreeDirExists).toBe(true);
    expect(commentedDataDirExists).toBe(false);
    expect(commentedWorktreeDirExists).toBe(false);
  });

  it("repairs a dangling ao launcher shim in fix mode", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-dangling-launcher-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    const aoPath = join(binDir, "ao");
    rmSync(aoPath, { force: true });
    symlinkSync(join(tempRoot, "deleted-checkout", "dist", "index.js"), aoPath);

    const npmLog = join(tempRoot, "npm.log");
    createFakeBinary(
      binDir,
      "npm",
      `printf '%s\n' "$*" >> ${JSON.stringify(npmLog)}
if [ "$1" = "link" ]; then
  rm -f ${JSON.stringify(aoPath)}
  printf '#!/bin/bash\nexit 0\n' > ${JSON.stringify(aoPath)}
  chmod +x ${JSON.stringify(aoPath)}
fi
if [ "$1" = "bin" ]; then
  printf "/tmp/npm-bin\n"
fi
exit 0`,
    );

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      configPath,
      [`dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`, "projects: {}"].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath, "--fix"], {
      env: {
        ...process.env,
        PATH: `${binDir}:/bin:/usr/bin`,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
      },
      encoding: "utf8",
    });

    const npmCommands = existsSync(npmLog) ? readFileSync(npmLog, "utf8") : "";
    const repairedLauncherIsExecutable = existsSync(aoPath);
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FIXED");
    expect(repairedLauncherIsExecutable).toBe(true);
    expect(npmCommands).toContain("link --force");
  });

  it("reports a healthy packaged install without source-checkout failures", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-package-"));
    const fakeInstall = createHealthyPackageInstall(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      configPath,
      [`dataDir: ${dataDir}`, `worktreeDir: ${worktreeDir}`, "projects: {}"].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:/bin:/usr/bin`,
        AO_REPO_ROOT: fakeInstall,
        AO_SCRIPT_LAYOUT: "package-install",
        AO_CONFIG_PATH: configPath,
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bundled doctor script is available");
    expect(result.stdout).toContain("packaged CLI runtime sanity check passed");
    expect(result.stdout).toContain("Environment looks healthy");
    expect(result.stdout).not.toContain("dependencies are missing");
    expect(result.stdout).not.toContain("launcher entrypoint is missing");
  });
});
