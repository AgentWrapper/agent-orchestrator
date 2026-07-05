import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import { PRSummaryParts } from "./PRSummaryDisplay";

const summary = (overrides: Partial<SessionPRSummary> = {}): SessionPRSummary => ({
	url: "https://github.com/acme/repo/pull/7",
	htmlUrl: "https://github.com/acme/repo/pull/7",
	number: 7,
	title: "Fix dashboard",
	state: "open",
	provider: "github",
	repo: "acme/repo",
	author: "ada",
	sourceBranch: "fix/dashboard",
	targetBranch: "main",
	headSha: "abc123",
	additions: 10,
	deletions: 3,
	changedFiles: 2,
	ci: { state: "passing", failingChecks: [] },
	review: { decision: "approved", hasUnresolvedHumanComments: false, unresolvedBy: [] },
	mergeability: { state: "mergeable", reasons: [], prUrl: "https://github.com/acme/repo/pull/7" },
	updatedAt: "2026-06-15T00:00:00Z",
	observedAt: "2026-06-15T00:00:00Z",
	ciObservedAt: "2026-06-15T00:00:00Z",
	reviewObservedAt: "2026-06-15T00:00:00Z",
	...overrides,
});

describe("PRSummaryParts", () => {
	it("counts overflow from the rendered maxLinks limit", () => {
		render(
			<PRSummaryParts
				interactiveLinks={false}
				maxLinks={2}
				pr={summary({
					ci: {
						state: "failing",
						failingChecks: [
							{ name: "unit", status: "failed", conclusion: "failure", url: "https://checks.example/unit" },
							{ name: "lint", status: "failed", conclusion: "failure", url: "https://checks.example/lint" },
							{ name: "types", status: "failed", conclusion: "failure", url: "https://checks.example/types" },
						],
					},
				})}
			/>,
		);

		expect(screen.getByText("unit")).toBeInTheDocument();
		expect(screen.getByText("lint")).toBeInTheDocument();
		expect(screen.queryByText("types")).not.toBeInTheDocument();
		expect(screen.getByText("+1 check")).toBeInTheDocument();
	});

	it("counts overflow beyond helper-truncated links", () => {
		render(
			<PRSummaryParts
				interactiveLinks={false}
				pr={summary({
					ci: {
						state: "failing",
						failingChecks: [
							{ name: "unit", status: "failed", conclusion: "failure", url: "https://checks.example/unit" },
							{ name: "lint", status: "failed", conclusion: "failure", url: "https://checks.example/lint" },
							{ name: "types", status: "failed", conclusion: "failure", url: "https://checks.example/types" },
							{ name: "build", status: "failed", conclusion: "failure", url: "https://checks.example/build" },
						],
					},
				})}
			/>,
		);

		expect(screen.getByText("unit")).toBeInTheDocument();
		expect(screen.getByText("lint")).toBeInTheDocument();
		expect(screen.getByText("types")).toBeInTheDocument();
		expect(screen.queryByText("build")).not.toBeInTheDocument();
		expect(screen.getByText("+1 check")).toBeInTheDocument();
	});
});
