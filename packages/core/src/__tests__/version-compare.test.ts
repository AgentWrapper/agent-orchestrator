import { describe, it, expect } from "vitest";

import { isVersionOutdated } from "../version-compare.js";

// Both `packages/cli/src/lib/update-check.ts` and
// `packages/web/src/app/api/version/route.ts` import this implementation
// from core. These tests are the single source of truth for the comparison
// rules — if either consumer's behavior diverges, fix the consumer, not this.

describe("isVersionOutdated (shared core implementation)", () => {
  describe("numeric major/minor/patch", () => {
    it("treats lower major as older", () => {
      expect(isVersionOutdated("0.2.2", "1.0.0")).toBe(true);
    });

    it("treats lower minor as older", () => {
      expect(isVersionOutdated("0.2.2", "0.3.0")).toBe(true);
    });

    it("treats lower patch as older", () => {
      expect(isVersionOutdated("0.2.2", "0.2.3")).toBe(true);
    });

    it("returns false when versions are equal", () => {
      expect(isVersionOutdated("0.2.2", "0.2.2")).toBe(false);
    });

    it("returns false when current is newer", () => {
      expect(isVersionOutdated("1.0.0", "0.9.9")).toBe(false);
    });

    it("treats missing patch as 0", () => {
      expect(isVersionOutdated("1.0", "1.0.1")).toBe(true);
    });

    it("returns false when prerelease tags produce NaN parts", () => {
      expect(isVersionOutdated("beta", "1.0.0")).toBe(false);
    });
  });

  describe("prerelease vs stable", () => {
    it("treats prerelease as older than the matching stable", () => {
      expect(isVersionOutdated("0.2.2-beta.1", "0.2.2")).toBe(true);
      expect(isVersionOutdated("0.2.2-rc.1", "0.2.2")).toBe(true);
      expect(isVersionOutdated("0.5.0-nightly-abc", "0.5.0")).toBe(true);
    });

    it("treats stable as newer than its prerelease", () => {
      expect(isVersionOutdated("0.3.0", "0.3.0-beta.1")).toBe(false);
    });

    it("compares numeric base first regardless of prerelease tag", () => {
      expect(isVersionOutdated("0.2.2-beta.1", "0.3.0")).toBe(true);
    });
  });

  describe("prerelease vs prerelease", () => {
    it("compares numeric prerelease segments numerically", () => {
      expect(isVersionOutdated("0.2.2-rc.1", "0.2.2-rc.2")).toBe(true);
      expect(isVersionOutdated("0.2.2-rc.2", "0.2.2-rc.1")).toBe(false);
      expect(isVersionOutdated("0.2.2-rc.2", "0.2.2-rc.2")).toBe(false);
    });

    it("treats any SHA-suffix difference as outdated (lexical compare would misfire ~50%)", () => {
      // The release pipeline tags nightlies as 0.x.y-nightly-<sha>. SHAs are
      // uniformly-random hex, so lexical ordering of `nightly-f00d123` vs
      // `nightly-0dead01` would give the wrong answer half the time
      // ('f' > '0' but the second SHA is newer). The cache always carries the
      // registry's CURRENT dist-tag target, so any SHA mismatch on the same
      // base means we're behind by construction.
      expect(isVersionOutdated("0.5.0-nightly-abc", "0.5.0-nightly-def")).toBe(true);
      // Critical: the inverse must also report "outdated" — that's the bug
      // the user would hit when their leading-hex sorts higher than latest's.
      expect(isVersionOutdated("0.5.0-nightly-def", "0.5.0-nightly-abc")).toBe(true);
      expect(isVersionOutdated("0.5.0-nightly-f00d123", "0.5.0-nightly-0dead01")).toBe(true);
      // Same SHA on both sides → still equal, not outdated.
      expect(isVersionOutdated("0.5.0-nightly-abc", "0.5.0-nightly-abc")).toBe(false);
    });

    it("still uses numeric ordering when prerelease segments are numbers", () => {
      // We didn't break the `rc.1 < rc.2` semver semantics — numeric segments
      // continue to compare numerically. Only non-numeric differences fall
      // back to "older."
      expect(isVersionOutdated("0.2.2-rc.1", "0.2.2-rc.2")).toBe(true);
      expect(isVersionOutdated("0.2.2-rc.2", "0.2.2-rc.1")).toBe(false);
    });

    it("longer prerelease wins when shared segments are equal", () => {
      expect(isVersionOutdated("0.5.0-nightly", "0.5.0-nightly.1")).toBe(true);
    });

    it("numeric segment is older than non-numeric segment", () => {
      expect(isVersionOutdated("0.5.0-1", "0.5.0-alpha")).toBe(true);
      expect(isVersionOutdated("0.5.0-alpha", "0.5.0-1")).toBe(false);
    });
  });
});
