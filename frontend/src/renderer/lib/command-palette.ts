import {
	attentionZone,
	attentionZoneOrder,
	openPRs,
	sessionIsActive,
	sessionNeedsAttention,
	workerSessions,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "../types/workspace";

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
	action?: CommandAction;
};

export type CommandPaletteContext = {
	workspaces: WorkspaceSummary[];
	currentProjectId?: string;
	currentSessionId?: string;
	restartingProjectIds?: ReadonlySet<string>;
};

export const commandGroupOrder: CommandGroupId[] = ["current", "attention", "projects", "sessions", "prs", "global"];

export const commandGroupLabel: Record<CommandGroupId, string> = {
	current: "Current",
	attention: "Needs attention",
	projects: "Projects",
	sessions: "Sessions",
	prs: "Pull requests",
	global: "Global",
};

function isSyntheticBranch(session: WorkspaceSession): boolean {
	return session.branch === `session/${session.id}`;
}

type SessionCommandGroup = Extract<CommandGroupId, "attention" | "sessions">;

const SESSION_ID_PREFIX: Record<SessionCommandGroup, string> = { attention: "attention", sessions: "session" };

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
		keywords: [workspace.name, session.branch, session.issueId ?? ""],
		action: {
			kind: "navigate",
			target: {
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: workspace.id, sessionId: session.id },
			},
		},
	};
}

function findSession(workspaces: WorkspaceSummary[], sessionId: string): WorkspaceSession | undefined {
	for (const workspace of workspaces) {
		const match = workspace.sessions.find((session) => session.id === sessionId);
		if (match) return match;
	}
	return undefined;
}

export function buildCommands(ctx: CommandPaletteContext): CommandItem[] {
	const { workspaces, currentProjectId, currentSessionId, restartingProjectIds } = ctx;
	const items: CommandItem[] = [];

	const currentProject = currentProjectId
		? workspaces.find((workspace) => workspace.id === currentProjectId)
		: undefined;
	const currentSession = currentSessionId ? findSession(workspaces, currentSessionId) : undefined;
	const isProjectRestarting = Boolean(currentProject && restartingProjectIds?.has(currentProject.id));

	items.push({
		id: "current-new-task",
		group: "current",
		title: "New task",
		subtitle: currentProject?.name,
		keywords: ["worker", "chat", "start"],
		disabled: !currentProject || isProjectRestarting,
		disabledReason: !currentProject
			? "No current project"
			: isProjectRestarting
				? "Orchestrator restarting"
				: undefined,
		...(currentProject ? { action: { kind: "open-new-task" as const, projectId: currentProject.id } } : {}),
	});

	if (currentProject) {
		items.push({
			id: "current-open-orchestrator",
			group: "current",
			title: "Open orchestrator",
			subtitle: currentProject.name,
			keywords: ["orchestrator", "spawn", currentProject.name],
			disabled: isProjectRestarting,
			disabledReason: isProjectRestarting ? "Orchestrator restarting" : undefined,
			action: { kind: "open-orchestrator", projectId: currentProject.id },
		});
		items.push({
			id: "current-project-settings",
			group: "current",
			title: "Project settings",
			subtitle: currentProject.name,
			keywords: ["settings", "config", currentProject.name],
			action: {
				kind: "navigate",
				target: { to: "/projects/$projectId/settings", params: { projectId: currentProject.id } },
			},
		});
	}

	if (currentSession && currentSession.kind !== "orchestrator" && !isSyntheticBranch(currentSession)) {
		items.push({
			id: "current-copy-branch",
			group: "current",
			title: "Copy branch name",
			subtitle: currentSession.branch,
			keywords: ["branch", "git", currentSession.branch, currentSession.title],
			action: { kind: "copy-branch", branch: currentSession.branch },
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
						session.branch,
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
		title: "New project",
		keywords: ["add", "import", "repo", "workspace"],
		action: { kind: "open-new-project" },
	});
	items.push({
		id: "global-settings",
		group: "global",
		title: "Global settings",
		keywords: ["settings", "preferences", "config"],
		action: { kind: "navigate", target: { to: "/settings" } },
	});
	items.push({
		id: "global-theme",
		group: "global",
		title: "Toggle theme",
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

export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
	if (!query.trim()) return items.filter((item) => !item.searchOnly);
	return items
		.map((item, index) => ({ item, index, score: matchScore(query, item) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.item);
}

export const MAX_ITEMS_PER_GROUP = 20;

export const MAX_SEARCH_RESULTS = 20;

export function groupCommands(items: CommandItem[]): { id: CommandGroupId; label: string; items: CommandItem[] }[] {
	return commandGroupOrder
		.map((id) => ({
			id,
			label: commandGroupLabel[id],
			items: items.filter((item) => item.group === id).slice(0, MAX_ITEMS_PER_GROUP),
		}))
		.filter((group) => group.items.length > 0);
}

export function visibleForQuery(items: CommandItem[], query: string): CommandItem[] {
	const ranked = filterCommands(items, query);
	return query.trim() ? ranked.slice(0, MAX_SEARCH_RESULTS) : ranked;
}

export type DisplayGroup = { id: string; label: string; items: CommandItem[] };

export function displayGroups(items: CommandItem[], query: string): DisplayGroup[] {
	const visible = visibleForQuery(items, query);
	if (query.trim()) {
		return visible.length > 0 ? [{ id: "results", label: "Results", items: visible }] : [];
	}
	return groupCommands(visible);
}
