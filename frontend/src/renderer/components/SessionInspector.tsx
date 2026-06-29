import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ArrowUpRight, GitPullRequest, Play, Shield, Terminal } from "lucide-react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { formatTimeCompact } from "../lib/format-time";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { prStatusRows, sessionPRDisplaySummaries, type PRDisplayTone } from "../lib/pr-display";
import type { SessionStatus, WorkspaceSession } from "../types/workspace";
import { sortedPRs, workerDisplayStatus } from "../types/workspace";
import { BrowserPanelView } from "./BrowserPanel";
import type { BrowserViewModel } from "../hooks/useBrowserView";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { PRAttentionPanel, PRSummaryMeta } from "./PRSummaryDisplay";

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

			<div className="session-inspector__body">
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
					<Row k="Agent" v={session.provider} mono />
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
					href={pr.htmlUrl || pr.url}
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
			<PRStatusStack className="mt-2" pr={pr} />
			<PRAttentionPanel pr={pr} />
		</div>
	);
}

function PRStatusStack({ className, pr }: { className?: string; pr: SessionPRSummary }) {
	return (
		<div className={cn("flex flex-col gap-0.5 font-mono text-[10.5px] leading-4", className)}>
			{prStatusRows(pr).map((row) => (
				<div key={row.key} className="min-w-0 truncate">
					<span className="text-passive">{row.label}</span>{" "}
					<span className={cn("font-medium", inspectorStatusToneClass(row.tone))}>{row.value}</span>
				</div>
			))}
		</div>
	);
}

function inspectorStatusToneClass(tone: PRDisplayTone): string {
	switch (tone) {
		case "success":
			return "text-success";
		case "warning":
			return "text-warning";
		case "error":
			return "text-error";
		case "neutral":
			return "text-muted-foreground";
		case "passive":
			return "text-passive";
	}
}

type TimelineTone = "now" | "good" | "warn" | "neutral";

function ActivityTimeline({ session }: { session: WorkspaceSession }) {
	const events: { tone: TimelineTone; node: ReactNode; ts: string | null }[] = [];
	const detail = activityDetail(session.status);

	events.push({
		tone: "now",
		node: (
			<>
				<span className="inspector-timeline__badge">
					<InspectorStatusPill session={session} />
				</span>
				{detail ? <span className="inspector-timeline__detail"> — {detail}</span> : null}
			</>
		),
		ts: formatTimeCompact(session.updatedAt),
	});

	for (const pr of sortedPRs(session)) {
		events.push({
			tone: "good",
			node: (
				<>
					Opened <b>PR #{pr.number}</b>
				</>
			),
			ts: null,
		});
	}

	events.push({
		tone: "neutral",
		node: <>Created worktree &amp; branch</>,
		ts: formatTimeCompact(session.createdAt ?? session.updatedAt),
	});

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

function activityDetail(status: SessionStatus): string | null {
	switch (status) {
		case "idle":
			return "Session idle";
		case "needs_input":
			return "Waiting for your input";
		case "no_signal":
			return "No recent agent signal";
		case "working":
			return null;
		default:
			return null;
	}
}

const STATUS_PILL: Record<
	ReturnType<typeof workerDisplayStatus> | "idle",
	{ label: string; tone: string; breathe: boolean }
> = {
	working: { label: "Working", tone: "var(--orange)", breathe: true },
	needs_you: { label: "Input needed", tone: "var(--amber)", breathe: false },
	ci_failed: { label: "CI failed", tone: "var(--red)", breathe: false },
	no_signal: { label: "No signal", tone: "var(--fg-muted)", breathe: false },
	mergeable: { label: "Ready", tone: "var(--green)", breathe: false },
	done: { label: "Done", tone: "var(--fg-muted)", breathe: false },
	unknown: { label: "Unknown", tone: "var(--fg-muted)", breathe: false },
	idle: { label: "Idle", tone: "var(--fg-muted)", breathe: false },
};

function InspectorStatusPill({ session }: { session: WorkspaceSession }) {
	const key = session.status === "idle" ? "idle" : workerDisplayStatus(session);
	const { label, tone, breathe } = STATUS_PILL[key];
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
	const harness = latest?.harness || config?.reviewers?.[0]?.harness || session.provider || "reviewer";
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
