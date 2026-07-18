import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Activity,
	Bot,
	Check,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	Cloud,
	FolderOpen,
	GitBranch,
	Loader2,
	MessageSquareText,
	Radio,
	Send,
	Square,
	Zap,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { components } from "../../api/schema";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage, getApiBaseUrl } from "../lib/api-client";
import { SUGGESTION_LIVE_DISCUSSION_ISSUE_PREFIX, type AgentProvider } from "../types/workspace";

type Project = components["schemas"]["Project"];
type ConversationEntry = components["schemas"]["ControllersSessionConversationEntry"];

const MAX_SESSION_PROMPT_BYTES = 4096;
const LIVE_DISCUSSION_STORAGE_PREFIX = "ao.suggestion-live.v1";
const QUICK_REQUEST_STORAGE_PREFIX = "ao.quick-request.v1";
const MANAGED_ASSISTANT_MODEL = "gpt-5.6-sol";
const QUICK_REQUEST_MODEL = MANAGED_ASSISTANT_MODEL;

type DecisionRole = "sol" | "fable" | "k3";
type DiscussionRole = "assistant" | DecisionRole;
type RoleSetupState = "waiting" | "starting" | "ready" | "failed";

function initialRoleSetupStates(): Record<DiscussionRole, RoleSetupState> {
	return { assistant: "waiting", sol: "waiting", fable: "waiting", k3: "waiting" };
}

type ParticipantDefinition = {
	id: DecisionRole;
	name: string;
	harness: AgentProvider;
	model: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	color: string;
};

const PARTICIPANTS: ParticipantDefinition[] = [
	{
		id: "sol",
		name: "Sol",
		harness: "codex",
		model: "gpt-5.6-sol",
		effort: "xhigh",
		color: "border-sky-500/30 bg-sky-500/8 text-sky-300",
	},
	{
		id: "fable",
		name: "Fable",
		harness: "claude-code",
		model: "fable",
		effort: "max",
		color: "border-orange-500/30 bg-orange-500/8 text-orange-300",
	},
	{
		id: "k3",
		name: "K3",
		harness: "kimi",
		model: "k3",
		color: "border-violet-500/30 bg-violet-500/8 text-violet-300",
	},
];

export type LiveSuggestionDiscussion = {
	id: string;
	title: string;
	createdAt: string;
	assistantId: string;
	participantIds: Record<DecisionRole, string>;
};

type QuickRequestEntry = {
	id: string;
	speaker: "You" | "Quick request";
	text: string;
};

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8Length(value) <= maxBytes) return value;
	let used = 0;
	let output = "";
	for (const character of value) {
		const bytes = utf8Length(character);
		if (used + bytes > maxBytes) break;
		output += character;
		used += bytes;
	}
	return output;
}

function boundedPrompt(prefix: string, rawContext: string): string {
	const truncationMarker = "\n\n[Context shortened to fit the session prompt.]";
	const available = MAX_SESSION_PROMPT_BYTES - utf8Length(prefix);
	if (utf8Length(rawContext) <= available) return prefix + rawContext;
	return prefix + truncateUtf8(rawContext, Math.max(0, available - utf8Length(truncationMarker))) + truncationMarker;
}

export function buildSuggestionDiscussionPrompt(title: string, note: string, projectPath = ""): string {
	const prefix = `You are the Assistant for an AO live suggestion discussion. You are a fast, neutral recorder and waker, never a decision-maker.

Rules:
- Do not recommend, argue, vote, rank, approve, reject, or choose an outcome.
- Do not edit files, run mutating commands, implement work, commit, push, or create a pull request.
- Wait for a DISCUSSION_SETUP message containing your session id, the three decision-session ids, the raw-context URL, and the orchestrator id.
- For a new user message, wake all three decision agents once. For a decision-agent contribution, wake only the other two once. If several entries accumulated, send one combined wake per target. Tell them only that the user is live and where the raw context is. Never summarize context for them.
- Do not acknowledge routine messages, repeat context, or wake an agent twice for the same transcript revision.
- Record important points as concise lines beginning NOTE:. When all three decision agents publish FINAL contributions, record the outcome as RESULT:, preserving disagreement when there is no consensus.
- Send the RESULT to the orchestrator only when it materially affects active work or the user asks. Otherwise keep it on this Suggestions page.
- Stay responsive for the lifetime of the live session.

Project context: ${projectPath.trim() || "Use the AO project workspace supplied to this session."}

Raw discussion prompt:
`;
	const rawContext = `${title.trim()}\n\n${note.trim() || "No additional note was supplied."}`;
	return boundedPrompt(prefix, rawContext);
}

export function buildDecisionAgentPrompt(
	participant: ParticipantDefinition,
	assistantId: string,
	projectPath = "",
): string {
	return `You are ${participant.name}, one of exactly three decision agents in an AO live suggestion discussion.

You are a decision participant. The Assistant is not. Do not ask the Assistant for an opinion or a summary.

Protocol:
- This is discussion-only. Do not edit files, run mutating commands, implement, commit, push, or create a pull request.
- Wait until the Assistant wakes you. The wake message gives the raw-context URL and says the user is live.
- Read the raw conversation yourself from that URL before every contribution. Inspect the project read-only when useful: ${projectPath.trim() || "the supplied AO project workspace"}.
- Publish each contribution verbatim to Assistant session ${assistantId} with: ao send --session ${assistantId} --message "[${participant.name.toUpperCase()}] <your contribution>"
- Never send private chain-of-thought. Send only concise conclusions, evidence, objections, questions, and tradeoffs suitable for the shared live transcript.
- Re-read the raw context only after a wake says it changed. Do not answer if it adds nothing material. Make at most three substantive contributions: opening view, challenge/reconciliation, then a contribution beginning FINAL:.
- You may disagree. Do not manufacture consensus.

Remain available after your FINAL contribution in case the live user asks a follow-up.`;
}

export function buildQuickRequestPrompt(projectPath: string, request: string): string {
	const prefix = `You are AO's Quick Request assistant. Handle only small operational questions for the current project.

Allowed work:
- Check whether the current git branch and commits are pushed. Use read-only git status, branch, log, and upstream comparisons.
- Check GitHub connectivity, authentication, repository identity, remotes, and pull-request status with read-only gh and git commands.
- Check AO agent/session health and summarize which agents are active, idle, blocked, stopped, or missing signal.
- Report the project path and help the user locate it. The desktop UI handles actually opening the project.

Rules:
- Keep answers direct and no longer than five short lines unless the user asks for detail.
- Run only read-only inspection commands. Never edit files, install packages, change configuration, commit, pull, push, merge, create a PR, start or stop agents, or send messages to another session.
- If a request is outside this narrow scope, say it belongs in the main project or discussion session.
- State uncertainty plainly and include the one next action the user should take when a check fails.

Project path: ${projectPath.trim() || "Use the AO project workspace supplied to this session."}

Initial request:
`;
	return boundedPrompt(prefix, `[QUICK_REQUEST] ${request.trim()}`);
}

function storageKey(projectId: string): string {
	return `${LIVE_DISCUSSION_STORAGE_PREFIX}.${encodeURIComponent(projectId)}`;
}

function readLiveDiscussion(projectId: string): LiveSuggestionDiscussion | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		const raw = window.localStorage?.getItem(storageKey(projectId));
		if (!raw) return undefined;
		const value = JSON.parse(raw) as Partial<LiveSuggestionDiscussion>;
		if (
			typeof value.id !== "string" ||
			typeof value.title !== "string" ||
			typeof value.createdAt !== "string" ||
			typeof value.assistantId !== "string" ||
			typeof value.participantIds?.sol !== "string" ||
			typeof value.participantIds?.fable !== "string" ||
			typeof value.participantIds?.k3 !== "string"
		) {
			return undefined;
		}
		return value as LiveSuggestionDiscussion;
	} catch {
		return undefined;
	}
}

function writeLiveDiscussion(projectId: string, discussion?: LiveSuggestionDiscussion): void {
	if (typeof window === "undefined") return;
	try {
		if (discussion) window.localStorage?.setItem(storageKey(projectId), JSON.stringify(discussion));
		else window.localStorage?.removeItem(storageKey(projectId));
	} catch {
		// Local persistence is a convenience; the AO sessions remain authoritative.
	}
}

function quickRequestStorageKey(projectId: string): string {
	return `${QUICK_REQUEST_STORAGE_PREFIX}.${encodeURIComponent(projectId)}`;
}

function readQuickRequestSession(projectId: string): string | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage?.getItem(quickRequestStorageKey(projectId)) || undefined;
	} catch {
		return undefined;
	}
}

function writeQuickRequestSession(projectId: string, sessionId: string): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage?.setItem(quickRequestStorageKey(projectId), sessionId);
	} catch {
		// The helper still works for the current page even if persistence is unavailable.
	}
}

async function createAgentSession(body: {
	projectId: string;
	harness: AgentProvider;
	issueId: string;
	displayName: string;
	prompt: string;
	agentConfig: { model: string; reasoningEffort?: string; permissions: "auto" | "bypass-permissions" };
}): Promise<string> {
	const { data, error } = await apiClient.POST("/api/v1/sessions", {
		body: { ...body, kind: "worker" },
	});
	if (error) {
		throw new Error(`Could not start ${body.displayName}: ${apiErrorMessage(error, "session setup failed")}`);
	}
	if (!data?.session?.id) throw new Error(`${body.displayName} returned no session`);
	return data.session.id;
}

async function stopDiscussionSessions(sessionIds: string[]): Promise<void> {
	await Promise.allSettled(
		sessionIds.map((sessionId) =>
			apiClient.POST("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId } },
			}),
		),
	);
}

export function SuggestionDiscussionPanel({
	projectId,
	title,
	note,
	onOpenSession,
	onOpenProject,
}: {
	projectId: string;
	title: string;
	note: string;
	onOpenSession: (sessionId: string) => void;
	onOpenProject: () => void;
}) {
	const queryClient = useQueryClient();
	const [expanded, setExpanded] = useState(false);
	const [discussion, setDiscussion] = useState<LiveSuggestionDiscussion | undefined>(() =>
		readLiveDiscussion(projectId),
	);
	const [roleSetupStates, setRoleSetupStates] = useState<Record<DiscussionRole, RoleSetupState>>(
		initialRoleSetupStates,
	);
	const [message, setMessage] = useState("");
	const [isStarting, setIsStarting] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const [error, setError] = useState<string>();
	const [quickSessionId, setQuickSessionId] = useState<string | undefined>(() =>
		readQuickRequestSession(projectId),
	);
	const [quickMessage, setQuickMessage] = useState("");
	const [isQuickSending, setIsQuickSending] = useState(false);
	const [quickPendingAction, setQuickPendingAction] = useState<string>();
	const [quickError, setQuickError] = useState<string>();

	const conversationQuery = useQuery({
		queryKey: ["suggestion-live-conversation", discussion?.assistantId],
		enabled: Boolean(discussion?.assistantId),
		queryFn: async () => {
			if (!discussion) return undefined;
			const { data, error: apiError } = await apiClient.GET("/api/v1/sessions/{sessionId}/conversation", {
				params: { path: { sessionId: discussion.assistantId } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not read the live discussion"));
			return data;
		},
		refetchInterval: discussion ? 1_500 : false,
		retry: 1,
	});

	const publicEntries = useMemo(
		() => (conversationQuery.data?.entries ?? []).flatMap(publicDiscussionEntry).slice(-60),
		[conversationQuery.data?.entries],
	);
	const latestResult = useMemo(
		() =>
			[...publicEntries]
				.reverse()
				.find((entry) => entry.speaker === "Assistant" && /(^|\n)RESULT:/i.test(entry.text))?.text,
		[publicEntries],
	);

	const quickConversationQuery = useQuery({
		queryKey: ["suggestion-quick-conversation", quickSessionId],
		enabled: Boolean(quickSessionId),
		queryFn: async () => {
			if (!quickSessionId) return undefined;
			const { data, error: apiError } = await apiClient.GET("/api/v1/sessions/{sessionId}/conversation", {
				params: { path: { sessionId: quickSessionId } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not read the quick request session"));
			return data;
		},
		refetchInterval: quickSessionId ? 1_500 : false,
		retry: 1,
	});
	const quickEntries = useMemo(
		() => (quickConversationQuery.data?.entries ?? []).flatMap(publicQuickRequestEntry).slice(-8),
		[quickConversationQuery.data?.entries],
	);

	const startDiscussion = async () => {
		const cleanTitle = title.trim();
		if (!cleanTitle || isStarting || discussion) return;
		setIsStarting(true);
		setError(undefined);
		setRoleSetupStates({ ...initialRoleSetupStates(), assistant: "starting" });
		const startedSessionIds: string[] = [];
		const setRoleSetupState = (role: DiscussionRole, state: RoleSetupState) => {
			setRoleSetupStates((current) => ({ ...current, [role]: state }));
		};
		try {
			const [projectResponse, sessionsResponse] = await Promise.all([
				apiClient.GET("/api/v1/projects/{id}", { params: { path: { id: projectId } } }),
				apiClient.GET("/api/v1/sessions"),
			]);
			const project = projectResponse.data?.status === "ok" ? (projectResponse.data.project as Project) : undefined;
			const projectPath = project?.path ?? "";
			const orchestratorId = sessionsResponse.data?.sessions.find(
				(session) => session.projectId === projectId && session.kind === "orchestrator" && !session.isTerminated,
			)?.id;
			const discussionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
			const assistantId = await createAgentSession({
				projectId,
				harness: "codex",
				issueId: `${SUGGESTION_LIVE_DISCUSSION_ISSUE_PREFIX}${discussionId}:assistant`,
				displayName: "Discussion Assistant",
				prompt: buildSuggestionDiscussionPrompt(cleanTitle, note, projectPath),
				agentConfig: {
					model: MANAGED_ASSISTANT_MODEL,
					reasoningEffort: "low",
					permissions: "bypass-permissions",
				},
			});
			startedSessionIds.push(assistantId);
			setRoleSetupState("assistant", "ready");

			const participantIds = {} as Record<DecisionRole, string>;
			setRoleSetupStates((current) => ({
				...current,
				sol: "starting",
				fable: "starting",
				k3: "starting",
			}));
			// The backend serializes only the shared Git worktree metadata step. The
			// remaining agent preparation and runtime launches can safely overlap.
			const participantResults = await Promise.allSettled(
				PARTICIPANTS.map(async (participant) => {
					try {
						const sessionId = await createAgentSession({
							projectId,
							harness: participant.harness,
							issueId: `${SUGGESTION_LIVE_DISCUSSION_ISSUE_PREFIX}${discussionId}:${participant.id}`,
							displayName: participant.name,
							prompt: buildDecisionAgentPrompt(participant, assistantId, projectPath),
							agentConfig: {
								model: participant.model,
								reasoningEffort: participant.effort,
								permissions: "bypass-permissions",
							},
						});
						startedSessionIds.push(sessionId);
						participantIds[participant.id] = sessionId;
						setRoleSetupState(participant.id, "ready");
						return sessionId;
					} catch (cause) {
						setRoleSetupState(participant.id, "failed");
						throw cause;
					}
				}),
			);
			const failedParticipant = participantResults.find(
				(result): result is PromiseRejectedResult => result.status === "rejected",
			);
			if (failedParticipant) throw failedParticipant.reason;
			const liveDiscussion: LiveSuggestionDiscussion = {
				id: discussionId,
				title: cleanTitle,
				createdAt: new Date().toISOString(),
				assistantId,
				participantIds,
			};
			const contextUrl = `${getApiBaseUrl() || "http://127.0.0.1:3001"}/api/v1/sessions/${assistantId}/conversation`;
			const setupMessage = `[DISCUSSION_SETUP]\nAssistant session: ${assistantId}\nRaw context: ${contextUrl}\nSol: ${participantIds.sol}\nFable: ${participantIds.fable}\nK3: ${participantIds.k3}\nOrchestrator: ${orchestratorId ?? "not available"}\n\nThe user is live. Wake Sol, Fable, and K3 now. Tell each only that the user is live and to read the raw context URL. Do not summarize the prompt or anyone's contribution.`;
			const { error: setupError } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: assistantId } },
				body: { message: setupMessage },
			});
			if (setupError) throw new Error(apiErrorMessage(setupError, "Could not activate the Discussion Assistant"));
			writeLiveDiscussion(projectId, liveDiscussion);
			setDiscussion(liveDiscussion);
			setExpanded(true);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		} catch (cause) {
			await stopDiscussionSessions(startedSessionIds);
			setRoleSetupStates((current) => {
				const hasExplicitFailure = Object.values(current).some((state) => state === "failed");
				return {
					assistant: !hasExplicitFailure || current.assistant === "failed" ? "failed" : "waiting",
					sol: current.sol === "failed" ? "failed" : "waiting",
					fable: current.fable === "failed" ? "failed" : "waiting",
					k3: current.k3 === "failed" ? "failed" : "waiting",
				};
			});
			setError(cause instanceof Error ? cause.message : "Could not start the live discussion");
		} finally {
			setIsStarting(false);
		}
	};

	const sendLiveMessage = async () => {
		const clean = message.trim();
		if (!discussion || !clean || isSending) return;
		setIsSending(true);
		setError(undefined);
		try {
			const { error: apiError } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: discussion.assistantId } },
				body: {
					message: `[USER_LIVE] ${clean}\n\nWake Sol, Fable, and K3 now. Tell them only that the user is live and where the raw context is; do not summarize this message.`,
				},
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not send the live message"));
			setMessage("");
			await conversationQuery.refetch();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not send the live message");
		} finally {
			setIsSending(false);
		}
	};

	const endDiscussion = async () => {
		if (!discussion || isStopping) return;
		setIsStopping(true);
		setError(undefined);
		try {
			await stopDiscussionSessions([discussion.assistantId, ...Object.values(discussion.participantIds)]);
			writeLiveDiscussion(projectId, undefined);
			setDiscussion(undefined);
			setRoleSetupStates(initialRoleSetupStates());
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not end the live discussion");
		} finally {
			setIsStopping(false);
		}
	};

	const sendQuickRequest = async (requestedMessage?: string, pendingAction?: string) => {
		const clean = (requestedMessage ?? quickMessage).trim();
		if (!clean || isQuickSending) return;
		if (/^(?:open|show|go to|take me to)\b.*\bproject\b/i.test(clean)) {
			setQuickMessage("");
			onOpenProject();
			return;
		}
		setIsQuickSending(true);
		setQuickPendingAction(pendingAction);
		setQuickError(undefined);
		try {
			if (quickSessionId) {
				const { error: apiError } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
					params: { path: { sessionId: quickSessionId } },
					body: { message: `[QUICK_REQUEST] ${clean}` },
				});
				if (apiError) throw new Error(apiErrorMessage(apiError, "Could not send the quick request"));
				setQuickMessage("");
				await quickConversationQuery.refetch();
				return;
			}

			const projectResponse = await apiClient.GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId } },
			});
			const project =
				projectResponse.data?.status === "ok" ? (projectResponse.data.project as Project) : undefined;
			const sessionId = await createAgentSession({
				projectId,
				harness: "codex",
				issueId: `${SUGGESTION_LIVE_DISCUSSION_ISSUE_PREFIX}quick:${Date.now().toString(36)}`,
				displayName: "Quick request",
				prompt: buildQuickRequestPrompt(project?.path ?? "", clean),
				agentConfig: {
					model: QUICK_REQUEST_MODEL,
					reasoningEffort: "low",
					permissions: "auto",
				},
			});
			writeQuickRequestSession(projectId, sessionId);
			setQuickSessionId(sessionId);
			setQuickMessage("");
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		} catch (cause) {
			setQuickError(cause instanceof Error ? cause.message : "Could not run the quick request");
		} finally {
			setIsQuickSending(false);
			setQuickPendingAction(undefined);
		}
	};

	return (
		<section className="mt-4 rounded-xl border border-accent/25 bg-accent/5 p-4" aria-label="Discussion live session">
			<div className="flex flex-wrap items-start gap-3">
				<span className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
					<MessageSquareText className="size-4" aria-hidden="true" />
					{discussion ? <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-success" /> : null}
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="text-sm font-semibold text-foreground">Discussion live session</h2>
					<p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
						A fast Assistant keeps the raw context and notes while Sol, Fable, and K3 make the decisions. The
						Assistant listens and wakes them; it never votes.
					</p>
				</div>
				{discussion ? (
					<span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-3 text-xs font-semibold text-success">
						<Radio className="size-3.5" /> Live
					</span>
				) : (
					<button
						aria-expanded={expanded}
						className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-semibold text-foreground hover:bg-interactive-hover"
						onClick={() => setExpanded((current) => !current)}
						type="button"
					>
						{expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
						{expanded ? "Hide setup" : "Set up live session"}
					</button>
				)}
			</div>

			{expanded || discussion ? (
				<div className="mt-4 border-t border-border/70 pt-4">
					<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
						<RoleCard
							name="Assistant"
							description="Sol · listener, notes, wake-ups"
							color="border-emerald-500/30 bg-emerald-500/8 text-emerald-300"
							status={discussion ? "ready" : roleSetupStates.assistant}
							onOpen={discussion ? () => onOpenSession(discussion.assistantId) : undefined}
						/>
						{PARTICIPANTS.map((participant) => (
							<RoleCard
								color={participant.color}
								description={`${participant.model} · decision agent`}
								key={participant.id}
								name={participant.name}
								status={discussion ? "ready" : roleSetupStates[participant.id]}
								onOpen={
									discussion ? () => onOpenSession(discussion.participantIds[participant.id]) : undefined
								}
							/>
						))}
					</div>

					{discussion ? (
						<>
							<div className="mt-4 rounded-xl border border-border bg-background/70">
								<div className="flex items-center justify-between border-b border-border px-4 py-3">
									<div>
										<div className="text-sm font-semibold text-foreground">{discussion.title}</div>
										<div className="mt-0.5 text-xs text-muted-foreground">Shared live transcript</div>
									</div>
									<button
										className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-semibold text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
										disabled={isStopping}
										onClick={() => void endDiscussion()}
										type="button"
									>
										{isStopping ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
										End session
									</button>
								</div>
								<div className="max-h-96 min-h-56 overflow-y-auto p-4" aria-live="polite">
									{conversationQuery.isLoading ? (
										<div className="grid min-h-48 place-items-center text-xs text-muted-foreground">
											<Loader2 className="size-5 animate-spin" aria-label="Loading live discussion" />
										</div>
									) : publicEntries.length === 0 ? (
										<div className="grid min-h-48 place-items-center text-center text-xs leading-5 text-muted-foreground">
											<div>
												<Bot className="mx-auto mb-2 size-6 text-accent" />
												Assistant is listening and waking the decision agents.
											</div>
										</div>
									) : (
										<div className="grid gap-3">
											{publicEntries.map((entry) => (
												<div className="grid grid-cols-[70px_minmax(0,1fr)] gap-3" key={entry.id}>
													<div className="pt-0.5 text-xs font-semibold text-muted-foreground">{entry.speaker}</div>
													<div className="whitespace-pre-wrap rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-6 text-foreground/90">
														{entry.text}
													</div>
												</div>
											))}
										</div>
									)}
								</div>
								<div className="flex gap-2 border-t border-border p-3">
									<input
										aria-label="Message live discussion"
										className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-passive focus:border-accent"
										disabled={isSending}
										onChange={(event) => setMessage(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter" && !event.shiftKey) {
												event.preventDefault();
												void sendLiveMessage();
											}
										}}
										placeholder="Ask the three decision agents..."
										value={message}
									/>
									<button
										className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground disabled:opacity-50"
										disabled={!message.trim() || isSending}
										onClick={() => void sendLiveMessage()}
										type="button"
									>
										{isSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
										Send live
									</button>
								</div>
							</div>
							{latestResult ? (
								<div className="mt-3 rounded-lg border border-success/25 bg-success/8 p-3">
									<div className="text-xs font-semibold uppercase tracking-wide text-success">Recorded result</div>
									<p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground">{latestResult}</p>
								</div>
							) : null}
						</>
					) : (
						<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
							<p className="max-w-2xl text-xs leading-5 text-muted-foreground">
								The draft title and note become the raw shared prompt. All four sessions are read-only and use full
								permission mode only to avoid approval stalls while reading context and messaging each other.
							</p>
							<button
								className="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-4 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50"
								disabled={!title.trim() || isStarting}
								onClick={() => void startDiscussion()}
								type="button"
							>
								{isStarting ? <Loader2 className="size-4 animate-spin" /> : <Radio className="size-4" />}
								{isStarting ? "Starting four agents..." : "Start live discussion"}
							</button>
						</div>
					)}
				</div>
			) : null}

			{error || conversationQuery.isError ? (
				<div className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					<CircleAlert className="size-4 shrink-0" />
					{error ??
						(conversationQuery.error instanceof Error
							? conversationQuery.error.message
							: "Could not read the live discussion")}
				</div>
			) : null}

			<div
				aria-label="Quick request session"
				className="mt-4 border-t border-border/70 pt-4"
				role="region"
			>
				<div className="flex flex-wrap items-start gap-3">
					<span className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning/10 text-warning">
						<Zap className="size-4" aria-hidden="true" />
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-sm font-semibold text-foreground">Quick request</h3>
							<span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
								Sol · low effort
							</span>
						</div>
						<p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
							A lightweight session for short operational checks. It can inspect git, GitHub, and agent status,
							but it cannot change the project.
						</p>
					</div>
				</div>

				<div className="mt-3 flex flex-wrap gap-2">
					<QuickAction
						disabled={isQuickSending}
						icon={<GitBranch className="size-3.5" aria-hidden="true" />}
						label="Git push status"
						pending={quickPendingAction === "Git push status"}
						onClick={() =>
							void sendQuickRequest(
								"Check whether the current branch and all local commits are pushed upstream.",
								"Git push status",
							)
						}
					/>
					<QuickAction
						disabled={isQuickSending}
						icon={<Cloud className="size-3.5" aria-hidden="true" />}
						label="GitHub connection"
						pending={quickPendingAction === "GitHub connection"}
						onClick={() =>
							void sendQuickRequest(
								"Check the GitHub connection, authentication, repository, and remotes.",
								"GitHub connection",
							)
						}
					/>
					<QuickAction
						disabled={isQuickSending}
						icon={<Activity className="size-3.5" aria-hidden="true" />}
						label="Agent status"
						pending={quickPendingAction === "Agent status"}
						onClick={() =>
							void sendQuickRequest(
								"Check the current AO agent and session status for this project.",
								"Agent status",
							)
						}
					/>
					<QuickAction
						disabled={isQuickSending}
						icon={<FolderOpen className="size-3.5" aria-hidden="true" />}
						label="Open project"
						onClick={onOpenProject}
					/>
				</div>

				{quickEntries.length > 0 ? (
					<div className="mt-3 max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border bg-background/70 p-3" aria-live="polite">
						{quickEntries.map((entry) => (
							<div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2" key={entry.id}>
								<div className="pt-1 text-[11px] font-semibold text-muted-foreground">{entry.speaker}</div>
								<div className="whitespace-pre-wrap text-xs leading-5 text-foreground/90">{entry.text}</div>
							</div>
						))}
					</div>
				) : quickSessionId && quickConversationQuery.isLoading ? (
					<div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status">
						<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
						Loading quick request session...
					</div>
				) : null}

				<div className="mt-3 flex gap-2">
					<input
						aria-label="Quick request"
						className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-passive focus:border-accent"
						disabled={isQuickSending}
						onChange={(event) => setQuickMessage(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void sendQuickRequest();
							}
						}}
						placeholder="Ask a quick project-status question..."
						value={quickMessage}
					/>
					<button
						aria-busy={isQuickSending}
						className="inline-flex h-9 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-semibold text-background disabled:opacity-50"
						disabled={!quickMessage.trim() || isQuickSending}
						onClick={() => void sendQuickRequest()}
						type="button"
					>
						{isQuickSending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
						{isQuickSending ? "Checking..." : "Ask"}
					</button>
				</div>

				{quickError || quickConversationQuery.isError ? (
					<div className="mt-2 flex items-center gap-2 text-xs text-destructive" role="alert">
						<CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
						{quickError ??
							(quickConversationQuery.error instanceof Error
								? quickConversationQuery.error.message
								: "Could not read the quick request session")}
					</div>
				) : null}
			</div>
		</section>
	);
}

function QuickAction({
	disabled,
	icon,
	label,
	onClick,
	pending = false,
}: {
	disabled?: boolean;
	icon: ReactNode;
	label: string;
	onClick: () => void;
	pending?: boolean;
}) {
	return (
		<button
			className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : icon}
			{label}
		</button>
	);
}

function RoleCard({
	name,
	description,
	color,
	onOpen,
	status,
}: {
	name: string;
	description: string;
	color: string;
	onOpen?: () => void;
	status: RoleSetupState;
}) {
	const statusLabel = status[0].toUpperCase() + status.slice(1);
	const statusClass =
		status === "ready"
			? "opacity-100 shadow-sm"
			: status === "starting"
				? "opacity-70"
				: status === "failed"
					? "opacity-100 ring-1 ring-destructive/50"
					: "opacity-40 grayscale";
	return (
		<button
			aria-label={`${name}: ${statusLabel}`}
			className={`rounded-lg border p-3 text-left transition-all duration-300 ${color} ${statusClass} ${onOpen ? "hover:brightness-110" : "cursor-default"}`}
			disabled={!onOpen}
			onClick={onOpen}
			type="button"
		>
			<div className="flex items-center justify-between gap-2 text-sm font-semibold">
				{name}
				<span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide" role="status">
					{status === "ready" ? <Check className="size-3.5" aria-hidden="true" /> : null}
					{status === "starting" ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
					{status === "failed" ? <CircleAlert className="size-3.5" aria-hidden="true" /> : null}
					{statusLabel}
				</span>
			</div>
			<div className="mt-1 text-[11px] leading-4 opacity-80">{description}</div>
		</button>
	);
}

function publicDiscussionEntry(entry: ConversationEntry): { id: string; speaker: string; text: string }[] {
	const text = entry.text.trim();
	if (!text) return [];
	if (entry.role === "assistant" && /(^|\n)(NOTE:|RESULT:)/i.test(text)) {
		return [{ id: entry.id, speaker: "Assistant", text }];
	}
	if (entry.role !== "user") return [];
	const match = text.match(/^\[(SOL|FABLE|K3|USER_LIVE)\]\s*([\s\S]*)$/i);
	if (!match) return [];
	const speaker = match[1].toUpperCase() === "USER_LIVE" ? "You" : match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
	const publicText = match[2].replace(/\n\nWake Sol,[\s\S]*$/i, "").trim();
	return publicText ? [{ id: entry.id, speaker, text: publicText }] : [];
}

function publicQuickRequestEntry(entry: ConversationEntry): QuickRequestEntry[] {
	const text = entry.text.trim();
	if (!text) return [];
	if (entry.role === "assistant") {
		return [{ id: entry.id, speaker: "Quick request", text }];
	}
	if (entry.role !== "user") return [];
	const markerAt = text.lastIndexOf("[QUICK_REQUEST]");
	if (markerAt < 0) return [];
	const request = text.slice(markerAt + "[QUICK_REQUEST]".length).trim();
	return request ? [{ id: entry.id, speaker: "You", text: request }] : [];
}
