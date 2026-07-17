// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scanRepoSetupCode } from "./import-scan";

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
