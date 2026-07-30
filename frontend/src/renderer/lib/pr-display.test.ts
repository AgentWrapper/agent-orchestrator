import { describe, expect, it } from "vitest";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import type { WorkspaceSession } from "../types/workspace";
import { prBrowserUrl, prDiffSummary, prStatusRows, prSummaryParts, sessionPRDisplaySummaries } from "./pr-display";

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

		expect(rows.map((row) => `${row.label}:${row.value}`)).toEqual(["CI:Checking", "Merge:Checking", "Review:None"]);
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

describe("sessionPRDisplaySummaries", () => {
	it("leaves lifecycle timing absent for fallback PR facts until provider times arrive", () => {
		const session: WorkspaceSession = {
			id: "sess-1",
			workspaceId: "ws-1",
			workspaceName: "repo",
			title: "Fix timing",
			provider: "codex",
			branch: "feat/timing",
			status: "review_pending",
			updatedAt: "2026-06-15T12:00:00Z",
			prs: [
				{
					url: "https://github.com/acme/repo/pull/7",
					number: 7,
					state: "open",
					ci: "passing",
					review: "none",
					mergeability: "mergeable",
					reviewComments: false,
					updatedAt: "2026-06-15T11:00:00Z",
				},
			],
		};

		const [fallback] = sessionPRDisplaySummaries(session);

		expect(fallback.updatedAt).toBe("2026-06-15T11:00:00Z");
		expect(fallback.createdAt).toBeUndefined();
		expect(fallback.stateChangedAt).toBeUndefined();
	});

	it("deduplicates entries when summaries contain duplicate PR numbers", () => {
		const session: WorkspaceSession = {
			id: "sess-dup",
			workspaceId: "ws-1",
			workspaceName: "repo",
			title: "Dup test",
			provider: "codex",
			branch: "main",
			status: "working",
			updatedAt: "2026-06-15T12:00:00Z",
			prs: [
				{
					url: "https://github.com/acme/repo/pull/7",
					number: 7,
					state: "open",
					ci: "passing",
					review: "none",
					mergeability: "mergeable",
					reviewComments: false,
					updatedAt: "2026-06-15T11:00:00Z",
				},
			],
		};

		const result = sessionPRDisplaySummaries(session, [summary({ number: 7 }), summary({ number: 7 })]);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(7);
	});

	it("never carries PRs from one session into another", () => {
		const sessionA: WorkspaceSession = {
			id: "sess-a",
			workspaceId: "ws-1",
			workspaceName: "repo",
			title: "Session A",
			provider: "codex",
			branch: "feat/a",
			status: "working",
			updatedAt: "2026-06-15T12:00:00Z",
			prs: [
				{
					url: "https://github.com/acme/repo/pull/1",
					number: 1,
					state: "open",
					ci: "passing",
					review: "none",
					mergeability: "mergeable",
					reviewComments: false,
					updatedAt: "2026-06-15T11:00:00Z",
				},
			],
		};
		const sessionB: WorkspaceSession = {
			id: "sess-b",
			workspaceId: "ws-1",
			workspaceName: "repo",
			title: "Session B",
			provider: "codex",
			branch: "feat/b",
			status: "working",
			updatedAt: "2026-06-15T12:00:00Z",
			prs: [
				{
					url: "https://github.com/acme/repo/pull/2",
					number: 2,
					state: "open",
					ci: "passing",
					review: "none",
					mergeability: "mergeable",
					reviewComments: false,
					updatedAt: "2026-06-15T11:00:00Z",
				},
			],
		};

		const resultA = sessionPRDisplaySummaries(sessionA);
		const resultB = sessionPRDisplaySummaries(sessionB);

		expect(resultA).toHaveLength(1);
		expect(resultA[0].number).toBe(1);
		expect(resultB).toHaveLength(1);
		expect(resultB[0].number).toBe(2);
	});

	it("merges facts and enriched summaries without duplication", () => {
		const session: WorkspaceSession = {
			id: "sess-merge",
			workspaceId: "ws-1",
			workspaceName: "repo",
			title: "Merge test",
			provider: "codex",
			branch: "feat/merge",
			status: "working",
			updatedAt: "2026-06-15T12:00:00Z",
			prs: [
				{
					url: "https://github.com/acme/repo/pull/7",
					number: 7,
					state: "open",
					ci: "passing",
					review: "none",
					mergeability: "mergeable",
					reviewComments: false,
					updatedAt: "2026-06-15T11:00:00Z",
				},
			],
		};

		const enriched = summary({ number: 7, title: "Enriched title", author: "bot" });
		const result = sessionPRDisplaySummaries(session, [enriched]);

		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Enriched title");
		expect(result[0].author).toBe("bot");
	});

	it("includes summary-only PRs that have no corresponding fact", () => {
		const session: WorkspaceSession = {
			id: "sess-summary-only",
			workspaceId: "ws-1",
			workspaceName: "repo",
			title: "Summary only",
			provider: "codex",
			branch: "main",
			status: "working",
			updatedAt: "2026-06-15T12:00:00Z",
			prs: [],
		};

		const result = sessionPRDisplaySummaries(session, [summary({ number: 42 })]);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(42);
	});

	it("returns empty when session has no PRs and no summaries", () => {
		const session: WorkspaceSession = {
			id: "sess-empty",
			workspaceId: "ws-1",
			workspaceName: "repo",
			title: "Empty",
			provider: "codex",
			branch: "main",
			status: "working",
			updatedAt: "2026-06-15T12:00:00Z",
			prs: [],
		};

		expect(sessionPRDisplaySummaries(session)).toEqual([]);
	});
});

describe("prSummaryParts", () => {
	it("always returns CI, Merge, and Review parts", () => {
		expect(prSummaryParts(summary()).map((part) => part.label)).toEqual(["CI", "Merge", "Review"]);
	});

	it("details active CI, merge, and review blockers under their parts", () => {
		const parts = prSummaryParts(
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

		expect(parts.map((part) => part.key)).toEqual(["ci", "merge", "review"]);
		expect(parts.find((part) => part.key === "ci")).toMatchObject({
			status: "Failing",
			summary: undefined,
			tone: "error",
		});
		expect(parts.find((part) => part.key === "ci")?.links[0]).toMatchObject({
			label: "copy-check",
			href: "https://checks.example/copy",
		});
		expect(parts.find((part) => part.key === "merge")).toMatchObject({
			status: "Blocked",
			summary: undefined,
			tone: "warning",
		});
		expect(parts.find((part) => part.key === "review")).toMatchObject({
			status: "Changes requested",
			summary: undefined,
			tone: "warning",
		});
		expect(parts.find((part) => part.key === "review")?.links[0]).toMatchObject({
			label: "alice +5",
			href: "https://github.com/acme/repo/pull/7#discussion_r1",
		});
	});

	it("links failing CI checks to their provider URLs", () => {
		const parts = prSummaryParts(
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

		const ciPart = parts.find((part) => part.key === "ci");
		expect(ciPart?.links).toEqual([
			{ label: "unit", href: "https://checks.example/unit", title: "failure" },
			{ label: "lint", href: "https://checks.example/lint", title: "failure" },
			{ label: "build", href: "https://checks.example/build", title: "failure" },
		]);
		expect(ciPart?.overflowLabel).toBe("+1 check");
	});

	it("prefers the submitted review summary over inline comments", () => {
		const parts = prSummaryParts(
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

		expect(parts.find((part) => part.key === "review")?.links[0]).toMatchObject({
			label: "alice +1",
			href: "https://github.com/acme/repo/pull/7#pullrequestreview-1",
			title: "Open requested-changes review from alice",
		});
	});

	it("falls back to the first inline comment when no review summary exists", () => {
		const parts = prSummaryParts(
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

		expect(parts.find((part) => part.key === "review")?.links[0]).toMatchObject({
			label: "alice +1",
			href: "https://github.com/acme/repo/pull/7#discussion_r1",
			title: "2 unresolved comments from alice",
		});
	});

	it("falls back to the PR page when review summary and inline comment URLs are missing", () => {
		const parts = prSummaryParts(
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

		expect(parts.find((part) => part.key === "review")?.links[0]).toMatchObject({
			label: "alice",
			href: "https://github.com/acme/repo/pull/7",
			title: "Open pull request for alice",
		});
	});

	it("shows bot reviewers with a bot label", () => {
		const parts = prSummaryParts(
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

		expect(parts.find((part) => part.key === "review")?.links[0]).toMatchObject({
			label: "copilot bot",
			href: "https://github.com/acme/repo/pull/7#pullrequestreview-2",
			title: "Open requested-changes review from copilot bot",
		});
	});

	it("links merge conflicts to GitHub's conflict resolution page", () => {
		const parts = prSummaryParts(
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

		expect(parts.find((part) => part.key === "merge")).toMatchObject({
			status: "Conflict",
			summary: undefined,
		});
		expect(parts.find((part) => part.key === "merge")?.links[0]).toMatchObject({
			label: "conflicts",
			href: "https://github.com/acme/repo/pull/7/conflicts",
		});
	});

	it("keeps closed or merged PR summaries to the three status parts", () => {
		const parts = prSummaryParts(
			summary({
				state: "merged",
				ci: { state: "failing", failingChecks: [{ name: "unit", status: "failed", conclusion: "failure" }] },
				review: { decision: "changes_requested", hasUnresolvedHumanComments: true, unresolvedBy: [] },
				mergeability: { state: "conflicting", reasons: ["conflicts"], prUrl: "https://github.com/acme/repo/pull/7" },
			}),
		);

		expect(parts).toHaveLength(3);
		expect(parts.find((part) => part.key === "merge")?.links).toEqual([]);
		expect(parts.find((part) => part.key === "review")?.links).toEqual([]);
	});

	it("puts draft readiness under Review", () => {
		const parts = prSummaryParts(
			summary({ state: "draft", review: { decision: "none", hasUnresolvedHumanComments: false, unresolvedBy: [] } }),
		);

		expect(parts.find((part) => part.key === "review")).toMatchObject({
			status: "None",
			summary: "Draft PR · Not ready for review",
		});
	});
});
