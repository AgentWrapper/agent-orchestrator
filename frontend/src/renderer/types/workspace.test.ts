import { describe, expect, it } from "vitest";
import {
	attentionZone,
	canonicalTrackerIssueId,
	findProjectOrchestrator,
	sessionIsActive,
	sessionNeedsAttention,
	toAgentProvider,
	toSessionStatus,
	workerDisplayStatus,
	workerStatusPulses,
	openPRs,
	mergedPRCount,
	primaryPR,
	sortedPRs,
	type AttentionZone,
	type PRState,
	type PullRequestFacts,
	type SessionStatus,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "./workspace";

describe("canonicalTrackerIssueId", () => {
	it("keeps provider-prefixed intake ids and rejects manual task titles", () => {
		expect(canonicalTrackerIssueId("github:acme/project#42")).toBe("github:acme/project#42");
		expect(canonicalTrackerIssueId("linear:ENG-7")).toBe("linear:ENG-7");
		expect(canonicalTrackerIssueId("jira:ENG-7")).toBe("jira:ENG-7");
		expect(canonicalTrackerIssueId("Fix fallback renderer")).toBeUndefined();
		expect(canonicalTrackerIssueId(undefined)).toBeUndefined();
	});
});

function sessionWith(overrides: Partial<WorkspaceSession>): WorkspaceSession {
	return {
		id: "sess-1",
		workspaceId: "ws-1",
		workspaceName: "my-app",
		title: "fix-bug",
		provider: "claude-code",
		branch: "feat/x",
		status: "working",
		updatedAt: "2026-01-01T00:00:00Z",
		prs: [],
		...overrides,
	};
}

const pr = (overrides: Partial<PullRequestFacts> & { number: number; state: PRState }): PullRequestFacts => ({
	url: `https://example.com/pr/${overrides.number}`,
	ci: "passing",
	review: "approved",
	mergeability: "mergeable",
	reviewComments: false,
	updatedAt: "2026-01-01T00:00:00Z",
	...overrides,
});

describe("toSessionStatus", () => {
	it("passes through a known status", () => {
		expect(toSessionStatus("mergeable")).toBe("mergeable");
		expect(toSessionStatus("no_signal")).toBe("no_signal");
	});

	it("keeps a backend merged status even when the session is terminated", () => {
		expect(toSessionStatus("merged", true)).toBe("merged");
	});

	it("uses terminated only as a fallback when a terminated session has no known status", () => {
		expect(toSessionStatus(undefined, true)).toBe("terminated");
	});

	it("falls back to unknown for an unknown live status", () => {
		expect(toSessionStatus("bogus")).toBe("unknown");
		expect(toSessionStatus(undefined)).toBe("unknown");
	});
});

describe("workerDisplayStatus", () => {
	it("prefers an explicit displayStatus override", () => {
		expect(workerDisplayStatus(sessionWith({ status: "ci_failed", displayStatus: "done" }))).toBe("done");
	});

	it.each([
		["needs_input", "needs_you"],
		["changes_requested", "needs_you"],
		["review_pending", "needs_you"],
		["ci_failed", "ci_failed"],
		["no_signal", "no_signal"],
		["approved", "mergeable"],
		["mergeable", "mergeable"],
		["merged", "done"],
		["terminated", "done"],
		["unknown", "unknown"],
		["working", "working"],
		["idle", "working"],
	] as const)("maps %s to %s", (status, expected) => {
		expect(workerDisplayStatus(sessionWith({ status }))).toBe(expected);
	});
});

describe("sessionIsActive", () => {
	it("is false for merged and terminated", () => {
		expect(sessionIsActive(sessionWith({ status: "merged" }))).toBe(false);
		expect(sessionIsActive(sessionWith({ status: "terminated" }))).toBe(false);
	});

	it("is true for in-progress statuses", () => {
		expect(sessionIsActive(sessionWith({ status: "working" }))).toBe(true);
		expect(sessionIsActive(sessionWith({ status: "pr_open" }))).toBe(true);
	});
});

describe("findProjectOrchestrator", () => {
	function workspaceWith(sessions: WorkspaceSession[]): WorkspaceSummary {
		return { id: "skills", name: "skills", path: "/tmp/skills", sessions };
	}

	it("skips a terminated orchestrator that precedes the live one", () => {
		// Regression: the daemon lists sessions by spawn number, so a dead
		// orchestrator (zellij session deleted) sorts before its live successor.
		// Picking it sent the Orchestrator button to an instant "[process exited]".
		const dead = sessionWith({ id: "skills-4", kind: "orchestrator", status: "terminated" });
		const live = sessionWith({ id: "skills-5", kind: "orchestrator", status: "needs_input" });
		const worker = sessionWith({ id: "skills-6", kind: "worker", status: "working" });
		expect(findProjectOrchestrator([workspaceWith([dead, live, worker])], "skills")).toBe(live);
	});

	it("returns undefined when every orchestrator is terminated", () => {
		const dead = sessionWith({ id: "skills-4", kind: "orchestrator", status: "terminated" });
		expect(findProjectOrchestrator([workspaceWith([dead])], "skills")).toBeUndefined();
	});

	it("ignores live workers when looking for an orchestrator", () => {
		const worker = sessionWith({ id: "skills-6", kind: "worker", status: "working" });
		expect(findProjectOrchestrator([workspaceWith([worker])], "skills")).toBeUndefined();
	});

	it("returns undefined for an unknown project", () => {
		const live = sessionWith({ id: "skills-5", kind: "orchestrator", status: "working" });
		expect(findProjectOrchestrator([workspaceWith([live])], "other")).toBeUndefined();
	});
});

describe("sessionNeedsAttention", () => {
	it.each(["needs_input", "no_signal", "changes_requested", "review_pending", "ci_failed"] as const)(
		"is true for %s",
		(status) => {
			expect(sessionNeedsAttention(sessionWith({ status }))).toBe(true);
		},
	);

	it("treats no_signal as needing attention", () => {
		expect(sessionNeedsAttention(sessionWith({ status: "no_signal" }))).toBe(true);
	});

	it("is false for statuses that don't need the user", () => {
		expect(sessionNeedsAttention(sessionWith({ status: "working" }))).toBe(false);
		expect(sessionNeedsAttention(sessionWith({ status: "mergeable" }))).toBe(false);
	});
});

describe("workerStatusPulses", () => {
	it("pulses only for working and needs_you", () => {
		expect(workerStatusPulses("working")).toBe(true);
		expect(workerStatusPulses("needs_you")).toBe(true);
		expect(workerStatusPulses("mergeable")).toBe(false);
		expect(workerStatusPulses("no_signal")).toBe(false);
		expect(workerStatusPulses("done")).toBe(false);
		expect(workerStatusPulses("unknown")).toBe(false);
	});
});

describe("toAgentProvider", () => {
	it("passes through a known provider", () => {
		expect(toAgentProvider("opencode")).toBe("opencode");
	});

	it("defaults unknown and undefined providers to codex", () => {
		expect(toAgentProvider("totally-unknown")).toBe("codex");
		expect(toAgentProvider(undefined)).toBe("codex");
	});
});

describe("PR helpers", () => {
	const session = sessionWith({
		prs: [
			pr({ number: 41, state: "open" }),
			pr({ number: 42, state: "draft" }),
			pr({ number: 40, state: "merged" }),
			pr({ number: 39, state: "closed" }),
		],
	});

	it("sortedPRs orders open, draft, merged, closed then by number", () => {
		expect(sortedPRs(session).map((p) => p.number)).toEqual([41, 42, 40, 39]);
	});

	it("openPRs returns open and draft only", () => {
		expect(
			openPRs(session)
				.map((p) => p.number)
				.sort(),
		).toEqual([41, 42]);
	});

	it("mergedPRCount counts merged PRs", () => {
		expect(mergedPRCount(session)).toBe(1);
	});

	it("primaryPR is the highest-priority PR (open before merged)", () => {
		expect(primaryPR(session)?.number).toBe(41);
	});

	it("primaryPR is undefined when there are no PRs", () => {
		expect(primaryPR(sessionWith({ prs: [] }))).toBeUndefined();
	});
});

describe("attentionZone", () => {
	const cases: Array<[SessionStatus, AttentionZone]> = [
		["mergeable", "merge"],
		["approved", "merge"],
		["needs_input", "action"],
		["no_signal", "action"],
		["ci_failed", "action"],
		["changes_requested", "action"],
		["review_pending", "pending"],
		["pr_open", "pending"],
		["draft", "pending"],
		["unknown", "pending"],
		["working", "working"],
		["idle", "working"],
		["merged", "done"],
		["terminated", "done"],
	];

	it.each(cases)("buckets %s into the %s zone", (status, zone) => {
		expect(attentionZone(sessionWith({ status }))).toBe(zone);
	});

	it("prioritizes merge as the highest-ROI zone", () => {
		// merge is checked before action/pending so an approved PR always surfaces.
		expect(attentionZone(sessionWith({ status: "approved" }))).toBe("merge");
	});
});
