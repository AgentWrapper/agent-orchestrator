import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

import {
  resolveDefaultRepoRootFromPath,
  resolveRepoRoot,
  resolveScriptLayout,
  resolveScriptLayoutFromPath,
  resolveScriptPath,
  runRepoScript,
} from "../../src/lib/script-runner.js";

describe("script-runner", () => {
  const originalAoRepoRoot = process.env["AO_REPO_ROOT"];
  const originalAoScriptLayout = process.env["AO_SCRIPT_LAYOUT"];
  const originalAoDev = process.env["AO_DEV"];

  beforeEach(() => {
    delete process.env["AO_REPO_ROOT"];
    delete process.env["AO_SCRIPT_LAYOUT"];
    delete process.env["AO_DEV"];
    mockSpawn.mockReset();
  });

  afterEach(() => {
    if (originalAoRepoRoot === undefined) {
      delete process.env["AO_REPO_ROOT"];
    } else {
      process.env["AO_REPO_ROOT"] = originalAoRepoRoot;
    }

    if (originalAoScriptLayout === undefined) {
      delete process.env["AO_SCRIPT_LAYOUT"];
    } else {
      process.env["AO_SCRIPT_LAYOUT"] = originalAoScriptLayout;
    }

    if (originalAoDev === undefined) {
      delete process.env["AO_DEV"];
    } else {
      process.env["AO_DEV"] = originalAoDev;
    }
  });

  // POSIX-style fixture paths in these tests reach `path.resolve()` on
  // Windows, which prepends the current drive letter and converts to
  // backslashes. Skip on Windows; the same code paths are exercised by the
  // other tests using `mkdtempSync` (which produces native paths).
  it.skipIf(process.platform === "win32")(
    "uses the package root for packaged installs inside node_modules",
    () => {
      const modulePath =
        "/usr/local/lib/node_modules/@aoagents/ao-cli/dist/lib/script-runner.js";

      expect(resolveScriptLayoutFromPath(modulePath)).toBe("package-install");
      expect(resolveDefaultRepoRootFromPath(modulePath)).toBe(
        "/usr/local/lib/node_modules/@aoagents/ao-cli",
      );
    },
  );

  it.skipIf(process.platform === "win32")("uses the repository root for source checkouts", () => {
    const modulePath =
      "/Users/test/agent-orchestrator/packages/cli/src/lib/script-runner.ts";

    expect(resolveScriptLayoutFromPath(modulePath)).toBe("source-checkout");
    expect(resolveDefaultRepoRootFromPath(modulePath)).toBe(
      "/Users/test/agent-orchestrator",
    );
  });

  it("includes the expected scripts path in missing-script errors", () => {
    const expectedScriptsDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/assets/scripts",
    );

    // Escape every regex metachar (including '\' on Windows paths) for the
    // scripts-directory portion so the assertion is path-separator-agnostic.
    const escapedDir = expectedScriptsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(() => resolveScriptPath("does-not-exist.sh")).toThrowError(
      new RegExp(
        `Script not found: does-not-exist\\.sh\\. Expected at: .*does-not-exist\\.sh \\(scripts directory: ${escapedDir}\\)`,
      ),
    );
  });

  it("rejects an invalid AO_REPO_ROOT override", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "script-runner-invalid-"));
    process.env["AO_REPO_ROOT"] = tempRoot;

    expect(() => resolveRepoRoot()).toThrowError(
      `AO_REPO_ROOT=${tempRoot} does not look like an agent-orchestrator checkout`,
    );

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("accepts a valid AO_REPO_ROOT override for source checkouts", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "script-runner-valid-"));
    mkdirSync(join(tempRoot, ".git"), { recursive: true });
    mkdirSync(join(tempRoot, "packages", "ao"), { recursive: true });
    writeFileSync(
      join(tempRoot, "packages", "ao", "package.json"),
      JSON.stringify({ name: "@aoagents/ao" }),
    );

    process.env["AO_REPO_ROOT"] = tempRoot;
    expect(resolveRepoRoot()).toBe(tempRoot);

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("ignores AO_SCRIPT_LAYOUT unless AO_DEV=1", () => {
    process.env["AO_SCRIPT_LAYOUT"] = "package-install";
    expect(resolveScriptLayout()).toBe("source-checkout");

    process.env["AO_DEV"] = "1";
    expect(resolveScriptLayout()).toBe("package-install");
  });

  // -----------------------------------------------------------------------
  // Windows PowerShell branch — runRepoScript prefers <script>.ps1 over <script>.sh
  // -----------------------------------------------------------------------

  // Windows-only: detection walks PATH for pwsh.exe / powershell.exe and
  // falls back to System32. On non-Windows hosts none of those exist, so
  // these assertions only have meaning when actually executed on Windows.
  it.skipIf(process.platform !== "win32")(
    "spawns PowerShell with -File and bypass policy when .ps1 sibling exists",
    async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "script-runner-ps-"));
      mkdirSync(join(tempRoot, ".git"), { recursive: true });
      mkdirSync(join(tempRoot, "packages", "ao"), { recursive: true });
      writeFileSync(
        join(tempRoot, "packages", "ao", "package.json"),
        JSON.stringify({ name: "@aoagents/ao" }),
      );

      process.env["AO_REPO_ROOT"] = tempRoot;
      const child = new EventEmitter();
      mockSpawn.mockReturnValue(child);
      setTimeout(() => child.emit("exit", 0, null), 0);

      // ao-doctor.sh ships with a sibling ao-doctor.ps1, so the Windows
      // branch in runRepoScript() should rewrite to .ps1 and dispatch via
      // PowerShell instead of bash.
      await runRepoScript("ao-doctor.sh", ["--check", "tmux"]);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [shell, args, opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd: string }];

      // PS binary: pwsh.exe / powershell.exe found on PATH or System32.
      expect(shell.toLowerCase()).toMatch(/(pwsh|powershell)\.exe$/);

      // Args: PowerShell flags first, then -File <ao-doctor.ps1>, then user args.
      expect(args.slice(0, 5)).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
      ]);
      expect(args[5]).toMatch(/ao-doctor\.ps1$/);
      // .sh is NOT what got resolved — the rewrite to .ps1 happened.
      expect(args[5]).not.toMatch(/ao-doctor\.sh$/);
      expect(args.slice(6)).toEqual(["--check", "tmux"]);

      // cwd is pinned to AO_REPO_ROOT just like the bash path does.
      expect(opts.cwd).toBe(tempRoot);

      rmSync(tempRoot, { recursive: true, force: true });
    },
  );

  // Sanity check that the rewrite is name-driven, not blind: a script that
  // doesn't end in .sh shouldn't be probed for a .ps1 sibling. The function
  // throws at resolveScriptPath because the literal name doesn't ship, so
  // we assert the error message rather than spawn shape.
  it.skipIf(process.platform !== "win32")(
    "does not rewrite to .ps1 for scripts that do not end in .sh",
    async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "script-runner-ps-noext-"));
      mkdirSync(join(tempRoot, ".git"), { recursive: true });
      mkdirSync(join(tempRoot, "packages", "ao"), { recursive: true });
      writeFileSync(
        join(tempRoot, "packages", "ao", "package.json"),
        JSON.stringify({ name: "@aoagents/ao" }),
      );
      process.env["AO_REPO_ROOT"] = tempRoot;

      // No .ps1 lookup happens, falls through to bash branch which then
      // resolveScriptPath fails because we ship no .nope file.
      await expect(runRepoScript("ao-doctor.nope", [])).rejects.toThrowError(
        /Script not found: ao-doctor\.nope/,
      );
      expect(mockSpawn).not.toHaveBeenCalled();

      rmSync(tempRoot, { recursive: true, force: true });
    },
  );

  it.skipIf(process.platform === "win32")("pins script execution cwd to the resolved install root", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "script-runner-cwd-"));
    mkdirSync(join(tempRoot, ".git"), { recursive: true });
    mkdirSync(join(tempRoot, "packages", "ao"), { recursive: true });
    writeFileSync(
      join(tempRoot, "packages", "ao", "package.json"),
      JSON.stringify({ name: "@aoagents/ao" }),
    );

    process.env["AO_REPO_ROOT"] = tempRoot;
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child);
    setTimeout(() => child.emit("exit", 0, null), 0);

    await runRepoScript("ao-doctor.sh", []);

    expect(mockSpawn).toHaveBeenCalledWith(
      // On Windows the resolved bash is an absolute path (e.g. Git Bash);
      // on POSIX it is the literal "bash" passed through to the shell.
      expect.stringMatching(/(^bash$|bash(\.exe)?$)/),
      [expect.stringContaining("ao-doctor.sh")],
      expect.objectContaining({
        cwd: tempRoot,
        env: expect.objectContaining({
          AO_REPO_ROOT: tempRoot,
          AO_SCRIPT_LAYOUT: "source-checkout",
        }),
      }),
    );

    rmSync(tempRoot, { recursive: true, force: true });
  });
});
