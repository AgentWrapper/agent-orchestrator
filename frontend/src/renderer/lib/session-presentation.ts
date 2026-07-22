import type { SessionActivity, SessionActivityState, SessionStatus, WorkspaceSession } from "../types/workspace";

export type AgentActivityView = {
	state: SessionActivityState;
	label: string;
	tone: string;
	dotClassName: string;
	breathe: boolean;
};

const agentActivityViews: Record<SessionActivityState, AgentActivityView> = {
	active: {
		state: "active",
		label: "Working",
		tone: "var(--color-status-working)",
		dotClassName: "bg-status-working",
		breathe: true,
	},
	idle: {
		state: "idle",
		label: "Idle",
		tone: "var(--color-status-idle)",
		dotClassName: "bg-status-idle",
		breathe: false,
	},
	waiting_input: {
		state: "waiting_input",
		label: "Input Needed",
		tone: "var(--color-status-needs-you)",
		dotClassName: "bg-status-needs-you",
		breathe: false,
	},
	blocked: {
		state: "blocked",
		label: "Awaiting Decision",
		tone: "var(--color-status-needs-you)",
		dotClassName: "bg-status-needs-you",
		breathe: false,
	},
	exited: {
		state: "exited",
		label: "Exited",
		tone: "var(--color-status-exited)",
		dotClassName: "bg-status-exited",
		breathe: false,
	},
	unknown: {
		state: "unknown",
		label: "Unknown",
		tone: "var(--color-status-unknown)",
		dotClassName: "bg-status-unknown",
		breathe: false,
	},
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
	cardClassName?: string;
};

const sessionStatusViews: Record<SessionStatus, SessionStatusView> = {
	working: { label: "Working", className: "text-status-working" },
	idle: { label: "Idle", className: "text-status-idle" },
	needs_input: { label: "Input needed", className: "text-status-needs-you" },
	exited: { label: "Exited", className: "text-status-exited" },
	no_signal: { label: "No signal", className: "text-status-unknown" },
	ci_failed: { label: "CI failed", className: "text-status-exited" },
	changes_requested: { label: "Changes requested", className: "text-status-needs-you" },
	review_pending: { label: "Review pending", className: "text-status-in-review" },
	draft: { label: "Draft PR", className: "text-status-in-review" },
	pr_open: { label: "PR open", className: "text-status-in-review" },
	approved: { label: "Approved", className: "text-status-ready" },
	mergeable: { label: "Ready", className: "text-status-ready" },
	merged: { label: "Merged", className: "text-status-merged", cardClassName: "border-status-merged/40 bg-surface" },
	terminated: {
		label: "Terminated",
		className: "text-status-terminated-foreground",
		cardClassName: "session-card-terminated",
	},
	unknown: { label: "Unknown status", className: "text-status-unknown" },
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
		glow: "color-mix(in srgb, var(--color-status-working) 7%, transparent)",
		dot: "var(--color-status-working)",
		dotGlow: true,
		titleClassName: "text-status-working",
		dotClassName: "bg-status-working",
	},
	action: {
		zone: "action",
		label: "Needs you",
		glow: "color-mix(in srgb, var(--color-status-needs-you) 6%, transparent)",
		dot: "var(--color-status-needs-you)",
		dotGlow: true,
		titleClassName: "text-status-needs-you",
		dotClassName: "bg-status-needs-you",
	},
	pending: {
		zone: "pending",
		label: "In review",
		glow: "color-mix(in srgb, var(--color-status-in-review) 5%, transparent)",
		dot: "var(--color-status-in-review)",
		dotGlow: false,
		titleClassName: "text-status-in-review",
		dotClassName: "bg-status-in-review",
	},
	merge: {
		zone: "merge",
		label: "Ready to merge",
		glow: "color-mix(in srgb, var(--color-status-ready) 7%, transparent)",
		dot: "var(--color-status-ready)",
		dotGlow: true,
		titleClassName: "text-status-ready",
		dotClassName: "bg-status-ready",
	},
	done: {
		zone: "done",
		label: "Done",
		glow: "var(--color-overlay-faint)",
		dot: "var(--color-status-terminated)",
		dotGlow: false,
		titleClassName: "text-status-terminated-foreground",
		dotClassName: "bg-status-terminated",
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
		case "exited":
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

export function getSessionDotView(session: Pick<WorkspaceSession, "activity">): { className: string } {
	const activity = getAgentActivityView(session.activity);
	return { className: `${activity.dotClassName}${activity.breathe ? " animate-status-pulse" : ""}` };
}

export type SessionTimelinePillStatus = Extract<SessionStatus, "no_signal" | "ci_failed" | "changes_requested">;

export type SessionTimelinePillView = {
	label: string;
	tone: string;
	breathe: boolean;
};

const sessionTimelinePillViews: Record<SessionTimelinePillStatus, SessionTimelinePillView> = {
	no_signal: { label: "No Signal", tone: "var(--color-status-unknown)", breathe: false },
	ci_failed: { label: "CI Failed", tone: "var(--color-status-exited)", breathe: false },
	changes_requested: { label: "Changes Requested", tone: "var(--color-status-needs-you)", breathe: false },
};

export function getSessionTimelinePillView(status: SessionTimelinePillStatus): SessionTimelinePillView {
	return sessionTimelinePillViews[status];
}

export function isSessionInIdleStack(session: Pick<WorkspaceSession, "status">): boolean {
	return session.status === "idle";
}
