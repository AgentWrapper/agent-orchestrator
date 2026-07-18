import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	CircleAlert,
	LoaderCircle,
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
	isReviewTranslatorSession,
	isSuggestionDiscussionSession,
	openPRs,
	REVIEW_TRANSLATOR_ISSUE_PREFIX,
	sessionNeedsAttention,
	type WorkspaceSession,
} from "../types/workspace";
import { XtermTerminal } from "./XtermTerminal";

export { REVIEW_TRANSLATOR_ISSUE_PREFIX } from "../types/workspace";
const MAX_REVIEW_CARDS = 8;
const REVIEW_CONVERSATION_POLL_MS = 1_000;
const REVIEW_START_GRACE_MS = 5_000;
const REVIEW_SETTLE_GRACE_MS = 2_000;
const REVIEW_RESPONSE_TIMEOUT_MS = 30_000;
const REVIEW_AGENT_MODEL = "gpt-5.6-sol";
const reviewAgentLaunches = new Map<string, Promise<string | undefined>>();

type ReviewConversationEntry = {
	role?: string;
	kind?: string;
	text?: string;
	timestamp?: string;
};

type ReviewConversationEvidence = {
	supported: boolean;
	responseLines: string[];
	requestedAt?: string;
};

type ReviewAttempt = {
	batchId: string;
	helperId?: string;
	startedAt: number;
	baselineActivityAt?: string;
	sawActivity: boolean;
};

export type ReviewTranslation = {
	sessionId: string;
	summary: string;
	question: string;
	choices?: ReviewChoice[];
};

export type ReviewChoice = {
	label: string;
	message: string;
};

export type ReviewCard = ReviewTranslation & {
	session: WorkspaceSession;
	reason: string;
};

export type ReviewPullRequestContext = {
	number: number;
	title?: string;
	headSha?: string;
	sourceBranch?: string;
	targetBranch?: string;
	state: string;
	ci: string;
	review: string;
	changedFiles?: number;
	failingChecks?: string[];
	unresolvedComments?: number;
	conflictFiles?: string[];
};

export type ReviewSourceContext = {
	sessionId: string;
	artifactPath?: string;
	latestAgentMessage?: string;
	pullRequests: ReviewPullRequestContext[];
};

type OrchestratorReviewBoardProps = {
	daemonReady: boolean;
	embedded?: boolean;
	orchestrator: WorkspaceSession;
	sessions: WorkspaceSession[];
	theme: Theme;
	backgroundOnly?: boolean;
	manageAgent?: boolean;
};

const reviewPriority: Partial<Record<WorkspaceSession["status"], number>> = {
	needs_input: 0,
	changes_requested: 1,
	ci_failed: 2,
	no_signal: 3,
	review_pending: 4,
	draft: 5,
	pr_open: 5,
};

function hasReviewablePullRequest(session: WorkspaceSession): boolean {
	return openPRs(session).length > 0;
}

function reviewCandidatePriority(session: WorkspaceSession): number {
	return reviewPriority[session.status] ?? (hasReviewablePullRequest(session) ? 5 : 99);
}

export function reviewCandidates(sessions: WorkspaceSession[]): WorkspaceSession[] {
	return sessions
		.filter(
			(session) =>
				!isOrchestratorSession(session) &&
				!isSuggestionDiscussionSession(session) &&
				!isReviewTranslatorSession(session) &&
				(sessionNeedsAttention(session) || hasReviewablePullRequest(session)),
		)
		.sort(
			(a, b) =>
				reviewCandidatePriority(a) - reviewCandidatePriority(b) ||
				Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
		)
		.slice(0, MAX_REVIEW_CARDS);
}

function reviewReason(session: WorkspaceSession): string {
	if (session.activity?.state === "blocked") {
		return "Waiting at a protected control prompt";
	}
	if (session.status === "terminated") {
		const pullRequest = openPRs(session)[0];
		if (pullRequest) {
			return pullRequest.state === "draft"
				? "Draft pull request ready to inspect; agent stopped"
				: "Open pull request ready to inspect; agent stopped";
		}
	}
	switch (session.status) {
		case "needs_input":
			return "Waiting for your direction";
		case "changes_requested":
			return "Review changes requested";
		case "ci_failed":
			return "Automated checks failed";
		case "no_signal":
			return "Agent signal is missing";
		case "review_pending":
			return "Review is pending";
		case "draft":
			return "Draft pull request ready to inspect";
		case "pr_open":
			return "Open pull request ready to inspect";
		default:
			return "Human review requested";
	}
}

function cleanTranslationText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.replace(/\s+/g, " ").trim();
	if (!clean) return undefined;
	return clean.slice(0, maxLength);
}

/**
 * A stopped worker cannot answer a message, but its open PR is still a concrete
 * review decision. Build that card locally so the review board is immediate,
 * reliable, and does not spend an agent turn translating facts AO already has.
 */
export function stoppedPullRequestTranslation(
	session: WorkspaceSession,
	context?: ReviewSourceContext,
): ReviewTranslation | undefined {
	if (session.status !== "terminated") return undefined;
	const detailed = context?.pullRequests.find((pr) => pr.state === "open" || pr.state === "draft");
	const fallback = openPRs(session)[0];
	if (!detailed && !fallback) return undefined;
	const number = fallback?.number ?? detailed?.number;
	const state = fallback?.state ?? detailed?.state;
	const title = cleanTranslationText(detailed?.title, 110);
	const label = `${state === "draft" ? "Draft PR" : "PR"}${number ? ` #${number}` : ""}`;
	return {
		sessionId: session.id,
		summary: title
			? `${label} from ${session.title} is ready: ${title}.`
			: `${label} from ${session.title} is ready for your decision.`,
		question: title ? `Approve ${label}, "${title}"?` : `Approve ${label} for ${session.title}?`,
		choices: [
			{ label: "Approve", message: `Approve ${label} for ${session.title}.` },
			{ label: "Request changes", message: `Request changes for ${label} from ${session.title}.` },
		],
	};
}

const genericReviewQuestionPatterns = [
	/\bdo you want to review\b/i,
	/\bwould you like to (?:review|inspect|open)\b/i,
	/\bwhat should (?:this|the)?\s*(?:agent|worker|task)\s+do next\b/i,
	/^(?:(?:do you want to|would you like to|should (?:we|i))\s+)?(?:review|inspect|open)\s+(?:this|the|it)\b/i,
	/\b(?:leave|left|keep)\b[^?]{0,60}\b(?:waiting|draft|open)\b/i,
	/\bshould (?:this|the)\s+(?:draft|pull request|pr|task|work)\s+be\s+(?:reviewed|revised|left|kept)\b/i,
	/\bshould (?:we|i)\s+(?:review|inspect|open|wait|continue)\b/i,
];

/** Only concrete, task-level decisions may become answerable review cards. */
export function isSpecificReviewQuestion(value: string): boolean {
	const question = value.replace(/\s+/g, " ").trim();
	return (
		question.length >= 16 &&
		question.endsWith("?") &&
		!genericReviewQuestionPatterns.some((pattern) => pattern.test(question))
	);
}

export function hasReviewTranslationResponse(lines: string[], batchId: string): boolean {
	const transcript = lines.join("\n");
	const start = `AO_REVIEW_BOARD_${batchId}_START`;
	const end = `AO_REVIEW_BOARD_${batchId}_END`;
	const startAt = transcript.lastIndexOf(start);
	return startAt >= 0 && transcript.indexOf(end, startAt + start.length) >= 0;
}

/** Read request/response evidence without mistaking the helper prompt for its answer. */
export function reviewConversationEvidence(
	entries: ReviewConversationEntry[],
	batchId: string,
): Omit<ReviewConversationEvidence, "supported"> {
	const marker = `AO_REVIEW_BOARD_${batchId}_START`;
	let requestedAt: string | undefined;
	const responseLines: string[] = [];
	for (const entry of entries) {
		if (entry.kind !== "message" || typeof entry.text !== "string") continue;
		if (entry.role === "user" && entry.text.includes(marker)) {
			requestedAt = entry.timestamp || requestedAt;
			continue;
		}
		if (entry.role === "assistant") responseLines.push(...entry.text.split(/\r?\n/));
	}
	return { requestedAt, responseLines };
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
		const body = transcript
			.slice(bodyAt, endAt)
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "");
		let parsed: { items?: unknown[] } | undefined;
		// Full-screen agent UIs can hard-wrap a JSON string into rendered terminal
		// lines. Try the exact response first, then reflow those visual line breaks
		// to spaces so a valid structured answer survives the terminal transcript.
		for (const candidate of [body, body.replace(/\r?\n[\t ]*/g, " ")]) {
			try {
				parsed = JSON.parse(candidate) as { items?: unknown[] };
				break;
			} catch {
				// Keep trying bounded variants of this marker pair.
			}
		}
		if (Array.isArray(parsed?.items)) {
			const items = parsed.items.flatMap((item) => {
				if (!item || typeof item !== "object") return [];
				const candidate = item as Record<string, unknown>;
				// Session ids never contain whitespace. Terminal reflow may insert a
				// visual break in the middle of one, so remove it after validation.
				const sessionId = cleanTranslationText(candidate.sessionId, 120)?.replace(/\s+/g, "");
				const summary = cleanTranslationText(candidate.summary, 280);
				const question = cleanTranslationText(candidate.question, 240);
				const choices = Array.isArray(candidate.choices)
					? candidate.choices.slice(0, 3).flatMap((choice) => {
							if (!choice || typeof choice !== "object") return [];
							const value = choice as Record<string, unknown>;
							const label = cleanTranslationText(value.label, 40);
							const message = cleanTranslationText(value.message, 200);
							return label && message ? [{ label, message }] : [];
						})
					: [];
				return sessionId && summary && question && isSpecificReviewQuestion(question)
					? [{ sessionId, summary, question, ...(choices.length >= 2 ? { choices } : {}) }]
					: [];
			});
			if (items.length > 0) latest = items;
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

export function reviewBatchId(
	candidates: WorkspaceSession[],
	refreshNonce: number,
	contexts: ReviewSourceContext[] = [],
): string {
	const contextsBySession = new Map(contexts.map((context) => [context.sessionId, context]));
	return batchHash(
		`${refreshNonce}|${candidates
			.map((session) => {
				const context = contextsBySession.get(session.id);
				const pullRequests = openPRs(session)
					.map(
						(pr) =>
							`${pr.number}:${pr.state}:${pr.ci}:${pr.review}:${pr.mergeability}:${pr.reviewComments ? "comments" : "clear"}`,
					)
					.sort()
					.join(",");
				const reviewContext = context
					? `${context.artifactPath ?? ""}:${context.latestAgentMessage ?? ""}:${context.pullRequests
							.map((pr) => `${pr.number}:${pr.title ?? ""}:${pr.headSha ?? ""}:${pr.ci}:${pr.review}`)
							.join(",")}`
					: "";
				// Activity (working/idle) is presentation state, not a review fact. Keeping
				// it out prevents the same question from being translated again whenever
				// a worker pauses or resumes.
				return `${session.id}:${session.status}:${pullRequests}:${reviewContext}`;
			})
			.join("|")}`,
	);
}

function boundedUtf8(value: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	let result = "";
	let size = 0;
	for (const character of value.replace(/\s+/g, " ").trim()) {
		const nextSize = encoder.encode(character).byteLength;
		if (size + nextSize > maxBytes) break;
		result += character;
		size += nextSize;
	}
	return result;
}

function reviewPromptFacts(candidates: WorkspaceSession[], contexts: ReviewSourceContext[], compact = false) {
	const contextsBySession = new Map(contexts.map((context) => [context.sessionId, context]));
	return candidates.map((session) => {
		const context = contextsBySession.get(session.id);
		return {
			sessionId: boundedUtf8(session.id, 48),
			title: boundedUtf8(session.title, compact ? 24 : 48),
			status: session.status,
			artifactPath: boundedUtf8(context?.artifactPath ?? "", compact ? 32 : 96),
			latestAgentMessage: boundedUtf8(context?.latestAgentMessage ?? "", compact ? 240 : 640),
			pullRequests: (context?.pullRequests ?? [])
				.filter((pr) => pr.state === "open" || pr.state === "draft")
				.slice(0, 1)
				.map((pr) => ({
					number: pr.number,
					title: boundedUtf8(pr.title ?? "", compact ? 28 : 72),
					headSha: boundedUtf8(pr.headSha ?? "", 40),
					...(compact
						? {}
						: {
								sourceBranch: boundedUtf8(pr.sourceBranch ?? "", 48),
								targetBranch: boundedUtf8(pr.targetBranch ?? "", 48),
							}),
					state: pr.state,
					ci: pr.ci,
					review: pr.review,
					...(compact
						? {}
						: {
								failingCheck: boundedUtf8(pr.failingChecks?.[0] ?? "", 48),
								unresolvedComments: pr.unresolvedComments ?? 0,
								conflictFile: boundedUtf8(pr.conflictFiles?.[0] ?? "", 56),
							}),
				})),
		};
	});
}

export function reviewAgentPrompt(
	candidates: WorkspaceSession[],
	batchId: string,
	contexts: ReviewSourceContext[] = [],
): string {
	const promptLines = (facts: ReturnType<typeof reviewPromptFacts>) => [
		"You are AO's dedicated review agent. AO sends a bounded batch when review-ready work changes. Use only read-only git show or git diff to inspect a supplied PR commit. Do not edit, test, message, or spawn agents.",
		"Use the supplied PR title, headSha, and artifactPath. When necessary, inspect that commit before writing the question.",
		"Turn each task and pull-request fact into calm, simple English.",
		"For every item, ask one concrete acceptance question about a specific behavior, requirement, option, value, test, file, or tradeoff named in the facts.",
		"Give each item 2 or 3 short clickable choices. Each choice needs a short label and a complete message AO can send back to the orchestrator as the user's answer.",
		"Never ask whether to review, open, inspect, revise, continue, wait, or leave the work. Never ask what the agent should do next.",
		"Do not invent missing details or choices. If the facts do not support a concrete question, omit that item.",
		"Keep the summary under 220 characters and the question under 180 characters.",
		`Return only this marker, one JSON object, and the closing marker: AO_REVIEW_BOARD_${batchId}_START`,
		'{"items":[{"sessionId":"exact id","summary":"plain English","question":"one concrete task decision","choices":[{"label":"short choice","message":"complete answer"},{"label":"other choice","message":"complete answer"}]}]}',
		`AO_REVIEW_BOARD_${batchId}_END`,
		`Worker facts: ${JSON.stringify(facts)}`,
	].join("\n");
	let prompt = promptLines(reviewPromptFacts(candidates, contexts));
	if (new TextEncoder().encode(prompt).byteLength > 4096) {
		prompt = promptLines(reviewPromptFacts(candidates, contexts, true));
	}
	return prompt;
}

function reviewArtifactPath(previewUrl?: string): string | undefined {
	const raw = previewUrl?.trim();
	if (!raw) return undefined;
	const marker = "/preview/files/";
	const markerAt = raw.indexOf(marker);
	const encoded = markerAt >= 0 ? raw.slice(markerAt + marker.length) : raw.includes("://") ? "" : raw;
	if (!encoded) return undefined;
	try {
		return decodeURIComponent(encoded).replace(/^\/+/, "");
	} catch {
		return encoded.replace(/^\/+/, "");
	}
}

export async function fetchReviewSourceContexts(candidates: WorkspaceSession[]): Promise<ReviewSourceContext[]> {
	return Promise.all(
		candidates.map(async (session) => {
			const fallbackPullRequests = session.prs.map((pr) => ({
				number: pr.number,
				state: pr.state,
				ci: pr.ci,
				review: pr.review,
				unresolvedComments: pr.reviewComments ? 1 : 0,
			}));
			try {
				const [scm, conversation] = await Promise.all([
					apiClient.GET("/api/v1/sessions/{sessionId}/pr", {
						params: { path: { sessionId: session.id } },
					}),
					apiClient.GET("/api/v1/sessions/{sessionId}/conversation", {
						params: { path: { sessionId: session.id } },
					}),
				]);
				const latestAgentMessage = conversation.data?.entries
					.filter((entry) => entry.kind === "message" && entry.role === "assistant" && entry.text?.trim())
					.at(-1)?.text;
				return {
					sessionId: session.id,
					artifactPath: reviewArtifactPath(session.previewUrl),
					latestAgentMessage,
					pullRequests:
						scm.data?.prs.map((pr) => ({
							number: pr.number,
							title: pr.title,
							headSha: pr.headSha,
							sourceBranch: pr.sourceBranch,
							targetBranch: pr.targetBranch,
							state: pr.state,
							ci: pr.ci.state,
							review: pr.review.decision,
							changedFiles: pr.changedFiles,
							failingChecks: pr.ci.failingChecks.map((check) => check.name),
							unresolvedComments: pr.review.unresolvedBy.reduce((count, reviewer) => count + reviewer.count, 0),
							conflictFiles: pr.mergeability.conflictFiles?.map((file) => file.path) ?? [],
						})) ?? fallbackPullRequests,
				};
			} catch {
				return {
					sessionId: session.id,
					artifactPath: reviewArtifactPath(session.previewUrl),
					pullRequests: fallbackPullRequests,
				};
			}
		}),
	);
}

function newestLiveReviewHelper(sessions: WorkspaceSession[], issueId: string): WorkspaceSession | undefined {
	return sessions
		.filter(
			(session) =>
				session.issueId === issueId &&
				Boolean(session.terminalHandleId) &&
				session.status !== "no_signal" &&
				session.status !== "terminated" &&
				session.status !== "merged",
		)
		.sort((a, b) => Date.parse(b.createdAt ?? b.updatedAt) - Date.parse(a.createdAt ?? a.updatedAt))[0];
}

function newestReviewHelper(sessions: WorkspaceSession[], issueId: string): WorkspaceSession | undefined {
	return sessions
		.filter((session) => session.issueId === issueId)
		.sort((a, b) => Date.parse(b.createdAt ?? b.updatedAt) - Date.parse(a.createdAt ?? a.updatedAt))[0];
}

export function OrchestratorReviewBoard({
	daemonReady,
	embedded = false,
	orchestrator,
	sessions,
	theme,
	backgroundOnly = false,
	manageAgent = true,
}: OrchestratorReviewBoardProps) {
	const queryClient = useQueryClient();
	const candidates = useMemo(() => reviewCandidates(sessions), [sessions]);
	const expectedIssueId = `${REVIEW_TRANSLATOR_ISSUE_PREFIX}${orchestrator.workspaceId}`;
	const [rejectedHelperIds, setRejectedHelperIds] = useState<ReadonlySet<string>>(() => new Set());
	const eligibleReviewSessions = useMemo(
		() => sessions.filter((session) => !rejectedHelperIds.has(session.id)),
		[rejectedHelperIds, sessions],
	);
	const liveHelper = useMemo(
		() => newestLiveReviewHelper(eligibleReviewSessions, expectedIssueId),
		[eligibleReviewSessions, expectedIssueId],
	);
	const historicalHelper = useMemo(
		() => newestReviewHelper(sessions, expectedIssueId),
		[expectedIssueId, sessions],
	);
	const rejectKnownReviewHelpers = useCallback(() => {
		setRejectedHelperIds((current) => {
			const next = new Set(current);
			for (const session of sessions) {
				if (session.issueId === expectedIssueId) next.add(session.id);
			}
			return next;
		});
	}, [expectedIssueId, sessions]);
	const candidateContextKey = useMemo(
		() =>
			candidates
				.map((session) => `${session.id}:${session.updatedAt}:${session.previewRevision ?? 0}`)
				.join("|"),
		[candidates],
	);
	const contextQuery = useQuery({
		queryKey: ["orchestrator-review-source", orchestrator.workspaceId, candidateContextKey],
		queryFn: () => fetchReviewSourceContexts(candidates),
		enabled: daemonReady && candidates.length > 0,
		retry: 1,
	});
	const reviewContexts = contextQuery.data ?? [];
	const contextsReady = !daemonReady || candidates.length === 0 || contextQuery.isFetched;
	const localTranslations = useMemo(() => {
		const contextsBySession = new Map(reviewContexts.map((context) => [context.sessionId, context]));
		return new Map(
			candidates.flatMap((session) => {
				const translation = stoppedPullRequestTranslation(session, contextsBySession.get(session.id));
				return translation ? [[session.id, translation] as const] : [];
			}),
		);
	}, [candidates, reviewContexts]);
	const [transcriptLines, setTranscriptLines] = useState<string[]>([]);
	const [helperState, setHelperState] = useState<TerminalSessionState>("idle");
	const [helperError, setHelperError] = useState<string>();
	const [requestError, setRequestError] = useState<string>();
	const [isRequesting, setIsRequesting] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [refreshNonce, setRefreshNonce] = useState(0);
	const [reviewAttempt, setReviewAttempt] = useState<ReviewAttempt>();
	const requestedBatchRef = useRef<string | undefined>(undefined);
	const forceRetryRef = useRef(false);
	const batchId = useMemo(
		() => reviewBatchId(candidates, refreshNonce, reviewContexts),
		[candidates, refreshNonce, reviewContexts],
	);
	const helper = candidates.length > 0 ? (liveHelper ?? historicalHelper) : undefined;
	const helperId = reviewAttempt?.batchId === batchId ? (reviewAttempt.helperId ?? helper?.id) : helper?.id;
	const attachableHelper =
		manageAgent &&
		liveHelper &&
		liveHelper.status !== "terminated" &&
		liveHelper.status !== "merged" &&
		liveHelper.activity?.state !== "exited"
			? liveHelper
			: undefined;
	const prompt = useMemo(
		() => reviewAgentPrompt(candidates, batchId, reviewContexts),
		[batchId, candidates, reviewContexts],
	);
	const helperConversationQuery = useQuery({
		queryKey: ["orchestrator-review-conversation", helperId, batchId],
		queryFn: async (): Promise<ReviewConversationEvidence> => {
			if (!helperId) return { supported: false, responseLines: [] };
			const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/conversation", {
				params: { path: { sessionId: helperId } },
			});
			if (error || !data) return { supported: false, responseLines: [] };
			return { supported: true, ...reviewConversationEvidence(data.entries, batchId) };
		},
		enabled: daemonReady && candidates.length > 0 && Boolean(helperId),
		retry: false,
		refetchInterval: (query) => {
			const evidence = query.state.data;
			if (evidence && hasReviewTranslationResponse(evidence.responseLines, batchId)) return false;
			return reviewAttempt?.batchId === batchId || helper?.issueId === expectedIssueId
				? REVIEW_CONVERSATION_POLL_MS
				: false;
		},
	});
	const conversationSupported = helperConversationQuery.data?.supported === true;
	const bridgeHelper = helperConversationQuery.data?.supported === false ? attachableHelper : undefined;
	const refetchHelperConversation = helperConversationQuery.refetch;
	const responseLines = conversationSupported
		? (helperConversationQuery.data?.responseLines ?? [])
		: transcriptLines;
	const parsedItems = useMemo(() => parseReviewTranslations(responseLines, batchId), [batchId, responseLines]);
	const helperResponded = useMemo(
		() => hasReviewTranslationResponse(responseLines, batchId),
		[batchId, responseLines],
	);
	const translatedItems = useMemo(() => {
		const candidateIds = new Set(candidates.map((candidate) => candidate.id));
		return parsedItems.filter((item) => candidateIds.has(item.sessionId));
	}, [candidates, parsedItems]);
	const translations = useMemo(() => {
		const combined = new Map(localTranslations);
		for (const item of translatedItems) combined.set(item.sessionId, item);
		return combined;
	}, [localTranslations, translatedItems]);
	const cards = useMemo<ReviewCard[]>(
		() =>
			candidates.flatMap((session) => {
				const translated = translations.get(session.id);
				return translated ? [{ ...translated, reason: reviewReason(session), session }] : [];
			}),
		[candidates, translations],
	);
	const unavailableSessions = useMemo(
		() => candidates.filter((session) => !translations.has(session.id)),
		[candidates, translations],
	);

	useEffect(() => {
		setTranscriptLines([]);
	}, [helper?.id]);

	useEffect(() => {
		requestedBatchRef.current = undefined;
		setReviewAttempt(undefined);
		setRequestError(undefined);
		setHelperError(undefined);
	}, [batchId]);

	useEffect(() => {
		if (
			!manageAgent ||
			candidates.length === 0 ||
			!daemonReady ||
			!contextsReady ||
			(helperId && !helperConversationQuery.isFetched) ||
			helperResponded ||
			requestError ||
			requestedBatchRef.current === batchId
		) {
			return;
		}
		const durableRequestedAt = helperConversationQuery.data?.requestedAt;
		if (durableRequestedAt && !forceRetryRef.current) {
			const durableStartedAt = Date.parse(durableRequestedAt ?? "");
			const helperStartedAt = Date.parse(helper?.activity?.lastActivityAt ?? helper?.createdAt ?? "");
			const startedAt = Number.isFinite(durableStartedAt)
				? durableStartedAt
				: Number.isFinite(helperStartedAt)
					? helperStartedAt
					: Date.now();
			const activityAt = Date.parse(helper?.activity?.lastActivityAt ?? "");
			requestedBatchRef.current = batchId;
			setReviewAttempt((current) =>
				current?.batchId === batchId
					? current
					: {
							batchId,
							helperId,
							startedAt,
							baselineActivityAt: helper?.activity?.lastActivityAt,
							sawActivity:
								helper?.activity?.state === "active" ||
								(Number.isFinite(durableStartedAt) && Number.isFinite(activityAt) && activityAt >= durableStartedAt),
						},
			);
			return;
		}

		const helperActivity = liveHelper?.activity?.state;
		const helperIsIdle = helperActivity === "idle" || (!helperActivity && liveHelper?.status === "idle");
		if (liveHelper && !helperIsIdle) {
			const helperIsActive =
				helperActivity === "active" || (!helperActivity && liveHelper.status === "working");
			if (helperIsActive) {
				const activityAt = Date.parse(liveHelper.activity?.lastActivityAt ?? "");
				setReviewAttempt((current) =>
					current?.batchId === batchId
						? current
						: {
								batchId,
							helperId: liveHelper.id,
							startedAt: Number.isFinite(activityAt) ? activityAt : Date.now(),
							baselineActivityAt: liveHelper.activity?.lastActivityAt,
								sawActivity: true,
							},
				);
			} else {
				setRequestError("The review helper is waiting for input, so AO did not send another prompt into it.");
			}
			return;
		}

		const existingLaunch = liveHelper ? undefined : reviewAgentLaunches.get(expectedIssueId);
		if (existingLaunch) {
			requestedBatchRef.current = batchId;
			setIsRequesting(true);
			setRequestError(undefined);
			setReviewAttempt({
				batchId,
				helperId: helper?.id,
				startedAt: Date.now(),
				baselineActivityAt: helper?.activity?.lastActivityAt,
				sawActivity: false,
			});
			void existingLaunch
				.then(async (spawnedHelperId) => {
					if (spawnedHelperId) {
						setReviewAttempt((current) =>
							current?.batchId === batchId ? { ...current, helperId: spawnedHelperId } : current,
						);
					}
					await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				})
				.catch((error) => {
					requestedBatchRef.current = undefined;
					setReviewAttempt(undefined);
					setRequestError(error instanceof Error ? error.message : "Unable to prepare the review");
				})
				.finally(() => setIsRequesting(false));
			return;
		}

		requestedBatchRef.current = batchId;
		forceRetryRef.current = false;
		setIsRequesting(true);
		setRequestError(undefined);
		setReviewAttempt({
			batchId,
			helperId: helper?.id,
			startedAt: Date.now(),
			baselineActivityAt: helper?.activity?.lastActivityAt,
			sawActivity: helper?.activity?.state === "active",
		});
		const sharedLaunch = liveHelper
			? undefined
			: (async () => {
					const { data, error } = await apiClient.POST("/api/v1/sessions", {
						body: {
							projectId: orchestrator.workspaceId,
							kind: "worker",
							issueId: expectedIssueId,
							displayName: "Review agent",
							prompt,
							agentConfig: {
								model: REVIEW_AGENT_MODEL,
								reasoningEffort: "low",
							},
						},
					});
					if (error) throw new Error(apiErrorMessage(error, "Unable to start the review agent"));
					return data?.session?.id;
				})();
		if (sharedLaunch) reviewAgentLaunches.set(expectedIssueId, sharedLaunch);
		void (async () => {
			try {
				if (liveHelper) {
					const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
						params: { path: { sessionId: liveHelper.id } },
						body: { message: prompt },
					});
					if (error) throw new Error(apiErrorMessage(error, "Unable to refresh the review helper"));
				} else {
					const spawnedHelperId = await sharedLaunch;
					if (spawnedHelperId) {
						setReviewAttempt((current) =>
							current?.batchId === batchId ? { ...current, helperId: spawnedHelperId } : current,
						);
					}
				}
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			} catch (error) {
				if (liveHelper) rejectKnownReviewHelpers();
				requestedBatchRef.current = undefined;
				setReviewAttempt(undefined);
				setRequestError(error instanceof Error ? error.message : "Unable to prepare the review");
			} finally {
				if (sharedLaunch && reviewAgentLaunches.get(expectedIssueId) === sharedLaunch) {
					reviewAgentLaunches.delete(expectedIssueId);
				}
				setIsRequesting(false);
			}
		})();
	}, [
		batchId,
		candidates.length,
		contextsReady,
		daemonReady,
		helper,
		helperId,
		helperConversationQuery.data?.requestedAt,
		helperConversationQuery.isFetched,
		helperResponded,
		liveHelper,
		manageAgent,
		orchestrator.workspaceId,
		prompt,
		queryClient,
		rejectKnownReviewHelpers,
		requestError,
	]);

	// The background reviewer is a loop, not a one-shot helper. Recover from a
	// failed launch or unusable response without requiring the user to open the
	// Review tab or press Retry.
	useEffect(() => {
		if (!manageAgent || !requestError || candidates.length === 0) return undefined;
		const timer = window.setTimeout(() => {
			requestedBatchRef.current = undefined;
			forceRetryRef.current = true;
			setReviewAttempt(undefined);
			setRequestError(undefined);
		}, 5_000);
		return () => window.clearTimeout(timer);
	}, [candidates.length, manageAgent, requestError]);

	useEffect(() => {
		if (!helperResponded) return;
		requestedBatchRef.current = batchId;
		setReviewAttempt(undefined);
		setRequestError(undefined);
	}, [batchId, helperResponded]);

	useEffect(() => {
		if (!manageAgent || !reviewAttempt || reviewAttempt.batchId !== batchId || helperResponded) return;
		const activityAt = helper?.activity?.lastActivityAt;
		if (helper?.activity?.state !== "active" && (!activityAt || activityAt === reviewAttempt.baselineActivityAt)) {
			return;
		}
		setReviewAttempt((current) =>
			current?.batchId === batchId && !current.sawActivity ? { ...current, sawActivity: true } : current,
		);
	}, [
		batchId,
		helper?.activity?.lastActivityAt,
		helper?.activity?.state,
		helperResponded,
		manageAgent,
		reviewAttempt,
	]);

	useEffect(() => {
		if (!manageAgent || !reviewAttempt || reviewAttempt.batchId !== batchId || helperResponded) return;
		const now = Date.now();
		const activityState = helper?.activity?.state;
		const helperIsIdle = activityState === "idle" || (!activityState && helper?.status === "idle");
		const helperInterrupted =
			(!conversationSupported && (helperState === "error" || helperState === "exited")) ||
			activityState === "waiting_input" ||
			activityState === "blocked" ||
			activityState === "exited";
		let expiresAt = reviewAttempt.startedAt + REVIEW_RESPONSE_TIMEOUT_MS;
		if (helperInterrupted) {
			// A provider can persist its final assistant message just after the
			// runtime reports exit. Keep a short settle window, then make one final
			// durable read before showing recovery UI.
			expiresAt = Math.min(expiresAt, now + REVIEW_SETTLE_GRACE_MS);
		} else if (helper && helperIsIdle) {
			if (!reviewAttempt.sawActivity) {
				expiresAt = Math.min(expiresAt, reviewAttempt.startedAt + REVIEW_START_GRACE_MS);
			} else {
				const activityAt = Date.parse(helper.activity?.lastActivityAt ?? "");
				const settledAt = Number.isFinite(activityAt)
					? activityAt + REVIEW_SETTLE_GRACE_MS
					: now + REVIEW_SETTLE_GRACE_MS;
				expiresAt = Math.min(expiresAt, settledAt);
			}
		}
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void (async () => {
				const finalRead = await refetchHelperConversation();
				if (cancelled) return;
				if (finalRead.data && hasReviewTranslationResponse(finalRead.data.responseLines, batchId)) return;
				rejectKnownReviewHelpers();
				setReviewAttempt(undefined);
				setRequestError(
					helperInterrupted
						? "review_interrupted"
						: activityState === "active"
							? "review_timed_out"
							: "review_unavailable",
				);
			})();
		}, Math.max(0, expiresAt - now));
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [
		batchId,
		conversationSupported,
		helper,
		helperResponded,
		helperState,
		manageAgent,
		refetchHelperConversation,
		rejectKnownReviewHelpers,
		reviewAttempt,
	]);

	const refresh = async () => {
		if (isRefreshing || isRequesting) return;
		setIsRefreshing(true);
		requestedBatchRef.current = undefined;
		forceRetryRef.current = true;
		setTranscriptLines([]);
		setReviewAttempt(undefined);
		setRequestError(undefined);
		setHelperError(undefined);
		try {
			await Promise.allSettled([
				contextQuery.refetch(),
				queryClient.invalidateQueries({ queryKey: workspaceQueryKey }),
			]);
			// A manual refresh must create a distinct request even when none of the
			// underlying review facts changed.
			setRefreshNonce((nonce) => nonce + 1);
		} finally {
			setIsRefreshing(false);
		}
	};

	const helperReady = candidates.length > 0 && translations.size === candidates.length;
	const helperWorking =
		contextQuery.isLoading ||
		contextQuery.isFetching ||
		helperConversationQuery.isLoading ||
		isRefreshing ||
		isRequesting ||
		Boolean(reviewAttempt?.batchId === batchId && !helperResponded && !requestError);
	const reviewFailed = !helperResponded && Boolean(requestError || (!conversationSupported && helperError));
	const someQuestionsUnavailable = !helperWorking && unavailableSessions.length > 0;
	const allClear = candidates.length === 0;

	if (backgroundOnly) {
		return bridgeHelper ? (
			<ReviewAgentBridge
				key={`${bridgeHelper.id}:${bridgeHelper.terminalHandleId ?? "starting"}`}
				daemonReady={daemonReady}
				helper={bridgeHelper}
				onError={setHelperError}
				onStateChange={setHelperState}
				onTranscriptChange={setTranscriptLines}
				theme={theme}
			/>
		) : null;
	}

	return (
		<div
			className={`relative flex min-h-0 flex-col overflow-hidden bg-background ${embedded ? "max-h-[42vh] shrink-0 rounded-lg border border-border" : "h-full"}`}
		>
			{bridgeHelper ? (
				<ReviewAgentBridge
					key={`${bridgeHelper.id}:${bridgeHelper.terminalHandleId ?? "starting"}`}
					daemonReady={daemonReady}
					helper={bridgeHelper}
					onError={setHelperError}
					onStateChange={setHelperState}
					onTranscriptChange={setTranscriptLines}
					theme={theme}
				/>
			) : null}
			<div className={`shrink-0 border-b border-border bg-surface/45 ${embedded ? "px-4 py-3" : "px-6 py-4"}`}>
				<div className="mx-auto flex max-w-5xl items-center gap-4">
					<div className="grid size-10 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
						<Sparkles className="size-5" aria-hidden="true" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="text-sm font-semibold text-foreground">
							{embedded ? "Review decisions" : "Your review board"}
						</div>
						<div className="mt-0.5 text-xs text-muted-foreground">
							Concrete decisions appear here with a direct answer path. Everything else stays linked to its task.
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
										: someQuestionsUnavailable
											? reviewFailed
												? "Review needs attention"
												: "No decision needed"
											: "Open tasks for details"}
						</span>
						<button
							aria-busy={isRefreshing || isRequesting}
							className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-caption font-semibold text-muted-foreground transition hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
							disabled={candidates.length === 0 || helperWorking}
							onClick={() => void refresh()}
							type="button"
						>
							<RefreshCw
								className={`size-3.5 ${isRefreshing || isRequesting ? "animate-spin" : ""}`}
								aria-hidden="true"
							/>
							{isRefreshing || isRequesting ? "Refreshing..." : "Refresh"}
						</button>
					</div>
				</div>
			</div>

			<div className={`min-h-0 flex-1 overflow-auto ${embedded ? "px-4 py-4" : "px-6 py-8"}`}>
				{allClear ? (
					<div
						className={`mx-auto grid max-w-xl place-items-center rounded-2xl border border-dashed border-border bg-surface/30 text-center ${embedded ? "min-h-24 p-4" : "min-h-72 p-8"}`}
					>
						<div>
							<div
								className={`${embedded ? "size-9" : "size-12"} mx-auto grid place-items-center rounded-full bg-success/10 text-success`}
							>
								<Check className="size-6" aria-hidden="true" />
							</div>
							<h2 className={`${embedded ? "mt-2 text-sm" : "mt-4 text-base"} font-semibold text-foreground`}>
								Nothing needs your answer
							</h2>
							<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
								Orbit will place a task here when an agent pauses, loses signal, fails checks, or receives review
								feedback.
							</p>
						</div>
					</div>
				) : (
					<div className="mx-auto flex min-h-full max-w-6xl flex-col justify-center gap-5">
						{cards.length > 0 ? (
							<div className="flex flex-wrap justify-center gap-5">
								{cards.map((card, index) => (
									<ReviewTaskCard
										card={card}
										index={index}
										key={card.sessionId}
										orchestratorId={orchestrator.id}
									/>
								))}
							</div>
						) : null}

						{helperWorking && cards.length === 0 ? (
							<div
							className={`mx-auto grid w-full max-w-xl place-items-center rounded-2xl border border-dashed border-border bg-surface/30 text-center ${embedded ? "min-h-32 p-4" : "min-h-64 p-8"}`}
								role="status"
							>
								<div>
									<LoaderCircle className="mx-auto size-7 animate-spin text-accent" aria-hidden="true" />
									<h2 className="mt-4 text-base font-semibold text-foreground">Preparing review questions</h2>
									<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
										AO is looking for a specific decision in each task.
									</p>
								</div>
							</div>
						) : null}

						{someQuestionsUnavailable ? (
							<section
								aria-label={reviewFailed ? "Review recovery" : "Tasks without a decision"}
								className="mx-auto w-full max-w-2xl rounded-2xl border border-border bg-surface p-5 shadow-sm"
							>
								<div className="flex items-start gap-3">
									<div className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning/10 text-warning">
										<CircleAlert className="size-4.5" aria-hidden="true" />
									</div>
									<div className="min-w-0 flex-1">
										<h2 className="text-sm font-semibold text-foreground">
											{reviewFailed ? "One-click review isn’t available yet" : "No decision needed right now"}
										</h2>
										<p className="mt-1 text-xs leading-5 text-muted-foreground">
											{reviewFailed
												? "The dedicated reviewer will retry automatically while AO is open."
												: "The dedicated reviewer is still turning these items into direct choices."}
										</p>
									</div>
									{reviewFailed ? (
										<button
											aria-busy={isRefreshing || isRequesting}
											className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-semibold text-foreground transition hover:bg-interactive-hover"
											disabled={helperWorking}
											onClick={() => void refresh()}
											type="button"
										>
											<RefreshCw
												className={`size-3.5 ${isRefreshing || isRequesting ? "animate-spin" : ""}`}
												aria-hidden="true"
											/>
											{isRefreshing || isRequesting ? "Trying again..." : "Try again"}
										</button>
									) : null}
								</div>
								<div className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border">
									{unavailableSessions.map((session) => (
										<div className="flex items-center gap-4 bg-background/60 px-4 py-3" key={session.id}>
											<div className="min-w-0 flex-1">
												<div className="truncate text-sm font-medium text-foreground">{session.title}</div>
												<div className="mt-0.5 truncate text-xs text-muted-foreground">
													{reviewReason(session)}
												</div>
											</div>
											<span className="shrink-0 text-caption font-medium text-muted-foreground">
												Reviewer queued
											</span>
										</div>
									))}
								</div>
							</section>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}

export function ReviewTaskCard({
	card,
	index,
	orchestratorId,
}: {
	card: ReviewCard;
	index: number;
	orchestratorId: string;
}) {
	const queryClient = useQueryClient();
	const [sendingChoice, setSendingChoice] = useState<string>();
	const [sentDecision, setSentDecision] = useState<string>();
	const [error, setError] = useState<string>();
	const isSending = Boolean(sendingChoice);
	const question = card.question;
	const choices: ReviewChoice[] =
		card.choices && card.choices.length >= 2
			? card.choices
			: [
					{ label: "Approve", message: `Approve the review item for ${card.session.title}.` },
					{ label: "Request changes", message: `Request changes for ${card.session.title}.` },
				];

	const sendDecision = async (choice: ReviewChoice) => {
		if (isSending) return;
		const message = `Review answer for ${card.session.title} (${card.session.id}): ${choice.message}\nQuestion: ${question}`;
		setSendingChoice(choice.message);
		setError(undefined);
		try {
			const { error: apiError } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: orchestratorId } },
				body: { message },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Unable to send your review decision"));
			setSentDecision(choice.label);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		} catch (sendError) {
			setError(sendError instanceof Error ? sendError.message : "Unable to send your review decision");
		} finally {
			setSendingChoice(undefined);
		}
	};

	return (
		<article className="flex min-h-80 w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-lg">
			<div className="flex items-start gap-3">
				<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning/10 font-mono text-xs font-semibold text-warning">
					{String(index + 1).padStart(2, "0")}
				</span>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-semibold text-foreground">{card.session.title}</div>
					<div className="mt-1 truncate text-caption text-muted-foreground">{card.reason}</div>
				</div>
			</div>

			<p className="mt-5 text-sm leading-6 text-foreground/90">{card.summary}</p>
			<div className="mt-4 rounded-xl border border-accent/20 bg-accent/8 p-4">
				<div className="font-mono text-caption font-semibold uppercase tracking-wide-md text-accent">
					Decision
				</div>
				<p className="mt-2 text-base font-medium leading-6 text-foreground">{question}</p>
			</div>

			{sentDecision ? (
				<div className="mt-4 flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 p-3 text-sm font-semibold text-success">
					<Check className="size-4" aria-hidden="true" />
					{sentDecision} sent to Orbit
				</div>
			) : (
				<div className={`mt-5 grid gap-2 ${choices.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
					{choices.map((choice, choiceIndex) => {
						const isThisChoiceSending = sendingChoice === choice.message;
						return (
							<button
								aria-label={`${choice.label} for ${card.session.title}`}
								aria-busy={isThisChoiceSending}
								className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition disabled:opacity-50 ${
									choiceIndex === 0
										? "bg-accent text-accent-foreground hover:opacity-90"
										: "border border-border bg-background text-foreground hover:bg-interactive-hover"
								}`}
								disabled={isSending}
								key={`${choice.label}:${choice.message}`}
								onClick={() => void sendDecision(choice)}
								type="button"
							>
								{isThisChoiceSending ? (
									<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
								) : choiceIndex === 0 ? (
									<Check className="size-3.5" aria-hidden="true" />
								) : null}
								{isThisChoiceSending ? "Sending..." : choice.label}
							</button>
						);
					})}
				</div>
			)}

			{error ? <div className="mt-3 text-xs text-destructive">{error}</div> : null}
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
		<div
			aria-hidden="true"
			className="pointer-events-none absolute -left-[10000px] top-0 h-[1000px] w-[1200px] opacity-0"
		>
			<XtermTerminal
				ariaLabel="Review agent terminal"
				fontSize={13}
				onError={(bridgeError) =>
					onError(bridgeError instanceof Error ? bridgeError.message : "Review agent terminal could not start")
				}
				onReady={setTerminal}
				onTranscriptChange={onTranscriptChange}
				theme={theme}
			/>
		</div>
	);
}
