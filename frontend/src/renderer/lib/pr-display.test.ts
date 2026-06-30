import { describe, expect, it } from "vitest";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import { prAttentionItems, prBrowserUrl, prDiffSummary, prStatusRows } from "./pr-display";

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

describe("prStatusRows", () => {
	it("formats the three PR states without exposing raw unknown", () => {
		const rows = prStatusRows(
			summary({
				ci: { state: "unknown", failingChecks: [] },
				review: { decision: "none", hasUnresolvedHumanComments: false, unresolvedBy: [] },
				mergeability: { state: "unknown", reasons: [], prUrl: "https://github.com/acme/repo/pull/7" },
			}),
		);

		expect(rows.map((row) => `${row.label}:${row.value}`)).toEqual(["CI:Checking", "Review:None", "Merge:Checking"]);
	});

	it("includes minimal diff detail on the merge row", () => {
		const rows = prStatusRows(summary({ changedFiles: 4, additions: 25, deletions: 2 }));
		expect(rows.find((row) => row.key === "merge")?.detail).toBe("4 files");
	});
});

describe("prDiffSummary", () => {
	it("formats file and line delta metadata", () => {
		expect(prDiffSummary(summary({ changedFiles: 6, additions: 42, deletions: 8 }))).toBe("6 files · +42 -8");
	});

	it("omits the diff label when no diff metadata is available", () => {
		expect(prDiffSummary(summary({ changedFiles: 0, additions: 0, deletions: 0 }))).toBeUndefined();
	});
});

describe("prBrowserUrl", () => {
	it("normalizes issue-shaped GitHub PR URLs to the pull request page", () => {
		expect(
			prBrowserUrl(
				summary({
					url: "https://github.com/acme/repo/issues/7",
					htmlUrl: "https://github.com/acme/repo/issues/7",
				}),
			),
		).toBe("https://github.com/acme/repo/pull/7");
	});
});

describe("prAttentionItems", () => {
	it("returns no attention for clean open PRs", () => {
		expect(prAttentionItems(summary())).toEqual([]);
	});

	it("details active CI, review, and merge blockers", () => {
		const items = prAttentionItems(
			summary({
				ci: {
					state: "failing",
					failingChecks: [
						{ name: "copy-check", status: "failed", conclusion: "failure", url: "https://checks.example/copy" },
					],
				},
				review: {
					decision: "changes_requested",
					hasUnresolvedHumanComments: true,
					unresolvedBy: [
						{
							reviewerId: "alice",
							count: 6,
							links: [{ url: "https://github.com/acme/repo/pull/7#discussion_r1", file: "main.go", line: 12 }],
						},
					],
				},
				mergeability: {
					state: "blocked",
					reasons: ["behind_base"],
					prUrl: "https://github.com/acme/repo/pull/7",
				},
			}),
		);

		expect(items.map((item) => item.kind)).toEqual(["merge_blocked", "ci_failing", "review_changes_requested"]);
		expect(items.find((item) => item.kind === "ci_failing")?.links[0]).toMatchObject({
			label: "copy-check",
			href: "https://checks.example/copy",
		});
		expect(items.find((item) => item.kind === "review_changes_requested")?.links[0]).toMatchObject({
			label: "alice +5",
			href: "https://github.com/acme/repo/pull/7#discussion_r1",
		});
	});

	it("links failing CI checks to their provider URLs", () => {
		const items = prAttentionItems(
			summary({
				ci: {
					state: "failing",
					failingChecks: [
						{ name: "unit", status: "failed", conclusion: "failure", url: "https://checks.example/unit" },
						{ name: "lint", status: "failed", conclusion: "failure", url: "https://checks.example/lint" },
						{ name: "build", status: "failed", conclusion: "failure", url: "https://checks.example/build" },
						{ name: "types", status: "failed", conclusion: "failure", url: "https://checks.example/types" },
					],
				},
			}),
		);

		const ciItem = items.find((item) => item.kind === "ci_failing");
		expect(ciItem?.links).toEqual([
			{ label: "unit", href: "https://checks.example/unit", title: "failure" },
			{ label: "lint", href: "https://checks.example/lint", title: "failure" },
			{ label: "build", href: "https://checks.example/build", title: "failure" },
		]);
		expect(ciItem?.overflowLabel).toBe("+1 check");
	});

	it("prefers the submitted review summary over inline comments", () => {
		const items = prAttentionItems(
			summary({
				review: {
					decision: "changes_requested",
					hasUnresolvedHumanComments: true,
					unresolvedBy: [
						{
							reviewerId: "alice",
							count: 2,
							reviewUrl: "https://github.com/acme/repo/pull/7#pullrequestreview-1",
							links: [
								{ url: "https://github.com/acme/repo/pull/7#discussion_r1", file: "main.go", line: 12 },
								{ url: "https://github.com/acme/repo/pull/7#discussion_r2", file: "test.go", line: 20 },
							],
						},
					],
				},
			}),
		);

		expect(items.find((item) => item.kind === "review_changes_requested")?.links[0]).toMatchObject({
			label: "alice +1",
			href: "https://github.com/acme/repo/pull/7#pullrequestreview-1",
			title: "Open requested-changes review from alice",
		});
	});

	it("falls back to the first inline comment when no review summary exists", () => {
		const items = prAttentionItems(
			summary({
				review: {
					decision: "changes_requested",
					hasUnresolvedHumanComments: true,
					unresolvedBy: [
						{
							reviewerId: "alice",
							count: 2,
							links: [
								{ url: "https://github.com/acme/repo/pull/7#discussion_r1", file: "main.go", line: 12 },
								{ url: "https://github.com/acme/repo/pull/7#discussion_r2", file: "test.go", line: 20 },
							],
						},
					],
				},
			}),
		);

		expect(items.find((item) => item.kind === "review_changes_requested")?.links[0]).toMatchObject({
			label: "alice +1",
			href: "https://github.com/acme/repo/pull/7#discussion_r1",
			title: "2 unresolved comments from alice",
		});
	});

	it("falls back to the PR page when review summary and inline comment URLs are missing", () => {
		const items = prAttentionItems(
			summary({
				url: "https://github.com/acme/repo/issues/7",
				htmlUrl: "https://github.com/acme/repo/issues/7",
				review: {
					decision: "changes_requested",
					hasUnresolvedHumanComments: true,
					unresolvedBy: [{ reviewerId: "alice", count: 1, links: [] }],
				},
			}),
		);

		expect(items.find((item) => item.kind === "review_changes_requested")?.links[0]).toMatchObject({
			label: "alice",
			href: "https://github.com/acme/repo/pull/7",
			title: "Open pull request for alice",
		});
	});

	it("shows bot reviewers with a bot label", () => {
		const items = prAttentionItems(
			summary({
				review: {
					decision: "changes_requested",
					hasUnresolvedHumanComments: false,
					unresolvedBy: [
						{
							reviewerId: "copilot",
							count: 0,
							reviewUrl: "https://github.com/acme/repo/pull/7#pullrequestreview-2",
							isBot: true,
							links: [],
						},
					],
				},
			}),
		);

		expect(items.find((item) => item.kind === "review_changes_requested")?.links[0]).toMatchObject({
			label: "copilot bot",
			href: "https://github.com/acme/repo/pull/7#pullrequestreview-2",
			title: "Open requested-changes review from copilot bot",
		});
	});

	it("links merge conflicts to GitHub's conflict resolution page", () => {
		const items = prAttentionItems(
			summary({
				url: "https://github.com/acme/repo/issues/7",
				htmlUrl: "https://github.com/acme/repo/issues/7",
				mergeability: {
					state: "conflicting",
					reasons: [],
					prUrl: "https://github.com/acme/repo/issues/7",
				},
			}),
		);

		expect(items.find((item) => item.kind === "merge_conflict")?.links[0]).toMatchObject({
			label: "conflicts",
			href: "https://github.com/acme/repo/pull/7/conflicts",
		});
	});

	it("suppresses attention once the PR is closed or merged", () => {
		expect(
			prAttentionItems(
				summary({
					state: "merged",
					ci: { state: "failing", failingChecks: [{ name: "unit", status: "failed", conclusion: "failure" }] },
					review: { decision: "changes_requested", hasUnresolvedHumanComments: true, unresolvedBy: [] },
					mergeability: { state: "conflicting", reasons: ["conflicts"], prUrl: "https://github.com/acme/repo/pull/7" },
				}),
			),
		).toEqual([]);
	});
});
