import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	ArrowRight,
	Check,
	CircleAlert,
	ExternalLink,
	FlipHorizontal2,
	LoaderCircle,
	MessageSquareReply,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTerminalSession, type AttachableTerminal, type TerminalSessionState } from "../hooks/useTerminalSession";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { Theme } from "../stores/ui-store";
import {
	isOrchestratorSession,
	isSuggestionDiscussionSession,
	sessionNeedsAttention,
	type WorkspaceSession,
} from "../types/workspace";
import { XtermTerminal } from "./XtermTerminal";

export const REVIEW_TRANSLATOR_ISSUE_PREFIX = "ao-review-translator:";
const MAX_REVIEW_CARDS = 8;

export type ReviewTranslation = {
	sessionId: string;
	summary: string;
	question: string;
};

type ReviewCard = ReviewTranslation & {
	session: WorkspaceSession;
	reason: string;
};

type OrchestratorReviewBoardProps = {
	daemonReady: boolean;
	orchestrator: WorkspaceSession;
	sessions: WorkspaceSession[];
	theme: Theme;
};

const reviewPriority: Partial<Record<WorkspaceSession["status"], number>> = {
	needs_input: 0,
	changes_requested: 1,
	ci_failed: 2,
	no_signal: 3,
	review_pending: 4,
};

export function reviewCandidates(sessions: WorkspaceSession[]): WorkspaceSession[] {
	return sessions
		.filter(
			(session) =>
				!isOrchestratorSession(session) &&
				!isSuggestionDiscussionSession(session) &&
				!session.issueId?.startsWith(REVIEW_TRANSLATOR_ISSUE_PREFIX) &&
				sessionNeedsAttention(session),
		)
		.sort(
			(a, b) =>
				(reviewPriority[a.status] ?? 99) - (reviewPriority[b.status] ?? 99) ||
				Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
		)
		.slice(0, MAX_REVIEW_CARDS);
}

function fallbackTranslation(session: WorkspaceSession): ReviewTranslation & { reason: string } {
	if (session.activity?.state === "blocked") {
		return {
			sessionId: session.id,
			summary: "This task is stopped at a permission or approval choice.",
			question: "Can you open the task and choose whether the agent may continue?",
			reason: "Waiting at a protected control prompt",
		};
	}
	switch (session.status) {
		case "needs_input":
			return {
				sessionId: session.id,
				summary: "This agent has paused because it needs a decision or more direction.",
				question: "What should this agent do next?",
				reason: "Waiting for your direction",
			};
		case "changes_requested":
			return {
				sessionId: session.id,
				summary: "A reviewer asked for changes before this work can move forward.",
				question: "Should the agent address the review feedback now, or take a different route?",
				reason: "Review changes requested",
			};
		case "ci_failed":
			return {
				sessionId: session.id,
				summary: "One or more automated checks failed on this task.",
				question: "Do you want the agent to investigate and fix the failing checks?",
				reason: "Automated checks failed",
			};
		case "no_signal":
			return {
				sessionId: session.id,
				summary: "AO has not heard from this agent recently, so its progress is uncertain.",
				question: "Should we inspect this task now, or leave the agent running?",
				reason: "Agent signal is missing",
			};
		case "review_pending":
			return {
				sessionId: session.id,
				summary: "The work is waiting for review before it can continue.",
				question: "Would you like to inspect the work now, or keep waiting for review?",
				reason: "Review is pending",
			};
		default:
			return {
				sessionId: session.id,
				summary: "This task needs a quick human review before it continues.",
				question: "What would you like this agent to do next?",
				reason: "Human review requested",
			};
	}
}

function cleanTranslationText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.replace(/\s+/g, " ").trim();
	if (!clean) return undefined;
	return clean.slice(0, maxLength);
}

/** Parse the review helper's bounded, structured terminal response. */
export function parseReviewTranslations(lines: string[], batchId: string): ReviewTranslation[] {
	const transcript = lines.join("\n");
	const start = `AO_REVIEW_BOARD_${batchId}_START`;
	const end = `AO_REVIEW_BOARD_${batchId}_END`;
	let cursor = 0;
	let latest: ReviewTranslation[] = [];
	while (cursor < transcript.length) {
		const startAt = transcript.indexOf(start, cursor);
		if (startAt < 0) break;
		const bodyAt = startAt + start.length;
		const endAt = transcript.indexOf(end, bodyAt);
		if (endAt < 0) break;
		cursor = endAt + end.length;
		try {
			const body = transcript
				.slice(bodyAt, endAt)
				.trim()
				.replace(/^```(?:json)?\s*/i, "")
				.replace(/\s*```$/, "");
			const parsed = JSON.parse(body) as { items?: unknown[] };
			if (!Array.isArray(parsed.items)) continue;
			const items = parsed.items.flatMap((item) => {
				if (!item || typeof item !== "object") return [];
				const candidate = item as Record<string, unknown>;
				const sessionId = cleanTranslationText(candidate.sessionId, 120);
				const summary = cleanTranslationText(candidate.summary, 280);
				const question = cleanTranslationText(candidate.question, 240);
				return sessionId && summary && question ? [{ sessionId, summary, question }] : [];
			});
			if (items.length > 0) latest = items;
		} catch {
			// Agent terminal output can contain an echoed example before the real
			// result. Ignore malformed marker pairs and keep scanning for the latest.
		}
	}
	return latest;
}

function batchHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function reviewBatchId(candidates: WorkspaceSession[], refreshNonce: number): string {
	return batchHash(
		`${refreshNonce}|${candidates.map((session) => `${session.id}:${session.status}:${session.updatedAt}`).join("|")}`,
	);
}

export function reviewAgentPrompt(candidates: WorkspaceSession[], batchId: string): string {
	const facts = candidates.map((session) => ({
		sessionId: session.id,
		title: session.title.slice(0, 80),
		status: session.status,
		activity: session.activity?.state ?? "unknown",
		branch: session.branch.slice(0, 80),
		openPullRequests: session.prs.filter((pr) => pr.state === "open" || pr.state === "draft").length,
	}));
	return [
		"You are AO's small review translator. You do not implement work, edit files, run commands, or spawn agents.",
		"Orbit selected the worker tasks below from live status facts. Translate each into calm, simple English for a human decision board.",
		"For every item, write one short summary of what is happening and one direct question the user can answer.",
		"Do not invent technical details. Keep the summary under 220 characters and the question under 180 characters.",
		`Return only this marker, one JSON object, and the closing marker: AO_REVIEW_BOARD_${batchId}_START`,
		'{"items":[{"sessionId":"exact id","summary":"plain English","question":"one direct question"}]}',
		`AO_REVIEW_BOARD_${batchId}_END`,
		`Worker facts: ${JSON.stringify(facts)}`,
	].join("\n");
}

function newestReviewHelper(sessions: WorkspaceSession[]): WorkspaceSession | undefined {
	return sessions
		.filter(
			(session) =>
				session.issueId?.startsWith(REVIEW_TRANSLATOR_ISSUE_PREFIX) &&
				session.status !== "terminated" &&
				session.status !== "merged",
		)
		.sort((a, b) => Date.parse(b.createdAt ?? b.updatedAt) - Date.parse(a.createdAt ?? a.updatedAt))[0];
}

export function OrchestratorReviewBoard({
	daemonReady,
	orchestrator,
	sessions,
	theme,
}: OrchestratorReviewBoardProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const candidates = useMemo(() => reviewCandidates(sessions), [sessions]);
	const helper = useMemo(() => newestReviewHelper(sessions), [sessions]);
	const [refreshNonce, setRefreshNonce] = useState(0);
	const [transcriptLines, setTranscriptLines] = useState<string[]>([]);
	const [helperState, setHelperState] = useState<TerminalSessionState>("idle");
	const [helperError, setHelperError] = useState<string>();
	const [requestError, setRequestError] = useState<string>();
	const [isRequesting, setIsRequesting] = useState(false);
	const requestedBatchRef = useRef<string | undefined>(undefined);
	const batchId = useMemo(() => reviewBatchId(candidates, refreshNonce), [candidates, refreshNonce]);
	const prompt = useMemo(() => reviewAgentPrompt(candidates, batchId), [batchId, candidates]);
	const parsedItems = useMemo(
		() => parseReviewTranslations(transcriptLines, batchId),
		[batchId, transcriptLines],
	);
	const translatedItems = useMemo(() => {
		const candidateIds = new Set(candidates.map((candidate) => candidate.id));
		return parsedItems.filter((item) => candidateIds.has(item.sessionId));
	}, [candidates, parsedItems]);
	const translations = useMemo(
		() => new Map(translatedItems.map((item) => [item.sessionId, item])),
		[translatedItems],
	);
	const cards = useMemo<ReviewCard[]>(
		() =>
			candidates.map((session) => {
				const fallback = fallbackTranslation(session);
				const translated = translations.get(session.id);
				return translated ? { ...fallback, ...translated, session } : { ...fallback, session };
			}),
		[candidates, translations],
	);

	useEffect(() => {
		setTranscriptLines([]);
	}, [helper?.id]);

	useEffect(() => {
		if (candidates.length === 0 || !daemonReady || requestedBatchRef.current === batchId) return;
		const expectedIssueId = `${REVIEW_TRANSLATOR_ISSUE_PREFIX}${batchId}`;
		if (helper?.issueId === expectedIssueId) {
			requestedBatchRef.current = batchId;
			return;
		}
		requestedBatchRef.current = batchId;
		setIsRequesting(true);
		setRequestError(undefined);
		void (async () => {
			try {
				if (helper) {
					const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
						params: { path: { sessionId: helper.id } },
						body: { message: prompt },
					});
					if (error) throw new Error(apiErrorMessage(error, "Unable to refresh the review helper"));
				} else {
					const { error } = await apiClient.POST("/api/v1/sessions", {
						body: {
							projectId: orchestrator.workspaceId,
							kind: "worker",
							harness: orchestrator.provider,
							issueId: expectedIssueId,
							displayName: "Review helper",
							prompt,
							agentConfig: {
								reasoningEffort: "low",
							},
						},
					});
					if (error) throw new Error(apiErrorMessage(error, "Unable to start the review helper"));
				}
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			} catch (error) {
				requestedBatchRef.current = undefined;
				setRequestError(error instanceof Error ? error.message : "Unable to prepare the review");
			} finally {
				setIsRequesting(false);
			}
		})();
	}, [
		batchId,
		candidates.length,
		daemonReady,
		helper,
		orchestrator.provider,
		orchestrator.workspaceId,
		prompt,
		queryClient,
	]);

	const openTask = useCallback(
		(session: WorkspaceSession) =>
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: session.workspaceId, sessionId: session.id },
			}),
		[navigate],
	);

	const refresh = () => {
		requestedBatchRef.current = undefined;
		setTranscriptLines([]);
		setRefreshNonce(Date.now());
	};

	const helperReady = candidates.length > 0 && translations.size === candidates.length;
	const helperWorking =
		isRequesting ||
		Boolean(helper && !helperReady && !requestError && helperState !== "error" && helperState !== "exited");
	const allClear = candidates.length === 0;

	return (
		<div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
			{helper ? (
				<ReviewAgentBridge
					key={`${helper.id}:${helper.terminalHandleId ?? "starting"}`}
					daemonReady={daemonReady}
					helper={helper}
					onError={setHelperError}
					onStateChange={setHelperState}
					onTranscriptChange={setTranscriptLines}
					theme={theme}
				/>
			) : null}
			<div className="shrink-0 border-b border-border bg-surface/45 px-6 py-4">
				<div className="mx-auto flex max-w-5xl items-center gap-4">
					<div className="grid size-10 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
						<Sparkles className="size-5" aria-hidden="true" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="text-sm font-semibold text-foreground">Your review board</div>
						<div className="mt-0.5 text-xs text-muted-foreground">
							Orbit picked the tasks that need a human decision. A small review agent turns their status into one clear question.
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<span
							aria-live="polite"
							className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-caption font-medium text-muted-foreground"
							role="status"
						>
							{allClear || helperReady ? (
								<Check className="size-3.5 text-success" aria-hidden="true" />
							) : helperWorking ? (
								<LoaderCircle className="size-3.5 animate-spin text-accent" aria-hidden="true" />
							) : (
								<CircleAlert className="size-3.5 text-warning" aria-hidden="true" />
							)}
							{allClear
								? "All clear"
								: helperReady
									? "Review ready"
									: helperWorking
										? "Review agent thinking"
										: "Simple fallback"}
						</span>
						<button
							className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-caption font-semibold text-muted-foreground transition hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
							disabled={candidates.length === 0 || isRequesting}
							onClick={refresh}
							type="button"
						>
							<RefreshCw className={`size-3.5 ${isRequesting ? "animate-spin" : ""}`} aria-hidden="true" />
							Refresh
						</button>
					</div>
				</div>
				{requestError || helperError ? (
					<div className="mx-auto mt-3 max-w-5xl rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
						{requestError ?? helperError} The cards below remain usable with AO's status-based wording.
					</div>
				) : null}
			</div>

			<div className="min-h-0 flex-1 overflow-auto px-6 py-8">
				{cards.length === 0 ? (
					<div className="mx-auto grid min-h-72 max-w-xl place-items-center rounded-2xl border border-dashed border-border bg-surface/30 p-8 text-center">
						<div>
							<div className="mx-auto grid size-12 place-items-center rounded-full bg-success/10 text-success">
								<Check className="size-6" aria-hidden="true" />
							</div>
							<h2 className="mt-4 text-base font-semibold text-foreground">Nothing needs your answer</h2>
							<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
								Orbit will place a task here when an agent pauses, loses signal, fails checks, or receives review feedback.
							</p>
						</div>
					</div>
				) : (
					<div className="mx-auto flex min-h-full max-w-6xl flex-wrap content-center justify-center gap-5">
						{cards.map((card, index) => (
							<ReviewTaskCard card={card} index={index} key={card.sessionId} onOpenTask={openTask} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function ReviewTaskCard({
	card,
	index,
	onOpenTask,
}: {
	card: ReviewCard;
	index: number;
	onOpenTask: (session: WorkspaceSession) => void;
}) {
	const queryClient = useQueryClient();
	const [flipped, setFlipped] = useState(false);
	const [answer, setAnswer] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string>();
	const protectedPrompt = card.session.activity?.state === "blocked";

	const sendAnswer = async () => {
		const message = answer.trim();
		if (!message || isSending || protectedPrompt) return;
		setIsSending(true);
		setError(undefined);
		try {
			const { error: apiError } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: card.session.id } },
				body: { message },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Unable to send your answer"));
			setSent(true);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		} catch (sendError) {
			setError(sendError instanceof Error ? sendError.message : "Unable to send your answer");
		} finally {
			setIsSending(false);
		}
	};

	return (
		<article className="h-96 w-full max-w-sm [perspective:1200px]">
			<div
				className="relative h-full w-full transition-transform duration-500 [transform-style:preserve-3d] motion-reduce:transition-none"
				style={{ transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}
			>
				<div
					aria-hidden={flipped}
					className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-lg [backface-visibility:hidden]"
				>
					<div className="flex items-start gap-3">
						<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning/10 font-mono text-xs font-semibold text-warning">
							{String(index + 1).padStart(2, "0")}
						</span>
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm font-semibold text-foreground">{card.session.title}</div>
							<div className="mt-1 truncate text-caption text-muted-foreground">{card.reason}</div>
						</div>
					</div>

					<div className="mt-6">
						<div className="font-mono text-caption font-semibold uppercase tracking-wide-md text-muted-foreground">Summary</div>
						<p className="mt-2 text-sm leading-6 text-foreground/90">{card.summary}</p>
					</div>
					<div className="mt-5 rounded-xl border border-accent/20 bg-accent/8 p-4">
						<div className="font-mono text-caption font-semibold uppercase tracking-wide-md text-accent">Question for you</div>
						<p className="mt-2 text-base font-medium leading-6 text-foreground">{card.question}</p>
					</div>

					<button
						aria-label={`Flip ${card.session.title} to answer`}
						className="mt-auto inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background text-xs font-semibold text-foreground transition hover:bg-interactive-hover"
						onClick={() => setFlipped(true)}
						tabIndex={flipped ? -1 : 0}
						type="button"
					>
						<FlipHorizontal2 className="size-4" aria-hidden="true" />
						Flip to answer
					</button>
				</div>

				<div
					aria-hidden={!flipped}
					className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-accent/25 bg-surface p-5 shadow-lg [backface-visibility:hidden] [transform:rotateY(180deg)]"
				>
					<div className="flex items-start justify-between gap-3">
						<div>
							<div className="text-sm font-semibold text-foreground">Answer the agent</div>
							<div className="mt-1 text-caption text-muted-foreground">Your reply goes only to {card.session.title}.</div>
						</div>
						<button
							aria-label={`Flip ${card.session.title} back to summary`}
							className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-interactive-hover hover:text-foreground"
							onClick={() => setFlipped(false)}
							tabIndex={flipped ? 0 : -1}
							type="button"
						>
							<FlipHorizontal2 className="size-4" aria-hidden="true" />
						</button>
					</div>

					<div className="mt-4 rounded-lg border border-border bg-background/70 p-3 text-sm leading-5 text-foreground">
						{card.question}
					</div>

					{protectedPrompt ? (
						<div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
							This is a protected approval prompt. Open the task and choose there so AO never answers a permission dialog for you.
						</div>
					) : sent ? (
						<div className="mt-4 grid flex-1 place-items-center text-center">
							<div>
								<div className="mx-auto grid size-10 place-items-center rounded-full bg-success/10 text-success">
									<Check className="size-5" aria-hidden="true" />
								</div>
								<div className="mt-3 text-sm font-semibold text-foreground">Answer sent</div>
								<div className="mt-1 text-xs text-muted-foreground">The task can continue with your direction.</div>
							</div>
						</div>
					) : (
						<>
							<label className="mt-4 flex min-h-0 flex-1 flex-col text-caption font-semibold text-muted-foreground">
								Your answer
								<textarea
									className="mt-2 min-h-24 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal leading-5 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
									disabled={!flipped || isSending}
									onChange={(event) => setAnswer(event.target.value)}
									placeholder="Write a short decision or next step..."
									value={answer}
								/>
							</label>
							{error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
						</>
					)}

					<div className="mt-4 flex items-center gap-2">
						<button
							className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-semibold text-muted-foreground transition hover:bg-interactive-hover hover:text-foreground"
							onClick={() => onOpenTask(card.session)}
							tabIndex={flipped ? 0 : -1}
							type="button"
						>
							<ExternalLink className="size-3.5" aria-hidden="true" />
							Open task
						</button>
						{!protectedPrompt && !sent ? (
							<button
								className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
								disabled={!answer.trim() || isSending}
								onClick={() => void sendAnswer()}
								tabIndex={flipped ? 0 : -1}
								type="button"
							>
								{isSending ? (
									<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
								) : (
									<MessageSquareReply className="size-3.5" aria-hidden="true" />
								)}
								Send answer
								<ArrowRight className="size-3.5" aria-hidden="true" />
							</button>
						) : null}
					</div>
				</div>
			</div>
		</article>
	);
}

function ReviewAgentBridge({
	daemonReady,
	helper,
	onError,
	onStateChange,
	onTranscriptChange,
	theme,
}: {
	daemonReady: boolean;
	helper: WorkspaceSession;
	onError: (message: string | undefined) => void;
	onStateChange: (state: TerminalSessionState) => void;
	onTranscriptChange: (lines: string[]) => void;
	theme: Theme;
}) {
	const [terminal, setTerminal] = useState<AttachableTerminal | null>(null);
	const { attach, error, state } = useTerminalSession(helper, { daemonReady });

	useEffect(() => onStateChange(state), [onStateChange, state]);
	useEffect(() => onError(error), [error, onError]);
	useEffect(() => {
		if (!terminal) return undefined;
		return attach(terminal);
	}, [attach, terminal]);

	return (
		<div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] top-0 h-[1000px] w-[1200px] opacity-0">
			<XtermTerminal
				ariaLabel="Review helper terminal"
				fontSize={13}
				onError={(bridgeError) =>
					onError(bridgeError instanceof Error ? bridgeError.message : "Review helper terminal could not start")
				}
				onReady={setTerminal}
				onTranscriptChange={onTranscriptChange}
				theme={theme}
			/>
		</div>
	);
}
