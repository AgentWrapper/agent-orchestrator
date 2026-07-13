import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ArrowUpRight, GitPullRequest, Play, Shield, Terminal, X } from "lucide-react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { formatTimeCompact } from "../lib/format-time";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { prBrowserUrl, sessionPRDisplaySummaries } from "../lib/pr-display";
import type { SessionActivityState, WorkspaceSession } from "../types/workspace";
import { canonicalTrackerIssueId, sortedPRs } from "../types/workspace";
import { BrowserPanelView, type BrowserAnnotationQueueModel } from "./BrowserPanel";
import type { BrowserViewModel } from "../hooks/useBrowserView";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { PRSummaryMeta, PRSummaryParts } from "./PRSummaryDisplay";
import { StatusPill } from "./StatusPill";

type ProjectConfig = components["schemas"]["ProjectConfig"];
type PRReviewState = components["schemas"]["PRReviewState"];
type ReviewsResponse = components["schemas"]["ListReviewsResponse"];
type OpenReviewerTerminal = (target: { handleId: string; harness: string }) => void;

export type InspectorView = "summary" | "reviews" | "browser";

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
];

const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

const prStateTone: Record<SessionPRSummary["state"], string> = {
	open: "border-success/40 bg-success/10 text-success",
	draft: "border-border bg-raised text-muted-foreground",
	merged: "border-accent/40 bg-accent-weak text-accent",
	closed: "border-error/40 bg-error/10 text-error",
};

const inspectorShellClass = "@container/inspector flex h-full min-h-0 flex-col overflow-hidden bg-background";

const inspectorBodyClass = "min-h-0 flex-1 overflow-y-auto p-5 pb-10 @max-[300px]/inspector:px-3.5";

const inspectorEmptyClass = "text-xs text-muted-foreground leading-normal";

const kvRowClass =
	"flex items-center gap-2.5 px-1 py-1.5 text-md-sm @max-[300px]/inspector:flex-col @max-[300px]/inspector:items-start @max-[300px]/inspector:gap-1";

const kvKeyClass = "w-kv-label shrink-0 text-muted-foreground @max-[300px]/inspector:w-auto";

const kvValueClass = "min-w-0 truncate text-foreground @max-[300px]/inspector:w-full";

const kvValueMonoClass = "font-mono text-sm-md";

const reviewerStatusTone: Record<"neutral" | "running" | "success" | "danger", string> = {
	neutral: "bg-raised text-muted-foreground",
	running: "bg-working/12 text-working",
	success: "bg-success/14 text-success",
	danger: "bg-error/14 text-error",
};

const reviewerDotTone: Record<"neutral" | "running" | "success" | "danger", string> = {
	neutral: "bg-passive",
	running: "bg-working",
	success: "bg-success",
	danger: "bg-error",
};

const reviewerVerdictTone: Record<"neutral" | "running" | "success" | "danger", string> = {
	neutral: "text-muted-foreground",
	running: "text-working",
	success: "text-success",
	danger: "text-error",
};

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
	browserView?: BrowserViewModel;
	/** Controlled active tab. Omit to let the inspector own its own selection. */
	view?: InspectorView;
	onViewChange?: (view: InspectorView) => void;
}) {
	const [internalView, setInternalView] = useState<InspectorView>("summary");
	const view = viewProp ?? internalView;
	const setView = (next: InspectorView) => {
		setInternalView(next);
		onViewChange?.(next);
	};

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
			<div className="flex h-inspector-tabs shrink-0 items-center gap-1 border-b border-border px-3" role="tablist">
				{VIEWS.map((entry) => (
					<button
						key={entry.id}
						type="button"
						role="tab"
						aria-selected={view === entry.id}
						className={cn(
							"inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md p-1.5 text-sm-md font-semibold text-passive transition-[background,color] duration-fast hover:bg-interactive-hover hover:text-foreground",
							view === entry.id && "bg-interactive-active text-foreground",
						)}
						onClick={() => setView(entry.id)}
					>
						<span className="inline-flex shrink-0 [&_svg]:size-icon-md">{entry.icon}</span>
						<span className="truncate">{entry.label}</span>
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
	title: string;
}) {
	return (
		<section className={cn("mb-6", className)} data-testid="inspector-section">
			<div className="mb-3 flex items-center justify-between text-2xs font-semibold uppercase tracking-wide-lg text-passive">
				<span>{title}</span>
				{action ?? null}
			</div>
			{children}
		</section>
	);
}

function SummaryView({ session }: { session: WorkspaceSession }) {
	const query = useSessionScmSummary(session.id);
	const prSummaries = sessionPRDisplaySummaries(session, query.data);
	const prSectionTitle = prSummaries.length > 1 ? `Pull requests (${prSummaries.length})` : "Pull request";
	const branchLabel = session.branch || `session/${session.id}`;
	const issueId = canonicalTrackerIssueId(session.issueId);

	return (
		<div role="tabpanel">
			<Section title={prSectionTitle}>
				{prSummaries.length === 0 ? (
					<p className={inspectorEmptyClass}>No pull request opened yet.</p>
				) : (
					<div className="flex flex-col gap-2">
						{prSummaries.map((pr) => (
							<PRSummaryCard key={pr.number} pr={pr} />
						))}
					</div>
				)}
			</Section>

			<Section title="Activity">
				<ActivityTimeline session={session} />
			</Section>

			<Section className="border-t border-border pt-5" title="Overview">
				<dl className="flex flex-col gap-1">
					<Row k="Agent" v={session.provider} mono />
					{issueId && <Row k="Issue" v={issueId} mono />}
					<Row k="Branch" v={branchLabel} mono />
					<Row k="Started" v={formatTimeCompact(session.createdAt ?? session.updatedAt)} mono />
					<Row k="Session" v={session.id} mono />
				</dl>
			</Section>
		</div>
	);
}

function PRSummaryCard({ pr }: { pr: SessionPRSummary }) {
	return (
		<div className="rounded-md border border-border bg-surface px-3 py-2.5">
			<div className="flex items-center gap-2">
				<GitPullRequest className="size-icon-md shrink-0 text-passive" aria-hidden="true" />
				<span className="text-md-sm font-medium text-foreground">PR #{pr.number}</span>
				<Badge variant="outline" className={cn("h-5 px-1.5 text-micro font-medium", prStateTone[pr.state])}>
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
			{pr.title ? <div className="mt-2 text-xs font-medium leading-snug text-foreground">{pr.title}</div> : null}
			<PRSummaryMeta className="mt-1.5" pr={pr} />
			<PRSummaryParts className="mt-2" pr={pr} variant="stacked" />
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

function ActivityTimeline({ session }: { session: WorkspaceSession }) {
	const events: { tone: TimelineTone; node: ReactNode; ts: string | null }[] = [];

	events.push({
		tone: "neutral",
		node: <>Created worktree &amp; branch</>,
		ts: formatTimeCompact(session.createdAt ?? session.updatedAt),
	});

	const prs = sortedPRs(session);
	for (const pr of prs.filter((pr) => pr.state === "draft")) {
		events.push({
			tone: "neutral",
			node: (
				<>
					Draft <b>PR #{pr.number}</b>
				</>
			),
			ts: null,
		});
	}

	for (const pr of prs.filter((pr) => pr.state !== "draft")) {
		events.push({
			tone: "neutral",
			node: (
				<>
					Opened <b>PR #{pr.number}</b>
				</>
			),
			ts: null,
		});
	}

	events.push({
		tone: "now",
		node: (
			<span className="inline-flex flex-wrap items-center gap-1.5">
				<span className="inline-flex align-middle">
					<InspectorActivityPill state={session.activity?.state ?? "unknown"} />
				</span>
				{session.status === "no_signal" ? (
					<span className="inline-flex align-middle">
						<TimelinePill {...ACTIVITY_WARNING_PILL.no_signal} />
					</span>
				) : null}
				{scmTimelineStates(session).map((state) => (
					<span key={state} className="inline-flex align-middle">
						<InspectorScmPill state={state} />
					</span>
				))}
			</span>
		),
		ts: session.activity?.lastActivityAt ? formatTimeCompact(session.activity.lastActivityAt) : null,
	});

	for (const pr of prs.filter((pr) => pr.state === "merged")) {
		events.push({
			tone: "good",
			node: (
				<>
					Merged <b>PR #{pr.number}</b>
				</>
			),
			ts: null,
		});
	}

	if (session.status === "merged") {
		events.push({
			tone: "good",
			node: <>Done</>,
			ts: formatTimeCompact(session.updatedAt),
		});
	}

	return (
		<div className="relative pl-5 before:absolute before:top-1 before:bottom-1.5 before:left-1.25 before:w-px before:bg-border before:content-['']">
			{events.map((event, index) => (
				<div key={index} className="relative pb-4 last:pb-0" data-testid="inspector-timeline-event">
					<span
						aria-hidden="true"
						className={cn("absolute -left-4.5 top-0.75 size-icon-xs rounded-full", timelineNodeTone[event.tone])}
					/>
					<div className="text-xs leading-normal text-foreground [&_b]:font-semibold">{event.node}</div>
					{event.ts ? <div className="mt-1 font-mono text-2xs text-passive">{event.ts}</div> : null}
				</div>
			))}
		</div>
	);
}

const ACTIVITY_PILL: Record<SessionActivityState, { label: string; tone: string; breathe: boolean }> = {
	active: { label: "Working", tone: "var(--color-working)", breathe: true },
	idle: { label: "Idle", tone: "var(--color-text-muted)", breathe: false },
	waiting_input: { label: "Input Needed", tone: "var(--color-warning)", breathe: false },
	blocked: { label: "Awaiting Decision", tone: "var(--color-warning)", breathe: false },
	exited: { label: "Exited", tone: "var(--color-text-muted)", breathe: false },
	unknown: { label: "Activity Unavailable", tone: "var(--color-text-muted)", breathe: false },
};

const ACTIVITY_WARNING_PILL: Record<"no_signal", { label: string; tone: string; breathe: boolean }> = {
	no_signal: { label: "No Signal", tone: "var(--color-text-muted)", breathe: false },
};

type ScmTimelineState = "ci_failed" | "changes_requested" | "conflict";

const SCM_PILL: Record<ScmTimelineState, { label: string; tone: string; breathe: boolean }> = {
	ci_failed: { label: "CI Failed", tone: "var(--color-danger)", breathe: false },
	changes_requested: { label: "Changes Requested", tone: "var(--color-warning)", breathe: false },
	conflict: { label: "Conflict", tone: "var(--color-danger)", breathe: false },
};

function InspectorActivityPill({ state }: { state: SessionActivityState }) {
	return <TimelinePill {...ACTIVITY_PILL[state]} />;
}

function InspectorScmPill({ state }: { state: ScmTimelineState }) {
	return <TimelinePill {...SCM_PILL[state]} />;
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
			return data ?? ({ reviewerHandleId: "", reviews: [] } satisfies ReviewsResponse);
		},
	});
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
	const triggerReview = useMutation({
		mutationFn: async () => {
			const { data, error, response } = await apiClient.POST("/api/v1/sessions/{sessionId}/reviews/trigger", {
				params: { path: { sessionId: session.id } },
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
				setReviewNotice("No needed reviews were started.");
				return;
			}
			if (data?.reviewerHandleId) {
				const harness = started.latestRun.harness || "reviewer";
				onOpenReviewerTerminal?.({ handleId: data.reviewerHandleId, harness });
			}
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

	return (
		<div role="tabpanel">
			<Section title="Reviews">
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
					notice={reviewNotice}
					session={session}
				/>
			</Section>
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

function mockReviewsResponse(session: WorkspaceSession): ReviewsResponse {
	return {
		reviewerHandleId: `${session.id}-reviewer`,
		reviews: sortedPRs(session).map((pr, index) => {
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
		}),
	};
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
	reviewerHandleId,
	isLoading,
	isTriggering,
	isCancelling,
	error,
	notice,
	onTrigger,
	onCancel,
	onOpenTerminal,
}: {
	session: WorkspaceSession;
	config?: ProjectConfig;
	reviewStates: PRReviewState[];
	reviewerHandleId: string;
	isLoading: boolean;
	isTriggering: boolean;
	isCancelling: boolean;
	error: unknown;
	notice: string | null;
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
	const latest = openReviewStates.find((review) => review.latestRun)?.latestRun;
	const harness = latest?.harness || config?.reviewers?.[0]?.harness || "claude-code";
	const terminalEnabled = Boolean(reviewerHandleId && onOpenTerminal);
	const aggregateVerdict = sessionReviewVerdict(openReviewStates);
	const reviewRunning = openReviewStates.some((reviewState) => reviewState.status === "running");
	const runAction = reviewSessionRunAction(openReviewStates, isTriggering);
	const openReviewerTerminal = () => {
		if (!terminalEnabled) return;
		onOpenTerminal?.({ handleId: reviewerHandleId, harness });
	};
	const runDisabled =
		isTriggering ||
		openReviewStates.length === 0 ||
		openReviewStates.every((reviewState) => reviewState.status === "ineligible");

	return (
		<div className="flex flex-col gap-4">
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
			<div className="inline-flex min-w-0 items-center gap-2 font-mono text-control font-semibold text-foreground">
				<Shield aria-hidden="true" className="size-icon-lg shrink-0 text-passive" />
				<span className="min-w-0 truncate">{harness}</span>
				<span className="font-sans text-sm-md font-medium text-passive">reviewer</span>
			</div>
			<div className="flex flex-col gap-3 overflow-hidden rounded-lg border border-border bg-surface p-3 @max-[300px]/inspector:overflow-hidden">
				<div className="flex min-w-0 items-center justify-between gap-2.5 @max-[300px]/inspector:flex-col @max-[300px]/inspector:items-start">
					<span className="min-w-0 truncate text-xs font-semibold text-muted-foreground">Pull requests</span>
					<span
						className={cn(
							"inline-flex h-control-xs max-w-inspector-status-chip shrink-0 items-center gap-1 overflow-hidden truncate rounded-md px-2 text-2xs font-semibold leading-none @max-[300px]/inspector:max-w-full",
							reviewerStatusTone[aggregateVerdict.tone],
						)}
					>
						{aggregateVerdict.label}
					</span>
				</div>
				<div className="flex flex-col gap-0 overflow-hidden rounded-md border border-border bg-surface-faint">
					{openReviewStates.length === 0 ? (
						<p className={cn(inspectorEmptyClass, "p-3")}>No open pull requests to review.</p>
					) : null}
					{openReviewStates.map((reviewState) => (
						<ReviewStateRow key={`${reviewState.prUrl}:${reviewState.targetSha}`} reviewState={reviewState} />
					))}
				</div>
				<div className="grid grid-cols-2 gap-2.5 pt-1 has-[:only-child]:grid-cols-1 @max-[300px]/inspector:grid-cols-1">
					<button
						className={cn(
							"inline-flex h-control-xl min-w-0 items-center justify-center gap-2 overflow-hidden truncate rounded-md border px-2.5 text-xs font-semibold transition-[background,border-color,color] duration-fast hover:bg-interactive-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-icon-md [&_svg]:shrink-0",
							reviewRunning
								? "border-error/42 bg-error/10 text-error"
								: "border-success/42 bg-success/10 text-success-bright",
						)}
						disabled={reviewRunning ? isCancelling : runDisabled}
						onClick={reviewRunning ? onCancel : onTrigger}
						type="button"
					>
						{reviewRunning ? <X aria-hidden="true" /> : <Play aria-hidden="true" />}
						{reviewRunning ? (isCancelling ? "Cancelling..." : "Cancel review") : runAction}
					</button>
					<button
						className="inline-flex h-control-xl min-w-0 items-center justify-center gap-2 overflow-hidden truncate rounded-md border border-border bg-raised px-2.5 text-xs font-semibold text-muted-foreground transition-[background,border-color,color] duration-fast hover:bg-interactive-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-icon-md [&_svg]:shrink-0"
						disabled={!terminalEnabled}
						onClick={openReviewerTerminal}
						type="button"
					>
						<Terminal aria-hidden="true" />
						Open terminal
					</button>
				</div>
			</div>
		</div>
	);
}

function ReviewStateRow({ reviewState }: { reviewState: PRReviewState }) {
	const verdict = reviewVerdict(reviewState);
	const title = reviewState.title?.trim() || `PR #${reviewState.prNumber}`;
	return (
		<div
			className={cn(
				"grid min-h-row-md grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-0 border-b border-border bg-transparent p-3 last:border-b-0",
				reviewState.status === "ineligible" && "opacity-70",
			)}
		>
			<div className="inline-flex min-w-0 items-center gap-2">
				<span className={cn("size-dot-sm shrink-0 rounded-full", reviewerDotTone[verdict.tone])} />
				<div className="grid min-w-0 grid-cols-[auto_auto] items-baseline gap-x-1.5 gap-y-1 text-xs font-semibold text-foreground [&_svg]:hidden">
					<GitPullRequest aria-hidden="true" />
					<a
						className="col-span-full min-w-0 truncate no-underline hover:underline"
						href={reviewState.prUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						{title}
					</a>
					<span className="col-start-1 font-mono text-caption text-passive">#{reviewState.prNumber}</span>
				</div>
			</div>
			<span className={cn("whitespace-nowrap text-caption font-semibold", reviewerVerdictTone[verdict.tone])}>
				{verdict.label}
			</span>
		</div>
	);
}

function sessionReviewVerdict(reviewStates: PRReviewState[]): {
	label: string;
	tone: "neutral" | "running" | "success" | "danger";
} {
	if (reviewStates.some((reviewState) => reviewState.status === "running")) {
		return { label: "Reviewing...", tone: "running" };
	}
	if (reviewStates.some((reviewState) => reviewState.latestRun?.status === "failed")) {
		return { label: "Failed", tone: "danger" };
	}
	if (reviewStates.some((reviewState) => reviewState.latestRun?.status === "cancelled")) {
		return { label: "Cancelled", tone: "neutral" };
	}
	if (reviewStates.some((reviewState) => reviewState.status === "changes_requested")) {
		return { label: "Changes requested", tone: "danger" };
	}
	const eligibleReviews = reviewStates.filter((reviewState) => reviewState.status !== "ineligible");
	if (eligibleReviews.length > 0 && eligibleReviews.every((reviewState) => reviewState.status === "up_to_date")) {
		return { label: "Approved", tone: "success" };
	}
	return { label: "Not run", tone: "neutral" };
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

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
	return (
		<div className={kvRowClass}>
			<dt className={kvKeyClass}>{k}</dt>
			<dd className={cn(kvValueClass, mono && kvValueMonoClass)}>{v}</dd>
		</div>
	);
}
