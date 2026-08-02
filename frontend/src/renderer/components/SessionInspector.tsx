import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
	AlertTriangle,
	ArrowUpRight,
	ChevronDown,
	ChevronRight,
	Files as FilesIcon,
	GitPullRequest,
	Play,
	Shield,
	Terminal,
	Trash2,
	X,
} from "lucide-react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { formatTimeCompact } from "../lib/format-time";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { useSessionUsage, type SessionUsage } from "../hooks/useSessionUsage";
import { clearTerminateSessionState, useTerminateSession } from "../hooks/useTerminateSession";
import { prBrowserUrl, sessionPRDisplaySummaries } from "../lib/pr-display";
import { formatTokenCount } from "../lib/format-token-count";
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
import { CodexIcon } from "./icons";
import { SessionTerminationPopover } from "./SessionTerminationPopover";
import { Switch } from "./ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type ProjectConfig = components["schemas"]["ProjectConfig"];
type PRReviewState = components["schemas"]["PRReviewState"];
type ReviewsResponse = components["schemas"]["ListReviewsResponse"];
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

// The AO reviewer runs on a configurable harness; show its own mark where we
// have one (codex today) and fall back to the generic shield otherwise.
function ReviewerHarnessIcon({ harness, className }: { harness: string; className?: string }) {
	if (harness === "codex") {
		return <CodexIcon aria-hidden="true" className={className} />;
	}
	return <Shield aria-hidden="true" className={className} />;
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
	const view = viewProp ?? internalView;
	// Badge the Browser tab when a preview target arrived without us opening it.
	const browserUnseen = useUiStore((state) =>
		session ? Boolean(state.inspectorSessions[session.id]?.browserUnseen) : false,
	);
	const setView = (next: InspectorView) => {
		setInternalView(next);
		onViewChange?.(next);
		if (next === "files") onOpenFiles?.();
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
			<div className="flex h-inspector-tabs shrink-0 items-center gap-1 border-b border-border px-2.5" role="tablist">
				{VIEWS.map((entry) => (
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
	title: string;
}) {
	// Boxed sections match the settings page row surface (bg + radius) with the
	// uppercase muted kicker kept inside the card, as in the inspector refs.
	return (
		<section className={cn("mb-2.5 last:mb-0", className)} data-testid="inspector-section">
			<div className="overflow-hidden rounded-settings-row bg-settings-row px-3.5 py-3">
				<div className="mb-2 flex items-center justify-between gap-2 text-2xs font-bold uppercase tracking-settings-section text-settings-muted">
					<span>{title}</span>
					{action ?? null}
				</div>
				{children}
			</div>
		</section>
	);
}

function SummaryView({ session }: { session: WorkspaceSession }) {
	const query = useSessionScmSummary(session.id);
	const developerMode = useUiStore((state) => state.developerMode);
	const usageQuery = useSessionUsage(session.id, developerMode);
	const showUsage =
		developerMode &&
		!usageQuery.isLoading &&
		!usageQuery.isError &&
		hasMeaningfulSessionUsage(usageQuery.data);
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

			{showUsage && usageQuery.data ? (
				<Section title="Usage & cost">
					<UsageCostTelemetry usage={usageQuery.data} />
				</Section>
				) : null}

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

function UsageCostTelemetry({ usage }: { usage: SessionUsage }) {
	const totalTokens = usageTokenTotal(usage.totals);
	const coverageLabel = formatUsageCoverage(sessionUsageCoverage(usage));
	const collectionLabel = usageCollectionLabel(usage.collectionState);
	const warnings = usage.warnings.map(formatUsageWarning);
	const statusText = `${coverageLabel} · ${collectionLabel}`;
	const statusLabel = [
		`Usage coverage: ${coverageLabel}. Collection status: ${collectionLabel}.`,
		warnings.length > 0 ? `Warnings: ${warnings.join("; ")}.` : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<div>
			<div className="grid grid-cols-2 gap-4">
				<div className="min-w-0">
					<p className="text-2xs text-settings-muted">Total tokens</p>
					<p
						aria-label={
							totalTokens === null
								? "Total tokens unavailable"
								: `${totalTokens.toLocaleString("en-US")} total tokens. ${coverageLabel}`
						}
						className="mt-0.5 truncate font-mono text-md-sm font-medium text-settings-label"
						title={
							totalTokens === null
								? undefined
								: `${totalTokens.toLocaleString("en-US")} tokens · ${coverageLabel}`
						}
					>
						{totalTokens === null ? "No usage yet" : formatTelemetryTokenValue(totalTokens)}
					</p>
				</div>
				<div className="min-w-0 text-right">
					<p className="text-2xs text-settings-muted">Total cost</p>
					<Badge
						className="mt-0.5 bg-success/10 px-1.5 py-0.5 text-[9px] leading-none"
						title="Dollar cost support is coming soon."
						variant="success"
					>
						Coming soon
					</Badge>
				</div>
			</div>

			<div className="mt-3">
				<div
					className="rounded-lg border border-(--color-border-settings-input) bg-(--color-bg-settings-input) px-2.5 py-2.5"
					data-testid="session-usage-metrics"
				>
					<UsageMetrics totals={usage.totals} />
				</div>
			</div>

			{usage.harnesses.length > 0 ? (
				<div className="mt-3 border-t border-(--color-border-settings-input) pt-2">
					<div className="grid grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-2 px-1 pb-1 text-2xs text-settings-muted">
						<span>Agent</span>
						<span className="text-right">Tokens</span>
						<span className="text-right">Cost</span>
					</div>
					{usage.harnesses.map((harness, index) => (
						<UsageProviderRow
							harness={harness}
							key={`${harness.harness}:${harness.provider}:${index}`}
						/>
					))}
				</div>
			) : null}

			{warnings.length > 0 ? (
				<div
					aria-label={`Usage warnings: ${warnings.join("; ")}`}
					className="mt-2 flex items-start gap-1.5 border-t border-(--color-border-settings-input) pt-2 text-2xs text-settings-muted"
					role="status"
				>
					<AlertTriangle aria-hidden="true" className="mt-px size-3 shrink-0 text-warning" />
					<span>{warnings.join("; ")}</span>
				</div>
			) : null}

			<p
				aria-label={statusLabel}
				className="mt-2 border-t border-(--color-border-settings-input) pt-2 text-right text-2xs text-settings-muted"
			>
				<span>{statusText}</span>
				{usage.lastObservedAt ? <span>{` · Updated ${formatTimeCompact(usage.lastObservedAt)}`}</span> : null}
			</p>
		</div>
	);
}

function useHoverableUsagePopover() {
	const [open, setOpen] = useState(false);
	const openedByPointer = useRef(false);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const cancelOpen = () => {
		if (openTimer.current !== null) clearTimeout(openTimer.current);
		openTimer.current = null;
	};
	const cancelClose = () => {
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		closeTimer.current = null;
	};

	useEffect(
		() => () => {
			if (openTimer.current !== null) clearTimeout(openTimer.current);
			if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		},
		[],
	);

	return {
		open,
		openedByPointer,
		cancelClose,
		markKeyboardOpen: () => {
			openedByPointer.current = false;
		},
		markPointerOpen: () => {
			openedByPointer.current = true;
		},
		onOpenChange: (nextOpen: boolean) => {
			cancelOpen();
			cancelClose();
			setOpen(nextOpen);
		},
		scheduleClose: () => {
			cancelOpen();
			cancelClose();
			closeTimer.current = setTimeout(() => setOpen(false), 120);
		},
		scheduleOpen: () => {
			openedByPointer.current = true;
			cancelOpen();
			cancelClose();
			openTimer.current = setTimeout(() => setOpen(true), 220);
		},
	};
}

function UsageProviderRow({ harness }: { harness: SessionUsage["harnesses"][number] }) {
	const harnessName = formatHarnessName(harness.harness);
	const totalTokens = usageTokenTotal(harness.totals);
	const coverageLabel = formatUsageCoverage(usageTotalsCoverage(harness.totals));
	const peek = useHoverableUsagePopover();

	return (
		<Popover onOpenChange={peek.onOpenChange} open={peek.open}>
			<PopoverTrigger asChild>
				<button
					aria-label={`${harnessName} usage details, ${coverageLabel}`}
					className="grid w-full cursor-default grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-2 rounded-md px-1 py-2 text-left outline-none transition-colors hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:ring-1 focus-visible:ring-ring"
					onKeyDown={peek.markKeyboardOpen}
					onPointerDown={peek.markPointerOpen}
					onPointerEnter={peek.scheduleOpen}
					onPointerLeave={peek.scheduleClose}
					type="button"
				>
					<span className="min-w-0">
						<span className="block truncate text-sm-md text-settings-label">{harnessName}</span>
						<span className="block truncate text-2xs text-settings-muted">{formatProviderName(harness.provider)}</span>
					</span>
					<span
						className="text-right font-mono text-2xs text-settings-label"
						title={
							totalTokens === null
								? undefined
								: `${totalTokens.toLocaleString("en-US")} tokens · ${coverageLabel}`
						}
					>
						{totalTokens === null ? "—" : formatTelemetryTokenValue(totalTokens)}
					</span>
					<span
						aria-label="Cost: Coming soon"
						className="text-right text-2xs text-settings-muted"
						title="Cost coming soon"
					>
						Coming soon
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				aria-label={`${harnessName} usage peek`}
				className="w-80 max-w-[calc(100vw-1rem)] p-3"
				onCloseAutoFocus={(event) => {
					if (peek.openedByPointer.current) event.preventDefault();
				}}
				onOpenAutoFocus={(event) => {
					if (peek.openedByPointer.current) event.preventDefault();
				}}
				onPointerEnter={peek.cancelClose}
				onPointerLeave={peek.scheduleClose}
				role="region"
				side="left"
			>
				<ProviderUsagePeek harness={harness} onRequestClose={() => peek.onOpenChange(false)} />
			</PopoverContent>
		</Popover>
	);
}

function ProviderUsagePeek({
	harness,
	onRequestClose,
}: {
	harness: SessionUsage["harnesses"][number];
	onRequestClose: () => void;
}) {
	const harnessName = formatHarnessName(harness.harness);
	const totalTokens = usageTokenTotal(harness.totals);
	const coverageLabel = formatUsageCoverage(usageTotalsCoverage(harness.totals));
	const [activeModelKey, setActiveModelKey] = useState<string | null>(null);

	return (
		<div>
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<p className="truncate text-sm-md font-semibold text-settings-label">{harnessName}</p>
					<p className="truncate text-2xs text-settings-muted">{formatProviderName(harness.provider)}</p>
				</div>
				<div className="shrink-0 text-right text-2xs">
					<p className="font-mono text-settings-label">
						{totalTokens === null ? "—" : formatTelemetryTokenValue(totalTokens)}
					</p>
					<p className="text-settings-muted">Coming soon</p>
					<p className="text-settings-muted">{coverageLabel}</p>
				</div>
			</div>

			<div className="mt-3 border-t border-border pt-3">
				<UsageMetrics totals={harness.totals} />
			</div>

			<div className="mt-3 border-t border-border pt-2">
				<div className="grid grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-2 px-1 pb-1 text-2xs text-settings-muted">
					<span>{formatCount(harness.models.length, "model")}</span>
					<span className="text-right">Tokens</span>
					<span className="text-right">Cost</span>
				</div>
				{harness.models.length > 0 ? (
					harness.models.map((model, index) => {
						const modelKey = `${model.provider}:${model.modelId}:${index}`;
						return (
							<UsageModelRow
								active={activeModelKey === modelKey}
								key={modelKey}
								model={model}
								onActiveChange={(active) => setActiveModelKey(active ? modelKey : null)}
								onRequestClose={onRequestClose}
							/>
						);
					})
				) : (
					<p className="px-1 py-2 text-2xs text-settings-muted">No model telemetry available.</p>
				)}
			</div>
		</div>
	);
}

function UsageModelRow({
	active,
	model,
	onActiveChange,
	onRequestClose,
}: {
	active: boolean;
	model: SessionUsage["harnesses"][number]["models"][number];
	onActiveChange: (active: boolean) => void;
	onRequestClose: () => void;
}) {
	const modelName = model.modelId || formatProviderName(model.provider);
	const totalTokens = usageTokenTotal(model.totals);
	const coverageLabel = formatUsageCoverage(usageTotalsCoverage(model.totals));
	const detailID = useId();

	return (
		<Tooltip delayDuration={0} onOpenChange={onActiveChange} open={active}>
			<TooltipTrigger asChild>
				<button
					aria-controls={detailID}
					aria-expanded={active}
					aria-label={`${modelName} usage details, ${coverageLabel}`}
					className="grid w-full cursor-default grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-2 rounded-md px-1 py-2 text-left outline-none transition-colors hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:ring-1 focus-visible:ring-ring"
					type="button"
				>
					<span className="min-w-0 truncate font-mono text-2xs text-settings-label">{modelName}</span>
					<span
						className="text-right font-mono text-2xs text-settings-label"
						title={
							totalTokens === null
								? undefined
								: `${totalTokens.toLocaleString("en-US")} tokens · ${coverageLabel}`
						}
					>
						{totalTokens === null ? "—" : formatTelemetryTokenValue(totalTokens)}
					</span>
					<span
						aria-label="Cost: Coming soon"
						className="text-right text-2xs text-settings-muted"
						title="Cost coming soon"
					>
						Coming soon
					</span>
				</button>
			</TooltipTrigger>
			<TooltipContent
				align="start"
				aria-label={`${modelName} detailed token usage`}
				className="w-80 max-w-[calc(100vw-1rem)] p-3 text-left text-popover-foreground"
				onEscapeKeyDown={onRequestClose}
				side="left"
				sideOffset={8}
			>
				<div
					aria-label={`${modelName} usage peek`}
					id={detailID}
					role="region"
				>
					<div className="mb-3 flex items-start justify-between gap-4">
						<div className="min-w-0">
							<p className="truncate font-mono text-sm-md font-semibold text-settings-label">{modelName}</p>
							<p className="truncate text-2xs text-settings-muted">{formatProviderName(model.provider)}</p>
						</div>
						<div className="shrink-0 text-right text-2xs">
							<p className="font-mono text-settings-label">
								{totalTokens === null ? "—" : formatTelemetryTokenValue(totalTokens)}
							</p>
							<p className="text-settings-muted">Coming soon</p>
							<p className="text-settings-muted">{coverageLabel}</p>
						</div>
					</div>
					<div className="border-t border-border pt-3">
						<UsageMetrics totals={model.totals} />
					</div>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

function UsageMetrics({ totals }: { totals: SessionUsage["totals"] }) {
	return (
		<dl className="grid grid-cols-2 gap-x-4 gap-y-2 @max-[300px]/inspector:grid-cols-1">
			<UsageMetric label="Input tokens" metric={totals.inputTokens} />
			<UsageMetric label="Output tokens" metric={totals.outputTokens} />
			<UsageMetric label="Cache read tokens" metric={totals.cacheReadTokens} />
			<UsageMetric label="Cache write tokens" metric={totals.cacheWriteTokens} />
			<UsageMetric label="Reasoning tokens" metric={totals.reasoningTokens} />
			<UsageMetric label="Uncached input tokens" metric={totals.uncachedInputTokens} />
		</dl>
	);
}

function UsageMetric({
	label,
	metric,
}: {
	label: string;
	metric: SessionUsage["totals"]["inputTokens"];
}) {
	const coverageLabel = formatUsageCoverage(metric.coverage);
	const accessibleLabel =
		metric.value === null
			? `${label}: telemetry unavailable`
			: `${label}: ${metric.value.toLocaleString("en-US")} tokens. ${coverageLabel}`;
	return (
		<div className="min-w-0">
			<dt className="truncate text-2xs text-settings-muted">{label}</dt>
			<dd
				aria-label={accessibleLabel}
				className="mt-0.5 truncate font-mono text-sm-md text-settings-label"
				title={
					metric.value === null
						? `${label} telemetry unavailable`
						: `${metric.value.toLocaleString("en-US")} tokens · ${coverageLabel}`
				}
			>
				{metric.value === null ? "—" : formatTelemetryTokenValue(metric.value)}
			</dd>
		</div>
	);
}

const usageMetricKeys = [
	"inputTokens",
	"uncachedInputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"outputTokens",
	"reasoningTokens",
] as const;

type UsageCoverage = SessionUsage["totals"]["inputTokens"]["coverage"];

function usageScopes(usage: SessionUsage): SessionUsage["totals"][] {
	return [
		usage.totals,
		...usage.harnesses.flatMap((harness) => [
			harness.totals,
			...harness.models.map((model) => model.totals),
		]),
	];
}

function hasMeaningfulSessionUsage(usage?: SessionUsage): usage is SessionUsage {
	if (!usage) return false;
	return usageScopes(usage).some((totals) =>
		usageMetricKeys.some((key) => (totals[key].value ?? 0) > 0),
	);
}

function usageTotalsCoverage(totals: SessionUsage["totals"]): UsageCoverage {
	const metrics = usageMetricKeys.map((key) => totals[key]);
	if (metrics.some((metric) => metric.coverage === "partial")) return "partial";
	const available = metrics.filter((metric) => metric.value !== null);
	if (available.length === 0) return "unavailable";
	return available.every((metric) => metric.coverage === "complete") ? "complete" : "partial";
}

function sessionUsageCoverage(usage: SessionUsage): UsageCoverage {
	const scopeCoverage = usageScopes(usage).map(usageTotalsCoverage);
	if (
		usage.warnings.length > 0 ||
		usage.collectionState === "collecting" ||
		usage.collectionState === "partial" ||
		scopeCoverage.includes("partial")
	) {
		return "partial";
	}
	if (scopeCoverage.includes("complete")) return "complete";
	return "unavailable";
}

function formatUsageCoverage(coverage: UsageCoverage): string {
	switch (coverage) {
		case "complete":
			return "Complete coverage";
		case "partial":
			return "Partial coverage";
		default:
			return "Coverage unavailable";
	}
}

function formatUsageWarning(warning: string): string {
	const text = warning.replaceAll("_", " ").trim();
	if (!text) return "Usage warning";
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatTelemetryTokenValue(totalTokens: number): string {
	return formatTokenCount(totalTokens).replace(/ tok$/, "");
}

function usageTokenTotal(totals: SessionUsage["totals"]): number | null {
	if (totals.inputTokens.value === null && totals.outputTokens.value === null) return null;
	return (totals.inputTokens.value ?? 0) + (totals.outputTokens.value ?? 0);
}

function formatCount(value: number, noun: string): string {
	return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function formatHarnessName(harness: string): string {
	const knownNames: Record<string, string> = {
		"claude-code": "Claude",
		claude: "Claude",
		codex: "Codex",
		glm: "GLM",
		kimi: "Kimi",
	};
	if (knownNames[harness]) return knownNames[harness];
	return harness
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function formatProviderName(provider: string): string {
	const knownNames: Record<string, string> = {
		anthropic: "Anthropic",
		openai: "OpenAI",
	};
	if (!provider) return "Unknown provider";
	if (knownNames[provider]) return knownNames[provider];
	return formatHarnessName(provider);
}

function usageCollectionLabel(state: SessionUsage["collectionState"]): string {
	switch (state) {
		case "waiting":
			return "Waiting";
		case "collecting":
			return "Collecting";
		case "complete":
			return "Collection complete";
		case "partial":
			return "Collection partial";
		default:
			return "Unavailable";
	}
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
			{/* AO code reviews lead: the flow is run AO review first, then raise the PR for others. */}
			<Section title="AO code reviews">
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

// One expandable PR row for AO review state. The header carries PR identity and
// update context; verdicts live in the expanded row below.
function ReviewDisclosure({
	title,
	meta,
	defaultOpen,
	children,
}: {
	title: string;
	meta: string;
	defaultOpen: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="py-2 first:pt-0.5 last:pb-0.5">
			<button
				aria-expanded={open}
				className="-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-interactive-hover/30"
				onClick={() => setOpen((current) => !current)}
				type="button"
			>
				{open ? (
					<ChevronDown className="size-icon-sm shrink-0 text-passive" aria-hidden="true" />
				) : (
					<ChevronRight className="size-icon-sm shrink-0 text-passive" aria-hidden="true" />
				)}
				<span className="min-w-0 flex-1 truncate text-sm-md font-semibold text-foreground">{title}</span>
				<span className="shrink-0 font-mono text-2xs text-passive">{meta}</span>
			</button>
			{open ? <div className="ml-2 mt-2.5 flex flex-col gap-4 border-l border-border/60 pl-3.5">{children}</div> : null}
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
	const reviewRunning = openReviewStates.some((reviewState) => reviewState.status === "running");
	const reviewHasRun = reviewRunning || Boolean(latest);
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
			<p className={cn(inspectorEmptyClass, "inline-flex min-w-0 items-center gap-1.5")}>
				<ReviewerHarnessIcon className="size-icon-sm shrink-0 text-passive" harness={harness} />
				<span className="truncate font-mono font-medium text-foreground">{harness}</span>
			</p>
			<div className="flex flex-col divide-y divide-border">
				{openReviewStates.length === 0 ? (
					<p className={cn(inspectorEmptyClass, "py-1")}>No open pull requests to review.</p>
				) : (
					openReviewStates.map((reviewState, index) => (
						<ReviewDisclosure
							key={`${reviewState.prUrl}:${reviewState.targetSha}`}
							defaultOpen={index === 0}
							meta={aoReviewMeta(reviewState)}
							title={reviewState.title?.trim() || `PR #${reviewState.prNumber}`}
						>
							<AoReviewRow reviewState={reviewState} />
						</ReviewDisclosure>
					))
				)}
			</div>
			<div className="-mx-4 -mb-3 mt-3 flex items-center justify-center gap-1 border-t border-border px-4 pb-3 pt-3">
				<Button
					className={cn("gap-1.5 [&_svg]:size-icon-sm", reviewRunning ? "text-error" : "text-success")}
					disabled={reviewRunning ? isCancelling : runDisabled}
					onClick={reviewRunning ? onCancel : onTrigger}
					size="sm"
					type="button"
					variant="ghost"
				>
					{reviewRunning ? <X aria-hidden="true" /> : <Play aria-hidden="true" />}
					{reviewRunning ? (isCancelling ? "Cancelling..." : "Cancel review") : runAction}
				</Button>
				{reviewHasRun ? (
					<Button
						className="gap-1.5 [&_svg]:size-icon-sm"
						disabled={!terminalEnabled}
						onClick={openReviewerTerminal}
						size="sm"
						type="button"
						variant="ghost"
					>
						<Terminal aria-hidden="true" />
						Open terminal
					</Button>
				) : null}
			</div>
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
	const verdict = displayRun ? runReviewVerdict(displayRun) : reviewVerdict(reviewState);
	const summary = displayRun?.body?.trim();
	const reviewUrl = aoReviewCommentUrl(displayRun);
	const reviewLinkLabel = reviewState.latestRun ? "View review" : "View previous review";
	return (
		<div className={cn("flex min-w-0 flex-col gap-2", reviewState.status === "ineligible" && "opacity-70")}>
			<VerdictBadge label={verdict.label} tone={verdict.tone} />
			{summary ? <p className="whitespace-pre-wrap break-words text-2xs leading-relaxed text-passive">{summary}</p> : null}
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
