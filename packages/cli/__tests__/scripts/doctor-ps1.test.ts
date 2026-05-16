import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Windows-only mirror of doctor-script.test.ts (which is fully skipped on Windows).
// Exercises the PS1 port's argparse and basic execution. A developer who breaks
// the script's syntax or top-level flow gets a clear failure here rather than at
// runtime on a user's machine.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(packageRoot, "src", "assets", "scripts", "ao-doctor.ps1");

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

describe.runIf(process.platform === "win32")("ao-doctor.ps1", () => {
  it("prints usage and exits 0 for --help", () => {
    const result = runPwsh(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: ao doctor");
    expect(result.stdout).toContain("--fix");
  });

  it("prints usage and exits 0 for -h", () => {
    const result = runPwsh(["-h"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: ao doctor");
  });

  it("rejects unknown flags with exit 1", () => {
    const result = runPwsh(["--bogus-flag"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option");
  });

  it("runs the full check pipeline against an empty repo and reports findings", () => {
    // Point AO_REPO_ROOT at an empty directory and AO_SCRIPT_LAYOUT at
    // source-checkout so the script exercises every Check-* function. The
    // exact PASS/WARN/FAIL count depends on the runner's environment (node,
    // git, pnpm typically present on GitHub windows-latest), but the script
    // must always print a final "Results: ... PASS, ... WARN, ... FAIL" line
    // and exit either 0 (no FAILs) or 1 (FAILs). This catches a script that
    // fails to parse or crashes mid-pipeline.
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-ps1-"));
    try {
      const result = runPwsh([], {
        AO_REPO_ROOT: tempRoot,
        AO_SCRIPT_LAYOUT: "source-checkout",
        AO_CONFIG_PATH: join(tempRoot, "agent-orchestrator.yaml"),
        AO_DOCTOR_TMP_ROOT: tempRoot,
      });
      expect([0, 1]).toContain(result.status);
      expect(result.stdout).toContain("Agent Orchestrator Doctor");
      expect(result.stdout).toMatch(/Results: \d+ PASS, \d+ WARN, \d+ FAIL, \d+ FIXED/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
