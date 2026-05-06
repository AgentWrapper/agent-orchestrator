import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as AoCore from "@aoagents/ao-core";

// We point the shared module at a fresh temp dir per test by mocking the
// AO base path resolver. The janitor pulls the dir from
// @aoagents/ao-core's getOpenCodeTmpDir.
let mockedDir = "";
vi.mock("@aoagents/ao-core", async () => {
  const actual = await vi.importActual<typeof AoCore>("@aoagents/ao-core");
  return {
    ...actual,
    getOpenCodeTmpDir: () => mockedDir,
  };
});

import {
  isBunTmpJanitorRunning,
  startBunTmpJanitor,
  stopBunTmpJanitor,
} from "../../src/lib/bun-tmp-janitor.js";

const PATTERN_NAME = ".fcb8efb7fbaad77d-00000000.so";

function setMtime(path: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

describe("bun-tmp-janitor", () => {
  beforeEach(() => {
    mockedDir = mkdtempSync(join(tmpdir(), "ao-bun-janitor-test-"));
  });

  afterEach(async () => {
    await stopBunTmpJanitor();
  });

  it("sweeps matching files older than ageMs in the AO-owned dir only", async () => {
    const oldFile = join(mockedDir, PATTERN_NAME);
    const youngFile = join(mockedDir, ".aaaaaaaa-bbbbbbbb.so");
    const unrelated = join(mockedDir, "regular-file.txt");
    writeFileSync(oldFile, "x".repeat(1024));
    writeFileSync(youngFile, "x");
    writeFileSync(unrelated, "x");
    setMtime(oldFile, 120_000); // 2 minutes old

    const sweeps: { removed: number; freedBytes: number; errors: number }[] = [];
    startBunTmpJanitor({
      intervalMs: 60_000,
      ageMs: 60_000,
      onSweep: (r) => sweeps.push(r),
    });

    // Wait for the immediate sweep to complete.
    await stopBunTmpJanitor();

    expect(sweeps.length).toBe(1);
    expect(sweeps[0]?.removed).toBe(1);
    expect(sweeps[0]?.freedBytes).toBe(1024);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(youngFile)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("treats a missing AO tmp dir as empty (no error)", async () => {
    mockedDir = join(tmpdir(), `ao-bun-janitor-missing-${Date.now()}`);
    expect(existsSync(mockedDir)).toBe(false);

    const sweeps: { removed: number; freedBytes: number; errors: number }[] = [];
    startBunTmpJanitor({ onSweep: (r) => sweeps.push(r) });
    await stopBunTmpJanitor();

    // No callback fires when removed=0 and errors=0.
    expect(sweeps).toEqual([]);
  });

  it("stopBunTmpJanitor awaits the in-flight sweep", async () => {
    // Drop a matching file so the immediate sweep does real work.
    const path = join(mockedDir, PATTERN_NAME);
    writeFileSync(path, "x");
    setMtime(path, 120_000);

    startBunTmpJanitor({ ageMs: 60_000 });
    expect(isBunTmpJanitorRunning()).toBe(true);

    await stopBunTmpJanitor();

    // After awaiting stop, the sweep must have run to completion: the
    // file must be gone, and the timer cleared.
    expect(isBunTmpJanitorRunning()).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("does not double-start", async () => {
    const a = startBunTmpJanitor();
    const b = startBunTmpJanitor();
    expect(a).toBe(true);
    expect(b).toBe(false);
    await stopBunTmpJanitor();
  });

  it("ignores files that do not match the Bun tmp library pattern", async () => {
    const matching = join(mockedDir, ".1234567890abcdef-12345678.dylib");
    const nonMatching = join(mockedDir, "libopentui.so");
    writeFileSync(matching, "x");
    writeFileSync(nonMatching, "x");
    setMtime(matching, 120_000);
    setMtime(nonMatching, 120_000);

    startBunTmpJanitor({ ageMs: 60_000 });
    await stopBunTmpJanitor();

    expect(existsSync(matching)).toBe(false);
    expect(existsSync(nonMatching)).toBe(true);
    // Sanity: stat works (file exists), proves we did not unlink it.
    expect(statSync(nonMatching).size).toBeGreaterThan(0);
  });
});
