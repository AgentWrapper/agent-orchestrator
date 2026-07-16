import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildIntake, deriveProviderRepo, IntakeFields } from "./IntakeFields";

describe("IntakeFields", () => {
	it("derives provider-native repositories including GitLab subgroups", () => {
		expect(deriveProviderRepo("git@github.com:acme/web.git", "github")).toBe("acme/web");
		expect(deriveProviderRepo("git@gitlab.example.com:group/subgroup/api.git", "gitlab")).toBe(
			"group/subgroup/api",
		);
	});

	it("builds inherited GitLab intake filters", () => {
		expect(
			buildIntake({ enabled: true, provider: "gitlab", repo: "", assignee: "alice", labels: "ready, backend" }),
		).toEqual({
			enabled: true,
			provider: "gitlab",
			assignee: "alice",
			labels: ["ready", "backend"],
		});
	});

	it("renders a GitLab repository preview without a GitHub URL", () => {
		render(
			<IntakeFields
				form={{ enabled: true, provider: "gitlab", repo: "", assignee: "alice", labels: "" }}
				onChange={() => undefined}
				repoPreview={{
					provider: "gitlab",
					value: "group/subgroup/api",
					href: "https://gitlab.example.com/group/subgroup/api",
				}}
			/>,
		);

		expect(screen.getByRole("link", { name: "group/subgroup/api" })).toHaveAttribute(
			"href",
			"https://gitlab.example.com/group/subgroup/api",
		);
	});
});
