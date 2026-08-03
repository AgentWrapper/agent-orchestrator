import { describe, expect, it } from "vitest";
import { githubAppUrl } from "./githubLink";

describe("githubAppUrl", () => {
	it("maps a repo URL", () => {
		expect(githubAppUrl("https://github.com/AgentWrapper/agent-orchestrator")).toBe(
			"github://repo/AgentWrapper/agent-orchestrator",
		);
	});

	it("maps a pull request URL", () => {
		expect(githubAppUrl("https://github.com/o/r/pull/184")).toBe("github://repo/o/r/pull/184");
	});

	it("maps an issue URL", () => {
		expect(githubAppUrl("https://github.com/o/r/issues/12")).toBe("github://repo/o/r/issues/12");
	});

	it("tolerates www, http, trailing slashes and query strings", () => {
		expect(githubAppUrl("http://www.github.com/o/r/")).toBe("github://repo/o/r");
		expect(githubAppUrl("https://github.com/o/r/pull/9?diff=split")).toBe("github://repo/o/r/pull/9");
		expect(githubAppUrl("  https://github.com/o/r  ")).toBe("github://repo/o/r");
	});

	// The case that motivated the null branch: the app cannot accept a prefilled
	// issue body, so "Report a problem" has to stay in the browser.
	it("refuses the prefilled new-issue URL", () => {
		expect(githubAppUrl("https://github.com/AgentWrapper/agent-orchestrator/issues/new?body=hello")).toBeNull();
		expect(githubAppUrl("https://github.com/o/r/issues/new")).toBeNull();
	});

	it("refuses non-github hosts", () => {
		expect(githubAppUrl("https://gitlab.com/o/r")).toBeNull();
		expect(githubAppUrl("https://example.com/github.com/o/r")).toBeNull();
		// Lookalike host — must not match on a suffix.
		expect(githubAppUrl("https://notgithub.com/o/r")).toBeNull();
	});

	it("refuses paths with no repo", () => {
		expect(githubAppUrl("https://github.com/")).toBeNull();
		expect(githubAppUrl("https://github.com/onlyowner")).toBeNull();
	});

	it("refuses reserved roots that look like owners", () => {
		expect(githubAppUrl("https://github.com/settings/profile")).toBeNull();
		expect(githubAppUrl("https://github.com/orgs/acme")).toBeNull();
	});

	it("refuses deep paths the app has no stable screen for", () => {
		expect(githubAppUrl("https://github.com/o/r/blob/main/README.md")).toBeNull();
		expect(githubAppUrl("https://github.com/o/r/pull/184/files")).toBeNull();
		expect(githubAppUrl("https://github.com/o/r/pull/abc")).toBeNull();
	});
});
