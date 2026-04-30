import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockExec, mockExecSilent } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExecSilent: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
  execSilent: mockExecSilent,
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-dashboard-test-"));
  mockExec.mockReset();
  mockExecSilent.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("cleanNextCache", () => {
  it("deletes .next directory when it exists", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(webDir, { recursive: true });
    mkdirSync(join(webDir, ".next", "server", "vendor-chunks"), { recursive: true });
    writeFileSync(
      join(webDir, ".next", "server", "vendor-chunks", "xterm@5.3.0.js"),
      "module.exports = {}",
    );

    const { cleanNextCache } = await import("../../src/lib/dashboard-rebuild.js");

    await cleanNextCache(webDir);

    // .next should be gone — this is the fix for the stale cache 500 error
    expect(existsSync(join(webDir, ".next"))).toBe(false);
  });

  it("is a no-op when .next does not exist", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(webDir, { recursive: true });

    const { cleanNextCache } = await import("../../src/lib/dashboard-rebuild.js");

    // Should not throw
    await cleanNextCache(webDir);

    expect(existsSync(join(webDir, ".next"))).toBe(false);
  });
});

describe("findRunningDashboardPid", () => {
  it("returns PID when a process is listening", async () => {
    mockExecSilent.mockResolvedValue("12345");

    const { findRunningDashboardPid } = await import("../../src/lib/dashboard-rebuild.js");

    const pid = await findRunningDashboardPid(3000);
    expect(pid).toBe("12345");
    expect(mockExecSilent).toHaveBeenCalledWith("lsof", ["-ti", ":3000", "-sTCP:LISTEN"]);
  });

  it("returns null when no process is listening", async () => {
    mockExecSilent.mockResolvedValue(null);

    const { findRunningDashboardPid } = await import("../../src/lib/dashboard-rebuild.js");

    const pid = await findRunningDashboardPid(3000);
    expect(pid).toBeNull();
  });
});

describe("isInstalledUnderNodeModules", () => {
  it("returns true for a Unix node_modules path segment", async () => {
    const { isInstalledUnderNodeModules } = await import("../../src/lib/dashboard-rebuild.js");

    expect(isInstalledUnderNodeModules("/usr/local/lib/node_modules/@aoagents/ao-web")).toBe(true);
  });

  it("returns true for a Windows node_modules path segment", async () => {
    const { isInstalledUnderNodeModules } = await import("../../src/lib/dashboard-rebuild.js");

    expect(isInstalledUnderNodeModules("C:\\Users\\me\\node_modules\\@composio\\ao-web")).toBe(
      true,
    );
  });

  it("returns false for source paths containing node_modules as plain text", async () => {
    const { isInstalledUnderNodeModules } = await import("../../src/lib/dashboard-rebuild.js");

    expect(
      isInstalledUnderNodeModules("/home/user/node_modules_backup/agent-orchestrator/packages/web"),
    ).toBe(false);
  });
});

describe("assertDashboardRebuildSupported", () => {
  it("passes for a source checkout", async () => {
    const { assertDashboardRebuildSupported } = await import("../../src/lib/dashboard-rebuild.js");

    expect(() =>
      assertDashboardRebuildSupported("/home/user/agent-orchestrator/packages/web"),
    ).not.toThrow();
  });

  it("throws for an npm-installed package path", async () => {
    const { assertDashboardRebuildSupported } = await import("../../src/lib/dashboard-rebuild.js");

    expect(() =>
      assertDashboardRebuildSupported("/usr/local/lib/node_modules/@aoagents/ao-web"),
    ).toThrow("Dashboard rebuild is only available from a source checkout");
  });
});

describe("rebuildDashboardProductionArtifacts", () => {
  it("cleans .next and runs pnpm build on success", async () => {
    const webDir = join(tmpDir, "packages", "web");
    mkdirSync(webDir, { recursive: true });
    mkdirSync(join(webDir, ".next"), { recursive: true });

    mockExec.mockResolvedValue({ stdout: "", stderr: "" });

    const { rebuildDashboardProductionArtifacts } =
      await import("../../src/lib/dashboard-rebuild.js");

    await rebuildDashboardProductionArtifacts(webDir);

    // .next should be cleaned
    expect(existsSync(join(webDir, ".next"))).toBe(false);
    // pnpm build should be called from workspace root (../../ relative to webDir)
    expect(mockExec).toHaveBeenCalledWith("pnpm", ["build"], { cwd: tmpDir });
  });

  it("throws when pnpm build fails", async () => {
    const webDir = join(tmpDir, "packages", "web");
    mkdirSync(webDir, { recursive: true });

    mockExec.mockRejectedValue(new Error("build failed"));

    const { rebuildDashboardProductionArtifacts } =
      await import("../../src/lib/dashboard-rebuild.js");

    await expect(rebuildDashboardProductionArtifacts(webDir)).rejects.toThrow(
      "Failed to rebuild dashboard production artifacts",
    );
  });

  it("throws when called from an npm-installed path", async () => {
    const { rebuildDashboardProductionArtifacts } =
      await import("../../src/lib/dashboard-rebuild.js");

    await expect(
      rebuildDashboardProductionArtifacts("/usr/local/lib/node_modules/@aoagents/ao-web"),
    ).rejects.toThrow("Dashboard rebuild is only available from a source checkout");
  });
});

describe("clearStaleCacheIfNeeded", () => {
  it("clears .next/cache and writes stamp when version differs", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(join(webDir, ".next", "cache", "webpack"), { recursive: true });
    writeFileSync(join(webDir, ".next", "AO_VERSION"), "0.1.0");
    writeFileSync(join(webDir, "package.json"), JSON.stringify({ version: "0.2.0" }));

    const { clearStaleCacheIfNeeded } = await import("../../src/lib/dashboard-rebuild.js");
    await clearStaleCacheIfNeeded(webDir);

    expect(existsSync(join(webDir, ".next", "cache"))).toBe(false);
    expect(existsSync(join(webDir, ".next", "AO_VERSION"))).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(webDir, ".next", "AO_VERSION"), "utf8")).toBe("0.2.0");
  });

  it("clears cache when stamp is missing (upgrade from old version)", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(join(webDir, ".next", "cache"), { recursive: true });
    writeFileSync(join(webDir, "package.json"), JSON.stringify({ version: "0.2.0" }));

    const { clearStaleCacheIfNeeded } = await import("../../src/lib/dashboard-rebuild.js");
    await clearStaleCacheIfNeeded(webDir);

    expect(existsSync(join(webDir, ".next", "cache"))).toBe(false);
    expect(existsSync(join(webDir, ".next", "AO_VERSION"))).toBe(true);
  });

  it("is a no-op when version matches", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(join(webDir, ".next", "cache", "webpack"), { recursive: true });
    writeFileSync(join(webDir, ".next", "AO_VERSION"), "0.2.0");
    writeFileSync(join(webDir, "package.json"), JSON.stringify({ version: "0.2.0" }));

    const { clearStaleCacheIfNeeded } = await import("../../src/lib/dashboard-rebuild.js");
    await clearStaleCacheIfNeeded(webDir);

    // cache should still exist
    expect(existsSync(join(webDir, ".next", "cache", "webpack"))).toBe(true);
  });

  it("leaves .next/server and .next/static intact", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(join(webDir, ".next", "cache"), { recursive: true });
    mkdirSync(join(webDir, ".next", "server"), { recursive: true });
    mkdirSync(join(webDir, ".next", "static"), { recursive: true });
    writeFileSync(join(webDir, ".next", "AO_VERSION"), "0.1.0");
    writeFileSync(join(webDir, "package.json"), JSON.stringify({ version: "0.2.0" }));

    const { clearStaleCacheIfNeeded } = await import("../../src/lib/dashboard-rebuild.js");
    await clearStaleCacheIfNeeded(webDir);

    expect(existsSync(join(webDir, ".next", "cache"))).toBe(false);
    expect(existsSync(join(webDir, ".next", "server"))).toBe(true);
    expect(existsSync(join(webDir, ".next", "static"))).toBe(true);
  });
});

describe("looksLikeStaleBuild pattern matching", () => {
  // We can't import the private function directly, so we replicate the patterns
  // to ensure the detection logic catches the actual error messages seen in production.
  const patterns = [
    /Cannot find module.*vendor-chunks/,
    /Cannot find module.*\.next/,
    /Module not found.*\.next/,
    /ENOENT.*\.next/,
    /Could not find a production build/,
  ];

  function looksLikeStaleBuild(stderr: string): boolean {
    return patterns.some((p) => p.test(stderr));
  }

  it("detects vendor-chunks module not found (the actual bug)", () => {
    // This is the exact error from the bug report
    const stderr = "Error: Cannot find module '/path/to/.next/server/vendor-chunks/xterm@5.3.0.js'";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects generic .next module not found", () => {
    const stderr = "Cannot find module '/path/to/.next/server/chunks/123.js'";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects Module not found in .next", () => {
    const stderr = "Module not found: Error in .next/static/chunks/app/page.js";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects ENOENT for .next files", () => {
    const stderr = "ENOENT: no such file or directory, open '.next/BUILD_ID'";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects missing production build", () => {
    const stderr = "Could not find a production build in the '.next' directory.";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("does not flag unrelated errors", () => {
    const stderr = "TypeError: Cannot read properties of undefined";
    expect(looksLikeStaleBuild(stderr)).toBe(false);
  });

  it("does not flag normal startup output", () => {
    const stderr = "ready - started server on 0.0.0.0:3000";
    expect(looksLikeStaleBuild(stderr)).toBe(false);
  });
});

describe("findRunningDashboardPidsForWebDir", () => {
  it("returns only listeners whose cwd matches the web directory", async () => {
    const webDir = join(tmpDir, "packages", "web");
    mkdirSync(webDir, { recursive: true });

    mockExecSilent
      .mockResolvedValueOnce("111\n222\n")
      .mockResolvedValueOnce(`p111\nn${webDir}\n`)
      .mockResolvedValueOnce("p222\nn/tmp/other\n");

    const { findRunningDashboardPidsForWebDir } =
      await import("../../src/lib/dashboard-rebuild.js");

    await expect(findRunningDashboardPidsForWebDir(webDir, [3000])).resolves.toEqual(["111"]);
    expect(mockExecSilent).toHaveBeenCalledWith("lsof", ["-ti", ":3000", "-sTCP:LISTEN"]);
    expect(mockExecSilent).toHaveBeenCalledWith("lsof", ["-a", "-p", "111", "-d", "cwd", "-Fn"]);
  });

  it("deduplicates dashboard pids found on multiple ports", async () => {
    const webDir = join(tmpDir, "packages", "web");
    mkdirSync(webDir, { recursive: true });

    mockExecSilent
      .mockResolvedValueOnce("111\n")
      .mockResolvedValueOnce(`p111\nn${webDir}\n`)
      .mockResolvedValueOnce("111\n")
      .mockResolvedValueOnce(`p111\nn${webDir}\n`);

    const { findRunningDashboardPidsForWebDir } =
      await import("../../src/lib/dashboard-rebuild.js");

    await expect(findRunningDashboardPidsForWebDir(webDir, [3000, 3001])).resolves.toEqual(["111"]);
  });
});
