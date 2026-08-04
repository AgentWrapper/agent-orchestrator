import type { TFunction } from "i18next";
import {
	attentionZone,
	attentionZoneOrder,
	isOrchestratorSession,
	openPRs,
	sessionIsActive,
	sessionNeedsAttention,
	workerSessions,
	type AttentionZone,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "../types/workspace";
import { appI18n, type MessageKey } from "../i18n";

export type CommandGroupId = "current" | "attention" | "projects" | "sessions" | "prs" | "global";

export type NavigateTarget =
	| { to: "/settings" }
	| { to: "/projects/$projectId"; params: { projectId: string } }
	| { to: "/projects/$projectId/settings"; params: { projectId: string } }
	| { to: "/projects/$projectId/sessions/$sessionId"; params: { projectId: string; sessionId: string } };

export type CommandAction =
	| { kind: "navigate"; target: NavigateTarget }
	| { kind: "open-new-task"; projectId: string }
	| { kind: "open-new-project" }
	| { kind: "open-orchestrator"; projectId: string }
	| { kind: "open-session-actions"; sessionId: string }
	| { kind: "resume-session"; projectId: string; sessionId: string }
	| { kind: "copy-branch"; branch: string }
	| { kind: "toggle-theme" };

export type CommandItem = {
	id: string;
	group: CommandGroupId;
	title: string;
	subtitle?: string;
	keywords?: string[];
	disabled?: boolean;
	disabledReason?: string;
	searchOnly?: boolean;
	zone?: AttentionZone;
	action?: CommandAction;
};

export type CommandPaletteContext = {
	workspaces: WorkspaceSummary[];
	currentProjectId?: string;
	currentSessionId?: string;
	restartingProjectIds?: ReadonlySet<string>;
};

export const commandGroupOrder: CommandGroupId[] = ["current", "attention", "projects", "sessions", "prs", "global"];

const commandGroupLabelKeys: Record<CommandGroupId, MessageKey> = {
	current: "command.group.current",
	attention: "command.group.attention",
	projects: "command.group.projects",
	sessions: "command.group.sessions",
	prs: "command.group.prs",
	global: "command.group.global",
};

/** Live labels for the current locale. */
export const commandGroupLabel: Record<CommandGroupId, string> = {
	get current() {
		return appI18n.t(commandGroupLabelKeys.current);
	},
	get attention() {
		return appI18n.t(commandGroupLabelKeys.attention);
	},
	get projects() {
		return appI18n.t(commandGroupLabelKeys.projects);
	},
	get sessions() {
		return appI18n.t(commandGroupLabelKeys.sessions);
	},
	get prs() {
		return appI18n.t(commandGroupLabelKeys.prs);
	},
	get global() {
		return appI18n.t(commandGroupLabelKeys.global);
	},
};

function isSyntheticBranch(session: WorkspaceSession): boolean {
	return session.branch === `session/${session.id}`;
}

type SessionCommandGroup = Extract<CommandGroupId, "attention" | "sessions">;

const SESSION_ID_PREFIX: Record<SessionCommandGroup, string> = { attention: "attention", sessions: "session" };

export type WorkspaceSessionContext = {
	workspace: WorkspaceSummary;
	session: WorkspaceSession;
};

function jumpTarget(workspace: WorkspaceSummary, session: WorkspaceSession): NavigateTarget {
	return {
		to: "/projects/$projectId/sessions/$sessionId",
		params: { projectId: workspace.id, sessionId: session.id },
	};
}

function sessionCommand(
	workspace: WorkspaceSummary,
	session: WorkspaceSession,
	group: SessionCommandGroup,
): CommandItem {
	return {
		id: `${SESSION_ID_PREFIX[group]}:${session.id}`,
		group,
		title: session.title,
		subtitle: workspace.name,
		zone: attentionZone(session),
		keywords: [workspace.name, session.branch ?? "", session.issueId ?? ""],
		action: { kind: "open-session-actions", sessionId: session.id },
	};
}

export function buildSessionActions(
	workspace: WorkspaceSummary,
	session: WorkspaceSession,
	t: TFunction = appI18n.t,
): CommandItem[] {
	const items: CommandItem[] = [];

	items.push({
		id: `session-action:jump:${session.id}`,
		group: "current",
		title: t("command.jumpToSession"),
		keywords: ["open", "go", "view", session.title],
		action: { kind: "navigate", target: jumpTarget(workspace, session) },
	});

	if (!sessionIsActive(session) && !isOrchestratorSession(session)) {
		items.push({
			id: `session-action:resume:${session.id}`,
			group: "current",
			title: t("command.resumeAgent"),
			subtitle: t("command.resumeAgentSubtitle"),
			keywords: ["restore", "restart", "retry", "resume", session.title],
			action: { kind: "resume-session", projectId: workspace.id, sessionId: session.id },
		});
	}

	if (session.branch && !isOrchestratorSession(session) && !isSyntheticBranch(session)) {
		items.push({
			id: `session-action:copy-branch:${session.id}`,
			group: "current",
			title: t("command.copyBranch"),
			subtitle: session.branch,
			keywords: ["branch", "git", session.branch, session.title],
			action: { kind: "copy-branch", branch: session.branch },
		});
	}

	return items;
}

export function findSession(workspaces: WorkspaceSummary[], sessionId: string): WorkspaceSessionContext | undefined {
	for (const workspace of workspaces) {
		const match = workspace.sessions.find((session) => session.id === sessionId);
		if (match) return { workspace, session: match };
	}
	return undefined;
}

export function buildCommands(ctx: CommandPaletteContext, t: TFunction = appI18n.t): CommandItem[] {
	const { workspaces, currentProjectId, currentSessionId, restartingProjectIds } = ctx;
	const items: CommandItem[] = [];

	const currentProject = currentProjectId
		? workspaces.find((workspace) => workspace.id === currentProjectId)
		: undefined;
	const currentSession = currentSessionId ? findSession(workspaces, currentSessionId)?.session : undefined;
	const isProjectRestarting = Boolean(currentProject && restartingProjectIds?.has(currentProject.id));

	items.push({
		id: "current-new-task",
		group: "current",
		title: t("command.newTask"),
		subtitle: currentProject?.name,
		keywords: ["worker", "chat", "start"],
		disabled: !currentProject || isProjectRestarting,
		disabledReason: !currentProject
			? t("command.noCurrentProject")
			: isProjectRestarting
				? t("command.orchestratorRestarting")
				: undefined,
		...(currentProject ? { action: { kind: "open-new-task" as const, projectId: currentProject.id } } : {}),
	});

	if (currentProject) {
		items.push({
			id: "current-open-orchestrator",
			group: "current",
			title: t("command.openOrchestrator"),
			subtitle: currentProject.name,
			keywords: ["orchestrator", "spawn", currentProject.name],
			disabled: isProjectRestarting,
			disabledReason: isProjectRestarting ? t("command.orchestratorRestarting") : undefined,
			action: { kind: "open-orchestrator", projectId: currentProject.id },
		});
		items.push({
			id: "current-project-settings",
			group: "current",
			title: t("command.projectSettings"),
			subtitle: currentProject.name,
			keywords: ["settings", "config", currentProject.name],
			action: {
				kind: "navigate",
				target: { to: "/projects/$projectId/settings", params: { projectId: currentProject.id } },
			},
		});
	}

	const currentBranch = currentSession?.branch;
	if (currentSession && currentBranch && !isOrchestratorSession(currentSession) && !isSyntheticBranch(currentSession)) {
		items.push({
			id: "current-copy-branch",
			group: "current",
			title: t("command.copyBranch"),
			subtitle: currentBranch,
			keywords: ["branch", "git", currentBranch, currentSession.title],
			action: { kind: "copy-branch", branch: currentBranch },
		});
	}

	const attentionSessions = workspaces
		.flatMap((workspace) => workerSessions(workspace.sessions).map((session) => ({ workspace, session })))
		.filter(
			({ session }) =>
				session.id !== currentSessionId && (attentionZone(session) === "merge" || sessionNeedsAttention(session)),
		)
		.sort(
			(a, b) =>
				attentionZoneOrder.indexOf(attentionZone(a.session)) - attentionZoneOrder.indexOf(attentionZone(b.session)),
		);

	const attentionIds = new Set(attentionSessions.map(({ session }) => session.id));

	for (const { workspace, session } of attentionSessions) {
		items.push(sessionCommand(workspace, session, "attention"));
	}

	for (const workspace of workspaces) {
		items.push({
			id: `project:${workspace.id}`,
			group: "projects",
			title: workspace.name,
			keywords: [workspace.path],
			action: { kind: "navigate", target: { to: "/projects/$projectId", params: { projectId: workspace.id } } },
		});
	}

	for (const workspace of workspaces) {
		for (const session of workerSessions(workspace.sessions).filter(
			(session) => !attentionIds.has(session.id) && session.id !== currentSessionId,
		)) {
			items.push({ ...sessionCommand(workspace, session, "sessions"), searchOnly: !sessionIsActive(session) });
		}
	}

	for (const workspace of workspaces) {
		for (const session of workerSessions(workspace.sessions)) {
			for (const pr of openPRs(session)) {
				items.push({
					id: `pr:${session.id}:${pr.number}`,
					group: "prs",
					title: `#${pr.number}`,
					subtitle: `${session.title} · ${workspace.name}`,
					keywords: [
						`#${pr.number}`,
						String(pr.number),
						pr.url,
						session.title,
						session.branch ?? "",
						workspace.name,
						pr.state,
					],
					action: {
						kind: "navigate",
						target: {
							to: "/projects/$projectId/sessions/$sessionId",
							params: { projectId: workspace.id, sessionId: session.id },
						},
					},
				});
			}
		}
	}

	items.push({
		id: "global-new-project",
		group: "global",
		title: t("command.newProject"),
		keywords: ["add", "import", "repo", "workspace"],
		action: { kind: "open-new-project" },
	});
	items.push({
		id: "global-settings",
		group: "global",
		title: t("command.globalSettings"),
		keywords: ["settings", "preferences", "config"],
		action: { kind: "navigate", target: { to: "/settings" } },
	});
	items.push({
		id: "global-theme",
		group: "global",
		title: t("command.toggleTheme"),
		keywords: ["dark", "light", "appearance"],
		action: { kind: "toggle-theme" },
	});

	return items;
}

function isSubsequence(query: string, haystack: string): boolean {
	let i = 0;
	for (let j = 0; j < haystack.length && i < query.length; j++) {
		if (haystack[j] === query[i]) i++;
	}
	return i === query.length;
}

export function matchScore(query: string, item: CommandItem): number {
	const q = query.trim().toLowerCase();
	if (!q) return 1;
	const title = item.title.toLowerCase();
	const extras = [item.subtitle ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();

	const titleIdx = title.indexOf(q);
	if (titleIdx === 0) return 1000;
	if (titleIdx > 0) return 800 - titleIdx;
	if (extras.includes(q)) return 500;
	if (isSubsequence(q, title)) return 200;
	if (isSubsequence(q, extras)) return 100;
	return 0;
}

function isAttentionItem(item: CommandItem): boolean {
	return item.zone === "action" || item.zone === "merge";
}

function attentionRank(item: CommandItem): number {
	return item.zone ? attentionZoneOrder.indexOf(item.zone) : attentionZoneOrder.length;
}

export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
	if (!query.trim()) return items.filter((item) => !item.searchOnly);
	return items
		.map((item, index) => ({ item, index, score: matchScore(query, item) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || attentionRank(a.item) - attentionRank(b.item) || a.index - b.index)
		.map((entry) => entry.item);
}

export const MAX_ITEMS_PER_GROUP = 20;

export const MAX_SEARCH_RESULTS = 20;

export function groupCommands(
	items: CommandItem[],
	t: TFunction = appI18n.t,
): { id: CommandGroupId; label: string; items: CommandItem[] }[] {
	return commandGroupOrder
		.map((id) => ({
			id,
			label: t(commandGroupLabelKeys[id]),
			items: items.filter((item) => item.group === id).slice(0, MAX_ITEMS_PER_GROUP),
		}))
		.filter((group) => group.items.length > 0);
}

export type DisplayGroup = { id: string; label: string; items: CommandItem[] };

export const MAX_ATTENTION_SEARCH_RESULTS = Math.floor(MAX_SEARCH_RESULTS / 2);

export function visibleForQuery(items: CommandItem[], query: string): CommandItem[] {
	const ranked = filterCommands(items, query);
	if (!query.trim()) return ranked;

	const attentionRanked = ranked.filter(isAttentionItem);
	const nonAttentionRanked = ranked.filter((item) => !isAttentionItem(item));

	const attention = attentionRanked.slice(0, MAX_ATTENTION_SEARCH_RESULTS);
	const attentionIds = new Set(attention.map((item) => item.id));
	const rest = nonAttentionRanked.slice(0, MAX_SEARCH_RESULTS - attention.length);

	const backfillBudget = MAX_SEARCH_RESULTS - attention.length - rest.length;
	const backfill =
		backfillBudget > 0 ? attentionRanked.filter((item) => !attentionIds.has(item.id)).slice(0, backfillBudget) : [];

	return [...attention, ...rest, ...backfill];
}

export function displayGroups(items: CommandItem[], query: string, t: TFunction = appI18n.t): DisplayGroup[] {
	// Keep matches under their category headings (Cursor-style), including while typing.
	const groups = groupCommands(visibleForQuery(items, query), t);
	if (!query.trim()) return groups;
	// The palette runs cmdk with shouldFilter:false and selects the first item in DOM
	// order, so Enter follows category order. Rank categories by their best match to
	// keep the highest-scoring hit — and therefore the Enter target — first.
	return groups
		.map((group, index) => ({
			group,
			index,
			score: Math.max(...group.items.map((item) => matchScore(query, item))),
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.group);
}
