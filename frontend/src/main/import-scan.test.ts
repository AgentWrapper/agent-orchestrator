// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scanRepoSetupCode, scanRepoValidationCode } from "./import-scan";

describe("scanRepoSetupCode", () => {
	it.each([
		["reserved repository", "__root__", false, false, undefined],
		["bare repository", "project.git", true, false, undefined],
		["unborn non-bare repository", "project", false, false, "PROJECT_UNBORN"],
		["unknown bare probe", "project", undefined, false, undefined],
		["repository with HEAD", "project", false, true, undefined],
	] as const)("classifies %s", (_case, name, isBare, hasHead, expected) => {
		expect(scanRepoSetupCode(name, isBare, hasHead)).toBe(expected);
	});
});

describe("scanRepoValidationCode", () => {
	it.each([
		["reserved repository", "__root__", "main", true, false, true, "RESERVED_NAME"],
		["bare repository", "project.git", "HEAD", false, true, false, "BARE_REPOSITORY"],
		["repository without commits", "project", "HEAD", false, false, false, "NO_COMMITS"],
		["repository without a branch", "project", "HEAD", true, false, true, "NO_CHECKED_OUT_BRANCH"],
		["repository without origin", "project", "main", false, false, true, "NO_ORIGIN_REMOTE"],
		["valid repository", "project", "main", true, false, true, undefined],
	] as const)("classifies %s", (_case, name, branch, hasRemote, isBare, hasHead, expected) => {
		expect(scanRepoValidationCode(name, branch, hasRemote, isBare, hasHead)).toBe(expected);
	});
});
