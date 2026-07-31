import {
	attentionZone,
	attentionZoneOrder,
	openPRs,
	sessionIsActive,
	sessionNeedsAttention,
	workerSessions,
	type PullRequestFacts,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "../types/workspace";
import {
	openReviewStatesFor,
	reviewIsRunning,
	reviewSessionRunAction,
	type PRReviewState,
} from "./session-reviews";

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
	| { kind: "open-pr"; url: string }
	| { kind: "copy-pr-url"; url: string }
	| { kind: "trigger-review"; sessionId: string }
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
	/** Live review states per session, injected by the palette's queries; absent sessions render enabled (the daemon validates on trigger). */
	reviewStatesBySessionId?: Readonly<Record<string, PRReviewState[]>>;
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
		keywords: [workspace.name, session.branch ?? "", session.issueId ?? ""],
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
	const { workspaces, currentProjectId, currentSessionId, restartingProjectIds, reviewStatesBySessionId } = ctx;
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

	const currentBranch = currentSession?.branch;
	if (currentSession && currentBranch && currentSession.kind !== "orchestrator" && !isSyntheticBranch(currentSession)) {
		items.push({
			id: "current-copy-branch",
			group: "current",
			title: "Copy branch name",
			subtitle: currentBranch,
			keywords: ["branch", "git", "copy", currentBranch, currentSession.title],
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
			const sessionReviewStates = reviewStatesBySessionId?.[session.id];
			// Whole prop omitted (e.g. a test that doesn't care about review state) means
			// "assume eligible"; a defined map with this session's key absent means the
			// live app hasn't loaded this session's review state yet — don't expose a
			// mutating action until we know it's safe to trigger.
			const dataLoadedForSession = reviewStatesBySessionId === undefined || sessionReviewStates !== undefined;
			const openReviewStates = sessionReviewStates ? openReviewStatesFor(session, sessionReviewStates) : undefined;
			const sessionReviewRunning = openReviewStates ? reviewIsRunning(openReviewStates) : false;
			for (const pr of openPRs(session)) {
				const subtitle = `${session.title} · ${workspace.name}`;
				const prKeywords = [
					`#${pr.number}`,
					String(pr.number),
					pr.url,
					session.title,
					session.branch ?? "",
					workspace.name,
					pr.state,
				];
				items.push({
					id: `pr:${session.id}:${pr.number}`,
					group: "prs",
					title: `#${pr.number}`,
					subtitle,
					keywords: prKeywords,
					action: {
						kind: "navigate",
						target: {
							to: "/projects/$projectId/sessions/$sessionId",
							params: { projectId: workspace.id, sessionId: session.id },
						},
					},
				});
				items.push({
					id: `pr-open:${session.id}:${pr.number}`,
					group: "prs",
					title: `Open PR #${pr.number}`,
					subtitle,
					keywords: [...prKeywords, "open", "open pr", "github", "browser"],
					searchOnly: true,
					action: { kind: "open-pr", url: pr.url },
				});
				items.push({
					id: `pr-copy:${session.id}:${pr.number}`,
					group: "prs",
					title: `Copy PR URL #${pr.number}`,
					subtitle,
					keywords: [...prKeywords, "copy", "copy pr", "url", "link", "share"],
					searchOnly: true,
					action: { kind: "copy-pr-url", url: pr.url },
				});
				if (sessionIsActive(session) && dataLoadedForSession) {
					items.push(prReviewCommand(session, pr, openReviewStates, sessionReviewRunning, subtitle, prKeywords));
				}
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

/**
 * Per-PR review command. The trigger endpoint is session-scoped (one run covers
 * all of the session's eligible open PRs, same as the Reviews tab button), so
 * the disabled state mirrors the shared ReviewPanel eligibility logic. When
 * review data has not loaded (or failed), the command stays enabled and the
 * daemon's response decides — its error surfaces via the palette error banner.
 */
function prReviewCommand(
	session: WorkspaceSession,
	pr: PullRequestFacts,
	openReviewStates: PRReviewState[] | undefined,
	sessionReviewRunning: boolean,
	subtitle: string,
	keywords: string[],
): CommandItem {
	const prReviewState = openReviewStates?.find((reviewState) => reviewState.prUrl === pr.url);
	const ineligible = openReviewStates !== undefined && (!prReviewState || prReviewState.status === "ineligible");
	const disabled = sessionReviewRunning || ineligible;
	const disabledReason = sessionReviewRunning
		? "Review already running"
		: ineligible
			? "Not eligible for review"
			: undefined;
	const runLabel = prReviewState ? reviewSessionRunAction([prReviewState], false) : "Run review";
	return {
		id: `pr-review:${session.id}:${pr.number}`,
		group: "prs",
		title: `${runLabel} #${pr.number}`,
		subtitle,
		keywords: [...keywords, "review", "run review", "re-run review", "ao review"],
		searchOnly: true,
		disabled,
		disabledReason,
		action: { kind: "trigger-review", sessionId: session.id },
	};
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
	// Keep matches under their category headings (Cursor-style), including while typing.
	const groups = groupCommands(visibleForQuery(items, query));
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
