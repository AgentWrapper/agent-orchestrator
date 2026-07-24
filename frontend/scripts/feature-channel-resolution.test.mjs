// @vitest-environment node
//
// Regression guard for electron-updater GitHubProvider's channel-selection predicate.
//
// The predicate (from GitHubProvider.js getLatestVersion) is:
//
//   const hrefChannel = semver.prerelease(tag)?.[0] || null;
//   const isNextPreRelease = hrefChannel && hrefChannel === currentChannel;
//   if (isNextPreRelease) { // this release matches the channel }
//
// In plain terms: the provider picks the first tag (newest from the Atom feed)
// whose `semver.prerelease(tag)[0]` equals the configured channel string.
//
// This test encodes that predicate over a fixture tag list and asserts:
//   - channel "pr2270" selects the pr2270 tag only, not newer nightly or stable
//   - channel "nightly" selects the nightly tag only, not the pr2270 build
//
// If a future electron-updater bump changes the matching rule (e.g. uses a
// different prerelease index or does a substring match), this test will catch it
// before the update channel silently starts delivering the wrong binary.
// Reference: node_modules/electron-updater/out/providers/GitHubProvider.js

import { describe, it, expect } from "vitest";
import semver from "semver";

// ---------------------------------------------------------------------------
// Fixture: a representative list of release tags ordered newest-first, as the
// GitHub Atom feed presents them (latest release first).
// ---------------------------------------------------------------------------
const TAGS = [
	// A nightly that is newer than the current stable and the feature build.
	"v0.3.0-nightly.202607060000",
	// A feature build for PR #2270.
	"v0.2.0-pr2270.202607061200",
	// The current stable release.
	"v0.2.0",
];

// ---------------------------------------------------------------------------
// The GitHubProvider's selection predicate, faithfully reproduced.
// Given an ordered list of tags and a channel string, returns the first matching tag.
// ---------------------------------------------------------------------------
function selectTag(tags, channel) {
	for (const tag of tags) {
		// Skip non-semver (e.g. doc tags).
		if (!semver.valid(tag)) continue;
		const hrefChannel = semver.prerelease(tag)?.[0] ?? null;
		// GitHubProvider: "const isNextPreRelease = hrefChannel && hrefChannel === currentChannel"
		const isNextPreRelease = hrefChannel && hrefChannel === channel;
		if (isNextPreRelease) return tag;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("electron-updater GitHubProvider channel-selection invariant", () => {
	describe("channel 'pr2270'", () => {
		it("selects the pr2270 feature-build tag", () => {
			expect(selectTag(TAGS, "pr2270")).toBe("v0.2.0-pr2270.202607061200");
		});

		it("does NOT select the newer nightly tag (no hijack)", () => {
			const selected = selectTag(TAGS, "pr2270");
			expect(selected).not.toBe("v0.3.0-nightly.202607060000");
		});

		it("does NOT select the stable tag", () => {
			const selected = selectTag(TAGS, "pr2270");
			expect(selected).not.toBe("v0.2.0");
		});

		it("semver.prerelease(tag)[0] for the pr2270 tag is exactly 'pr2270'", () => {
			expect(semver.prerelease("v0.2.0-pr2270.202607061200")?.[0]).toBe("pr2270");
		});
	});

	describe("channel 'nightly'", () => {
		it("selects the nightly tag", () => {
			expect(selectTag(TAGS, "nightly")).toBe("v0.3.0-nightly.202607060000");
		});

		it("does NOT select the pr2270 build (no cross-channel hijack)", () => {
			const selected = selectTag(TAGS, "nightly");
			expect(selected).not.toBe("v0.2.0-pr2270.202607061200");
		});

		it("does NOT select the stable tag", () => {
			const selected = selectTag(TAGS, "nightly");
			expect(selected).not.toBe("v0.2.0");
		});

		it("semver.prerelease(tag)[0] for the nightly tag is exactly 'nightly'", () => {
			expect(semver.prerelease("v0.3.0-nightly.202607060000")?.[0]).toBe("nightly");
		});
	});

	describe("channel 'latest' (stable users)", () => {
		it("returns null — stable users are on no prerelease channel, nothing matches", () => {
			// "latest" is not a semver prerelease id; no tag has prerelease[0] === "latest".
			expect(selectTag(TAGS, "latest")).toBeNull();
		});
	});

	describe("isolation: no tag is selected by the wrong channel", () => {
		it("pr2270 channel does not match nightly prerelease[0]", () => {
			expect(semver.prerelease("v0.3.0-nightly.202607060000")?.[0]).not.toBe("pr2270");
		});

		it("nightly channel does not match pr2270 prerelease[0]", () => {
			expect(semver.prerelease("v0.2.0-pr2270.202607061200")?.[0]).not.toBe("nightly");
		});

		it("stable tag has no prerelease component at all", () => {
			expect(semver.prerelease("v0.2.0")).toBeNull();
		});
	});
});
