// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
	isPlaceholderSha256,
	parseChecksumsFile,
	PLACEHOLDER_SHA256,
	resolveExpectedHash,
} from "./fetch-tmux.mjs";

const HASH_ARM64 = "a".repeat(64);
const HASH_LINUX = "b".repeat(64);
const CHECKSUMS = `${HASH_ARM64}  tmux-darwin-arm64\n${HASH_LINUX}  tmux-linux-x64\n`;

describe("parseChecksumsFile", () => {
	it("parses sha256sum lines into an asset map", () => {
		const map = parseChecksumsFile(CHECKSUMS);
		expect(map.get("tmux-darwin-arm64")).toBe(HASH_ARM64);
		expect(map.get("tmux-linux-x64")).toBe(HASH_LINUX);
	});
});

describe("isPlaceholderSha256", () => {
	it("treats all-zero pins as unset", () => {
		expect(isPlaceholderSha256(PLACEHOLDER_SHA256)).toBe(true);
		expect(isPlaceholderSha256(undefined)).toBe(true);
		expect(isPlaceholderSha256("c".repeat(64))).toBe(false);
	});
});

describe("resolveExpectedHash", () => {
	const checksums = parseChecksumsFile(CHECKSUMS);

	it("uses release checksums when no pin is set", () => {
		expect(resolveExpectedHash(undefined, checksums, "tmux-darwin-arm64")).toBe(HASH_ARM64);
	});

	it("rejects placeholder pins instead of treating them as real hashes", () => {
		expect(resolveExpectedHash(PLACEHOLDER_SHA256, checksums, "tmux-darwin-arm64")).toBe(HASH_ARM64);
	});

	it("accepts a matching in-repo pin", () => {
		expect(resolveExpectedHash(HASH_ARM64, checksums, "tmux-darwin-arm64")).toBe(HASH_ARM64);
	});

	it("fails when a pin disagrees with the release", () => {
		expect(() => resolveExpectedHash("c".repeat(64), checksums, "tmux-darwin-arm64")).toThrow(
			/does not match release checksums.txt/,
		);
	});
});
