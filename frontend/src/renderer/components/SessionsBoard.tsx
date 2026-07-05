import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, GitBranch, Plus, RotateCw } from "lucide-react";
import { DashboardSubhead } from "./DashboardSubhead";
import {
	type AttentionZone,
	type WorkspaceSession,
	attentionZone,
	newestActiveOrchestrator,
	orchestratorHealth,
	workerSessions,
	sessionNeedsAttention,
} from "../types/workspace";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { OrchestratorIcon } from "./icons";
import { NewTaskDialog } from "./NewTaskDialog";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import { prBrowserUrl, sessionPRDisplaySummaries } from "../lib/pr-display";
import { cn } from "../lib/utils";
import { useUiStore } from "../stores/ui-store";

type SessionsBoardProps = {
	/** When set, the board shows only this project's sessions. */
	projectId?: string;
};

type Column = {
	level: AttentionZone;
	label: string;
	dot: string;
	titleClass: string;
	tint: string;
};

const COLUMNS: Column[] = [
	{
		level: "working",
		label: "Working",
		dot: "var(--orange)",
		titleClass: "text-working font-semibold",
		tint: "244 158 43",
	},
	{
		level: "action",
		label: "Needs you",
		dot: "var(--amber)",
		titleClass: "text-warning font-semibold",
		tint: "226 194 83",
	},
	{
		level: "pending",
		label: "In review",
		dot: "var(--fg-passive)",
		titleClass: "text-muted-foreground font-semibold",
		tint: "126 146 171",
	},
	{
		level: "merge",
		label: "Ready to merge",
		dot: "var(--green)",
		titleClass: "text-success font-semibold",
		tint: "69 174 125",
	},
];
export function SessionsBoard({ projectId }: SessionsBoardProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const workspaceQuery = useWorkspaceQuery();
	const boardRef = useRef<HTMLDivElement>(null);
	const cardRectsRef = useRef<Map<string, DOMRect>>(new Map());

	const all = workspaceQuery.data ?? [];
	const workspaces = projectId ? all.filter((w) => w.id === projectId) : all;
	const workspace = projectId ? workspaces[0] : undefined;
	const sessions = workspaces.flatMap((w) => workerSessions(w.sessions));
	const orchestrator = projectId ? newestActiveOrchestrator(workspaces[0]?.sessions ?? []) : undefined;
	const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
	const [isSpawning, setIsSpawning] = useState(false);
	const restartingProjectIds = useUiStore((state) => state.restartingProjectIds);
	const setProjectRestarting = useUiStore((state) => state.setProjectRestarting);
	const setOrchestratorReplacementError = useUiStore((state) => state.setOrchestratorReplacementError);
	const isProjectRestarting = projectId ? restartingProjectIds.has(projectId) : false;
	const health = workspace ? orchestratorHealth(workspace, isProjectRestarting) : { state: "ok" as const };

	// Collapsed Done / Terminated bar
	const [doneExpanded, setDoneExpanded] = useState(false);

	const openOrchestrator = async () => {
		if (!projectId || isProjectRestarting) return;
		if (orchestrator) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId: orchestrator.id },
			});
			return;
		}
		setIsSpawning(true);
		try {
			const sessionId = await spawnOrchestrator(projectId);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId },
			});
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

	// Group sessions into Kanban Columns
	const byZone = new Map<AttentionZone, WorkspaceSession[]>();
	for (const session of sessions) {
		const zone = attentionZone(session);
		(byZone.get(zone) ?? byZone.set(zone, []).get(zone)!).push(session);
	}
	const done = byZone.get("done") ?? [];

	useLayoutEffect(() => {
		const board = boardRef.current;
		if (!board) return;
		const cards = Array.from(board.querySelectorAll<HTMLElement>("[data-session-card-id]"));
		const nextRects = new Map<string, DOMRect>();

		for (const card of cards) {
			const id = card.dataset.sessionCardId;
			if (!id) continue;
			const next = card.getBoundingClientRect();
			nextRects.set(id, next);
			const prev = cardRectsRef.current.get(id);
			if (!prev) continue;
			const deltaX = prev.left - next.left;
			const deltaY = prev.top - next.top;
			if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
			card.animate(
				[
					{ opacity: 0.62, transform: `translate(${deltaX}px, ${deltaY}px) scale(0.96)` },
					{ opacity: 0.88, transform: `translate(${deltaX * 0.18}px, ${deltaY * 0.18}px) scale(0.985)` },
					{ opacity: 1, transform: "translate(0, 0) scale(1)" },
				],
				{ duration: 250, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
			);
		}

		cardRectsRef.current = nextRects;
	}, [sessions]);

	const navigateToSession = (session: WorkspaceSession) =>
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: session.workspaceId, sessionId: session.id },
		});

	const actions = projectId ? (
		<>
			<button
				aria-label="New task"
				className="dashboard-app-header__accent-btn"
				disabled={isProjectRestarting}
				onClick={() => setIsNewTaskOpen(true)}
				type="button"
			>
				<Plus className="h-3.5 w-3.5" aria-hidden="true" />
				New task
			</button>
			<button
				aria-label={orchestrator ? "Orchestrator" : "Spawn Orchestrator"}
				className="dashboard-app-header__primary-btn"
				disabled={isSpawning || isProjectRestarting}
				onClick={() => void openOrchestrator()}
				type="button"
			>
				<OrchestratorIcon className="h-3.5 w-3.5" aria-hidden="true" />
				{isProjectRestarting ? "Restarting..." : isSpawning ? "Spawning..." : orchestrator ? "Orchestrator" : "Spawn Orchestrator"}
			</button>
		</>
	) : undefined;

	return (
		<div ref={boardRef} className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
			<DashboardSubhead
				title="Board"
				subtitle="Live agent sessions flowing from work to review to merge."
				variant="board"
				actions={actions}
			/>

			{projectId && health.state !== "ok" ? (
				<div className="mx-[18px] mb-3 mt-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-muted-foreground">
					<AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
					<span className="min-w-0 flex-1">{health.message}</span>
					{health.state === "restart_needed" || health.state === "duplicates" ? (
						<button
							className="dashboard-app-header__primary-btn"
							disabled={isProjectRestarting}
							onClick={() => void restartOrchestrator()}
							type="button"
						>
							<RotateCw className="size-3.5" aria-hidden="true" />
							Restart
						</button>
					) : null}
				</div>
			) : null}

			<div className="kanban-board-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1">
				{workspaceQuery.isError ? (
					<p className="py-16 text-center text-[13px] text-passive">Could not load sessions.</p>
				) : (
					<div className="kanban-columns-wrapper h-full min-h-0 items-stretch px-5 pb-5 pt-5">
						{COLUMNS.map((col) => {
							const colSessions = byZone.get(col.level) ?? [];
							const sortedColSessions = [...colSessions].sort((a, b) => {
								const aAttention = sessionNeedsAttention(a) ? 1 : 0;
								const bAttention = sessionNeedsAttention(b) ? 1 : 0;
								if (aAttention !== bAttention) return bAttention - aAttention;
								const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
								const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
								return bTime - aTime;
							});

							return <ZoneColumn key={col.level} col={col} sessions={sortedColSessions} onOpen={navigateToSession} />;
						})}
					</div>
				)}
			</div>

			{done.length > 0 && (
				<div className="shrink-0 border-t border-border bg-background/90 px-6 py-1 backdrop-blur">
					<button
						aria-expanded={doneExpanded}
						className="group flex min-h-[44px] w-full items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
						onClick={() => setDoneExpanded((v) => !v)}
						type="button"
					>
						<svg aria-hidden="true" className={cn("h-3 w-3 shrink-0 transition-transform duration-150", doneExpanded && "rotate-90")} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
							<path d="m9 18 6-6-6-6" />
						</svg>
						<span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.05em]">Done / Terminated</span>
						<span className="ml-auto shrink-0 rounded-full bg-bg-3 px-2 py-0.5 font-mono text-[10px] text-passive">{done.length}</span>
					</button>
					{doneExpanded && (
						<div className="flex flex-wrap gap-2 pb-4 pt-1">
							{done.map((session) => (
								<button key={session.id} className="max-w-full rounded-[6px] border border-border bg-bg-2 px-3 py-1.5 text-left transition-all duration-150 hover:border-border-strong hover:bg-bg-3" onClick={() => navigateToSession(session)} type="button">
									<span className="block max-w-[260px] truncate text-[12px] text-muted-foreground">{session.title}</span>
								</button>
							))}
						</div>
					)}
				</div>
			)}

			<NewTaskDialog open={isNewTaskOpen} projectId={projectId} onCreated={(sessionId) => void handleTaskCreated(sessionId)} onOpenChange={setIsNewTaskOpen} />
		</div>
	);
}



function ZoneColumn({ col, sessions, onOpen }: { col: Column; sessions: WorkspaceSession[]; onOpen: (session: WorkspaceSession) => void }) {
	return (
		<section className="kanban-column matte-column group/lane flex min-h-0 flex-1 flex-col px-4 pt-4 pb-3.5" style={{ "--column-tone": col.dot, "--column-tint": col.tint } as CSSProperties}>
			<div className="flex shrink-0 items-center gap-[9px] px-0.5 pb-4 pt-0.5">
				<span className="h-3.5 w-1.5 rounded-[2px]" style={{ background: col.dot }} />
				<span className={cn("column-title-shine pb-[3px] text-[15.5px] leading-none tracking-normal", col.titleClass, `column-title-shine--${col.level}`)}>
					{col.label}
				</span>
				<span className="ml-auto font-mono text-[11px] leading-none text-passive">{sessions.length}</span>
			</div>

			<div className="kanban-lane-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pb-2">
				{sessions.map((session) => (
					<SessionCard key={session.id} session={session} onOpen={() => onOpen(session)} />
				))}
				{sessions.length === 0 && (
					<div className="flex min-h-[112px] flex-col items-center justify-center rounded-[8px] border border-dashed border-border/20 px-4 py-12 text-center">
						<span className="text-[11.5px] font-light text-passive">No tasks</span>
					</div>
				)}
			</div>
		</section>
	);
}

function SessionCard({ session, onOpen }: { session: WorkspaceSession; onOpen: () => void }) {
	const badge = sessionBadge(session);
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
		<div
			className={cn(
				"session-card animate-card-enter group relative w-full cursor-grab rounded-[4px] border p-3.5 text-left shadow-none outline-none transition-all duration-150 ease-out hover:-translate-y-0.5 active:cursor-grabbing",
			)}
			data-session-card-id={session.id}
			onClick={onOpen}
			onKeyDown={handleKeyDown}
			role="button"
			tabIndex={0}
		>
			<div className="session-card__title text-[14.5px] font-semibold leading-snug tracking-normal text-foreground">{session.title}</div>

			<div className="mt-2.5 flex min-w-0 items-center gap-2">
				<span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium">
					<span className={cn("h-1.5 w-1.5 rounded-full", statusDotClass(session.status))} />
					<span className={cn("truncate", sessionBadgeTextClass(session.status))}>{badge.label}</span>
				</span>
				<span className="ml-auto max-w-[42%] shrink-0 truncate font-mono text-[10px] text-passive transition-colors group-hover:text-foreground">
					{agentLabel(session.provider)}
				</span>
			</div>

			<div className="grid grid-rows-[0fr] transition-all duration-300 ease-in-out group-hover:grid-rows-[1fr]">
				<div className="overflow-hidden">
					<div className="opacity-0 transition-opacity duration-300 ease-out delay-75 group-hover:opacity-100">
						{showBranch && (
							<div className="mt-2.5 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-passive/85 transition-colors group-hover:text-foreground">
								<GitBranch className="inline h-3.5 w-3.5 shrink-0" />
								<span className="block truncate">{branch}</span>
							</div>
						)}

						<div
							className="mt-3.5 border-t border-border/10 pt-3 font-mono text-[12px] text-passive transition-colors group-hover:border-border/55 group-hover:text-foreground"
							onClick={(event) => event.stopPropagation()}
						>
							{prSummaries.length > 0 ? (
								<div className="flex flex-col gap-2.5">
									{groupPRsByLifecycle(prSummaries).map((group) => (
										<BoardPRGroup group={group} key={group.status.label} />
									))}
								</div>
							) : (
								<div className="text-[10px] font-light text-passive/70 transition-colors group-hover:text-foreground">
									No pull requests opened yet.
								</div>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

type BoardPRLifecycleStatus = { label: "closed" | "open" | "draft" | "merged"; className: string };
type BoardPRGroup = { status: BoardPRLifecycleStatus; prs: SessionPRSummary[] };

function BoardPRGroup({ group }: { group: BoardPRGroup }) {
	return (
		<span
			aria-label={`${group.prs.map((pr) => `#${pr.number}`).join(", ")} ${group.status.label}`}
			className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5"
		>
			<span className="text-passive/75 transition-colors group-hover:text-foreground">PR</span>
			{group.prs.map((pr, index) => (
				<span key={pr.number}>
					<a
						className="font-semibold text-passive underline-offset-2 transition-colors hover:text-foreground hover:underline"
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

function groupPRsByLifecycle(prs: SessionPRSummary[]): BoardPRGroup[] {
	const groups = new Map<BoardPRLifecycleStatus["label"], BoardPRGroup>();
	for (const pr of prs) {
		const status = prLifecycleStatus(pr);
		const group = groups.get(status.label);
		if (group) {
			group.prs.push(pr);
		} else {
			groups.set(status.label, { status, prs: [pr] });
		}
	}
	return Array.from(groups.values());
}

function prLifecycleStatus(pr: SessionPRSummary): BoardPRLifecycleStatus {
	if (pr.state === "draft") return { label: "draft", className: "text-passive" };
	if (pr.state === "merged") return { label: "merged", className: "text-accent" };
	if (pr.state === "closed") return { label: "closed", className: "text-error" };
	return { label: "open", className: "text-success" };
}
function sessionBadgeTextClass(status: WorkspaceSession["status"]): string {
	switch (status) {
		case "working":
			return "text-working/90";
		case "needs_input":
		case "changes_requested":
		case "review_pending":
		case "draft":
		case "pr_open":
			return "text-warning/90";
		case "ci_failed":
			return "text-error/90";
		case "approved":
		case "mergeable":
			return "text-success/90";
		default:
			return "text-passive";
	}
}
function statusDotClass(status: WorkspaceSession["status"]): string {
	switch (status) {
		case "working":
			return "bg-working animate-status-pulse";
		case "needs_input":
		case "changes_requested":
			return "bg-warning";
		case "ci_failed":
			return "bg-error";
		case "approved":
		case "mergeable":
			return "bg-success";
		default:
			return "bg-passive";
	}
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

function sessionBadge(session: WorkspaceSession): { label: string; className: string } {
	switch (session.status) {
		case "needs_input":
			return { label: "Input needed", className: "border-warning/25 bg-warning/10 text-warning" };
		case "no_signal":
			return { label: "No signal", className: "border-border bg-bg-2 text-passive" };
		case "ci_failed":
			return { label: "CI failed", className: "border-error/25 bg-error/10 text-error" };
		case "changes_requested":
			return { label: "Changes requested", className: "border-warning/25 bg-warning/10 text-warning" };
		case "review_pending":
			return { label: "Review pending", className: "border-border bg-bg-2 text-muted-foreground" };
		case "draft":
			return { label: "Draft PR", className: "border-border bg-bg-2 text-muted-foreground" };
		case "pr_open":
			return { label: "PR open", className: "border-border bg-bg-2 text-muted-foreground" };
		case "approved":
			return { label: "Approved", className: "border-success/25 bg-success/10 text-success" };
		case "mergeable":
			return { label: "Ready", className: "border-success/25 bg-success/10 text-success" };
		case "merged":
			return { label: "Merged", className: "border-border bg-bg-2 text-passive" };
		case "terminated":
			return { label: "Terminated", className: "border-border bg-bg-2 text-passive" };
		default:
			return { label: "Working", className: "border-working/25 bg-working/10 text-working" };
	}
}
