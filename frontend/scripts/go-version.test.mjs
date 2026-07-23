// @vitest-environment node
import { describe, expect, it } from "vitest";
import { meetsMinimumVersion, parseGoVersion, parseMinimumGoVersion } from "./go-version.mjs";

describe("parseGoVersion", () => {
	it("parses stable Go versions and defaults a missing patch to zero", () => {
		expect(parseGoVersion("go version go1.25.7 darwin/arm64")).toEqual([1, 25, 7]);
		expect(parseGoVersion("go version go1.26 linux/amd64")).toEqual([1, 26, 0]);
	});

	it("rejects unparseable and prerelease Go versions", () => {
		expect(parseGoVersion("not Go")).toBeNull();
		expect(parseGoVersion("go version go1.25rc1 darwin/arm64")).toBeNull();
		expect(parseGoVersion("go version go1.25.7rc1 darwin/arm64")).toBeNull();
	});
});

describe("parseMinimumGoVersion", () => {
	it("reads the stable Go requirement from go.mod", () => {
		expect(parseMinimumGoVersion("module example.com/project\n\ngo 1.25.7\n")).toEqual([1, 25, 7]);
		expect(parseMinimumGoVersion("go 1.26\n")).toEqual([1, 26, 0]);
	});

	it("rejects a missing or prerelease Go directive", () => {
		expect(parseMinimumGoVersion("module example.com/project\n")).toBeNull();
		expect(parseMinimumGoVersion("go 1.25rc1\n")).toBeNull();
	});
});

describe("meetsMinimumVersion", () => {
	const minimum = [1, 25, 7];

	it.each([
		{ version: [1, 25, 6], expected: false },
		{ version: [1, 25, 7], expected: true },
		{ version: [1, 26, 0], expected: true },
		{ version: [2, 0, 0], expected: true },
	])("returns $expected for $version", ({ version, expected }) => {
		expect(meetsMinimumVersion(version, minimum)).toBe(expected);
	});

	it("accepts an explicit minimum version", () => {
		expect(meetsMinimumVersion([1, 25, 7], minimum)).toBe(true);
	});
});
