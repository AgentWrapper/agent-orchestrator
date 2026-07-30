import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
	ArrowUpRight,
	ChevronDown,
	ChevronRight,
	Files as FilesIcon,
	GitPullRequest,
	Play,
	ScanEye,
	Terminal,
	Trash2,
	Loader2,
	X,
} from "lucide-react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { formatTimeCompact } from "../lib/format-time";
import { AgentAvatar } from "./AgentAvatar";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { clearTerminateSessionState, useTerminateSession } from "../hooks/useTerminateSession";
import { prBrowserUrl, sessionPRDisplaySummaries } from "../lib/pr-display";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { canonicalTrackerIssueId, findProjectOrchestrator, sortedPRs } from "../types/workspace";
import { getAgentActivityView, getSessionTimelinePillView } from "../lib/session-presentation";
import { aoBridge } from "../lib/bridge";
import { BrowserPanelView, type BrowserAnnotationQueueModel } from "./BrowserPanel";
import type { BrowserViewModel } from "../hooks/useBrowserView";
import { useUiStore } from "../stores/ui-store";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { PRSummaryMeta, PRSummaryParts } from "./PRSummaryDisplay";
import { StatusPill } from "./StatusPill";
import { SessionTerminationPopover } from "./SessionTerminationPopover";
import { ReviewerSelect } from "./ReviewerSelect";
import { agentsQueryOptions } from "../hooks/useAgentsQuery";
import { Switch } from "./ui/switch";

type ProjectConfig = components["schemas"]["ProjectConfig"];
type PRReviewState = components["schemas"]["PRReviewState"];
type ReviewsResponse = components["schemas"]["ListReviewsResponse"];
type ReviewRunFacts = components["schemas"]["ReviewRun"];
type OpenReviewerTerminal = (target: { handleId: string; harness: string }) => void;

export type InspectorView = "summary" | "reviews" | "browser" | "files";

const VIEWS: { id: InspectorView; label: string; icon: ReactNode }[] = [
	{
		id: "summary",
		label: "Summary",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
				<line x1="8" y1="7" x2="20" y2="7" />
				<line x1="8" y1="12" x2="20" y2="12" />
				<line x1="8" y1="17" x2="16" y2="17" />
				<circle cx="4" cy="7" r="1" />
				<circle cx="4" cy="12" r="1" />
				<circle cx="4" cy="17" r="1" />
			</svg>
		),
	},
	{
		id: "reviews",
		label: "Reviews",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
				<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
			</svg>
		),
	},
	{
		id: "browser",
		label: "Browser",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
				<circle cx="12" cy="12" r="9" />
				<line x1="3" y1="12" x2="21" y2="12" />
				<path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
			</svg>
		),
	},
	{
		id: "files",
		label: "Files",
		icon: <FilesIcon aria-hidden="true" />,
	},
];

const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

const prStateTone: Record<SessionPRSummary["state"], string> = {
	open: "border-success/40 bg-success/10 text-success",
	draft: "border-border bg-raised text-muted-foreground",
	merged: "border-accent/40 bg-accent-weak text-accent",
	closed: "border-error/40 bg-error/10 text-error",
};

const inspectorShellClass = "@container/inspector flex h-full min-h-0 flex-col overflow-hidden";

const inspectorBodyClass = "min-h-0 flex-1 overflow-y-auto p-3 pb-4 @max-[300px]/inspector:px-2.5";

const inspectorEmptyClass = "text-xs text-settings-muted leading-normal";

const kvRowClass =
	"flex items-center gap-2.5 px-1 py-1.5 text-md-sm @max-[300px]/inspector:flex-col @max-[300px]/inspector:items-start @max-[300px]/inspector:gap-1";

const kvKeyClass = "w-kv-label shrink-0 text-settings-muted @max-[300px]/inspector:w-auto";

const kvValueClass = "min-w-0 truncate text-settings-label @max-[300px]/inspector:w-full";

const kvValueMonoClass = "font-mono text-sm-md";

const reviewerVerdictTone: Record<"neutral" | "running" | "success" | "danger", string> = {
	neutral: "text-muted-foreground",
	running: "text-working",
	success: "text-success",
	danger: "text-error",
};

function VerdictBadge({ label, tone }: { label: string; tone: "neutral" | "running" | "success" | "danger" }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-2xs font-medium",
				reviewerVerdictTone[tone],
			)}
		>
			<span className="size-1.5 shrink-0 rounded-full bg-current" />
			{label}
		</span>
	);
}

/**
 * Tabbed inspector rail beside the terminal (Summary · Reviews · Browser).
 */
export function SessionInspector({
	session,
	onOpenReviewerTerminal,
	browserPoppedOut = false,
	browserAnnotationQueue,
	isInspectorVisible = true,
	onToggleBrowserPopOut,
	onOpenFiles,
	filesView,
	browserView,
	view: viewProp,
	onViewChange,
}: {
	session?: WorkspaceSession;
	onOpenReviewerTerminal?: OpenReviewerTerminal;
	browserPoppedOut?: boolean;
	browserAnnotationQueue?: BrowserAnnotationQueueModel;
	isInspectorVisible?: boolean;
	onToggleBrowserPopOut?: (next: boolean) => void;
	onOpenFiles?: () => void;
	filesView?: ReactNode;
	browserView?: BrowserViewModel;
	/** Controlled active tab. Omit to let the inspector own its own selection. */
	view?: InspectorView;
	onViewChange?: (view: InspectorView) => void;
}) {
	const [internalView, setInternalView] = useState<InspectorView>("summary");
	const requestedView = viewProp ?? internalView;
	// Badge the Browser tab when a preview target arrived without us opening it.
	const browserUnseen = useUiStore((state) =>
		session ? Boolean(state.inspectorSessions[session.id]?.browserUnseen) : false,
	);
	const setView = (next: InspectorView) => {
		setInternalView(next);
		onViewChange?.(next);
		if (next === "files") onOpenFiles?.();
	};
	// Reviews has nothing to say until a PR exists, and a tab whose only content
	// is "No pull request opened yet" is a dead end. Hide it until it has work.
	const hasReviewablePR = session ? sortedPRs(session).length > 0 : false;
	const views = VIEWS.filter((entry) => entry.id !== "reviews" || hasReviewablePR);

	// A session can lose its last PR while Reviews is open; fall back rather than
	// render a panel whose tab is gone.
	const view: InspectorView = requestedView === "reviews" && !hasReviewablePR ? "summary" : requestedView;

	if (!session) {
		return (
			<aside className={inspectorShellClass} aria-label="Session inspector">
				<div className={inspectorBodyClass}>
					<p className={inspectorEmptyClass}>Loading session…</p>
				</div>
			</aside>
		);
	}

	return (
		<aside className={inspectorShellClass} aria-label="Session inspector">
			<div className="flex h-inspector-tabs shrink-0 items-center gap-1 border-b border-border px-2.5" role="tablist">
				{views.map((entry) => (
					<button
						aria-label={entry.label}
						key={entry.id}
						type="button"
						role="tab"
						aria-selected={view === entry.id}
						className={cn(
							"inline-flex h-control-md shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-sm-md font-semibold text-passive transition-[background,color] duration-fast hover:bg-interactive-hover hover:text-foreground",
							view === entry.id && "bg-interactive-active text-foreground",
						)}
						onClick={() => setView(entry.id)}
						title={entry.label}
					>
						<span className="relative inline-flex shrink-0 [&_svg]:size-icon-md">
							{entry.icon}
							{entry.id === "browser" && browserUnseen ? (
								<span aria-hidden="true" className="absolute -right-1 -top-1 inline-flex size-dot-sm">
									{/* Pinging halo + solid core: a glowing beacon that draws the eye to
									    a link that arrived in the terminal, cleared once the tab opens. */}
									<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
									<span className="relative inline-flex size-dot-sm rounded-full bg-primary ring-2 ring-background" />
								</span>
							) : null}
						</span>
						<span className="truncate @max-[350px]/inspector:hidden">{entry.label}</span>
					</button>
				))}
			</div>

			<div
				className={cn(
					inspectorBodyClass,
					// The Browser tab renders its own bordered panel edge-to-edge, so
					// drop the body padding for it (except when popped out, where the
					// body only holds the "return to panel" empty state).
					view === "browser" &&
						!browserPoppedOut &&
						"p-0 overflow-hidden [&>[role=tabpanel]]:border-0 [&>[role=tabpanel]]:rounded-none",
					view === "files" && "p-0 overflow-hidden [&>[role=tabpanel]]:h-full",
				)}
			>
				{view === "summary" ? <SummaryView session={session} /> : null}
				{view === "reviews" ? <ReviewsView onOpenReviewerTerminal={onOpenReviewerTerminal} session={session} /> : null}
				{view === "browser" ? (
					<BrowserView
						browserPoppedOut={browserPoppedOut}
						browserAnnotationQueue={browserAnnotationQueue}
						browserView={browserView}
						isActive={isInspectorVisible && !browserPoppedOut}
						onTogglePopOut={onToggleBrowserPopOut}
						session={session}
					/>
				) : null}
				{view === "files" ? <FilesView filesView={filesView} onOpenFiles={onOpenFiles} /> : null}
			</div>
		</aside>
	);
}

function Section({
	action,
	children,
	className,
	title,
}: {
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	/** Accepted for call-site compatibility; all sections use the settings-row box. */
	surface?: boolean;
	/** Omit where the surrounding tab already names the section. */
	title?: string;
}) {
	// Boxed sections match the settings page row surface (bg + radius) with the
	// uppercase muted kicker kept inside the card, as in the inspector refs.
	return (
		<section className={cn("mb-2.5 last:mb-0", className)} data-testid="inspector-section">
			<div className="overflow-hidden rounded-settings-row bg-settings-row px-3.5 py-3">
				{title || action ? (
					<div className="mb-2 flex items-center justify-between gap-2 text-2xs font-bold uppercase tracking-settings-section text-settings-muted">
						{title ? <span>{title}</span> : <span />}
						{action ?? null}
					</div>
				) : null}
				{children}
			</div>
		</section>
	);
}

function SummaryView({ session }: { session: WorkspaceSession }) {
	const query = useSessionScmSummary(session.id);
	const prSummaries = sessionPRDisplaySummaries(session, query.data);
	const prSectionTitle = prSummaries.length > 1 ? `Pull requests (${prSummaries.length})` : "Pull request";
	const issueId = canonicalTrackerIssueId(session.issueId);

	return (
		<div role="tabpanel">
			<Section title={prSectionTitle}>
				{prSummaries.length === 0 ? (
					<p className={inspectorEmptyClass}>No pull request opened yet.</p>
				) : (
					<div className="flex flex-col gap-1.5">
						{prSummaries.map((pr) => (
							<PRSummaryCard key={pr.number} pr={pr} />
						))}
					</div>
				)}
			</Section>

			{session.kind !== "orchestrator" ? <CompletionControls session={session} /> : null}

			<Section title="Activity">
				<ActivityTimeline prs={prSummaries} session={session} />
				<ResumeAgentControl session={session} />
			</Section>

			<Section title="Overview">
				<dl className="flex flex-col gap-1">
					<Row k="Agent" v={session.provider} mono />
					{issueId && <Row k="Issue" v={issueId} mono />}
					{session.branch && <Row k="Branch" v={session.branch} mono />}
					<Row k="Started" v={formatTimeCompact(session.createdAt ?? session.updatedAt)} mono />
					<Row k="Session" v={session.id} mono />
				</dl>
			</Section>
		</div>
	);
}

function ResumeAgentControl({ session }: { session: WorkspaceSession }) {
	const queryClient = useQueryClient();
	const resume = useMutation({
		mutationFn: async () => {
			if (usePreviewData) return;
			const { data, error, response } = await apiClient.POST("/api/v1/sessions/{sessionId}/resume-agent", {
				params: { path: { sessionId: session.id } },
			});
			if (error) throw new Error(apiErrorMessage(error, `Failed to resume agent (${response.status})`));
			return data;
		},
		onSuccess: async (data) => {
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			if (data?.resumeMode === "saved_prompt") {
				void aoBridge.notifications
					.show({
						id: `resume-agent-fallback:${session.id}:${Date.now()}`,
						title: "Started from saved prompt",
						body: "AO could not resume the native agent session, so it started a new conversation from the saved prompt.",
					})
					.catch((err) => {
						console.warn("Unable to show resume fallback notification", err);
					});
			}
		},
	});

	if (session.isTerminated === true || session.activity?.state !== "exited") return null;

	const error = resume.error instanceof Error ? resume.error.message : null;
	return (
		<div className="mt-3 border-t border-(--color-border-settings-input) pt-3">
			<Button
				className="w-full"
				disabled={resume.isPending}
				onClick={() => resume.mutate()}
				size="sm"
				type="button"
				variant="outline"
			>
				<Play className="size-icon-sm" aria-hidden="true" />
				{resume.isPending ? "Resuming agent…" : "Resume agent"}
			</Button>
			{error ? (
				<p className="mt-2 text-2xs leading-normal text-error" role="status">
					{error}
				</p>
			) : null}
		</div>
	);
}

function CompletionControls({ session }: { session: WorkspaceSession }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const terminate = useTerminateSession();
	const policy = useMutation({
		mutationFn: async (terminateOnPrMerge: boolean) => {
			if (usePreviewData) return;
			const { error, response } = await apiClient.PATCH("/api/v1/sessions/{sessionId}/merge-policy", {
				params: { path: { sessionId: session.id } },
				body: { terminateOnPrMerge },
			});
			if (error) throw new Error(apiErrorMessage(error, `Failed to update merge policy (${response.status})`));
		},
		onMutate: async (terminateOnPrMerge) => {
			await queryClient.cancelQueries({ queryKey: workspaceQueryKey });
			const previous = queryClient.getQueryData<WorkspaceSummary[]>(workspaceQueryKey);
			queryClient.setQueryData<WorkspaceSummary[]>(workspaceQueryKey, (current) =>
				updateSessionMergePolicy(current, session.id, terminateOnPrMerge),
			);
			return { previous };
		},
		onError: (_error, _next, context) => {
			if (context?.previous) queryClient.setQueryData(workspaceQueryKey, context.previous);
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
	});
	const policyError = policy.error instanceof Error ? policy.error.message : null;
	const canTerminateNow = session.status === "merged";

	const confirmTermination = () => {
		const workspaces = queryClient.getQueryData<WorkspaceSummary[]>(workspaceQueryKey) ?? [];
		const orchestrator = findProjectOrchestrator(workspaces, session.workspaceId);
		setConfirmOpen(false);
		terminate.mutate(session);
		if (orchestrator) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: session.workspaceId, sessionId: orchestrator.id },
			});
			return;
		}
		void navigate({ to: "/projects/$projectId", params: { projectId: session.workspaceId } });
	};

	if (session.isTerminated === true) return null;

	return (
		<Section title="Completion">
			{canTerminateNow ? (
				<div className="flex items-center justify-between gap-3 py-1">
					<span className="min-w-0 text-xs font-medium text-settings-label">Terminate</span>
					<SessionTerminationPopover
						onConfirm={confirmTermination}
						onOpenChange={setConfirmOpen}
						open={confirmOpen}
						session={session}
						trigger={
							<button
								aria-label="Terminate session"
								className="inline-flex size-control-md items-center justify-center rounded-sm text-passive transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
								onClick={() => clearTerminateSessionState(queryClient, session.id)}
								type="button"
							>
								<Trash2 className="size-icon-sm" aria-hidden="true" />
							</button>
						}
					/>
				</div>
			) : (
				<>
					<div className="flex items-center justify-between gap-3 py-1">
						<label className="min-w-0 text-xs font-medium text-settings-label" htmlFor={`merge-policy-${session.id}`}>
							Terminate on merge
						</label>
						<Switch
							aria-label="Terminate session when pull requests merge"
							checked={Boolean(session.terminateOnPrMerge)}
							disabled={policy.isPending}
							id={`merge-policy-${session.id}`}
							onCheckedChange={(checked) => policy.mutate(checked)}
						/>
					</div>
					{policyError ? (
						<p className="mt-1 text-2xs leading-normal text-error" role="status">
							{policyError}
						</p>
					) : null}
				</>
			)}
		</Section>
	);
}

function updateSessionMergePolicy(
	workspaces: WorkspaceSummary[] | undefined,
	sessionId: string,
	terminateOnPrMerge: boolean,
): WorkspaceSummary[] | undefined {
	return workspaces?.map((workspace) => ({
		...workspace,
		sessions: workspace.sessions.map((candidate) =>
			candidate.id === sessionId ? { ...candidate, terminateOnPrMerge } : candidate,
		),
	}));
}

function PRSummaryCard({ pr }: { pr: SessionPRSummary }) {
	return (
		<div className="rounded-lg border border-(--color-border-settings-input) bg-(--color-bg-settings-input) px-2.5 py-1.5">
			<div className="flex items-center gap-2">
				<GitPullRequest className="size-icon-md shrink-0 text-settings-muted" aria-hidden="true" />
				<span className="text-md-sm font-medium text-settings-label">PR #{pr.number}</span>
				<Badge
					variant="outline"
					className={cn("h-5 px-1.5 text-[9px] leading-none font-medium", prStateTone[pr.state])}
				>
					{pr.state}
				</Badge>
				<a
					href={prBrowserUrl(pr)}
					target="_blank"
					rel="noopener noreferrer"
					className="ml-auto inline-flex items-center gap-0.5 text-caption font-medium text-accent hover:underline"
				>
					<span>Open</span>
					<ArrowUpRight aria-hidden="true" className="size-icon-2xs" strokeWidth={2} />
				</a>
			</div>
			{pr.title ? <div className="mt-1.5 text-xs font-medium leading-snug text-settings-label">{pr.title}</div> : null}
			<PRSummaryMeta className="mt-1" pr={pr} />
			<PRSummaryParts className="mt-1.5" pr={pr} variant="stacked" />
		</div>
	);
}

type TimelineTone = "now" | "good" | "warn" | "neutral";

const timelineNodeTone: Record<TimelineTone, string> = {
	neutral: "bg-passive shadow-timeline-dot",
	now: "bg-working shadow-timeline-dot-now",
	good: "bg-success shadow-timeline-dot",
	warn: "bg-warning shadow-timeline-dot",
};

function ActivityTimeline({ prs, session }: { prs: SessionPRSummary[]; session: WorkspaceSession }) {
	const history: { tone: TimelineTone; node: ReactNode; ts: string | null }[] = [];

	history.push({
		tone: "neutral",
		node: <>Created workspace</>,
		ts: formatTimeCompact(session.createdAt ?? session.updatedAt),
	});

	for (const pr of prs.filter((pr) => pr.state === "draft")) {
		history.push({
			tone: "neutral",
			node: <PRTimelineLink pr={pr} verb="Draft" />,
			ts: prStateTime(pr),
		});
	}

	for (const pr of prs.filter((pr) => pr.state !== "draft")) {
		history.push({
			tone: "neutral",
			node: <PRTimelineLink pr={pr} verb="Opened" />,
			ts: prCreatedTime(pr),
		});
	}

	for (const pr of prs.filter((pr) => pr.state === "merged")) {
		history.push({
			tone: "good",
			node: <PRTimelineLink pr={pr} verb="Merged" />,
			ts: prStateTime(pr),
		});
	}

	if (session.status === "merged") {
		history.push({
			tone: "good",
			node: <>Done</>,
			ts: latestMergedTime(prs),
		});
	}

	// Current activity is a live reading, not a historical event. Keep it above
	// the optional reverse-chronological history and do not imply that its last
	// hook time is when the state transition occurred.
	const current = {
		tone: "now",
		node: (
			<span className="inline-flex flex-wrap items-center gap-1.5">
				<span className="inline-flex align-middle">
					<InspectorActivityPill activity={session.activity} />
				</span>
				{session.status === "no_signal" ? (
					<span className="inline-flex align-middle">
						<TimelinePill {...getSessionTimelinePillView("no_signal")} />
					</span>
				) : null}
				{scmTimelineStates(session).map((state) => (
					<span key={state} className="inline-flex align-middle">
						<InspectorScmPill state={state} />
					</span>
				))}
			</span>
		),
		ts: null,
	} satisfies { tone: TimelineTone; node: ReactNode; ts: null };
	const events = [current, ...history.reverse()];

	return (
		<div className="relative pl-5">
			{events.map((event, index) => (
				<div key={index} className="relative pb-4 last:pb-0" data-testid="inspector-timeline-event">
					{index < events.length - 1 ? (
						<span
							aria-hidden="true"
							className={cn(
								"absolute -bottom-[10.5px] -left-3.5 w-px bg-border",
								event.tone === "now" ? "top-1/2" : "top-[10.5px]",
							)}
							data-testid="inspector-timeline-connector"
						/>
					) : null}
					<div className="relative flex min-h-icon-xs items-center">
						<span
							aria-hidden="true"
							className={cn(
								"absolute -left-4.5 size-icon-xs rounded-full",
								event.tone === "now" ? "top-1/2 -translate-y-1/2" : "top-1.5",
								timelineNodeTone[event.tone],
							)}
						/>
						<div className="text-xs leading-normal text-foreground [&_b]:font-semibold">{event.node}</div>
					</div>
					{event.ts ? <div className="mt-1 font-mono text-2xs text-passive">{event.ts}</div> : null}
				</div>
			))}
		</div>
	);
}

function PRTimelineLink({ pr, verb }: { pr: SessionPRSummary; verb: "Draft" | "Opened" | "Merged" }) {
	return (
		<a
			aria-label={`${verb} PR #${pr.number}`}
			className="inline-flex min-w-0 items-center gap-1 rounded-xs text-foreground underline-offset-2 transition-colors hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/50"
			href={prBrowserUrl(pr)}
			rel="noopener noreferrer"
			target="_blank"
		>
			<span>{verb} </span>
			<b>PR #{pr.number}</b>
			<ArrowUpRight aria-hidden="true" className="size-icon-2xs shrink-0" strokeWidth={2} />
		</a>
	);
}

function prStateTime(pr: SessionPRSummary): string | null {
	return pr.stateChangedAt ? formatTimeCompact(pr.stateChangedAt) : null;
}

function prCreatedTime(pr: SessionPRSummary): string | null {
	return pr.createdAt ? formatTimeCompact(pr.createdAt) : null;
}

function latestMergedTime(prs: SessionPRSummary[]): string | null {
	let latest: { timestamp: string; milliseconds: number } | undefined;
	for (const pr of prs) {
		if (pr.state !== "merged" || !pr.stateChangedAt) continue;
		const milliseconds = Date.parse(pr.stateChangedAt);
		if (!Number.isFinite(milliseconds)) continue;
		if (!latest || milliseconds > latest.milliseconds) {
			latest = { timestamp: pr.stateChangedAt, milliseconds };
		}
	}
	return latest ? formatTimeCompact(latest.timestamp) : null;
}

type ScmTimelineState = "ci_failed" | "changes_requested" | "conflict";

const CONFLICT_PILL = { label: "Conflict", tone: "var(--color-danger)", breathe: false };

function InspectorActivityPill({ activity }: { activity?: WorkspaceSession["activity"] }) {
	return <TimelinePill {...getAgentActivityView(activity)} />;
}

function InspectorScmPill({ state }: { state: ScmTimelineState }) {
	if (state === "conflict") return <TimelinePill {...CONFLICT_PILL} />;
	return <TimelinePill {...getSessionTimelinePillView(state)} />;
}

function TimelinePill({ label, tone, breathe }: { label: string; tone: string; breathe: boolean }) {
	return <StatusPill label={label} tone={tone} breathe={breathe} />;
}

function scmTimelineStates(session: WorkspaceSession): ScmTimelineState[] {
	const states: ScmTimelineState[] = [];
	const seen = new Set<ScmTimelineState>();
	const add = (state: ScmTimelineState) => {
		if (seen.has(state)) return;
		seen.add(state);
		states.push(state);
	};

	if (session.status === "ci_failed") add("ci_failed");
	if (session.status === "changes_requested") add("changes_requested");
	for (const pr of session.prs) {
		if (pr.ci === "failing") add("ci_failed");
		if (pr.review === "changes_requested") add("changes_requested");
		if (pr.mergeability === "conflicting") add("conflict");
	}

	return states;
}

/** Reviewer harness the daemon accepts, typed from the generated schema. */
type ReviewerHarness = NonNullable<components["schemas"]["ControllersTriggerReviewRequest"]["harness"]>;
type AgentInfo = components["schemas"]["AgentInfo"];
type AgentCatalog = { supported?: AgentInfo[]; installed?: AgentInfo[]; authorized?: AgentInfo[] };

function ReviewsView({
	session,
	onOpenReviewerTerminal,
}: {
	session: WorkspaceSession;
	onOpenReviewerTerminal?: OpenReviewerTerminal;
}) {
	const hasPr = sortedPRs(session).length > 0;
	const queryClient = useQueryClient();
	const [reviewNotice, setReviewNotice] = useState<string | null>(null);
	const reviewsQuery = useQuery({
		queryKey: ["session-reviews", session.id],
		enabled: hasPr,
		refetchInterval: (query) => {
			const data = query.state.data as ReviewsResponse | undefined;
			const reviews = data?.reviews ?? [];
			return reviews.some((review) => review.status === "running") ? 2500 : false;
		},
		queryFn: async () => {
			if (usePreviewData) return mockReviewsResponse(session);
			const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/reviews", {
				params: { path: { sessionId: session.id } },
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to load reviews"));
			return data ?? ({ reviewerHandleId: "", reviews: [], runs: [] } satisfies ReviewsResponse);
		},
	});
	const agentsQuery = useQuery(agentsQueryOptions);
	const projectConfigQuery = useQuery({
		queryKey: ["project-config", session.workspaceId],
		enabled: hasPr,
		queryFn: async () => {
			if (usePreviewData) return mockProjectConfig();
			const { data, error } = await apiClient.GET("/api/v1/projects/{id}", {
				params: { path: { id: session.workspaceId } },
			});
			if (error) return undefined;
			return projectConfig(data?.project);
		},
	});
	// Empty means "whatever the project configured"; picking one overrides this
	// pass only, so the choice never silently edits project config.
	const [reviewerOverride, setReviewerOverride] = useState<ReviewerHarness | "">("");
	const triggerReview = useMutation({
		mutationFn: async () => {
			// No override sends no body at all, leaving the default path on the wire
			// exactly as it was.
			const { data, error, response } = await apiClient.POST("/api/v1/sessions/{sessionId}/reviews/trigger", {
				params: { path: { sessionId: session.id } },
				...(reviewerOverride ? { body: { harness: reviewerOverride } } : {}),
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to start review"));
			return { data, reused: response?.status === 200 };
		},
		onMutate: () => {
			setReviewNotice(null);
		},
		onSuccess: ({ data, reused }) => {
			void queryClient.invalidateQueries({ queryKey: ["session-reviews", session.id] });
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			const started = data?.reviews?.find((review) => review.status === "running" && review.latestRun);
			if (reused || !started?.latestRun) {
				setReviewNotice("This commit has already been reviewed. Push a new commit to run another review.");
				return;
			}
			if (data?.reviewerHandleId) {
				const harness = started.latestRun.harness || "reviewer";
				onOpenReviewerTerminal?.({ handleId: data.reviewerHandleId, harness });
			}
		},
	});
	const setAutoInject = useMutation({
		mutationFn: async (enabled: boolean) => {
			const { error } = await apiClient.PATCH("/api/v1/sessions/{sessionId}/review-policy", {
				params: { path: { sessionId: session.id } },
				body: { autoInject: enabled },
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to save the review setting"));
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
	});
	const cancelReview = useMutation({
		mutationFn: async () => {
			const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/reviews/cancel", {
				params: { path: { sessionId: session.id } },
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to cancel review"));
		},
		onSuccess: () => {
			setReviewNotice(null);
			void queryClient.invalidateQueries({ queryKey: ["session-reviews", session.id] });
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
	});
	const reviewStates = reviewsQuery.data?.reviews ?? [];
	const scmSummary = useSessionScmSummary(session.id);
	const prSummaries = sessionPRDisplaySummaries(session, scmSummary.data);
	const githubReviews = prSummaries.filter(
		(pr) =>
			pr.state === "open" &&
			((pr.review?.reviews?.length ?? 0) > 0 ||
				(pr.review?.unresolvedBy ?? []).some((reviewer) => reviewer.count > 0)),
	);
	const unresolvedTotal = prSummaries
		.filter((pr) => pr.state === "open")
		.reduce((total, pr) => total + (pr.review?.unresolvedBy ?? []).reduce((n, r) => n + r.count, 0), 0);
	const githubReviewCount = githubReviews.reduce((n, pr) => n + (pr.review?.reviews?.length ?? 0), 0);

	return (
		<div role="tabpanel">
			{/* One panel, two sources, in the order they happen: AO's own reviewer runs
			    first, then whatever humans and bots leave on the PR. Tabs hid one
			    behind the other when the point is to read them together. */}
			<Section surface title="Agent review">
				<ReviewPanel
					config={projectConfigQuery.data}
					error={reviewsQuery.error ?? triggerReview.error ?? cancelReview.error}
					isLoading={reviewsQuery.isLoading}
					isCancelling={cancelReview.isPending}
					isTriggering={triggerReview.isPending}
					onOpenTerminal={onOpenReviewerTerminal}
					onCancel={() => cancelReview.mutate()}
					onTrigger={() => triggerReview.mutate()}
					reviewerHandleId={reviewsQuery.data?.reviewerHandleId ?? ""}
					reviewStates={reviewStates}
					runs={reviewsQuery.data?.runs ?? []}
					notice={reviewNotice}
					agentCatalog={agentsQuery.data}
					reviewerOverride={reviewerOverride}
					onReviewerOverrideChange={setReviewerOverride}
					autoInject={!session.reviewAutoInjectOff}
					autoInjectPending={setAutoInject.isPending}
					autoInjectError={setAutoInject.error}
					onAutoInjectChange={(next) => setAutoInject.mutate(next)}
					session={session}
				/>
			</Section>
			<Section surface title={`Reviews on the pull request${githubReviewCount > 0 ? ` (${githubReviewCount})` : ""}`}>
				<GithubReviewPanel
					isLoading={scmSummary.isLoading}
					prs={githubReviews}
					unresolvedTotal={unresolvedTotal}
				/>
			</Section>
		</div>
	);
}

function ReviewDisclosure({
	title,
	meta,
	defaultOpen,
	collapsible = true,
	children,
}: {
	title: string;
	meta: string;
	defaultOpen: boolean;
	/** A lone PR is always open: there is nothing to choose between, so a
	    chevron would only offer the user a way to hide the one thing here. */
	collapsible?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	if (!collapsible) {
		return (
			<div className="py-2 first:pt-0.5 last:pb-0.5">
				<div className="flex min-w-0 flex-col gap-1 px-1.5 py-1">
					<span className="line-clamp-2 text-sm-md font-semibold leading-snug text-foreground" title={title}>
						{title}
					</span>
					<span className="truncate font-mono text-micro text-passive" title={meta}>
						{meta}
					</span>
				</div>
				<div className="mt-2 flex flex-col gap-3 pl-1.5">{children}</div>
			</div>
		);
	}
	return (
		<div className="py-2 first:pt-0.5 last:pb-0.5">
			<button
				aria-expanded={open}
				data-testid="review-pr-row"
				className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-interactive-hover/30"
				onClick={() => setOpen((current) => !current)}
				type="button"
			>
				{open ? (
					<ChevronDown className="size-icon-sm shrink-0 text-passive" aria-hidden="true" />
				) : (
					<ChevronRight className="size-icon-sm shrink-0 text-passive" aria-hidden="true" />
				)}
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate text-sm-md font-semibold leading-snug text-foreground" title={title}>
						{title}
					</span>
					<span className="truncate font-mono text-micro text-passive" title={meta}>
						{meta}
					</span>
				</span>
			</button>
			{open ? <div className="mt-2 flex flex-col gap-3 pl-1.5">{children}</div> : null}
		</div>
	);
}

function projectConfig(project: components["schemas"]["ProjectOrDegraded"] | undefined): ProjectConfig | undefined {
	if (!project || !("config" in project)) return undefined;
	return project.config;
}

function mockProjectConfig(): ProjectConfig {
	return {
		worker: { agent: "codex" },
		orchestrator: { agent: "codex" },
		reviewers: [{ harness: "codex" }],
	};
}

// Preview-only pins so the Reviews tab can be seen mid-run and with a verdict
// left behind by an earlier commit — neither follows from a PR's review decision.
const MOCK_RUNNING_PR = 322;
const MOCK_STALE_PR = 324;

function mockReviewsResponse(session: WorkspaceSession): ReviewsResponse {
	const states: PRReviewState[] = sortedPRs(session).map((pr, index) => {
			const targetSha = `demo${pr.number}${index}`;
			const reviewedAt = new Date(Date.now() - (index + 1) * 11 * 60 * 1000).toISOString();
			const latestRun =
				pr.review === "approved" || pr.review === "changes_requested"
					? {
							batchId: `demo-batch-${session.id}`,
							body:
								pr.review === "approved"
									? "Demo review approved. The implementation is ready for the README screenshot flow."
									: "Demo review found polish feedback for the terminal presentation.",
							createdAt: reviewedAt,
							githubReviewId: `${pr.number}01`,
							harness: "codex",
							id: `demo-review-run-${pr.number}`,
							prUrl: pr.url,
							reviewId: `demo-review-${pr.number}`,
							sessionId: session.id,
							status: "delivered",
							targetSha,
							verdict: pr.review === "approved" ? "approved" : "changes_requested",
						}
					: undefined;
			const run = (over: Record<string, unknown>) => ({
				batchId: `demo-batch-${session.id}`,
				body: "",
				createdAt: reviewedAt,
				githubReviewId: "",
				harness: "codex",
				id: `demo-review-run-${pr.number}`,
				prUrl: pr.url,
				reviewId: `demo-review-${pr.number}`,
				sessionId: session.id,
				status: "complete",
				targetSha,
				verdict: "",
				...over,
			});
			// A couple of PRs are pinned to states the review decision alone cannot
			// produce, so the preview shows every shape the panel can render.
			if (pr.number === MOCK_RUNNING_PR) {
				return {
					latestRun: run({ status: "running", id: `demo-review-run-${pr.number}-live` }),
					prNumber: pr.number,
					prUrl: pr.url,
					status: "running",
					targetSha,
					title: mockReviewTitle(pr.number),
				};
			}
			if (pr.number === MOCK_STALE_PR) {
				// Reviewed, then a new commit landed: the verdict is about code that
				// has since changed, so the panel demotes it to "Previous".
				return {
					previousRun: run({
						status: "delivered",
						verdict: "changes_requested",
						githubReviewId: `${pr.number}09`,
						body: "Demo review asked for a tighter activity sample before the last commit.",
						targetSha: `${targetSha}-old`,
					}),
					prNumber: pr.number,
					prUrl: pr.url,
					status: "needs_review",
					targetSha,
					title: mockReviewTitle(pr.number),
				};
			}
			return {
				latestRun,
				prNumber: pr.number,
				prUrl: pr.url,
				status:
					pr.review === "approved"
						? "up_to_date"
						: pr.review === "changes_requested"
							? "changes_requested"
							: pr.state === "draft"
								? "ineligible"
								: "needs_review",
				targetSha,
				title: mockReviewTitle(pr.number),
			};
	});
	// Earlier passes, so the history control has something to open. Two reviewers
	// on the same PR is the case the control exists for.
	const runs: ReviewRunFacts[] = states.flatMap((state) => {
		const base = {
			batchId: `demo-batch-${session.id}`,
			githubReviewId: "",
			prUrl: state.prUrl,
			reviewId: `demo-review-${state.prNumber}`,
			sessionId: session.id,
			status: "delivered",
			targetSha: state.targetSha,
		};
		return [
			{
				...base,
				id: `demo-hist-${state.prNumber}-a`,
				harness: "codex",
				verdict: "changes_requested",
				body: "Earlier codex pass asked for tests around the discount edge cases.",
				createdAt: new Date(Date.now() - 55 * 60 * 1000).toISOString(),
			},
			{
				...base,
				id: `demo-hist-${state.prNumber}-b`,
				harness: "claude-code",
				verdict: "approved",
				body: "Earlier claude-code pass found nothing blocking.",
				createdAt: new Date(Date.now() - 95 * 60 * 1000).toISOString(),
			},
		];
	});
	return { reviewerHandleId: `${session.id}-reviewer`, reviews: states, runs };
}

function mockReviewTitle(prNumber: number): string {
	switch (prNumber) {
		case 319:
			return "Browser preview rail renders inside AO";
		case 320:
			return "Review tab keeps stacked PR rows visible";
		case 321:
			return "Draft child PR waits for parent review";
		case 318:
			return "Terminal polish feedback";
		case 323:
			return "README screenshot assets ready";
		default:
			return `Demo pull request ${prNumber}`;
	}
}

function ReviewPanel({
	session,
	config,
	reviewStates,
	runs,
	reviewerHandleId,
	isLoading,
	isTriggering,
	isCancelling,
	error,
	notice,
	agentCatalog,
	reviewerOverride,
	onReviewerOverrideChange,
	autoInject,
	autoInjectPending,
	autoInjectError,
	onAutoInjectChange,
	onTrigger,
	onCancel,
	onOpenTerminal,
}: {
	session: WorkspaceSession;
	config?: ProjectConfig;
	reviewStates: PRReviewState[];
	runs: ReviewRunFacts[];
	reviewerHandleId: string;
	isLoading: boolean;
	isTriggering: boolean;
	isCancelling: boolean;
	error: unknown;
	notice: string | null;
	agentCatalog?: AgentCatalog;
	reviewerOverride: ReviewerHarness | "";
	onReviewerOverrideChange: (next: ReviewerHarness | "") => void;
	autoInject: boolean;
	autoInjectPending: boolean;
	autoInjectError: unknown;
	onAutoInjectChange: (next: boolean) => void;
	onTrigger: () => void;
	onCancel: () => void;
	onOpenTerminal?: OpenReviewerTerminal;
}) {
	if (sortedPRs(session).length === 0) {
		return <p className={inspectorEmptyClass}>No pull request opened yet.</p>;
	}
	if (isLoading) {
		return <p className={inspectorEmptyClass}>Loading reviews...</p>;
	}

	const openPRURLs = new Set(
		sortedPRs(session)
			.filter((pr) => pr.state === "open")
			.map((pr) => pr.url),
	);
	const openReviewStates = reviewStates.filter((reviewState) => openPRURLs.has(reviewState.prUrl));
	// Whichever PR happens to come first is not the reviewer to name. With one PR
	// reviewed earlier by claude-code and another running under codex, taking the
	// first run reported the wrong agent as the one working. Prefer the run
	// actually in flight, then the newest recorded one.
	const runningRun = openReviewStates.find((review) => review.status === "running")?.latestRun;
	const newestRun = openReviewStates
		.map((review) => review.latestRun)
		.filter((run): run is NonNullable<typeof run> => Boolean(run))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	const latest = runningRun ?? newestRun;
	const harness = latest?.harness || config?.reviewers?.[0]?.harness || "claude-code";
	const selectedReviewer = reviewerOverride || harness;
	const terminalEnabled = Boolean(reviewerHandleId && onOpenTerminal);
	const reviewRunning = openReviewStates.some((reviewState) => reviewState.status === "running");
	const reviewHasRun = reviewRunning || Boolean(latest);
	const runAction = reviewSessionRunAction(openReviewStates, isTriggering);
	const openReviewerTerminal = () => {
		if (!terminalEnabled) return;
		onOpenTerminal?.({ handleId: reviewerHandleId, harness });
	};
	// Every recorded pass per PR, so each reviewer keeps its own tab. Falls back
	// to the state's own runs against a daemon that predates the runs field.
	const runsByPR = new Map<string, ReviewRunFacts[]>();
	for (const run of runs) {
		runsByPR.set(run.prUrl, [...(runsByPR.get(run.prUrl) ?? []), run]);
	}
	if (runs.length === 0) {
		for (const state of openReviewStates) {
			const fallback = [state.latestRun, state.previousRun].filter(Boolean) as ReviewRunFacts[];
			if (fallback.length > 0) runsByPR.set(state.prUrl, fallback);
		}
	}
	const filteredRunsByPR = new Map<string, ReviewRunFacts[]>();
	for (const [prUrl, prRuns] of runsByPR) {
		filteredRunsByPR.set(prUrl, prRuns.filter((run) => (run.harness || "reviewer") === selectedReviewer));
	}

	const runDisabled =
		isTriggering ||
		openReviewStates.length === 0 ||
		openReviewStates.every((reviewState) => reviewState.status === "ineligible");

	return (
		<div className="flex flex-col gap-3">
			{error ? (
				<p className="m-0 rounded-md border border-error/28 bg-error/8 px-2.5 py-2 text-sm-md leading-normal text-error">
					{apiErrorMessage(error, "Review request failed")}
				</p>
			) : null}
			{notice ? (
				<p className="m-0 rounded-md border border-success/28 bg-success/8 px-2.5 py-2 text-sm-md leading-normal text-success">
					{notice}
				</p>
			) : null}
			<div className="flex min-w-0 items-center justify-between gap-3">
				<div className="min-w-0">
					<span className="inline-flex items-center gap-1.5 text-micro font-medium uppercase tracking-wide-sm text-passive">
						<ScanEye aria-hidden="true" className="size-icon-2xs shrink-0" />
						Review history
					</span>
					<p className="m-0 mt-0.5 text-micro text-passive">Filter history and choose the agent for the next run.</p>
				</div>
				<ReviewerSelect
					ariaLabel="Select reviewer agent"
					authorized={agentCatalog?.authorized}
					defaultHarness={harness}
					disabled={reviewRunning}
					installed={agentCatalog?.installed}
					onChange={(next) => onReviewerOverrideChange(next as ReviewerHarness | "")}
					supported={agentCatalog?.supported}
					triggerClassName="max-w-[10rem] shrink-0"
					value={reviewerOverride}
				/>
			</div>
			<div className="flex flex-col divide-y divide-border">
				{openReviewStates.length === 0 ? (
					<p className={cn(inspectorEmptyClass, "py-1")}>No open pull requests to review.</p>
				) : (
					openReviewStates.map((reviewState) => (
						<ReviewDisclosure
							key={`${reviewState.prUrl}:${reviewState.targetSha}`}
							collapsible
							defaultOpen={false}
							meta={aoReviewMeta(reviewState)}
							title={reviewState.title?.trim() || `PR #${reviewState.prNumber}`}
						>
							<ReviewerRuns
								reviewState={reviewState}
								runs={filteredRunsByPR.get(reviewState.prUrl) ?? []}
								reviewer={selectedReviewer}
								hasAnyRuns={(runsByPR.get(reviewState.prUrl)?.length ?? 0) > 0}
							/>
						</ReviewDisclosure>
					))
				)}
			</div>
			<label className="-mx-4 flex min-w-0 cursor-pointer items-start gap-2.5 border-t border-border px-4 pt-3">
				<Switch
					aria-label="Send review findings to the agent"
					checked={autoInject}
					className="mt-0.5 shrink-0 data-[state=checked]:bg-accent-strong"
					disabled={autoInjectPending}
					onCheckedChange={onAutoInjectChange}
				/>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-2xs font-medium leading-tight text-foreground">Send findings to the agent</span>
					<span className="text-micro leading-snug text-passive">
						The worker is told what the review found as soon as it finishes.
					</span>
				</span>
			</label>
			{autoInjectError ? (
				<p className="m-0 rounded-md border border-error/28 bg-error/8 px-2.5 py-2 text-sm-md leading-normal text-error">
					{apiErrorMessage(autoInjectError, "Unable to save the review setting")}
				</p>
			) : null}
			{/* Running is the one state worth interrupting the panel for, so it gets a
			    live strip above the actions rather than only a word on a button. */}
			{reviewRunning ? (
				<div className="-mx-4 mt-1 flex items-center gap-2 border-y border-border px-4 py-2">
					<Loader2 aria-hidden="true" className="size-icon-sm shrink-0 animate-spin text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate text-2xs font-medium text-muted-foreground">
						{isCancelling ? "Cancelling review…" : `Review in progress · ${harness}`}
					</span>
				</div>
			) : null}
			<div
				className={cn(
					"-mx-4 -mb-3 flex items-center justify-center gap-2 border-t border-border px-4 pb-3 pt-3",
					reviewRunning ? "mt-0 border-t-0" : "mt-3",
				)}
			>
				{/* The review action carries the panel, so it gets real button weight
				    instead of reading as one more link next to Open terminal. */}
				{/* Same accent as the Orchestrator action, so the two primary buttons in
				    the app read as the same kind of thing. */}
				<Button
					className={cn(
						"shrink-0 gap-1.5 [&_svg]:size-icon-sm",
						!reviewRunning &&
							"border-transparent bg-accent-strong text-accent-foreground hover:opacity-100 hover:brightness-110 active:brightness-95",
					)}
					disabled={reviewRunning ? isCancelling : runDisabled}
					onClick={reviewRunning ? onCancel : onTrigger}
					size="sm"
					type="button"
					variant={reviewRunning ? "outline" : "primary"}
				>
					{reviewRunning ? <X aria-hidden="true" /> : <Play aria-hidden="true" />}
					{reviewRunning ? (isCancelling ? "Cancelling..." : "Cancel review") : runAction}
				</Button>
				{reviewHasRun ? (
					<Button
						className="shrink-0 gap-1.5 [&_svg]:size-icon-sm"
						disabled={!terminalEnabled}
						onClick={openReviewerTerminal}
						size="sm"
						type="button"
						variant="ghost"
					>
						<Terminal aria-hidden="true" />
						Terminal
					</Button>
				) : null}
			</div>
		</div>
	);
}

/**
 * Reviews left on the PR by humans and bots, as opposed to AO's own runs.
 *
 */
function GithubReviewPanel({
	prs,
	unresolvedTotal,
	isLoading,
}: {
	prs: SessionPRSummary[];
	unresolvedTotal: number;
	isLoading: boolean;
}) {
	if (isLoading) {
		return <p className={inspectorEmptyClass}>Loading reviews...</p>;
	}
	if (prs.length === 0) {
		return <p className={inspectorEmptyClass}>No one has reviewed this pull request yet.</p>;
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col divide-y divide-border">
				{prs.map((pr, index) => {
					const entries = pr.review?.reviews ?? [];
					const unresolved = (pr.review?.unresolvedBy ?? []).reduce((n, r) => n + r.count, 0);
					return (
						<ReviewDisclosure
							key={pr.number}
							collapsible={prs.length > 1}
							defaultOpen={index === 0}
							meta={`#${pr.number}${unresolved > 0 ? ` · ${unresolved} unresolved` : ""}`}
							title={pr.title?.trim() || `PR #${pr.number}`}
						>
							{entries.map((entry) => (
								<GithubReviewRow entry={entry} key={`${entry.reviewerId}:${entry.submittedAt}`} />
							))}
						</ReviewDisclosure>
					);
				})}
			</div>
			{unresolvedTotal === 0 ? <p className={inspectorEmptyClass}>No unresolved threads.</p> : null}
		</div>
	);
}

type GithubReviewEntry = NonNullable<NonNullable<SessionPRSummary["review"]>["reviews"]>[number];

function GithubReviewRow({ entry }: { entry: GithubReviewEntry }) {
	const verdict = githubVerdict(entry.verdict);
	const body = entry.body?.trim();
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex min-w-0 items-center gap-2">
				<span className="min-w-0 truncate text-2xs font-medium text-foreground">{entry.reviewerId}</span>
				{entry.isBot ? <span className="shrink-0 font-mono text-micro text-passive">bot</span> : null}
			</div>
			<VerdictBadge label={verdict.label} tone={verdict.tone} />
			{body ? <p className="whitespace-pre-wrap break-words text-2xs leading-relaxed text-passive">{body}</p> : null}
			{entry.reviewUrl ? (
				<a
					className="inline-flex items-center gap-0.5 self-start text-2xs font-medium text-passive no-underline transition-colors hover:text-foreground"
					href={entry.reviewUrl}
					target="_blank"
					rel="noopener noreferrer"
				>
					View review
					<ArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
				</a>
			) : null}
		</div>
	);
}

function githubVerdict(verdict: string): { label: string; tone: "neutral" | "running" | "success" | "danger" } {
	switch (verdict) {
		case "approved":
			return { label: "Approved", tone: "success" };
		case "changes_requested":
			return { label: "Changes requested", tone: "danger" };
		case "review_required":
			return { label: "Review required", tone: "neutral" };
		default:
			return { label: "Commented", tone: "neutral" };
	}
}

/** Every recorded reviewer pass for one PR, newest first. */
function ReviewerRuns({
	reviewState,
	runs,
	reviewer,
	hasAnyRuns,
}: {
	reviewState: PRReviewState;
	runs: ReviewRunFacts[];
	reviewer: string;
	hasAnyRuns: boolean;
}) {
	if (runs.length === 0 && hasAnyRuns) {
		return <p className={cn(inspectorEmptyClass, "m-0")}>{`${reviewer} has not reviewed this PR yet.`}</p>;
	}
	// Preserve the current-commit state when the only available run belongs to
	// an older SHA. History must not make stale findings look current.
	if (!reviewState.latestRun || runs.length === 0) return <AoReviewRow reviewState={reviewState} />;
	return (
		<ReviewRunList
			reviewState={reviewState}
			runs={[...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))}
		/>
	);
}

/** Review history for a PR, with the harness identified on every pass. */
function ReviewRunList({ reviewState, runs }: { reviewState: PRReviewState; runs: ReviewRunFacts[] }) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-3", reviewState.status === "ineligible" && "opacity-70")}>
			{runs.map((run, index) => {
				const verdict = runReviewVerdict(run);
				// A terminated run's body is the reason it stopped, not findings.
				const body = run.status === "cancelled" || run.status === "failed" ? "" : run.body?.trim();
				const url = aoReviewCommentUrl(run);
				return (
					<div className="flex min-w-0 flex-col gap-1.5" key={run.id}>
						<span className="inline-flex min-w-0 items-center gap-2">
							<span className="inline-flex min-w-0 items-center gap-1 text-micro font-medium text-muted-foreground">
								<AgentAvatar className="size-icon-sm shrink-0" decorative provider={run.harness || "reviewer"} />
								<span className="truncate">{run.harness || "reviewer"}</span>
							</span>
							<VerdictBadge label={verdict.label} tone={verdict.tone} />
							<span className="shrink-0 font-mono text-micro text-passive">{formatTimeCompact(run.createdAt)}</span>
							{index > 0 ? <span className="shrink-0 text-micro text-passive">earlier pass</span> : null}
						</span>
						{body ? (
							<p className="m-0 whitespace-pre-wrap break-words text-2xs leading-relaxed text-muted-foreground">
								{body}
							</p>
						) : null}
						{url ? (
							<a
								className="inline-flex items-center gap-0.5 self-start text-2xs font-medium text-passive no-underline transition-colors hover:text-foreground"
								href={url}
								target="_blank"
								rel="noopener noreferrer"
							>
								View review
								<ArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
							</a>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function aoReviewMeta(reviewState: PRReviewState): string {
	const displayRun = reviewState.latestRun ?? reviewState.previousRun;
	if (displayRun?.createdAt) {
		return `#${reviewState.prNumber} · ${formatTimeCompact(displayRun.createdAt)}`;
	}
	if (!displayRun && reviewVerdict(reviewState).label === "Not run") {
		return `#${reviewState.prNumber} · Not run`;
	}
	return `#${reviewState.prNumber}`;
}

function AoReviewRow({ reviewState }: { reviewState: PRReviewState }) {
	const displayRun = reviewState.latestRun ?? reviewState.previousRun;
	// With no run against the current head we fall back to the last one, which is
	// a verdict on code that has since changed. Rendering it plainly made a stale
	// "Changes requested" look like it still applied to the new commit, so the
	// live state leads and the old verdict is explicitly marked as previous.
	const isStale = !reviewState.latestRun && Boolean(reviewState.previousRun);
	const verdict = displayRun && !isStale ? runReviewVerdict(displayRun) : reviewVerdict(reviewState);
	const previousVerdict = isStale && displayRun ? runReviewVerdict(displayRun) : undefined;
	// A cancelled run's body is the cancellation reason, not review findings, and
	// the badge above already says "Cancelled" — rendering it as the summary made
	// the row state the same thing twice.
	const isTerminatedRun = displayRun?.status === "cancelled" || displayRun?.status === "failed";
	const summary = isTerminatedRun ? undefined : displayRun?.body?.trim();
	const reviewUrl = aoReviewCommentUrl(displayRun);
	const reviewLinkLabel = reviewState.latestRun ? "View review" : "View previous review";
	return (
		<div className={cn("flex min-w-0 flex-col gap-1.5", reviewState.status === "ineligible" && "opacity-70")}>
			<span className="inline-flex min-w-0 items-center gap-2">
				{displayRun ? (
					<span className="inline-flex min-w-0 items-center gap-1 text-micro font-medium text-muted-foreground">
						<AgentAvatar
							className="size-icon-sm shrink-0"
							decorative
							provider={displayRun.harness || "reviewer"}
						/>
						<span className="truncate">{displayRun.harness || "reviewer"}</span>
					</span>
				) : null}
				<VerdictBadge
					label={isStale ? "Not run on this commit" : verdict.label}
					tone={isStale ? "neutral" : verdict.tone}
				/>
			</span>
			{previousVerdict ? (
				<p className="m-0 inline-flex min-w-0 items-center gap-1.5 text-2xs text-passive">
					<span className="shrink-0">Previous:</span>
					<span className={cn("inline-flex min-w-0 items-center gap-1.5", reviewerVerdictTone[previousVerdict.tone])}>
						<span className="size-1.5 shrink-0 rounded-full bg-current opacity-60" />
						<span className="truncate">{previousVerdict.label}</span>
					</span>
				</p>
			) : null}
			{summary ? (
				<p className="m-0 whitespace-pre-wrap break-words text-2xs leading-relaxed text-muted-foreground">{summary}</p>
			) : null}
			{reviewUrl ? (
				<a
					className="inline-flex items-center gap-0.5 self-start text-2xs font-medium text-passive no-underline transition-colors hover:text-foreground"
					href={reviewUrl}
					target="_blank"
					rel="noopener noreferrer"
				>
					{reviewLinkLabel}
					<ArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
				</a>
			) : null}
		</div>
	);
}

function runReviewVerdict(run: NonNullable<PRReviewState["latestRun"]>): {
	label: string;
	tone: "neutral" | "running" | "success" | "danger";
} {
	if (run.status === "failed") {
		return { label: "Failed", tone: "danger" };
	}
	if (run.status === "cancelled") {
		return { label: "Cancelled", tone: "neutral" };
	}
	if (run.status === "running") {
		return { label: "Reviewing...", tone: "running" };
	}
	switch (run.verdict) {
		case "approved":
			return { label: "Approved", tone: "success" };
		case "changes_requested":
			return { label: "Changes requested", tone: "danger" };
		default:
			return { label: "Not run", tone: "neutral" };
	}
}

// GitHub anchors a posted review at #pullrequestreview-<id> on the PR page; we
// only have that link once the run has been delivered to GitHub.
function aoReviewCommentUrl(run: PRReviewState["latestRun"]): string | null {
	if (!run?.prUrl || !run.githubReviewId) return null;
	return `${run.prUrl}#pullrequestreview-${run.githubReviewId}`;
}

function reviewVerdict(reviewState: PRReviewState): {
	label: string;
	tone: "neutral" | "running" | "success" | "danger";
} {
	if (reviewState.latestRun?.status === "failed") {
		return { label: "Failed", tone: "danger" };
	}
	if (reviewState.latestRun?.status === "cancelled") {
		return { label: "Cancelled", tone: "neutral" };
	}
	switch (reviewState.status) {
		case "running":
			return { label: "Reviewing...", tone: "running" };
		case "up_to_date":
			return { label: "Approved", tone: "success" };
		case "changes_requested":
			return { label: "Changes requested", tone: "danger" };
		case "needs_review":
		case "ineligible":
			return { label: "Not run", tone: "neutral" };
	}
	return { label: "Not run", tone: "neutral" };
}

function reviewSessionRunAction(reviewStates: PRReviewState[], isTriggering: boolean): string {
	if (isTriggering || reviewStates.some((reviewState) => reviewState.status === "running")) {
		return "Reviewing...";
	}
	if (reviewStates.some((reviewState) => reviewState.status === "changes_requested" || reviewState.latestRun)) {
		return "Re-run review";
	}
	return "Run review";
}

function BrowserView({
	session,
	isActive,
	browserPoppedOut,
	browserAnnotationQueue,
	onTogglePopOut,
	browserView,
}: {
	session: WorkspaceSession;
	isActive: boolean;
	browserPoppedOut: boolean;
	browserAnnotationQueue?: BrowserAnnotationQueueModel;
	onTogglePopOut?: (next: boolean) => void;
	browserView?: BrowserViewModel;
}) {
	// While maximized, the browser is a full-window overlay that covers the rail,
	// so the inspector's Browser tab has nothing to show (and must not mount a
	// second BrowserPanelView — it would fight the overlay over the shared native
	// view slot). Exit is via the overlay's own minimize button.
	if (browserPoppedOut) {
		return (
			<div role="tabpanel">
				<div className={cn(inspectorEmptyClass, "flex flex-col items-center gap-2 py-10 px-5 text-center")}>
					<p className="text-md-sm text-muted-foreground">Browser preview is in the center pane.</p>
					<Button onClick={() => onTogglePopOut?.(false)} size="sm" type="button" variant="outline">
						Return to panel
					</Button>
				</div>
			</div>
		);
	}

	if (!browserView || !browserAnnotationQueue) {
		return null;
	}

	return (
		<BrowserPanelView
			active={isActive}
			annotationQueue={browserAnnotationQueue}
			browserView={browserView}
			onTogglePopOut={(next) => onTogglePopOut?.(next)}
			poppedOut={false}
			session={session}
		/>
	);
}

function FilesView({ filesView, onOpenFiles }: { filesView?: ReactNode; onOpenFiles?: () => void }) {
	if (filesView) {
		return (
			<div className="h-full min-h-0" role="tabpanel">
				{filesView}
			</div>
		);
	}
	return (
		<div role="tabpanel">
			<div className={cn(inspectorEmptyClass, "flex flex-col items-center gap-2 px-5 py-10 text-center")}>
				<p className="text-md-sm text-muted-foreground">Files are not available for this session.</p>
				<Button disabled={!onOpenFiles} onClick={() => onOpenFiles?.()} size="sm" type="button" variant="outline">
					Open files
				</Button>
			</div>
		</div>
	);
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
	return (
		<div className={kvRowClass}>
			<dt className={kvKeyClass}>{k}</dt>
			<dd className={cn(kvValueClass, mono && kvValueMonoClass)}>{v}</dd>
		</div>
	);
}
