import { describe, it, expect } from "vitest";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Windows-only mirror of update-script.test.ts. The bash tests skip on Windows
// because spawnSync("bash", ...) requires Git Bash and the bash-specific scenarios
// don't apply to the PS1 port. These tests run only on Windows and exercise the
// PS1 script's argparse + help text — the high-frequency surface that breaks
// when someone touches ao-update.ps1.
//
// Full happy-path coverage (fake git/pnpm/npm binaries via .cmd shims) deserves
// its own diff; this file establishes the baseline so any developer who breaks
// the PS1 script's argparse or syntax is caught immediately.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(packageRoot, "src", "assets", "scripts", "ao-update.ps1");

function runPwsh(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    {
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
    },
  );
}

describe.runIf(process.platform === "win32")("ao-update.ps1", () => {
  it("prints usage and exits 0 for --help", () => {
    const result = runPwsh(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: ao update");
    expect(result.stdout).toContain("--skip-smoke");
    expect(result.stdout).toContain("--smoke-only");
  });

  it("prints usage and exits 0 for -h", () => {
    const result = runPwsh(["-h"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: ao update");
  });

  it("rejects unknown flags with exit 1", () => {
    const result = runPwsh(["--bogus-flag"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option");
  });

  it("rejects conflicting --skip-smoke and --smoke-only with exit 1", () => {
    const result = runPwsh(["--skip-smoke", "--smoke-only"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Conflicting options");
  });
});
