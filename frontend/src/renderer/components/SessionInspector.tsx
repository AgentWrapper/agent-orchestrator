import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, GitPullRequest, Play, Shield, Terminal } from "lucide-react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { formatTimeCompact } from "../lib/format-time";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { prBrowserUrl, sessionPRDisplaySummaries } from "../lib/pr-display";
import type { SessionActivityState, WorkspaceSession } from "../types/workspace";
import { canonicalTrackerIssueId, sortedPRs } from "../types/workspace";
import { useAgentsQuery } from "../hooks/useAgentsQuery";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { BrowserPanelView } from "./BrowserPanel";
import type { BrowserViewModel } from "../hooks/useBrowserView";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { PRSummaryMeta, PRSummaryParts } from "./PRSummaryDisplay";

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

/**
 * Tabbed inspector rail beside the terminal (Summary · Reviews · Browser).
 */
export function SessionInspector({
	session,
	onOpenReviewerTerminal,
	browserPoppedOut = false,
	isInspectorVisible = true,
	onToggleBrowserPopOut,
	browserView,
	view: viewProp,
	onViewChange,
}: {
	session?: WorkspaceSession;
	onOpenReviewerTerminal?: OpenReviewerTerminal;
	browserPoppedOut?: boolean;
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
			<aside className="session-inspector" aria-label="Session inspector">
				<div className="session-inspector__body">
					<p className="inspector-empty">Loading session…</p>
				</div>
			</aside>
		);
	}

	return (
		<aside className="session-inspector" aria-label="Session inspector">
			<div className="session-inspector__tabs" role="tablist">
				{VIEWS.map((entry) => (
					<button
						key={entry.id}
						type="button"
						role="tab"
						aria-selected={view === entry.id}
						className={cn("session-inspector__tab", view === entry.id && "is-active")}
						onClick={() => setView(entry.id)}
					>
						<span className="session-inspector__tab-icon">{entry.icon}</span>
						<span className="session-inspector__tab-label">{entry.label}</span>
					</button>
				))}
			</div>

			<div
				className={cn(
					"session-inspector__body",
					// The Browser tab renders its own bordered panel edge-to-edge, so
					// drop the body padding for it (except when popped out, where the
					// body only holds the "return to panel" empty state).
					view === "browser" && !browserPoppedOut && "session-inspector__body--browser",
				)}
			>
				{view === "summary" ? <SummaryView session={session} /> : null}
				{view === "reviews" ? <ReviewsView onOpenReviewerTerminal={onOpenReviewerTerminal} session={session} /> : null}
				{view === "browser" ? (
					<BrowserView
						browserPoppedOut={browserPoppedOut}
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
		<section className={cn("inspector-section", className)}>
			<div className="inspector-section__head">
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
					<p className="inspector-empty">No pull request opened yet.</p>
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

			<Section className="inspector-section--separated" title="Overview">
				<dl className="inspector-kv">
					<AgentRow session={session} />
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
		<div className="rounded-[7px] border border-border bg-surface px-3 py-2.5">
			<div className="flex items-center gap-2">
				<GitPullRequest className="h-3.5 w-3.5 shrink-0 text-passive" aria-hidden="true" />
				<span className="text-[12.5px] font-medium text-foreground">PR #{pr.number}</span>
				<Badge variant="outline" className={cn("h-5 px-1.5 text-[10px] font-medium", prStateTone[pr.state])}>
					{pr.state}
				</Badge>
				<a
					href={prBrowserUrl(pr)}
					target="_blank"
					rel="noopener noreferrer"
					className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-medium text-accent hover:underline"
				>
					<span>Open</span>
					<ArrowUpRight aria-hidden="true" className="h-3 w-3" strokeWidth={2} />
				</a>
			</div>
			{pr.title ? <div className="mt-2 text-[12px] font-medium leading-snug text-foreground">{pr.title}</div> : null}
			<PRSummaryMeta className="mt-1.5" pr={pr} />
			<PRSummaryParts className="mt-2" pr={pr} variant="stacked" />
		</div>
	);
}

type TimelineTone = "now" | "good" | "warn" | "neutral";

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
				<span className="inspector-timeline__badge">
					<InspectorActivityPill state={session.activity?.state ?? "unknown"} />
				</span>
				{session.status === "no_signal" ? (
					<span className="inspector-timeline__badge">
						<TimelinePill {...ACTIVITY_WARNING_PILL.no_signal} />
					</span>
				) : null}
				{scmTimelineStates(session).map((state) => (
					<span key={state} className="inspector-timeline__badge">
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
		<div className="inspector-timeline">
			{events.map((event, index) => (
				<div
					key={index}
					className={cn(
						"inspector-timeline__ev",
						event.tone === "now" && "inspector-timeline__ev--now",
						event.tone === "good" && "inspector-timeline__ev--good",
						event.tone === "warn" && "inspector-timeline__ev--warn",
					)}
				>
					<span className="inspector-timeline__node" aria-hidden="true" />
					<div className="inspector-timeline__et">{event.node}</div>
					{event.ts ? <div className="inspector-timeline__ets">{event.ts}</div> : null}
				</div>
			))}
		</div>
	);
}

const ACTIVITY_PILL: Record<SessionActivityState, { label: string; tone: string; breathe: boolean }> = {
	active: { label: "Working", tone: "var(--orange)", breathe: true },
	idle: { label: "Idle", tone: "var(--fg-muted)", breathe: false },
	waiting_input: { label: "Input Needed", tone: "var(--amber)", breathe: false },
	exited: { label: "Exited", tone: "var(--fg-muted)", breathe: false },
	unknown: { label: "Activity Unavailable", tone: "var(--fg-muted)", breathe: false },
};

const ACTIVITY_WARNING_PILL: Record<"no_signal", { label: string; tone: string; breathe: boolean }> = {
	no_signal: { label: "No Signal", tone: "var(--fg-muted)", breathe: false },
};

type ScmTimelineState = "ci_failed" | "changes_requested" | "conflict";

const SCM_PILL: Record<ScmTimelineState, { label: string; tone: string; breathe: boolean }> = {
	ci_failed: { label: "CI Failed", tone: "var(--red)", breathe: false },
	changes_requested: { label: "Changes Requested", tone: "var(--amber)", breathe: false },
	conflict: { label: "Conflict", tone: "var(--red)", breathe: false },
};

function InspectorActivityPill({ state }: { state: SessionActivityState }) {
	return <TimelinePill {...ACTIVITY_PILL[state]} />;
}

function InspectorScmPill({ state }: { state: ScmTimelineState }) {
	return <TimelinePill {...SCM_PILL[state]} />;
}

function TimelinePill({ label, tone, breathe }: { label: string; tone: string; breathe: boolean }) {
	return (
		<span
			className="inline-flex shrink-0 items-center gap-[7px] whitespace-nowrap rounded-[7px] px-[11px] py-[5px] text-[11.5px] font-semibold"
			style={{
				color: tone,
				background: `color-mix(in srgb, ${tone} 7%, transparent)`,
				boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone} 25%, transparent)`,
			}}
		>
			<span
				className={cn("h-1.5 w-1.5 rounded-full", breathe && "animate-status-pulse")}
				style={{ background: tone }}
			/>
			{label}
		</span>
	);
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
	const reviewStates = reviewsQuery.data?.reviews ?? [];

	return (
		<div role="tabpanel">
			<Section title="Reviews">
				<ReviewPanel
					config={projectConfigQuery.data}
					error={reviewsQuery.error ?? triggerReview.error}
					isLoading={reviewsQuery.isLoading}
					isTriggering={triggerReview.isPending}
					onOpenTerminal={onOpenReviewerTerminal}
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
	error,
	notice,
	onTrigger,
	onOpenTerminal,
}: {
	session: WorkspaceSession;
	config?: ProjectConfig;
	reviewStates: PRReviewState[];
	reviewerHandleId: string;
	isLoading: boolean;
	isTriggering: boolean;
	error: unknown;
	notice: string | null;
	onTrigger: () => void;
	onOpenTerminal?: OpenReviewerTerminal;
}) {
	if (sortedPRs(session).length === 0) {
		return <p className="inspector-empty">No pull request opened yet.</p>;
	}
	if (isLoading) {
		return <p className="inspector-empty">Loading reviews...</p>;
	}

	const latest = reviewStates.find((review) => review.latestRun)?.latestRun;
	const harness = latest?.harness || config?.reviewers?.[0]?.harness || "claude-code";
	const terminalEnabled = Boolean(reviewerHandleId && onOpenTerminal);
	const aggregateVerdict = sessionReviewVerdict(reviewStates);
	const runAction = reviewSessionRunAction(reviewStates, isTriggering);
	const runDisabled =
		isTriggering ||
		reviewStates.length === 0 ||
		reviewStates.some((reviewState) => reviewState.status === "running") ||
		reviewStates.every((reviewState) => reviewState.status === "ineligible");

	return (
		<div className="reviewer-list">
			{error ? <p className="reviewer-error">{apiErrorMessage(error, "Review request failed")}</p> : null}
			{notice ? <p className="reviewer-notice">{notice}</p> : null}
			<div className="reviewer-kicker">
				<Shield aria-hidden="true" />
				<span>{harness}</span>
				<span>reviewer</span>
			</div>
			<div className="reviewer-card">
				<div className="reviewer-card__top">
					<span className="reviewer-card__label">Pull requests</span>
					<span className={cn("reviewer-status", `reviewer-status--${aggregateVerdict.tone}`)}>
						{aggregateVerdict.label}
					</span>
				</div>
				<div className="reviewer-summary-list">
					{reviewStates.length === 0 ? <p className="inspector-empty">No review state loaded yet.</p> : null}
					{reviewStates.map((reviewState) => (
						<ReviewStateRow key={`${reviewState.prUrl}:${reviewState.targetSha}`} reviewState={reviewState} />
					))}
				</div>
				<div className="reviewer-card__actions">
					<button
						className="reviewer-card__action reviewer-card__action--primary"
						disabled={runDisabled}
						onClick={onTrigger}
						type="button"
					>
						<Play aria-hidden="true" />
						{runAction}
					</button>
					<button
						className="reviewer-card__action"
						disabled={!terminalEnabled}
						onClick={() => {
							if (!terminalEnabled) return;
							onOpenTerminal?.({ handleId: reviewerHandleId, harness });
						}}
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
				"reviewer-row",
				`reviewer-row--${verdict.tone}`,
				reviewState.status === "ineligible" && "opacity-70",
			)}
		>
			<div className="reviewer-row__main">
				<span className={cn("reviewer-row__dot", `reviewer-row__dot--${verdict.tone}`)} />
				<div className="reviewer-row__copy">
					<GitPullRequest aria-hidden="true" />
					<a href={reviewState.prUrl} target="_blank" rel="noopener noreferrer">
						{title}
					</a>
					<span className="reviewer-row__number">#{reviewState.prNumber}</span>
				</div>
			</div>
			<span className={cn("reviewer-row__verdict", `reviewer-row__verdict--${verdict.tone}`)}>{verdict.label}</span>
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
	onTogglePopOut,
	browserView,
}: {
	session: WorkspaceSession;
	isActive: boolean;
	browserPoppedOut: boolean;
	onTogglePopOut?: (next: boolean) => void;
	browserView?: BrowserViewModel;
}) {
	if (browserPoppedOut) {
		return (
			<div role="tabpanel">
				<div className="inspector-empty inspector-empty--browser">
					<p>Browser preview is in the center pane.</p>
					<Button onClick={() => onTogglePopOut?.(false)} size="sm" type="button" variant="outline">
						Return to panel
					</Button>
				</div>
			</div>
		);
	}

	if (!browserView) {
		return null;
	}

	return (
		<BrowserPanelView
			active={isActive}
			browserView={browserView}
			onTogglePopOut={(next) => onTogglePopOut?.(next)}
			poppedOut={false}
			session={session}
		/>
	);
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
	return (
		<div className="inspector-kv__row">
			<dt className="inspector-kv__k">{k}</dt>
			<dd className={cn("inspector-kv__v", mono && "inspector-kv__v--mono")}>{v}</dd>
		</div>
	);
}

// The Overview "Agent" row, made switchable: an active session's agent can be
// swapped in place from the same field that displays it. Terminated sessions
// render the plain value (switching a dead session is a restore, not a swap).
// Selecting a new harness fires POST /sessions/{id}/switch; the worktree and
// its work are preserved and the new agent starts fresh. The workspace query is
// invalidated so the terminal re-attaches to the new runtime handle over CDC.
function AgentRow({ session }: { session: WorkspaceSession }) {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);
	const current = session.provider;
	// Only offer agents whose local auth probe recently passed — switching to an
	// un-authenticated agent just fails at launch. Advisory (spawn stays the
	// authoritative check), but it keeps the menu to agents that can actually run.
	const agentsQuery = useAgentsQuery();
	const authorized = agentsQuery.data?.authorized ?? [];

	const switchAgent = useMutation({
		mutationFn: async (harness: string) => {
			const { error: apiError } = await apiClient.POST("/api/v1/sessions/{sessionId}/switch", {
				params: { path: { sessionId: session.id } },
				body: { harness },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
		},
		onSuccess: () => {
			setError(null);
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
		onError: (e) => setError(e instanceof Error ? e.message : "Switch failed"),
	});

	// A merged session is finished for good — no switch/relaunch. Every other
	// state (live, or terminated because the agent exited) can be re-pointed at a
	// new agent: live swaps in place, terminated relaunches under the new agent.
	if (session.status === "merged") {
		return <Row k="Agent" v={current} mono />;
	}

	return (
		<div className="inspector-kv__row">
			<dt className="inspector-kv__k">Agent</dt>
			<dd className={cn("inspector-kv__v", "inspector-kv__v--mono")}>
				<DropdownMenu>
					<DropdownMenuTrigger
						aria-label="Switch agent"
						className="group -mx-1.5 inline-flex items-center gap-1.5 rounded-[5px] border border-transparent px-1.5 py-0.5 text-left outline-none transition-colors hover:border-border hover:bg-surface focus-visible:border-border focus-visible:bg-surface disabled:opacity-60"
						disabled={switchAgent.isPending}
						title="Switch agent"
					>
						<span>{switchAgent.isPending ? "Switching…" : current}</span>
						<ChevronDown
							aria-hidden="true"
							className="h-3 w-3 shrink-0 text-passive transition-colors group-hover:text-foreground"
							strokeWidth={2}
						/>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
						{authorized.length === 0 ? (
							<DropdownMenuItem disabled>
								<span className="text-[12px] text-passive">
									{agentsQuery.isLoading ? "Loading agents…" : "No authenticated agents"}
								</span>
							</DropdownMenuItem>
						) : (
							authorized.map((agent) => (
								<DropdownMenuItem
									key={agent.id}
									disabled={switchAgent.isPending}
									onSelect={() => {
										if (agent.id !== current) switchAgent.mutate(agent.id);
									}}
								>
									<Check
										className={cn("h-3.5 w-3.5", agent.id === current ? "opacity-100" : "opacity-0")}
										aria-hidden="true"
									/>
									<span className="font-mono text-[12px]">{agent.id}</span>
								</DropdownMenuItem>
							))
						)}
					</DropdownMenuContent>
				</DropdownMenu>
				{error ? (
					<span className="mt-1 block text-[11px] font-normal text-[color:var(--status-fail,#ef6b6b)]" role="alert">
						{error}
					</span>
				) : null}
			</dd>
		</div>
	);
}
