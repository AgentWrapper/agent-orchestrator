import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { DashboardSubhead } from "./DashboardSubhead";
import {
	type AttentionZone,
	type WorkspaceSession,
	attentionZone,
	canonicalTrackerIssueId,
	newestActiveOrchestrator,
	orchestratorHealth,
	workerSessions,
} from "../types/workspace";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { NotificationCenter } from "./NotificationCenter";
import { BoardWelcome, ProjectBoardEmpty } from "./BoardEmptyState";
import { OrchestratorIcon } from "./icons";
import { NewTaskDialog } from "./NewTaskDialog";
import { TopbarButton, TopbarKillError } from "./TopbarButton";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import { prBrowserUrl, sessionPRDisplaySummaries } from "../lib/pr-display";
import { cn } from "../lib/utils";
import { useUiStore } from "../stores/ui-store";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

const isLinux =
	typeof navigator !== "undefined" &&
	((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform)
		.toLowerCase()
		.includes("linux");

type SessionsBoardProps = {
	/** When set, the board shows only this project's sessions. */
	projectId?: string;
};

// The four kanban columns, left→right by flow (work → review → merge), ported
// verbatim from agent-orchestrator (SIMPLE_KANBAN_LEVELS + AttentionZone +
// mc-board.css). "done" is archived, not a column.
// NOTE: no `label` field here — the display label is translated at render
// time in ZoneColumn via `t(\`board.columns.${col.level}\`)`, so there is no
// second, unused copy of the string to drift out of sync (see the
// TOPBAR_ACTIVITY_PILL lesson in ShellTopbar.tsx).
type Column = {
	level: AttentionZone;
	glow: string;
	dot: string;
	dotGlow: boolean;
	titleClass: string;
};
const COLUMNS: Column[] = [
	{
		level: "working",
		glow: "color-mix(in srgb, var(--color-working) 7%, transparent)",
		dot: "var(--color-working)",
		dotGlow: true,
		titleClass: "text-working",
	},
	{
		level: "action",
		glow: "color-mix(in srgb, var(--color-warning) 6%, transparent)",
		dot: "var(--color-warning)",
		dotGlow: true,
		titleClass: "text-warning",
	},
	{
		level: "pending",
		glow: "var(--color-overlay-faint)",
		dot: "var(--color-text-muted)",
		dotGlow: false,
		titleClass: "text-muted-foreground",
	},
	{
		level: "merge",
		glow: "color-mix(in srgb, var(--color-success) 7%, transparent)",
		dot: "var(--color-success)",
		dotGlow: true,
		titleClass: "text-success",
	},
];

export function SessionsBoard({ projectId }: SessionsBoardProps) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const workspaceQuery = useWorkspaceQuery();
	const all = workspaceQuery.data ?? [];
	const workspaces = projectId ? all.filter((w) => w.id === projectId) : all;
	const workspace = projectId ? workspaces[0] : undefined;
	const sessions = workspaces.flatMap((w) => workerSessions(w.sessions));
	const orchestrator = projectId ? newestActiveOrchestrator(workspaces[0]?.sessions ?? []) : undefined;
	const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
	const [isSpawning, setIsSpawning] = useState(false);
	const [spawnError, setSpawnError] = useState<string | null>(null);
	const restartingProjectIds = useUiStore((state) => state.restartingProjectIds);
	const orchestratorStartupError = useUiStore((state) =>
		projectId ? (state.orchestratorStartupErrors[projectId] ?? null) : null,
	);
	const setProjectRestarting = useUiStore((state) => state.setProjectRestarting);
	const setOrchestratorReplacementError = useUiStore((state) => state.setOrchestratorReplacementError);
	const setOrchestratorStartupError = useUiStore((state) => state.setOrchestratorStartupError);
	const isProjectRestarting = projectId ? restartingProjectIds.has(projectId) : false;
	const health = workspace ? orchestratorHealth(workspace, isProjectRestarting) : { state: "ok" as const };
	const visibleSpawnError = spawnError ?? orchestratorStartupError;
	// The board instance survives project-to-project navigation (same route,
	// new param), so a spawn failure must not follow the user to another board.
	useEffect(() => setSpawnError(null), [projectId]);
	const previousProjectIdRef = useRef(projectId);
	useEffect(() => {
		const previousProjectId = previousProjectIdRef.current;
		if (previousProjectId && previousProjectId !== projectId) {
			setOrchestratorStartupError(previousProjectId, null);
		}
		previousProjectIdRef.current = projectId;
	}, [projectId, setOrchestratorStartupError]);
	useEffect(() => {
		if (projectId && orchestrator && orchestratorStartupError) {
			setOrchestratorStartupError(projectId, null);
		}
	}, [orchestrator, orchestratorStartupError, projectId, setOrchestratorStartupError]);

	const byZone = new Map<AttentionZone, WorkspaceSession[]>();
	for (const session of sessions) {
		const zone = attentionZone(session);
		(byZone.get(zone) ?? byZone.set(zone, []).get(zone)!).push(session);
	}
	const done = byZone.get("done") ?? [];
	// First-run orientation replaces the empty column shells (only once the
	// query has resolved, so the welcome never flashes over real data): the
	// global board teaches the app before any project exists, and a fresh
	// project board invites the first task instead of showing four zeros.
	const isLoaded = workspaceQuery.isSuccess;
	const showWelcome = !projectId && isLoaded && all.length === 0;
	const showProjectEmpty = projectId !== undefined && isLoaded && workspaces.length > 0 && sessions.length === 0;
	// Collapsed by default, like agent-orchestrator's done-bar: finished and
	// killed sessions cost one quiet line under the board until expanded.
	const [doneExpanded, setDoneExpanded] = useState(false);

	const openSession = (session: WorkspaceSession) =>
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: session.workspaceId, sessionId: session.id },
		});

	const openOrchestrator = async () => {
		if (!projectId || isProjectRestarting) return;
		if (orchestrator) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId: orchestrator.id },
			});
			return;
		}
		setSpawnError(null);
		setOrchestratorStartupError(projectId, null);
		setIsSpawning(true);
		try {
			const sessionId = await spawnOrchestrator(projectId, "board");
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			setOrchestratorStartupError(projectId, null);
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId },
			});
		} catch (err) {
			// Never fail silently: the daemon's message (e.g. a worktree/branch
			// conflict) is the only actionable signal the user gets.
			console.error("Failed to spawn orchestrator:", err);
			setSpawnError(err instanceof Error ? err.message : t("board.errors.spawnFailed"));
		} finally {
			setIsSpawning(false);
		}
	};

	const restartOrchestrator = async () => {
		if (!projectId) return;
		await restartProjectOrchestrator({
			projectId,
			queryClient,
			navigate,
			setProjectRestarting,
			setOrchestratorReplacementError,
		});
	};

	const handleTaskCreated = async (sessionId: string) => {
		if (!projectId) return;
		await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId, sessionId },
		});
	};

	const actions = projectId ? (
		<>
			{isLinux ? <NotificationCenter /> : null}
			{visibleSpawnError && !showProjectEmpty && (
				<TopbarKillError className="max-w-content-max truncate" title={visibleSpawnError}>
					{visibleSpawnError}
				</TopbarKillError>
			)}
			<TopbarButton
				aria-label={t("board.actions.newTask")}
				disabled={isProjectRestarting}
				onClick={() => setIsNewTaskOpen(true)}
				variant="accent"
			>
				<Plus className="size-icon-md" aria-hidden="true" />
				{t("board.actions.newTask")}
			</TopbarButton>
			<TopbarButton
				aria-label={orchestrator ? t("board.actions.orchestrator") : t("board.actions.spawnOrchestrator")}
				disabled={isSpawning || isProjectRestarting}
				onClick={() => void openOrchestrator()}
				variant="primary"
			>
				<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
				{isProjectRestarting
					? t("board.actions.restarting")
					: isSpawning
						? t("board.actions.spawning")
						: orchestrator
							? t("board.actions.orchestrator")
							: t("board.actions.spawnOrchestrator")}
			</TopbarButton>
		</>
	) : isLinux ? (
		<NotificationCenter />
	) : undefined;

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			{/* The first-launch welcome carries its own orientation; a "Board"
			    header above it would describe a board that isn't rendered
			    (review feedback on #2432). */}
			{!showWelcome && <DashboardSubhead title={t("board.title")} subtitle={t("board.subtitle")} actions={actions} />}

			<div className="min-h-0 flex-1 overflow-hidden p-4.5">
				{projectId && health.state !== "ok" ? (
					<div className="mb-3 flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
						<AlertTriangle className="size-icon-base shrink-0 text-warning" aria-hidden="true" />
						<span className="min-w-0 flex-1">{health.message}</span>
						{health.state === "restart_needed" || health.state === "duplicates" ? (
							<TopbarButton disabled={isProjectRestarting} onClick={() => void restartOrchestrator()} variant="primary">
								<RotateCw className="size-3.5" aria-hidden="true" />
								{t("board.actions.restart")}
							</TopbarButton>
						) : null}
					</div>
				) : null}
				{workspaceQuery.isError ? (
					<p className="py-10 text-center text-xs text-passive">{t("board.errors.loadSessions")}</p>
				) : showWelcome ? (
					<BoardWelcome />
				) : showProjectEmpty ? (
					<ProjectBoardEmpty
						hasOrchestrator={orchestrator !== undefined}
						isSpawning={isSpawning}
						isProjectRestarting={isProjectRestarting}
						onNewTask={() => setIsNewTaskOpen(true)}
						onOpenOrchestrator={() => void openOrchestrator()}
						spawnError={visibleSpawnError}
					/>
				) : (
					<div className="grid h-full grid-cols-4 gap-2">
						{COLUMNS.map((col) => (
							<ZoneColumn key={col.level} col={col} sessions={byZone.get(col.level) ?? []} onOpen={openSession} />
						))}
					</div>
				)}
			</div>

			{done.length > 0 && (
				<div className="shrink-0 border-t border-border px-4.5">
					{/* agent-orchestrator's done-bar (Dashboard.tsx + globals.css):
					    a full-width chevron + label + count toggle row. min-h matches
					    the sidebar footer (7px pad ×2 + 37px Settings button) so this
					    border-t aligns with the sidebar's footer border. The button is
					    37px (not the 35.5px its text-control implies) because the
					    unlayered `button { font: inherit }` in styles.css outranks
					    Tailwind's layered text utilities, leaving it at 14px/21px. */}
					<button
						aria-expanded={doneExpanded}
						className="group flex min-h-row-md w-full items-center gap-2 py-2 text-muted-foreground transition-colors hover:text-foreground"
						onClick={() => setDoneExpanded((v) => !v)}
						type="button"
					>
						<svg
							aria-hidden="true"
							className={cn("size-icon-2xs shrink-0 transition-transform duration-normal", doneExpanded && "rotate-90")}
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							viewBox="0 0 24 24"
						>
							<path d="m9 18 6-6-6-6" />
						</svg>
						<span className="font-mono text-2xs font-medium uppercase tracking-wide-sm">{t("board.done")}</span>
						<span className="ml-auto shrink-0 font-mono text-micro text-passive">{done.length}</span>
					</button>
					{doneExpanded && (
						<div className="flex flex-wrap gap-2 pb-2.5 pt-1">
							{done.map((s) => (
								<button
									key={s.id}
									className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-border-strong"
									onClick={() => openSession(s)}
									type="button"
								>
									<span className="text-xs text-muted-foreground">{s.title}</span>
								</button>
							))}
						</div>
					)}
				</div>
			)}
			<NewTaskDialog
				open={isNewTaskOpen}
				projectId={projectId}
				onCreated={(sessionId) => void handleTaskCreated(sessionId)}
				onOpenChange={setIsNewTaskOpen}
			/>
		</div>
	);
}

function ZoneColumn({
	col,
	sessions,
	onOpen,
}: {
	col: Column;
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
}) {
	const { t } = useTranslation();
	return (
		<section
			className="flex min-w-0 flex-col overflow-hidden rounded-panel"
			style={{
				background: `linear-gradient(180deg, ${col.glow}, transparent var(--size-kanban-glow)), var(--color-overlay-subtle)`,
			}}
		>
			<div className="flex shrink-0 items-center gap-2.25 px-3.75 pb-2.75 pt-3.5">
				<span
					className="size-dot-sm rounded-full"
					style={{
						background: col.dot,
						boxShadow: col.dotGlow ? `0 0 7px color-mix(in srgb, ${col.dot} 60%, transparent)` : undefined,
					}}
				/>
				<span className={cn("text-caption font-semibold uppercase tracking-wide-md", col.titleClass)}>
					{t(`board.columns.${col.level}`)}
				</span>
				<span className="ml-auto font-mono text-caption leading-none text-passive">{sessions.length}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2.75 pb-3">
				<div className="flex flex-col gap-2.5">
					{sessions.map((session) => (
						<SessionCard key={session.id} session={session} onOpen={() => onOpen(session)} />
					))}
				</div>
			</div>
		</section>
	);
}

function SessionCard({ session, onOpen }: { session: WorkspaceSession; onOpen: () => void }) {
	const { t } = useTranslation();
	const badge = sessionBadge(session, t);
	const issueId = canonicalTrackerIssueId(session.issueId);
	const branch = session.branch || "";
	const showBranch = branch !== "" && !sameLabel(branch, session.title) && !sameLabel(branch, session.id);
	const prSummaries = sessionPRDisplaySummaries(session, useSessionScmSummary(session.id).data);
	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.currentTarget !== event.target) return;
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		onOpen();
	};
	return (
		<div className="w-full rounded-md border border-border bg-surface text-left transition-colors hover:border-border-strong">
			<div onClick={onOpen} onKeyDown={handleKeyDown} role="button" tabIndex={0}>
				<div className="flex items-center gap-2 px-3.25 pb-2.25 pt-3">
					<span className={cn("inline-flex items-center gap-1.5 text-caption font-medium", badge.className)}>
						<span className={cn("size-dot-sm rounded-full bg-current")} />
						{badge.label}
					</span>
					{issueId && (
						<span
							className="inline-flex max-w-branch-chip items-center truncate rounded-sm bg-accent/12 px-1.5 py-0.5 font-mono text-micro text-accent"
							title={t("board.intakeIssue", { id: issueId })}
						>
							{issueId}
						</span>
					)}
					<span className="ml-auto shrink-0 font-mono text-2xs tracking-wide-xs text-passive">
						{agentLabel(session.provider)}
					</span>
				</div>
				<div
					className={cn(
						"px-3.25 text-control font-medium leading-snug tracking-tight text-foreground",
						showBranch ? "pb-2" : "pb-3",
						"line-clamp-2 overflow-hidden",
					)}
				>
					{session.title}
				</div>
				{showBranch && <div className="px-3.25 pb-2.5 font-mono text-2xs text-passive">{branch}</div>}
			</div>
			<div
				className="border-t border-border px-3.25 py-2 font-mono text-2xs text-passive"
				onClick={(event) => event.stopPropagation()}
			>
				{prSummaries.length === 0 ? (
					t("board.noPR")
				) : (
					<div className="flex flex-col gap-1">
						{groupPRsByLifecycle(prSummaries, t).map((group) => (
							<BoardPRGroup group={group} key={group.status.key} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}

type BoardPRLifecycleStatus = { key: "closed" | "open" | "draft" | "merged"; label: string; className: string };
type BoardPRGroup = { status: BoardPRLifecycleStatus; prs: SessionPRSummary[] };

function BoardPRGroup({ group }: { group: BoardPRGroup }) {
	return (
		<span
			aria-label={`${group.prs.map((pr) => `#${pr.number}`).join(", ")} ${group.status.label}`}
			className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
		>
			<span>PR</span>
			{group.prs.map((pr, index) => (
				<span key={pr.number}>
					<a
						className="text-passive underline-offset-2 transition-colors hover:text-foreground hover:underline"
						href={prBrowserUrl(pr)}
						rel="noreferrer"
						target="_blank"
					>
						#{pr.number}
					</a>
					{index < group.prs.length - 1 ? "," : null}
				</span>
			))}
			<span className={cn("font-medium", group.status.className)}>{group.status.label}</span>
		</span>
	);
}

function groupPRsByLifecycle(prs: SessionPRSummary[], t: TFunction): BoardPRGroup[] {
	const groups = new Map<BoardPRLifecycleStatus["key"], BoardPRGroup>();
	for (const pr of prs) {
		const status = prLifecycleStatus(pr, t);
		const group = groups.get(status.key);
		if (group) {
			group.prs.push(pr);
		} else {
			groups.set(status.key, { status, prs: [pr] });
		}
	}
	return Array.from(groups.values());
}

function prLifecycleStatus(pr: SessionPRSummary, t: TFunction): BoardPRLifecycleStatus {
	if (pr.state === "draft") return { key: "draft", label: t("board.lifecycle.draft"), className: "text-passive" };
	if (pr.state === "merged") return { key: "merged", label: t("board.lifecycle.merged"), className: "text-accent" };
	if (pr.state === "closed") return { key: "closed", label: t("board.lifecycle.closed"), className: "text-error" };
	return { key: "open", label: t("board.lifecycle.open"), className: "text-success" };
}

function sameLabel(a: string, b: string): boolean {
	const normalize = (value: string) =>
		value
			.toLowerCase()
			.replace(/^(feat|fix|chore|refactor|session)\//, "")
			.replace(/[^a-z0-9]+/g, "");
	return normalize(a) === normalize(b);
}

function agentLabel(provider: WorkspaceSession["provider"]): string {
	switch (provider) {
		case "claude-code":
			return "Claude";
		case "opencode":
			return "OpenCode";
		default:
			return provider;
	}
}

function sessionBadge(session: WorkspaceSession, t: TFunction): { label: string; className: string } {
	switch (session.status) {
		case "needs_input":
			return { label: t("board.status.inputNeeded"), className: "text-warning" };
		case "no_signal":
			return { label: t("board.status.noSignal"), className: "text-passive" };
		case "ci_failed":
			return { label: t("board.status.ciFailed"), className: "text-error" };
		case "changes_requested":
			return { label: t("board.status.changesRequested"), className: "text-warning" };
		case "review_pending":
			return { label: t("board.status.reviewPending"), className: "text-muted-foreground" };
		case "draft":
			return { label: t("board.status.draftPR"), className: "text-muted-foreground" };
		case "pr_open":
			return { label: t("board.status.prOpen"), className: "text-muted-foreground" };
		case "approved":
			return { label: t("board.status.approved"), className: "text-success" };
		case "mergeable":
			return { label: t("board.status.ready"), className: "text-success" };
		case "merged":
			return { label: t("board.status.merged"), className: "text-passive" };
		case "terminated":
			return { label: t("board.status.terminated"), className: "text-passive" };
		case "idle":
			return { label: t("board.status.idle"), className: "text-passive" };
		default:
			return { label: t("board.status.working"), className: "text-working" };
	}
}
