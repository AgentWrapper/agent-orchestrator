import { describe, expect, it } from "vitest";
import {
	attentionZone,
	getAgentActivityView,
	getAttentionZoneView,
	getSessionDotView,
	getSessionStatusView,
	getSessionTimelinePillView,
	isAgentActivityWorking,
	isSessionInIdleStack,
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
		["terminated", "Terminated"],
		["unknown", "Unknown status"],
	] as const)("maps %s session status to %s", (status, label) => {
		expect(getSessionStatusView(status).label).toBe(label);
	});

	it("uses distinct session-card tones for idle, no signal, and PR waiting states", () => {
		expect(getSessionStatusView("idle").className).toBe("text-passive");
		expect(getSessionStatusView("no_signal").className).toBe("text-warning");
		expect(getSessionStatusView("draft").className).toBe("text-accent");
		expect(getSessionStatusView("pr_open").className).toBe("text-accent");
		expect(getSessionStatusView("review_pending").className).toBe("text-accent");
	});

	it.each([
		["approved", "merge", "Ready to merge"],
		["mergeable", "merge", "Ready to merge"],
		["needs_input", "action", "Needs you"],
		["no_signal", "action", "Needs you"],
		["ci_failed", "action", "Needs you"],
		["changes_requested", "action", "Needs you"],
		["unknown", "action", "Needs you"],
		["review_pending", "pending", "In review"],
		["pr_open", "pending", "In review"],
		["draft", "pending", "In review"],
		["working", "working", "Working"],
		["idle", "working", "Working"],
		["merged", "done", "Done"],
		["terminated", "done", "Done"],
	] as const)("maps %s to the %s attention zone", (status, zone, label) => {
		expect(attentionZone(sessionWith({ status }))).toBe(zone);
		expect(getAttentionZoneView(status)).toMatchObject({ zone, label });
	});

	it("uses attention zones only for sidebar dot color and motion", () => {
		const activeWorkingDotClass = getSessionDotView(
			sessionWith({
				status: "working",
				activity: { state: "active", lastActivityAt: "" },
			}),
		).className;
		const idleDotClass = getSessionDotView(sessionWith({ status: "idle" })).className;
		const activeUnknownDotClass = getSessionDotView(
			sessionWith({
				status: "unknown",
				activity: { state: "active", lastActivityAt: "" },
			}),
		).className;
		const idleDraftDotClass = getSessionDotView(
			sessionWith({
				status: "draft",
				activity: { state: "idle", lastActivityAt: "" },
			}),
		).className;

		expect(activeWorkingDotClass).toContain("bg-working");
		expect(activeWorkingDotClass).not.toContain("animate-status-pulse");
		expect(idleDotClass).toContain("bg-working");
		expect(idleDotClass).not.toContain("animate-status-pulse");
		expect(activeUnknownDotClass).toContain("bg-warning");
		expect(activeUnknownDotClass).not.toContain("animate-status-pulse");
		expect(idleDraftDotClass).toContain("bg-accent-dim");
		expect(idleDraftDotClass).not.toContain("animate-status-pulse");
		expect(getSessionDotView(sessionWith({ status: "ci_failed" })).className).toContain("bg-warning");
		expect(getSessionDotView(sessionWith({ status: "unknown" })).className).toContain("bg-warning");
	});

	it("uses a muted accent treatment for In Review instead of idle gray", () => {
		expect(getAttentionZoneView("review_pending")).toMatchObject({
			dot: "var(--color-accent-dim)",
			titleClassName: "text-accent",
			dotClassName: "bg-accent-dim",
		});
	});

	it("separates idle sessions inside the Working board column", () => {
		expect(isSessionInIdleStack(sessionWith({ status: "idle" }))).toBe(true);
		expect(
			isSessionInIdleStack(
				sessionWith({
					status: "idle",
					activity: { state: "active", lastActivityAt: "" },
					prs: [openPr],
				}),
			),
		).toBe(true);
		expect(
			isSessionInIdleStack(
				sessionWith({
					status: "working",
					activity: { state: "idle", lastActivityAt: "" },
					prs: [openPr],
				}),
			),
		).toBe(true);
		expect(
			isSessionInIdleStack(
				sessionWith({
					status: "working",
					activity: { state: "active", lastActivityAt: "" },
				}),
			),
		).toBe(false);
		expect(isSessionInIdleStack(sessionWith({ status: "working" }))).toBe(false);
	});

	it.each([
		["no_signal", "No Signal", "var(--color-text-muted)"],
		["ci_failed", "CI Failed", "var(--color-danger)"],
		["changes_requested", "Changes Requested", "var(--color-warning)"],
	] as const)("centralizes the %s timeline pill", (status, label, tone) => {
		expect(getSessionTimelinePillView(status)).toMatchObject({ label, tone, breathe: false });
	});
});
