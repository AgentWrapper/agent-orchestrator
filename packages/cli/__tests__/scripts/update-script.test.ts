import { describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(packageRoot, "src", "assets", "scripts", "ao-update.sh");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createFakeBinary(binDir: string, name: string, body: string): void {
  writeExecutable(join(binDir, name), `#!/bin/bash\nset -e\n${body}\n`);
}

describe("ao-update.sh", () => {
  it("falls back to origin when no upstream remote exists", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-script-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(join(fakeRepo, "packages", "cli"), { recursive: true });
    mkdirSync(join(fakeRepo, "packages", "ao"), { recursive: true });

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(tempRoot, "commands.log");

    createFakeBinary(
      binDir,
      "git",
      `printf 'git %s\\n' "$*" >> ${JSON.stringify(commandLog)}\ncase "$*" in\n  "remote get-url upstream") exit 1 ;;
  "rev-parse --is-inside-work-tree") printf 'true\\n' ;;
  "status --porcelain") ;;
  "branch --show-current") printf 'main\\n' ;;
  "fetch origin main") ;;
  "rev-parse HEAD") printf 'oldsha000\\n' ;;
  "rev-parse origin/main") printf 'newsha111\\n' ;;
  "pull --ff-only origin main") ;;
  *) ;;
esac\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "pnpm",
      `printf 'pnpm %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nif [ "$1" = "--version" ]; then\n  printf '9.15.4\\n'\nfi\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "npm",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "node",
      `printf 'node %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nif [ "$1" = "--version" ]; then\n  printf 'v20.11.1\\n'\nfi\nexit 0`,
    );

    const result = spawnSync("bash", [scriptPath, "--skip-smoke"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    const commands = readFileSync(commandLog, "utf8");
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(commands).toContain("git fetch origin main");
    expect(commands).toContain("git pull --ff-only origin main");
    expect(commands).toContain("pnpm install");
    expect(commands).toContain("pnpm --filter @aoagents/ao-core clean");
    expect(commands).toContain("pnpm --filter @aoagents/ao-cli build");
    expect(commands).toContain("npm link --force");
  });

  it("syncs the fork with upstream via gh and fast-forwards the local checkout from upstream", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-upstream-script-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(join(fakeRepo, "packages", "cli"), { recursive: true });
    mkdirSync(join(fakeRepo, "packages", "ao"), { recursive: true });

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(tempRoot, "commands.log");

    createFakeBinary(
      binDir,
      "git",
      `printf 'git %s\\n' "$*" >> ${JSON.stringify(commandLog)}\ncase "$*" in\n  "remote get-url origin") printf 'https://github.com/yyovil/agent-orchestrator.git\\n' ;;
  "remote get-url upstream") printf 'https://github.com/ComposioHQ/agent-orchestrator.git\\n' ;;
  "rev-parse --is-inside-work-tree") printf 'true\\n' ;;
  "status --porcelain") ;;
  "branch --show-current") printf 'main\\n' ;;
  "fetch upstream main") ;;
  "rev-parse HEAD") printf 'oldsha000\\n' ;;
  "rev-parse upstream/main") printf 'newsha111\\n' ;;
  "pull --ff-only upstream main") ;;
  *) ;;
esac\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "gh",
      `printf 'gh %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "pnpm",
      `printf 'pnpm %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nif [ "$1" = "--version" ]; then\n  printf '9.15.4\\n'\nfi\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "npm",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "node",
      `printf 'node %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nif [ "$1" = "--version" ]; then\n  printf 'v20.11.1\\n'\nfi\nexit 0`,
    );

    const result = spawnSync("bash", [scriptPath, "--skip-smoke"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    const commands = readFileSync(commandLog, "utf8");
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(commands).toContain(
      "gh repo sync yyovil/agent-orchestrator --source ComposioHQ/agent-orchestrator --branch main",
    );
    expect(commands).toContain("git fetch upstream main");
    expect(commands).toContain("git pull --ff-only upstream main");
    expect(commands).not.toContain("git fetch origin main");
  });

  it("uses forced npm link so stale global ao shims are overwritten", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-stale-shim-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(join(fakeRepo, "packages", "cli"), { recursive: true });
    mkdirSync(join(fakeRepo, "packages", "ao"), { recursive: true });

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(tempRoot, "commands.log");

    createFakeBinary(
      binDir,
      "git",
      `case "$*" in
  "remote get-url upstream") exit 1 ;;
  "rev-parse --is-inside-work-tree") printf 'true\n' ;;
  "status --porcelain") ;;
  "branch --show-current") printf 'main\n' ;;
  "fetch origin main") ;;
  "rev-parse HEAD") printf 'oldsha000\n' ;;
  "rev-parse origin/main") printf 'newsha111\n' ;;
  "pull --ff-only origin main") ;;
esac
exit 0`,
    );
    createFakeBinary(
      binDir,
      "pnpm",
      `if [ "$1" = "--version" ]; then printf '9.15.4\n'; fi
exit 0`,
    );
    createFakeBinary(
      binDir,
      "npm",
      `printf 'npm %s\n' "$*" >> ${JSON.stringify(commandLog)}
if [ "$*" = "link" ]; then
  printf 'npm error code EEXIST\n' >&2
  exit 1
fi
exit 0`,
    );
    createFakeBinary(
      binDir,
      "node",
      `if [ "$1" = "--version" ]; then printf 'v20.11.1\n'; fi
exit 0`,
    );

    const result = spawnSync("bash", [scriptPath, "--skip-smoke"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    const commands = existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "";
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(commands).toContain("npm link --force");
    expect(commands).not.toContain("npm link\n");
    expect(result.stdout).not.toContain("Permission denied");
  });

  it("runs the built-in smoke commands in smoke-only mode", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-smoke-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(join(fakeRepo, "packages", "ao", "bin"), { recursive: true });
    writeFileSync(join(fakeRepo, "packages", "ao", "bin", "ao.js"), "#!/usr/bin/env node\n");

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(tempRoot, "commands.log");
    createFakeBinary(
      binDir,
      "node",
      `if [ "$1" = "--version" ]; then printf 'v20.11.1\\n'; fi
printf 'node %s\\n' "$*" >> ${JSON.stringify(commandLog)}
exit 0`,
    );

    const result = spawnSync("bash", [scriptPath, "--smoke-only"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    const commands = readFileSync(commandLog, "utf8");
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(commands).toContain(
      `node ${join(fakeRepo, "packages", "ao", "bin", "ao.js")} --version`,
    );
    expect(commands).toContain(
      `node ${join(fakeRepo, "packages", "ao", "bin", "ao.js")} doctor --help`,
    );
    expect(commands).toContain(
      `node ${join(fakeRepo, "packages", "ao", "bin", "ao.js")} update --help`,
    );
  });

  it("fails fast on a dirty install repo with an actionable message", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-dirty-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(fakeRepo, { recursive: true });

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });

    createFakeBinary(
      binDir,
      "git",
      `case "$*" in
  "rev-parse --is-inside-work-tree") printf "true\\n" ;;
  "status --porcelain") printf " M README.md\\n" ;;
  "branch --show-current") printf "main\\n" ;;
esac
exit 0`,
    );
    createFakeBinary(
      binDir,
      "pnpm",
      'if [ "$1" = "--version" ]; then printf "9.15.4\\n"; fi\nexit 0',
    );
    createFakeBinary(binDir, "npm", "exit 0");
    createFakeBinary(
      binDir,
      "node",
      'if [ "$1" = "--version" ]; then printf "v20.11.1\\n"; fi\nexit 0',
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Working tree is dirty");
    expect(result.stderr).toContain("commit or stash");
  });

  it("skips rebuild but still runs smoke tests when local HEAD matches remote HEAD", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-already-latest-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(join(fakeRepo, "packages", "cli"), { recursive: true });
    mkdirSync(join(fakeRepo, "packages", "ao", "bin"), { recursive: true });
    writeFileSync(join(fakeRepo, "packages", "ao", "bin", "ao.js"), "#!/usr/bin/env node\n");

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(tempRoot, "commands.log");

    const sha = "abc123def456abc123def456abc123def456abc123";

    createFakeBinary(
      binDir,
      "git",
      `printf 'git %s\\n' "$*" >> ${JSON.stringify(commandLog)}
case "$*" in
  "remote get-url upstream") exit 1 ;;
  "rev-parse --is-inside-work-tree") printf 'true\\n' ;;
  "status --porcelain") ;;
  "branch --show-current") printf 'main\\n' ;;
  "fetch origin main") ;;
  "rev-parse HEAD") printf '${sha}\\n' ;;
  "rev-parse origin/main") printf '${sha}\\n' ;;
  *) ;;
esac
exit 0`,
    );
    createFakeBinary(
      binDir,
      "pnpm",
      `printf 'pnpm %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nif [ "$1" = "--version" ]; then\n  printf '9.15.4\\n'\nfi\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "npm",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "node",
      `printf 'node %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nif [ "$1" = "--version" ]; then\n  printf 'v20.11.1\\n'\nfi\nexit 0`,
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    const commands = readFileSync(commandLog, "utf8");
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Already on latest version");
    // Rebuild commands should NOT have run
    expect(commands).not.toContain("pnpm install");
    expect(commands).not.toContain("pnpm --filter @aoagents/ao-core build");
    expect(commands).not.toContain("npm link");
    expect(commands).not.toContain("git pull --ff-only origin main");
    // Smoke tests SHOULD still have run
    expect(commands).toContain(
      `node ${join(fakeRepo, "packages", "ao", "bin", "ao.js")} --version`,
    );
    expect(commands).toContain(
      `node ${join(fakeRepo, "packages", "ao", "bin", "ao.js")} doctor --help`,
    );
  });

  it("rejects conflicting smoke flags in the script", () => {
    const result = spawnSync("bash", [scriptPath, "--skip-smoke", "--smoke-only"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Conflicting options");
  });

  it("reports when the update itself dirties the checkout", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-post-dirty-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(join(fakeRepo, "packages", "cli"), { recursive: true });
    mkdirSync(join(fakeRepo, "packages", "ao"), { recursive: true });

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });

    createFakeBinary(
      binDir,
      "git",
      `case "$*" in
  "remote get-url upstream") exit 1 ;;
  "rev-parse --is-inside-work-tree") printf "true\\n" ;;
  "status --porcelain")
    if [ -f ${JSON.stringify(join(tempRoot, "post-dirty"))} ]; then
      printf " M pnpm-lock.yaml\\n"
    fi
    ;;
  "branch --show-current") printf "main\\n" ;;
  "rev-parse HEAD") printf "oldsha000\\n" ;;
  "rev-parse origin/main") printf "newsha111\\n" ;;
  "pull --ff-only origin main") touch ${JSON.stringify(join(tempRoot, "post-dirty"))} ;;
esac
exit 0`,
    );
    createFakeBinary(
      binDir,
      "pnpm",
      'if [ "$1" = "--version" ]; then printf "9.15.4\\n"; fi\nexit 0',
    );
    createFakeBinary(binDir, "npm", "exit 0");
    createFakeBinary(
      binDir,
      "node",
      'if [ "$1" = "--version" ]; then printf "v20.11.1\\n"; fi\nexit 0',
    );

    const result = spawnSync("bash", [scriptPath, "--skip-smoke"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Update modified tracked files");
  });
});
