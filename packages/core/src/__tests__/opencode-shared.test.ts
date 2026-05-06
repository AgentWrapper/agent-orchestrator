import { describe, expect, it, beforeEach } from "vitest";

import {
  ensureOpenCodeTmpDir,
  getOpenCodeChildEnv,
  getOpenCodeTmpDir,
  invalidateOpenCodeSessionListCache,
  resetOpenCodeSessionListCache,
  OPENCODE_SESSION_LIST_CACHE_TTL_MS,
} from "../opencode-shared.js";

describe("opencode-shared", () => {
  beforeEach(() => {
    resetOpenCodeSessionListCache();
  });

  describe("OPENCODE_SESSION_LIST_CACHE_TTL_MS", () => {
    it("does not cover the 500ms send-confirmation poll interval", () => {
      // The send-confirmation loop in session-manager polls 6× at 500ms
      // intervals (~3s total). The TTL must be ≤500ms so each loop
      // iteration sees fresh data and the
      // `updatedAt > baselineUpdatedAt` delivery signal can fire.
      expect(OPENCODE_SESSION_LIST_CACHE_TTL_MS).toBeLessThanOrEqual(500);
      expect(OPENCODE_SESSION_LIST_CACHE_TTL_MS).toBeGreaterThan(0);
    });
  });

  describe("getOpenCodeTmpDir / ensureOpenCodeTmpDir", () => {
    it("lives under the AO base dir, not the system /tmp", () => {
      const dir = getOpenCodeTmpDir();
      expect(dir).toMatch(/\.agent-orchestrator[\\/]\.bun-tmp$/);
      expect(dir.startsWith("/tmp")).toBe(false);
    });

    it("creates the directory and tolerates pre-existing", () => {
      const a = ensureOpenCodeTmpDir();
      const b = ensureOpenCodeTmpDir();
      expect(a).toBe(b);
    });
  });

  describe("getOpenCodeChildEnv", () => {
    it("sets TMPDIR/TMP/TEMP to the AO-owned dir", () => {
      const env = getOpenCodeChildEnv();
      const dir = getOpenCodeTmpDir();
      expect(env["TMPDIR"]).toBe(dir);
      expect(env["TMP"]).toBe(dir);
      expect(env["TEMP"]).toBe(dir);
    });

    it("merges extra env vars on top, but keeps TMPDIR pointed at AO dir", () => {
      const env = getOpenCodeChildEnv({ FOO: "bar" });
      expect(env["FOO"]).toBe("bar");
      expect(env["TMPDIR"]).toBe(getOpenCodeTmpDir());
    });

    it("allows extra env to override TMPDIR for explicit opt-out", () => {
      const env = getOpenCodeChildEnv({ TMPDIR: "/elsewhere" });
      expect(env["TMPDIR"]).toBe("/elsewhere");
    });
  });

  describe("invalidateOpenCodeSessionListCache", () => {
    it("is a no-throw on an empty cache", () => {
      expect(() => invalidateOpenCodeSessionListCache()).not.toThrow();
    });
  });
});
