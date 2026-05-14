import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathsEqual, canonicalCompareKey } from "../../src/lib/path-equality.js";

let tmpDir: string;
let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-pathseq-"));
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("pathsEqual", () => {
  it("returns true for the same path", () => {
    const dir = join(tmpDir, "same");
    mkdirSync(dir);
    expect(pathsEqual(dir, dir)).toBe(true);
  });

  it("returns false for clearly different paths", () => {
    const a = join(tmpDir, "a");
    const b = join(tmpDir, "b");
    mkdirSync(a);
    mkdirSync(b);
    expect(pathsEqual(a, b)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("treats drive-letter case as equal on Windows", () => {
    // Real filesystem path so realpathSync resolves; only the input case differs.
    const dir = join(tmpDir, "case-test");
    mkdirSync(dir);
    const lowerDrive = dir.replace(/^([A-Z]):/, (_, c: string) => `${c.toLowerCase()}:`);
    const upperDrive = dir.replace(/^([a-z]):/, (_, c: string) => `${c.toUpperCase()}:`);
    expect(pathsEqual(lowerDrive, upperDrive)).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "treats arbitrary path-segment case as equal on Windows",
    () => {
      const dir = join(tmpDir, "MixedCaseSegment");
      mkdirSync(dir);
      const lower = dir.toLowerCase();
      // realpathSync should resolve both to the same on-disk canonical form;
      // pathsEqual then lowercases for comparison on Windows.
      expect(pathsEqual(dir, lower)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")("is case-sensitive on POSIX", () => {
    // Don't actually mkdir — we just want to verify the comparison logic.
    // Use a non-existent path so realpathSync falls back to the literal.
    setPlatform("linux");
    const a = "/tmp/Case-Sensitive-Test-NoExist";
    const b = "/tmp/case-sensitive-test-noexist";
    expect(pathsEqual(a, b)).toBe(false);
  });

  it("falls back to literal comparison when realpathSync fails (path doesn't exist)", () => {
    const a = join(tmpDir, "nonexistent");
    expect(pathsEqual(a, a)).toBe(true);
  });
});

describe("canonicalCompareKey", () => {
  it("expands ~ to HOME", () => {
    const originalHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    try {
      const key = canonicalCompareKey("~");
      // On Windows the result is lowercased; on POSIX it's case-preserved.
      expect(key.toLowerCase()).toBe(tmpDir.toLowerCase());
    } finally {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
    }
  });

  it("returns the same key for equivalent inputs", () => {
    const dir = join(tmpDir, "equiv");
    mkdirSync(dir);
    expect(canonicalCompareKey(dir)).toBe(canonicalCompareKey(dir));
  });
});
