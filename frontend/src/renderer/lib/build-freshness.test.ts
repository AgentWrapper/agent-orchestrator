import { describe, expect, it } from "vitest";
import { classifyBuildFreshness } from "./build-freshness";

describe("classifyBuildFreshness", () => {
	it("detects a stale loaded bundle when the served frontend tree differs", () => {
		expect(classifyBuildFreshness("client-tree", { frontendTree: "served-tree" })).toEqual({
			state: "stale",
			clientFrontendTree: "client-tree",
			servedFrontendTree: "served-tree",
		});
	});

	it("treats matching frontend trees as current even when revisions differ", () => {
		const manifestWithIgnoredRevision = {
			frontendTree: "same-tree",
			revision: "backend-only-deploy",
		} as { frontendTree?: string };

		expect(classifyBuildFreshness("same-tree", manifestWithIgnoredRevision)).toEqual({
			state: "current",
			clientFrontendTree: "same-tree",
			servedFrontendTree: "same-tree",
		});
	});

	it("returns unknown when either side lacks a frontend tree identity", () => {
		expect(classifyBuildFreshness("", { frontendTree: "served-tree" })).toMatchObject({
			state: "unknown",
			reason: "client frontend tree unavailable",
		});
		expect(classifyBuildFreshness("client-tree", {})).toMatchObject({
			state: "unknown",
			reason: "served frontend tree unavailable",
		});
	});
});
