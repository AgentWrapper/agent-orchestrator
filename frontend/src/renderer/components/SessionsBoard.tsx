import { useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import {
	type AttentionZone,
	type WorkspaceSession,
	attentionZone,
	canonicalTrackerIssueId,
	workerSessions,
} from "../types/workspace";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { DashboardSubhead } from "./DashboardSubhead";
import { OrchestratorIcon } from "./icons";
import { NewTaskDialog } from "./NewTaskDialog";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { prDiffSummary, sessionPRDisplaySummaries } from "../lib/pr-display";
import { cn } from "../lib/utils";
import { PRAttentionPanel, PRStatusStrip } from "./PRSummaryDisplay";

type SessionsBoardProps = {
	/** When set, the board shows only this project's sessions. */
	projectId?: string;
};

// The four kanban columns, left→right by flow (work → review → merge), ported
// verbatim from agent-orchestrator (SIMPLE_KANBAN_LEVELS + AttentionZone +
// mc-board.css). "done" is archived, not a column.
type Column = {
	level: AttentionZone;
	label: string;
	glow: string;
	dot: string;
	dotGlow: boolean;
	titleClass: string;
};
const COLUMNS: Column[] = [
	{
		level: "working",
		label: "Working",
		glow: "color-mix(in srgb, var(--orange) 7%, transparent)",
		dot: "var(--orange)",
		dotGlow: true,
		titleClass: "text-working",
	},
	{
		level: "action",
		label: "Needs you",
		glow: "color-mix(in srgb, var(--amber) 6%, transparent)",
		dot: "var(--amber)",
		dotGlow: true,
		titleClass: "text-warning",
	},
	{
		level: "pending",
		label: "In review",
		glow: "var(--kanban-pending-glow)",
		dot: "var(--fg-muted)",
		dotGlow: false,
		titleClass: "text-muted-foreground",
	},
	{
		level: "merge",
		label: "Ready to merge",
		glow: "color-mix(in srgb, var(--green) 7%, transparent)",
		dot: "var(--green)",
		dotGlow: true,
		titleClass: "text-success",
	},
];

export function SessionsBoard({ projectId }: SessionsBoardProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const workspaceQuery = useWorkspaceQuery();
	const all = workspaceQuery.data ?? [];
	const workspaces = projectId ? all.filter((w) => w.id === projectId) : all;
	const sessions = workspaces.flatMap((w) => workerSessions(w.sessions));
	const orchestrator = projectId
		? workspaces[0]?.sessions.find((session) => session.kind === "orchestrator" && session.status !== "terminated")
		: undefined;
	const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
	const [isSpawning, setIsSpawning] = useState(false);

	const byZone = new Map<AttentionZone, WorkspaceSession[]>();
	for (const session of sessions) {
		const zone = attentionZone(session);
		(byZone.get(zone) ?? byZone.set(zone, []).get(zone)!).push(session);
	}
	const done = byZone.get("done") ?? [];
	// Collapsed by default, like agent-orchestrator's done-bar: finished and
	// killed sessions cost one quiet line under the board until expanded.
	const [doneExpanded, setDoneExpanded] = useState(false);

	const openSession = (session: WorkspaceSession) =>
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: session.workspaceId, sessionId: session.id },
		});

	const openOrchestrator = async () => {
		if (!projectId) return;
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
			<button
				aria-label="New task"
				className="dashboard-app-header__accent-btn"
				onClick={() => setIsNewTaskOpen(true)}
				type="button"
			>
				<Plus className="h-3.5 w-3.5" aria-hidden="true" />
				New task
			</button>
			<button
				aria-label={orchestrator ? "Orchestrator" : "Spawn Orchestrator"}
				className="dashboard-app-header__primary-btn"
				disabled={isSpawning}
				onClick={() => void openOrchestrator()}
				type="button"
			>
				<OrchestratorIcon className="h-3.5 w-3.5" aria-hidden="true" />
				{isSpawning ? "Spawning..." : orchestrator ? "Orchestrator" : "Spawn Orchestrator"}
			</button>
		</>
	) : undefined;

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead
				title="Board"
				subtitle="Live agent sessions flowing from work → review → merge."
				actions={actions}
			/>

			<div className="min-h-0 flex-1 overflow-hidden p-[18px]">
				{workspaceQuery.isError ? (
					<p className="py-10 text-center text-[12px] text-passive">Could not load sessions.</p>
				) : (
					<div className="grid h-full grid-cols-4 gap-2">
						{COLUMNS.map((col) => (
							<ZoneColumn key={col.level} col={col} sessions={byZone.get(col.level) ?? []} onOpen={openSession} />
						))}
					</div>
				)}
			</div>

			{done.length > 0 && (
				<div className="shrink-0 border-t border-border px-[18px]">
					{/* agent-orchestrator's done-bar (Dashboard.tsx + globals.css):
					    a full-width chevron + label + count toggle row. min-h matches
					    the sidebar footer (7px pad ×2 + 37px Settings button) so this
					    border-t aligns with the sidebar's footer border. The button is
					    37px (not the 35.5px its text-[13px] implies) because the
					    unlayered `button { font: inherit }` in styles.css outranks
					    Tailwind's layered text utilities, leaving it at 14px/21px. */}
					<button
						aria-expanded={doneExpanded}
						className="group flex min-h-[51px] w-full items-center gap-2 py-2 text-muted-foreground transition-colors hover:text-foreground"
						onClick={() => setDoneExpanded((v) => !v)}
						type="button"
					>
						<svg
							aria-hidden="true"
							className={cn("h-3 w-3 shrink-0 transition-transform duration-150", doneExpanded && "rotate-90")}
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							viewBox="0 0 24 24"
						>
							<path d="m9 18 6-6-6-6" />
						</svg>
						<span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.05em]">Done / Terminated</span>
						<span className="ml-auto shrink-0 font-mono text-[10px] text-passive">{done.length}</span>
					</button>
					{doneExpanded && (
						<div className="flex flex-wrap gap-2 pb-2.5 pt-1">
							{done.map((s) => (
								<button
									key={s.id}
									className="rounded-[7px] border border-border bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-border-strong"
									onClick={() => openSession(s)}
									type="button"
								>
									<span className="text-[12px] text-muted-foreground">{s.title}</span>
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
	return (
		<section
			className="flex min-w-0 flex-col overflow-hidden rounded-[13px]"
			style={{ background: `linear-gradient(180deg, ${col.glow}, transparent 130px), var(--kanban-column-bg)` }}
		>
			<div className="flex shrink-0 items-center gap-[9px] px-[15px] pb-[11px] pt-[14px]">
				<span
					className="h-[7px] w-[7px] rounded-full"
					style={{
						background: col.dot,
						boxShadow: col.dotGlow ? `0 0 7px color-mix(in srgb, ${col.dot} 60%, transparent)` : undefined,
					}}
				/>
				<span className={cn("text-[11px] font-semibold uppercase tracking-[0.08em]", col.titleClass)}>{col.label}</span>
				<span className="ml-auto font-mono text-[11px] leading-none text-passive">{sessions.length}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-[11px] pb-3">
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
	const badge = sessionBadge(session);
	const issueId = canonicalTrackerIssueId(session.issueId);
	const branch = session.branch || "";
	const showBranch = branch !== "" && !sameLabel(branch, session.title) && !sameLabel(branch, session.id);
	const prSummaries = sessionPRDisplaySummaries(session, useSessionScmSummary(session.id).data);
	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget) {
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onOpen();
		}
	};
	return (
		<div
			className="w-full rounded-[7px] border border-border bg-surface text-left transition-colors hover:border-border-strong"
			onClick={onOpen}
			onKeyDown={handleKeyDown}
			role="button"
			tabIndex={0}
		>
			<div className="flex items-center gap-2 px-[13px] pb-[9px] pt-3">
				<span className={cn("inline-flex items-center gap-1.5 text-[11px] font-medium", badge.className)}>
					<span className={cn("h-[7px] w-[7px] rounded-full bg-current")} />
					{badge.label}
				</span>
				{issueId && (
					<span
						className="inline-flex max-w-[13rem] items-center truncate rounded-[4px] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-1.5 py-0.5 font-mono text-[10px] text-accent"
						title={`Intake issue: ${issueId}`}
					>
						{issueId}
					</span>
				)}
				<span className="ml-auto shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-passive">
					{agentLabel(session.provider)}
				</span>
			</div>
			<div
				className={cn(
					"px-[13px] text-[13px] font-medium leading-[1.42] tracking-[-0.01em] text-foreground",
					showBranch ? "pb-2" : "pb-3",
					"line-clamp-2 overflow-hidden",
				)}
			>
				{session.title}
			</div>
			{showBranch && <div className="px-[13px] pb-2.5 font-mono text-[10.5px] text-passive">{branch}</div>}
			<div className="border-t border-border px-[13px] py-2 font-mono text-[10.5px] text-passive">
				{prSummaries.length > 0 ? (
					<div className="flex flex-col gap-2">
						{prSummaries.map((prSummary, index) => (
							<BoardPRSummary
								className={cn(index > 0 && "border-t border-border pt-2")}
								key={prSummary.number}
								pr={prSummary}
							/>
						))}
					</div>
				) : (
					"no PR yet"
				)}
			</div>
		</div>
	);
}

function BoardPRSummary({ className, pr }: { className?: string; pr: SessionPRSummary }) {
	const diffSummary = prDiffSummary(pr);
	return (
		<div className={cn("flex min-w-0 flex-col gap-1", className)}>
			<span>
				PR #{pr.number} · {pr.state}
			</span>
			{diffSummary ? <span className="truncate">{diffSummary}</span> : null}
			<PRStatusStrip pr={pr} />
			<PRAttentionPanel className="mt-1.5 pt-1.5" maxItems={2} pr={pr} />
		</div>
	);
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
			return { label: "Input needed", className: "text-warning" };
		case "no_signal":
			return { label: "No signal", className: "text-passive" };
		case "ci_failed":
			return { label: "CI failed", className: "text-error" };
		case "changes_requested":
			return { label: "Changes requested", className: "text-warning" };
		case "review_pending":
			return { label: "Review pending", className: "text-muted-foreground" };
		case "draft":
			return { label: "Draft PR", className: "text-muted-foreground" };
		case "pr_open":
			return { label: "PR open", className: "text-muted-foreground" };
		case "approved":
			return { label: "Approved", className: "text-success" };
		case "mergeable":
			return { label: "Ready", className: "text-success" };
		case "merged":
			return { label: "Merged", className: "text-passive" };
		case "terminated":
			return { label: "Terminated", className: "text-passive" };
		default:
			return { label: "Working", className: "text-working" };
	}
}
