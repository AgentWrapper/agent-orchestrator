import type { SessionActivity, SessionActivityState, SessionStatus, WorkspaceSession } from "../types/workspace";

export type AgentActivityView = {
	state: SessionActivityState;
	label: string;
	tone: string;
	breathe: boolean;
};

const agentActivityViews: Record<SessionActivityState, AgentActivityView> = {
	active: { state: "active", label: "Working", tone: "var(--color-working)", breathe: true },
	idle: { state: "idle", label: "Idle", tone: "var(--color-text-muted)", breathe: false },
	waiting_input: { state: "waiting_input", label: "Input Needed", tone: "var(--color-warning)", breathe: false },
	blocked: { state: "blocked", label: "Awaiting Decision", tone: "var(--color-warning)", breathe: false },
	exited: { state: "exited", label: "Exited", tone: "var(--color-text-muted)", breathe: false },
	unknown: { state: "unknown", label: "Unknown", tone: "var(--color-text-muted)", breathe: false },
};

export function getAgentActivityView(activity?: SessionActivity | null): AgentActivityView {
	const state = activity?.state ?? "unknown";
	return agentActivityViews[state] ?? agentActivityViews.unknown;
}

export function isAgentActivityWorking(activity?: SessionActivity | null): boolean {
	return getAgentActivityView(activity).state === "active";
}

export type SessionStatusView = {
	label: string;
	className: string;
};

const sessionStatusViews: Record<SessionStatus, SessionStatusView> = {
	working: { label: "Working", className: "text-working" },
	idle: { label: "Idle", className: "text-passive" },
	needs_input: { label: "Input needed", className: "text-warning" },
	no_signal: { label: "No signal", className: "text-warning" },
	ci_failed: { label: "CI failed", className: "text-error" },
	changes_requested: { label: "Changes requested", className: "text-warning" },
	review_pending: { label: "Review pending", className: "text-accent" },
	draft: { label: "Draft PR", className: "text-accent" },
	pr_open: { label: "PR open", className: "text-accent" },
	approved: { label: "Approved", className: "text-success" },
	mergeable: { label: "Ready", className: "text-success" },
	merged: { label: "Merged", className: "text-passive" },
	terminated: { label: "Terminated", className: "text-passive" },
	unknown: { label: "Unknown status", className: "text-warning" },
};

export function getSessionStatusView(status: SessionStatus): SessionStatusView {
	return sessionStatusViews[status] ?? sessionStatusViews.unknown;
}

export type AttentionZone = "merge" | "action" | "pending" | "working" | "done";

export type AttentionZoneView = {
	zone: AttentionZone;
	label: string;
	glow: string;
	dot: string;
	dotGlow: boolean;
	titleClassName: string;
	dotClassName: string;
};

const attentionZoneViews: Record<AttentionZone, AttentionZoneView> = {
	working: {
		zone: "working",
		label: "Working",
		glow: "color-mix(in srgb, var(--color-working) 7%, transparent)",
		dot: "var(--color-working)",
		dotGlow: true,
		titleClassName: "text-working",
		dotClassName: "bg-working",
	},
	action: {
		zone: "action",
		label: "Needs you",
		glow: "color-mix(in srgb, var(--color-warning) 6%, transparent)",
		dot: "var(--color-warning)",
		dotGlow: true,
		titleClassName: "text-warning",
		dotClassName: "bg-warning",
	},
	pending: {
		zone: "pending",
		label: "In review",
		glow: "color-mix(in srgb, var(--color-accent) 5%, transparent)",
		dot: "var(--color-accent-dim)",
		dotGlow: false,
		titleClassName: "text-accent",
		dotClassName: "bg-accent-dim",
	},
	merge: {
		zone: "merge",
		label: "Ready to merge",
		glow: "color-mix(in srgb, var(--color-success) 7%, transparent)",
		dot: "var(--color-success)",
		dotGlow: true,
		titleClassName: "text-success",
		dotClassName: "bg-success",
	},
	done: {
		zone: "done",
		label: "Done",
		glow: "var(--color-overlay-faint)",
		dot: "var(--color-text-muted)",
		dotGlow: false,
		titleClassName: "text-muted-foreground",
		dotClassName: "bg-passive",
	},
};

export const attentionZoneOrder: AttentionZone[] = ["merge", "action", "pending", "working", "done"];
export const boardAttentionZoneOrder: AttentionZone[] = ["working", "action", "pending", "merge"];

export const attentionZoneLabel: Record<AttentionZone, string> = {
	merge: attentionZoneViews.merge.label,
	action: attentionZoneViews.action.label,
	pending: attentionZoneViews.pending.label,
	working: attentionZoneViews.working.label,
	done: attentionZoneViews.done.label,
};

export function attentionZone(input: SessionStatus | Pick<WorkspaceSession, "status">): AttentionZone {
	const status = typeof input === "string" ? input : input.status;
	switch (status) {
		case "merged":
		case "terminated":
			return "done";
		case "approved":
		case "mergeable":
			return "merge";
		case "needs_input":
		case "no_signal":
		case "ci_failed":
		case "changes_requested":
		case "unknown":
			return "action";
		case "review_pending":
		case "pr_open":
		case "draft":
			return "pending";
		case "working":
		case "idle":
		default:
			return "working";
	}
}

export function getAttentionZoneView(status: SessionStatus): AttentionZoneView {
	return attentionZoneViews[attentionZone(status)];
}

export function getAttentionZoneViewForZone(zone: AttentionZone): AttentionZoneView {
	return attentionZoneViews[zone];
}

export function getSessionDotView(session: Pick<WorkspaceSession, "status">): { className: string } {
	return { className: getAttentionZoneView(session.status).dotClassName };
}

export type SessionTimelinePillStatus = Extract<SessionStatus, "no_signal" | "ci_failed" | "changes_requested">;

export type SessionTimelinePillView = {
	label: string;
	tone: string;
	breathe: boolean;
};

const sessionTimelinePillViews: Record<SessionTimelinePillStatus, SessionTimelinePillView> = {
	no_signal: { label: "No Signal", tone: "var(--color-text-muted)", breathe: false },
	ci_failed: { label: "CI Failed", tone: "var(--color-danger)", breathe: false },
	changes_requested: { label: "Changes Requested", tone: "var(--color-warning)", breathe: false },
};

export function getSessionTimelinePillView(status: SessionTimelinePillStatus): SessionTimelinePillView {
	return sessionTimelinePillViews[status];
}

export function isSessionInIdleStack(session: Pick<WorkspaceSession, "status" | "activity">): boolean {
	return session.status === "idle" || (session.status === "working" && session.activity?.state === "idle");
}
