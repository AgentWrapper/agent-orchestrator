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

  it("uses the package root for packaged installs inside node_modules", () => {
    const modulePath =
      "/usr/local/lib/node_modules/@aoagents/ao-cli/dist/lib/script-runner.js";

    expect(resolveScriptLayoutFromPath(modulePath)).toBe("package-install");
    expect(resolveDefaultRepoRootFromPath(modulePath)).toBe(
      "/usr/local/lib/node_modules/@aoagents/ao-cli",
    );
  });

  it("uses the repository root for source checkouts", () => {
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

    expect(() => resolveScriptPath("does-not-exist.sh")).toThrowError(
      new RegExp(
        `Script not found: does-not-exist\\.sh\\. Expected at: .*does-not-exist\\.sh \\(scripts directory: ${expectedScriptsDir.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\)`,
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

  it("pins script execution cwd to the resolved install root", async () => {
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
      "bash",
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
