import { describe, expect, it } from "vitest";
import { deriveGitLabApiBaseUrl, deriveProviderRepo, deriveRepositoryHref } from "./scm-repo";

describe("SCM repository helpers", () => {
	it("preserves nested GitLab groups while keeping GitHub owner/repo semantics", () => {
		expect(deriveProviderRepo("git@gitlab.example.com:group/subgroup/project.git", "gitlab")).toBe(
			"group/subgroup/project",
		);
		expect(deriveProviderRepo("https://github.com/acme/project.git", "github")).toBe("acme/project");
	});

	it("derives the GitLab v4 API URL from a self-hosted web URL", () => {
		expect(deriveGitLabApiBaseUrl("https://gitlab.example.com/")).toBe("https://gitlab.example.com/api/v4");
		expect(deriveGitLabApiBaseUrl("https://gitlab.example.com/gitlab/")).toBe(
			"https://gitlab.example.com/gitlab/api/v4",
		);
		expect(deriveGitLabApiBaseUrl("not a url")).toBe("");
	});

	it("removes a self-hosted GitLab base path from HTTPS and SCP repository coordinates", () => {
		const webBaseUrl = "https://code.example.com/gitlab";
		expect(deriveProviderRepo("https://code.example.com/gitlab/group/subgroup/project.git", "gitlab", webBaseUrl)).toBe(
			"group/subgroup/project",
		);
		expect(deriveProviderRepo("git@code.example.com:gitlab/group/subgroup/project.git", "gitlab", webBaseUrl)).toBe(
			"group/subgroup/project",
		);
	});

	it("keeps a self-hosted GitLab base path in HTTPS and SCP repository links", () => {
		const webBaseUrl = "https://code.example.com/gitlab";
		expect(
			deriveRepositoryHref(
				"https://code.example.com/gitlab/group/subgroup/project.git",
				"group/subgroup/project",
				webBaseUrl,
			),
		).toBe("https://code.example.com/gitlab/group/subgroup/project");
		expect(
			deriveRepositoryHref(
				"git@code.example.com:gitlab/group/subgroup/project.git",
				"group/subgroup/project",
				webBaseUrl,
			),
		).toBe("https://code.example.com/gitlab/group/subgroup/project");
	});
});
