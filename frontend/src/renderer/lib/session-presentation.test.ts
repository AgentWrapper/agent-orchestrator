import { describe, expect, it } from "vitest";
import {
	attentionZone,
	getAgentActivityView,
	getAttentionZoneView,
	getSessionDotView,
	getSessionStatusView,
	getSessionTimelinePillView,
	isAgentActivityWorking,
	isSessionIdle,
} from "./session-presentation";
import type { WorkspaceSession } from "../types/workspace";

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

const openPr: WorkspaceSession["prs"][number] = {
	number: 7,
	url: "https://github.com/acme/app/pull/7",
	state: "open",
	ci: "unknown",
	review: "none",
	mergeability: "unknown",
	reviewComments: false,
	updatedAt: "2026-01-01T00:00:00Z",
};

describe("session presentation", () => {
	it.each([
		["active", "Working", true],
		["idle", "Idle", false],
		["waiting_input", "Input Needed", false],
		["blocked", "Awaiting Decision", false],
		["exited", "Exited", false],
		["unknown", "Unknown", false],
	] as const)("maps %s agent activity to %s", (state, label, breathe) => {
		expect(getAgentActivityView({ state, lastActivityAt: "" })).toMatchObject({ label, breathe });
	});

	it("uses raw agent activity, not session status, for working indicators", () => {
		expect(isAgentActivityWorking({ state: "active", lastActivityAt: "" })).toBe(true);
		expect(isAgentActivityWorking({ state: "idle", lastActivityAt: "" })).toBe(false);
		expect(isAgentActivityWorking(undefined)).toBe(false);
	});

	it.each([
		["working", "Working"],
		["idle", "Idle"],
		["needs_input", "Input needed"],
		["no_signal", "No signal"],
		["ci_failed", "CI failed"],
		["changes_requested", "Changes requested"],
		["review_pending", "Review pending"],
		["draft", "Draft PR"],
		["pr_open", "PR open"],
		["approved", "Approved"],
		["mergeable", "Ready"],
		["merged", "Merged"],
		["exited", "Exited"],
		["terminated", "Terminated"],
		["unknown", "Unknown status"],
	] as const)("maps %s session status to %s", (status, label) => {
		expect(getSessionStatusView(status).label).toBe(label);
	});

	it("uses distinct session-card tones for idle, no signal, and PR waiting states", () => {
		expect(getSessionStatusView("idle").className).toBe("text-status-idle");
		expect(getSessionStatusView("no_signal").className).toBe("text-status-unknown");
		expect(getSessionStatusView("draft").className).toBe("text-status-in-review");
		expect(getSessionStatusView("pr_open").className).toBe("text-status-in-review");
		expect(getSessionStatusView("review_pending").className).toBe("text-status-in-review");
		expect(getSessionStatusView("exited").className).toBe("text-status-exited");
	});

	it.each([
		["approved", "merge", "Ready to merge"],
		["mergeable", "merge", "Ready to merge"],
		["needs_input", "action", "Needs you"],
		["exited", "action", "Needs you"],
		["no_signal", "action", "Needs you"],
		["ci_failed", "action", "Needs you"],
		["changes_requested", "action", "Needs you"],
		["unknown", "action", "Needs you"],
		["review_pending", "pending", "In review"],
		["pr_open", "pending", "In review"],
		["draft", "pending", "In review"],
		["working", "working", "Working"],
		["idle", "working", "Working"],
		["merged", "merge", "Ready to merge"],
		["terminated", "done", "Terminated"],
	] as const)("maps %s to the %s attention zone", (status, zone, label) => {
		expect(attentionZone(sessionWith({ status }))).toBe(zone);
		expect(getAttentionZoneView(status)).toMatchObject({ zone, label });
	});

	it.each([
		["without a PR", undefined, "bg-status-working"],
		["with an open PR", "pr_open", "bg-status-in-review"],
		["with a draft PR", "draft", "bg-status-in-review"],
		["with pending review", "review_pending", "bg-status-in-review"],
		["with failing CI", "ci_failed", "bg-status-needs-you"],
		["with requested changes", "changes_requested", "bg-status-needs-you"],
		["with an approved PR", "approved", "bg-status-ready"],
		["with a mergeable PR", "mergeable", "bg-status-ready"],
		["with a merged PR", "merged", "bg-status-merged"],
	] as const)("colors and animates an active sidebar session %s", (_label, scmStatus, expectedClass) => {
		const dot = getSessionDotView(
			sessionWith({
				activity: { state: "active", lastActivityAt: "" },
				scmStatus,
			}),
		);

		expect(dot?.className).toContain(expectedClass);
		expect(dot?.className).toContain("animate-status-pulse");
	});

	it.each([
		["an open PR", { ...openPr }, "bg-status-in-review"],
		["a draft PR", { ...openPr, state: "draft" }, "bg-status-in-review"],
		["pending review", { ...openPr, review: "review_required" }, "bg-status-in-review"],
		["failing CI", { ...openPr, ci: "failing" }, "bg-status-needs-you"],
		["requested changes", { ...openPr, review: "changes_requested" }, "bg-status-needs-you"],
		["an approved PR", { ...openPr, review: "approved" }, "bg-status-ready"],
		["a mergeable PR", { ...openPr, mergeability: "mergeable" }, "bg-status-ready"],
		["a merged PR", { ...openPr, state: "merged" }, "bg-status-merged"],
	] as const)(
		"derives the active sidebar color from %s when an older daemon omits scmStatus",
		(_label, pr, expectedClass) => {
			const dot = getSessionDotView(
				sessionWith({
					activity: { state: "active", lastActivityAt: "" },
					prs: [pr],
				}),
			);

			expect(dot?.className).toContain(expectedClass);
			expect(dot?.className).toContain("animate-status-pulse");
		},
	);

	it("prefers the daemon's stack-aware scmStatus over the compatibility fallback", () => {
		const dot = getSessionDotView(
			sessionWith({
				activity: { state: "active", lastActivityAt: "" },
				scmStatus: "review_pending",
				prs: [{ ...openPr, ci: "failing" }],
			}),
		);

		expect(dot?.className).toContain("bg-status-in-review");
		expect(dot?.className).not.toContain("bg-status-needs-you");
	});

	it("keeps a static gray sidebar dot while the agent is idle", () => {
		const dot = getSessionDotView(
			sessionWith({
				status: "draft",
				scmStatus: "draft",
				activity: { state: "idle", lastActivityAt: "" },
				prs: [{ ...openPr, state: "draft" }],
			}),
		);

		expect(dot.className).toBe("bg-status-idle");
		expect(dot.className).not.toContain("animate-status-pulse");
	});

	it.each([
		["waiting_input", "bg-status-needs-you"],
		["blocked", "bg-status-needs-you"],
		["exited", "bg-status-exited"],
		["unknown", "bg-status-unknown"],
	] as const)("keeps the raw %s activity tone when the agent is not active", (state, expectedClass) => {
		expect(getSessionDotView(sessionWith({ activity: { state, lastActivityAt: "" }, prs: [openPr] }))?.className).toBe(
			expectedClass,
		);
		expect(
			getSessionDotView(sessionWith({ activity: { state, lastActivityAt: "" }, prs: [openPr] }))?.className,
		).not.toContain("animate-status-pulse");
	});

	it("uses a muted accent treatment for In Review instead of idle gray", () => {
		expect(getAttentionZoneView("review_pending")).toMatchObject({
			dot: "var(--color-status-in-review)",
			titleClassName: "text-status-in-review",
			dotClassName: "bg-status-in-review",
		});
	});

	it("classifies only backend-derived idle sessions for the work lane", () => {
		expect(isSessionIdle(sessionWith({ status: "idle" }))).toBe(true);
		expect(
			isSessionIdle(
				sessionWith({
					status: "idle",
					activity: { state: "active", lastActivityAt: "" },
					prs: [openPr],
				}),
			),
		).toBe(true);
		expect(
			isSessionIdle(
				sessionWith({
					status: "working",
					activity: { state: "idle", lastActivityAt: "" },
					prs: [openPr],
				}),
			),
		).toBe(false);
		expect(
			isSessionIdle(
				sessionWith({
					status: "working",
					activity: { state: "active", lastActivityAt: "" },
				}),
			),
		).toBe(false);
		expect(isSessionIdle(sessionWith({ status: "working" }))).toBe(false);
	});

	it.each([
		["no_signal", "No Signal", "var(--color-status-unknown)"],
		["ci_failed", "CI Failed", "var(--color-status-exited)"],
		["changes_requested", "Changes Requested", "var(--color-status-needs-you)"],
	] as const)("centralizes the %s timeline pill", (status, label, tone) => {
		expect(getSessionTimelinePillView(status)).toMatchObject({ label, tone, breathe: false });
	});
});
