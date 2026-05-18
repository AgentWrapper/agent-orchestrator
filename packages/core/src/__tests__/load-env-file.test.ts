import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../config.js";

describe("loadEnvFile", () => {
  let dir: string;
  const TEST_KEYS = [
    "AO_TEST_FOO",
    "AO_TEST_BAR",
    "AO_TEST_BAZ",
    "AO_TEST_QUX",
    "AO_TEST_EMPTY",
    "AO_TEST_EXISTING",
    "AO_TEST_EXPORT_TAB",
    "AO_TEST_QUOTED",
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-env-"));
    for (const k of TEST_KEYS) Reflect.deleteProperty(process.env, k);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of TEST_KEYS) Reflect.deleteProperty(process.env, k);
  });

  function write(content: string): string {
    const path = join(dir, ".env");
    writeFileSync(path, content);
    return path;
  }

  it("parses KEY=value lines", () => {
    loadEnvFile(write("AO_TEST_FOO=hello\nAO_TEST_BAR=world\n"));
    expect(process.env.AO_TEST_FOO).toBe("hello");
    expect(process.env.AO_TEST_BAR).toBe("world");
  });

  it("strips surrounding quotes", () => {
    loadEnvFile(write(`AO_TEST_QUOTED="quoted value"\n`));
    expect(process.env.AO_TEST_QUOTED).toBe("quoted value");
  });

  it("strips `export ` prefix (bash-style .env)", () => {
    loadEnvFile(write("export AO_TEST_FOO=exported-value\n"));
    expect(process.env.AO_TEST_FOO).toBe("exported-value");
    expect(process.env["export AO_TEST_FOO"]).toBeUndefined();
  });

  it("strips `export\\t` prefix (tab separator)", () => {
    loadEnvFile(write("export\tAO_TEST_EXPORT_TAB=tabbed\n"));
    expect(process.env.AO_TEST_EXPORT_TAB).toBe("tabbed");
  });

  it("skips lines with invalid identifier keys", () => {
    // "1FOO" starts with a digit — invalid env var name, must be skipped
    // rather than silently polluting process.env.
    loadEnvFile(write("1FOO=bad\nAO_TEST_FOO=good\n"));
    expect(process.env["1FOO"]).toBeUndefined();
    expect(process.env.AO_TEST_FOO).toBe("good");
  });

  it("ignores comments and blank lines", () => {
    loadEnvFile(
      write("# comment\n\nAO_TEST_FOO=value\n   \n# another\n"),
    );
    expect(process.env.AO_TEST_FOO).toBe("value");
  });

  it("preserves existing env vars including explicit empty string", () => {
    process.env.AO_TEST_EXISTING = "preset";
    process.env.AO_TEST_EMPTY = ""; // deliberate disable signal
    loadEnvFile(
      write("AO_TEST_EXISTING=overwritten\nAO_TEST_EMPTY=overwritten\n"),
    );
    expect(process.env.AO_TEST_EXISTING).toBe("preset");
    expect(process.env.AO_TEST_EMPTY).toBe("");
  });

  it("returns silently when file does not exist", () => {
    expect(() => loadEnvFile(join(dir, "missing.env"))).not.toThrow();
  });
});
