import {
	ChevronDown,
	ChevronRight,
	CheckCircle2,
	CircleAlert,
	FileText,
	Gauge,
	Loader2,
	MessageSquareReply,
	Plus,
	Send,
	ShieldCheck,
	Sparkles,
	SquareTerminal,
	Trash2,
	X,
} from "lucide-react";
import {
	type ChangeEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isSuggestionDiscussionSession, type WorkspaceSession } from "../types/workspace";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import { readRuntimePreferences, writeRuntimePreferences } from "../lib/runtime-preferences";

export type ConversationGroup = {
	id: string;
	lines: string[];
	summary: string;
};

export type ConversationInputRequest = {
	actions?: Array<{
		input: string;
		label: string;
		tone: "primary" | "neutral";
	}>;
	kind: "approval" | "question";
	prompt: string;
};

export type ConversationSections = {
	thinkingGroups: ConversationGroup[];
	outputGroups: ConversationGroup[];
};

export type ConversationHistoryItem =
	| { id: string; role: "assistant"; groups: ConversationGroup[] }
	| { id: string; role: "user"; text: string };

const DECORATION_ONLY = /^[\s─━│┃┄┅┈┉┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬▀▄█░▒▓]+$/u;
const LOW_VALUE_LINE = /^(esc to|ctrl\+|shift\+|press .* to|tokens? used|context left)/i;
const APPROVAL_PROMPT =
	/(?:do you want to|would you like to|are you sure|permission|approve|allow|proceed|continue|run (?:this|the) command)/i;
const QUESTION_PROMPT = /(?:\?|choose (?:an?|one)|select (?:an?|one)|needs? your input|waiting for your)/i;
const APPROVAL_OPTION = /^[^\p{L}\p{N}]*(?:\[)?([1-9])(?:\]|[.)\]:-])?\s+(.+)$/u;
const APPROVAL_OPTION_LABEL = /(?:yes|no|allow|deny|approve|proceed|cancel|continue|run)/i;
const POSITIVE_OPTION = /(?:yes|allow|approve|proceed|continue|run)/i;
const USER_PROMPT_LINE = /^\s*(?:>|\u203a)\s+\S/u;
const ASSISTANT_MESSAGE_START = /^\s*(?:\u25cf|\u2022)\s+\S/u;
const OUTPUT_BOUNDARY =
	/(?:How is Claude doing this session|Baked for \d|Frosting|running stop hook|Tip: Working with HTML\/CSS)/i;
const MAX_CONVERSATION_GROUPS = 96;

type ComposerAttachment = {
	name: string;
	path: string;
};

const DEFAULT_RUNTIME_CHOICE = "default";
const MODEL_OPTIONS: Record<string, Array<{ label: string; value: string }>> = {
	codex: [
		{ value: DEFAULT_RUNTIME_CHOICE, label: "GPT default" },
		{ value: "gpt-5.5", label: "GPT-5.5" },
		{ value: "gpt-5.4", label: "GPT-5.4" },
	],
	"claude-code": [
		{ value: DEFAULT_RUNTIME_CHOICE, label: "Claude default" },
		{ value: "opus", label: "Claude Opus" },
		{ value: "sonnet", label: "Claude Sonnet" },
		{ value: "fable", label: "Claude Fable" },
	],
};
const ACCESS_OPTIONS = [
	{ value: DEFAULT_RUNTIME_CHOICE, label: "Default access" },
	{ value: "accept-edits", label: "Accept edits" },
	{ value: "auto", label: "Automatic" },
	{ value: "bypass-permissions", label: "Full access" },
] as const;
const EFFORT_OPTIONS = [
	{ value: DEFAULT_RUNTIME_CHOICE, label: "Default effort" },
	{ value: "low", label: "Low effort" },
	{ value: "medium", label: "Medium effort" },
	{ value: "high", label: "High effort" },
	{ value: "xhigh", label: "Extra high" },
] as const;

const DEFAULT_APPROVAL_ACTIONS: NonNullable<ConversationInputRequest["actions"]> = [
	{ input: "1", label: "Approve once", tone: "primary" },
	{ input: "2", label: "Always allow", tone: "neutral" },
	{ input: "3", label: "Deny", tone: "neutral" },
];

export function formatThinkingDuration(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function cleanTranscriptLine(line: string): string {
	return line.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+$/g, "");
}

function isUsefulLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.length > 0 &&
		/[\p{L}\p{N}]/u.test(trimmed) &&
		!DECORATION_ONLY.test(trimmed) &&
		!LOW_VALUE_LINE.test(trimmed)
	);
}

export function buildConversationGroups(transcriptLines: string[]): ConversationGroup[] {
	const groups: string[][] = [];
	let current: string[] = [];
	const flush = () => {
		const useful = current.map(cleanTranscriptLine).filter(isUsefulLine);
		current = [];
		if (useful.length === 0) return;
		const previous = groups.at(-1);
		if (previous?.join("\n") === useful.join("\n")) return;
		groups.push(useful);
	};

	for (const rawLine of transcriptLines) {
		const line = cleanTranscriptLine(rawLine);
		if (line.trim() === "") {
			flush();
			continue;
		}
		current.push(line);
	}
	flush();

	return groups.slice(-MAX_CONVERSATION_GROUPS).map((lines, index) => ({
		id: `${index}:${lines[0]?.slice(0, 48) ?? "thought"}`,
		lines,
		summary: [...lines].reverse().find(isUsefulLine)?.trim() ?? "Working...",
	}));
}

function findLastGroupIndex(
	groups: ConversationGroup[],
	predicate: (group: ConversationGroup, index: number) => boolean,
): number {
	for (let index = groups.length - 1; index >= 0; index -= 1) {
		if (predicate(groups[index], index)) return index;
	}
	return -1;
}

function isUserPromptGroup(group: ConversationGroup): boolean {
	return group.lines.some((line) => USER_PROMPT_LINE.test(line));
}

function isAssistantMessageStart(group: ConversationGroup): boolean {
	const firstUsefulLine = group.lines.find(isUsefulLine)?.trim() ?? "";
	return ASSISTANT_MESSAGE_START.test(firstUsefulLine) && !OUTPUT_BOUNDARY.test(firstUsefulLine);
}

function trimOutputGroups(groups: ConversationGroup[]): ConversationGroup[] {
	const output: ConversationGroup[] = [];
	for (const group of groups) {
		const boundaryIndex = group.lines.findIndex((line) => OUTPUT_BOUNDARY.test(line));
		const lines = boundaryIndex >= 0 ? group.lines.slice(0, boundaryIndex) : group.lines;
		const summary = [...lines].reverse().find(isUsefulLine)?.trim();
		if (summary) output.push({ ...group, lines, summary });
		if (boundaryIndex >= 0) break;
	}
	return output;
}

/**
 * Splits the rendered terminal transcript into the latest concise activity and
 * the most recent completed assistant response. Claude's optional feedback
 * prompt and stop-hook chrome are treated as UI boundaries, never as output.
 */
export function splitConversationSections(groups: ConversationGroup[], isWorking: boolean): ConversationSections {
	const lastPromptIndex = findLastGroupIndex(groups, isUserPromptGroup);
	const lastAssistantAfterPrompt = findLastGroupIndex(
		groups,
		(group, index) => index > lastPromptIndex && isAssistantMessageStart(group),
	);
	const lastAssistantBeforePrompt = findLastGroupIndex(
		groups,
		(group, index) => index < lastPromptIndex && isAssistantMessageStart(group),
	);

	let outputStart = isWorking ? lastAssistantBeforePrompt : lastAssistantAfterPrompt;
	if (!isWorking && outputStart < 0) outputStart = lastAssistantBeforePrompt;
	if (!isWorking && outputStart < 0) {
		outputStart = lastPromptIndex >= 0 ? lastPromptIndex + 1 : Math.max(0, groups.length - 8);
	}

	let outputEnd = groups.length;
	if (outputStart >= 0) {
		const nextPromptOffset = groups.slice(outputStart + 1).findIndex(isUserPromptGroup);
		if (nextPromptOffset >= 0) outputEnd = outputStart + 1 + nextPromptOffset;
	}
	const outputGroups = outputStart >= 0 ? trimOutputGroups(groups.slice(outputStart, outputEnd)) : [];

	const thinkingStart = lastPromptIndex >= 0 ? lastPromptIndex + 1 : Math.max(0, outputStart - 12);
	const thinkingEnd = !isWorking && outputStart > thinkingStart ? outputStart : groups.length;
	const thinkingGroups = groups
		.slice(thinkingStart, thinkingEnd)
		.filter((group) => !isUserPromptGroup(group) && !group.lines.some((line) => OUTPUT_BOUNDARY.test(line)))
		.slice(-12);

	return { thinkingGroups, outputGroups };
}

function userPromptText(group: ConversationGroup): string {
	return group.lines
		.filter((line) => USER_PROMPT_LINE.test(line))
		.map((line) => line.replace(/^\s*(?:>|\u203a)\s+/, "").trim())
		.filter(Boolean)
		.join("\n");
}

/**
 * Reconstructs completed chat turns from terminal transcript groups. Each
 * prompt remains in place and each completed response is appended after it;
 * the current in-progress trace stays in Latest thinking.
 */
export function buildConversationHistory(
	groups: ConversationGroup[],
	isWorking: boolean,
): ConversationHistoryItem[] {
	const promptIndexes = groups.flatMap((group, index) => (isUserPromptGroup(group) ? [index] : []));
	if (promptIndexes.length === 0) {
		if (isWorking) return [];
		const { outputGroups } = splitConversationSections(groups, false);
		return outputGroups.length > 0
			? [{ id: `assistant:${outputGroups[0]?.id ?? "output"}`, role: "assistant", groups: outputGroups }]
			: [];
	}

	const history: ConversationHistoryItem[] = [];
	for (let promptOffset = 0; promptOffset < promptIndexes.length; promptOffset += 1) {
		const promptIndex = promptIndexes[promptOffset] ?? 0;
		const promptGroup = groups[promptIndex];
		const prompt = promptGroup ? userPromptText(promptGroup) : "";
		if (prompt) {
			history.push({ id: `user:${promptGroup?.id ?? promptIndex}`, role: "user", text: prompt });
		}

		const nextPromptIndex = promptIndexes[promptOffset + 1];
		const turnEnd = nextPromptIndex ?? groups.length;
		const turnIsComplete = nextPromptIndex !== undefined || !isWorking;
		if (!turnIsComplete || promptIndex + 1 >= turnEnd) continue;

		let outputStart = -1;
		for (let index = promptIndex + 1; index < turnEnd; index += 1) {
			const group = groups[index];
			if (group && isAssistantMessageStart(group)) outputStart = index;
		}
		if (outputStart < 0) outputStart = promptIndex + 1;
		const outputGroups = trimOutputGroups(
			groups.slice(outputStart, turnEnd).filter((group) => !isUserPromptGroup(group)),
		);
		if (outputGroups.length > 0) {
			history.push({
				id: `assistant:${outputGroups[0]?.id ?? outputStart}`,
				role: "assistant",
				groups: outputGroups,
			});
		}
	}
	return history;
}

function pendingSentMessages(sentMessages: string[], history: ConversationHistoryItem[]): string[] {
	const transcriptPrompts = new Map<string, number>();
	for (const item of history) {
		if (item.role !== "user") continue;
		const normalized = item.text.trim();
		transcriptPrompts.set(normalized, (transcriptPrompts.get(normalized) ?? 0) + 1);
	}
	return sentMessages.filter((message) => {
		const normalized = message.trim();
		const remaining = transcriptPrompts.get(normalized) ?? 0;
		if (remaining === 0) return true;
		transcriptPrompts.set(normalized, remaining - 1);
		return false;
	});
}

export function findConversationInputRequest(
	session: WorkspaceSession,
	groups: ConversationGroup[],
): ConversationInputRequest | undefined {
	const activityNeedsInput = session.activity?.state === "blocked" || session.activity?.state === "waiting_input";
	if (session.status !== "needs_input" && !activityNeedsInput) return undefined;

	const lines = groups.flatMap((group) => group.lines);
	const approvalPrompt = [...lines].reverse().find((line) => APPROVAL_PROMPT.test(line));
	const questionPrompt = [...lines].reverse().find((line) => QUESTION_PROMPT.test(line));
	const fallback =
		groups.at(-1)?.summary ??
		(isSuggestionDiscussionSession(session)
			? "The discussion agent is waiting for your response."
			: "Orbit is waiting for your response.");
	const isApproval = session.activity?.state === "blocked" || Boolean(approvalPrompt);
	const numberedActionsByInput = new Map<string, NonNullable<ConversationInputRequest["actions"]>[number]>();
	if (isApproval) {
		for (const line of lines) {
			const match = line.trim().match(APPROVAL_OPTION);
			if (!match || !APPROVAL_OPTION_LABEL.test(match[2])) continue;
			numberedActionsByInput.set(match[1], {
				input: match[1],
				label: match[2].trim(),
				tone: POSITIVE_OPTION.test(match[2]) ? "primary" : "neutral",
			});
		}
	}
	const numberedActions = [...numberedActionsByInput.values()].sort(
		(left, right) => Number(left.input) - Number(right.input),
	);
	const inlineYesNo = isApproval && lines.some((line) => /(?:\(|\[)\s*y(?:es)?\s*\/\s*n(?:o)?\s*(?:\)|\])/i.test(line));
	const actions =
		numberedActions.length > 0
			? numberedActions.slice(0, 4)
			: inlineYesNo
				? [
						{ input: "y", label: "Proceed", tone: "primary" as const },
						{ input: "n", label: "Not now", tone: "neutral" as const },
					]
				: isApproval
					? DEFAULT_APPROVAL_ACTIONS
					: [];

	return {
		...(actions.length > 0 ? { actions } : {}),
		kind: isApproval ? "approval" : "question",
		prompt: (approvalPrompt ?? questionPrompt ?? fallback).trim(),
	};
}

export function OrchestratorConversation({
	session,
	transcriptLines,
	onClearHistory,
	onOpenTerminal,
	onTerminalInput,
}: {
	session: WorkspaceSession;
	transcriptLines: string[];
	onClearHistory?: () => void;
	onOpenTerminal?: () => void;
	onTerminalInput?: (input: string) => void;
}) {
	const groups = useMemo(() => buildConversationGroups(transcriptLines), [transcriptLines]);
	const isWorking = session.status === "working" || session.activity?.state === "active";
	const { thinkingGroups, outputGroups } = useMemo(
		() => splitConversationSections(groups, isWorking),
		[groups, isWorking],
	);
	const history = useMemo(() => buildConversationHistory(groups, isWorking), [groups, isWorking]);
	const inputRequest = useMemo(() => findConversationInputRequest(session, groups), [groups, session]);
	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	const [message, setMessage] = useState("");
	const [sentMessages, setSentMessages] = useState<string[]>([]);
	const [isSending, setIsSending] = useState(false);
	const [isAttaching, setIsAttaching] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
	const [modelChoice, setModelChoice] = useState(DEFAULT_RUNTIME_CHOICE);
	const [effortChoice, setEffortChoice] = useState(DEFAULT_RUNTIME_CHOICE);
	const [accessChoice, setAccessChoice] = useState(DEFAULT_RUNTIME_CHOICE);
	const [lastSentRuntimeSignature, setLastSentRuntimeSignature] = useState<string | null>(null);
	const [confirmingClear, setConfirmingClear] = useState(false);
	const turnStartedAtRef = useRef<number | null>(isWorking ? Date.now() : null);
	const previousIsWorkingRef = useRef(isWorking);
	const [turnTimingActive, setTurnTimingActive] = useState(isWorking);
	const [turnElapsedMs, setTurnElapsedMs] = useState(0);
	const [finishedTurnMs, setFinishedTurnMs] = useState<number | null>(null);
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const isDecisionBlocked = session.activity?.state === "blocked";
	const isSuggestionDiscussion = isSuggestionDiscussionSession(session);
	const agentName = isSuggestionDiscussion ? "Discussion agent" : "Orbit";
	const modelOptions = MODEL_OPTIONS[session.provider] ?? [{ value: DEFAULT_RUNTIME_CHOICE, label: "Model default" }];
	const selectedModelLabel =
		modelOptions.find((option) => option.value === modelChoice)?.label ?? modelOptions[0]?.label ?? "Model default";
	const selectedAccessLabel = ACCESS_OPTIONS.find((option) => option.value === accessChoice)?.label ?? "Default access";
	const effortOptions =
		session.provider === "claude-code"
			? [...EFFORT_OPTIONS, { value: "max", label: "Maximum effort" }]
			: EFFORT_OPTIONS;
	const selectedEffortLabel = effortOptions.find((option) => option.value === effortChoice)?.label ?? "Default effort";
	const pendingMessages = useMemo(() => pendingSentMessages(sentMessages, history), [history, sentMessages]);
	const thinkingStatus = turnTimingActive
		? `Thinking · ${formatThinkingDuration(turnElapsedMs)}`
		: finishedTurnMs !== null
			? `Finished in ${formatThinkingDuration(finishedTurnMs)}`
			: groups.length > 0
				? "Finished"
				: "Ready";

	const startTurnTiming = useCallback(() => {
		turnStartedAtRef.current = Date.now();
		setTurnElapsedMs(0);
		setFinishedTurnMs(null);
		setTurnTimingActive(true);
	}, []);

	useEffect(() => {
		setThinkingExpanded(false);
		setMessage("");
		setSentMessages([]);
		setSendError(null);
		setAttachments([]);
		setLastSentRuntimeSignature(null);
		setConfirmingClear(false);
		turnStartedAtRef.current = isWorking ? Date.now() : null;
		previousIsWorkingRef.current = isWorking;
		setTurnTimingActive(isWorking);
		setTurnElapsedMs(0);
		setFinishedTurnMs(null);
		const saved = readRuntimePreferences(session.workspaceId, session.provider, "orchestrator-composer");
		setModelChoice(saved.modelChoice ?? DEFAULT_RUNTIME_CHOICE);
		setEffortChoice(saved.effortChoice ?? DEFAULT_RUNTIME_CHOICE);
		setAccessChoice(saved.permissionChoice ?? DEFAULT_RUNTIME_CHOICE);
	}, [session.id, session.provider, session.workspaceId]);

	useEffect(() => {
		const wasWorking = previousIsWorkingRef.current;
		previousIsWorkingRef.current = isWorking;
		if (isWorking && !wasWorking) {
			if (turnStartedAtRef.current === null) startTurnTiming();
			return;
		}
		if (!isWorking && wasWorking && turnStartedAtRef.current !== null) {
			const duration = Math.max(0, Date.now() - turnStartedAtRef.current);
			turnStartedAtRef.current = null;
			setTurnElapsedMs(duration);
			setFinishedTurnMs(duration);
			setTurnTimingActive(false);
		}
	}, [isWorking, startTurnTiming]);

	useEffect(() => {
		if (!turnTimingActive) return;
		const updateElapsed = () => {
			if (turnStartedAtRef.current !== null) {
				setTurnElapsedMs(Math.max(0, Date.now() - turnStartedAtRef.current));
			}
		};
		updateElapsed();
		const timer = window.setInterval(updateElapsed, 1000);
		return () => window.clearInterval(timer);
	}, [turnTimingActive]);

	const rememberModelChoice = (value: string) => {
		setModelChoice(value);
		writeRuntimePreferences(session.workspaceId, session.provider, "orchestrator-composer", { modelChoice: value });
	};
	const rememberEffortChoice = (value: string) => {
		setEffortChoice(value);
		writeRuntimePreferences(session.workspaceId, session.provider, "orchestrator-composer", { effortChoice: value });
	};
	const rememberAccessChoice = (value: string) => {
		setAccessChoice(value);
		writeRuntimePreferences(session.workspaceId, session.provider, "orchestrator-composer", {
			permissionChoice: value,
		});
	};

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller || thinkingExpanded) return;
		scroller.scrollTop = scroller.scrollHeight;
	}, [
		groups.at(-1)?.summary,
		inputRequest?.prompt,
		outputGroups.at(-1)?.summary,
		pendingMessages.length,
		thinkingExpanded,
	]);

	const sendMessage = async () => {
		const clean = message.trim();
		if ((!clean && attachments.length === 0) || isSending) return;
		const visibleMessage =
			clean ||
			(attachments.length === 1
				? `Attached ${attachments[0]?.name ?? "a file"}`
				: `Attached ${attachments.length} files`);
		const outgoingSections = [clean || "Please review the attached file(s)."];
		if (attachments.length > 0) {
			outgoingSections.push(
				`Attached files (local paths):\n${attachments.map((attachment) => `- ${attachment.path}`).join("\n")}`,
			);
		}
		const runtimePreferences = [
			modelChoice !== DEFAULT_RUNTIME_CHOICE ? `model=${modelChoice}` : null,
			effortChoice !== DEFAULT_RUNTIME_CHOICE ? `effort=${effortChoice}` : null,
			accessChoice !== DEFAULT_RUNTIME_CHOICE ? `permissions=${accessChoice}` : null,
		].filter((preference): preference is string => Boolean(preference));
		const runtimeSignature = runtimePreferences.join(";");
		if (runtimeSignature !== lastSentRuntimeSignature && (runtimeSignature || lastSentRuntimeSignature !== null)) {
			outgoingSections.push(
				runtimeSignature
					? `Subagent runtime defaults (apply to every subagent): ${runtimeSignature}.`
					: "Subagent runtime defaults: reset.",
			);
		}
		const outgoingMessage = outgoingSections.join("\n\n");
		setIsSending(true);
		setSendError(null);
		try {
			const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: session.id } },
				body: { message: outgoingMessage },
			});
			if (error) {
				throw new Error(
					apiErrorMessage(error, isSuggestionDiscussion ? "Unable to message discussion agent" : "Unable to message orchestrator"),
				);
			}
			setLastSentRuntimeSignature(runtimeSignature);
			startTurnTiming();
			setSentMessages((current) => [...current, visibleMessage]);
			setMessage("");
			setAttachments([]);
		} catch (error) {
			setSendError(
				error instanceof Error
					? error.message
					: isSuggestionDiscussion
						? "Unable to message discussion agent"
						: "Unable to message orchestrator",
			);
		} finally {
			setIsSending(false);
		}
	};

	const handleFileSelection = async (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		event.target.value = "";
		if (files.length === 0 || isAttaching) return;
		setIsAttaching(true);
		setSendError(null);
		try {
			const savedAttachments: ComposerAttachment[] = [];
			for (const file of files) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const path = await aoBridge.terminal.saveDroppedFile({ name: file.name, bytes });
				if (path) savedAttachments.push({ name: file.name, path });
			}
			if (savedAttachments.length === 0) throw new Error("Unable to attach the selected file(s).");
			setAttachments((current) => {
				const knownPaths = new Set(current.map((attachment) => attachment.path));
				return [...current, ...savedAttachments.filter((attachment) => !knownPaths.has(attachment.path))];
			});
		} catch (error) {
			setSendError(error instanceof Error ? error.message : "Unable to attach the selected file(s).");
		} finally {
			setIsAttaching(false);
		}
	};

	const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		void sendMessage();
	};

	const focusComposer = () => {
		composerRef.current?.focus();
	};

	const clearHistory = () => {
		onClearHistory?.();
		setSentMessages([]);
		setThinkingExpanded(false);
		setConfirmingClear(false);
	};

	return (
		<div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background">
			<div className="flex min-h-11 shrink-0 items-center justify-end border-b border-border px-5 sm:px-8">
				{confirmingClear ? (
					<div
						aria-label="Clear chat history confirmation"
						className="flex flex-wrap items-center justify-end gap-2 text-caption text-muted-foreground"
						role="alertdialog"
					>
						<span>Clear the visible history? {agentName} keeps its working context.</span>
						<button
							className="h-7 rounded-md px-2.5 font-semibold text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
							onClick={() => setConfirmingClear(false)}
							type="button"
						>
							Cancel
						</button>
						<button
							className="h-7 rounded-md bg-destructive px-2.5 font-semibold text-destructive-foreground hover:opacity-90"
							onClick={clearHistory}
							type="button"
						>
							Clear history now
						</button>
					</div>
				) : (
					<button
						aria-label="Clear chat history"
						className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption font-medium text-muted-foreground transition hover:bg-interactive-hover hover:text-foreground"
						onClick={() => setConfirmingClear(true)}
						type="button"
					>
						<Trash2 className="size-3.5" aria-hidden="true" />
						Clear history
					</button>
				)}
			</div>
			<div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
				<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
					{history.map((item) =>
						item.role === "user" ? (
							<UserMessage key={item.id} text={item.text} />
						) : (
							<OutputCard groups={item.groups} key={item.id} />
						),
					)}

					{pendingMessages.map((sent, index) => (
						<UserMessage key={`pending:${sent}:${index}`} text={sent} />
					))}

					<ThinkingDisclosure
						active={turnTimingActive}
						expanded={thinkingExpanded}
						groups={thinkingGroups}
						onToggle={() => setThinkingExpanded((current) => !current)}
						status={thinkingStatus}
					/>

					{inputRequest && (
					<InputRequestCard
						agentName={agentName}
						request={inputRequest}
							onOpenTerminal={onOpenTerminal}
							onReply={focusComposer}
							onTerminalInput={onTerminalInput}
						/>
					)}
				</div>
			</div>

			<div className="shrink-0 bg-background/95 px-5 pb-4 pt-2 sm:px-8">
				<div className="mx-auto max-w-2xl">
					<div
						className={`rounded-2xl border bg-background px-3.5 pb-2.5 pt-3 shadow-[0_5px_22px_rgba(0,0,0,0.08)] ${
							isDecisionBlocked
								? "border-border opacity-65"
								: "border-border focus-within:border-border-strong focus-within:ring-1 focus-within:ring-border"
						}`}
					>
						<input
							aria-label="Choose files"
							className="sr-only"
							disabled={isDecisionBlocked || isAttaching}
							multiple
							onChange={(event) => void handleFileSelection(event)}
							ref={fileInputRef}
							type="file"
						/>
						<textarea
							aria-label={isSuggestionDiscussion ? "Message discussion agent" : "Message orchestrator"}
							className="max-h-36 min-h-10 w-full resize-none bg-transparent px-0.5 py-1 text-sm leading-5 text-foreground outline-none placeholder:text-passive"
							disabled={isDecisionBlocked}
							onChange={(event) => setMessage(event.target.value)}
							onKeyDown={handleComposerKeyDown}
							placeholder={
								isDecisionBlocked
									? "Review the approval request above..."
									: isSuggestionDiscussion
										? "Discuss and refine this suggestion..."
										: "Message Orbit..."
							}
							ref={composerRef}
							rows={1}
							value={message}
						/>
						{attachments.length > 0 && (
							<div className="mb-1.5 flex flex-wrap gap-1.5" aria-label="Attached files">
								{attachments.map((attachment) => (
									<span
										className="inline-flex min-w-0 max-w-52 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-caption text-foreground"
										key={attachment.path}
									>
										<FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
										<span className="truncate">{attachment.name}</span>
										<button
											aria-label={`Remove ${attachment.name}`}
											className="grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
											onClick={() =>
												setAttachments((current) => current.filter((item) => item.path !== attachment.path))
											}
											type="button"
										>
											<X className="size-3" aria-hidden="true" />
										</button>
									</span>
								))}
							</div>
						)}
						<div className="mt-1.5 flex items-center gap-2">
							<button
								aria-label="Add files"
								className="grid size-8 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition hover:bg-interactive-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
								disabled={isDecisionBlocked || isAttaching}
								onClick={() => fileInputRef.current?.click()}
								title="Add files"
								type="button"
							>
								{isAttaching ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-4" />}
							</button>
							<ComposerSelect
								ariaLabel="Access level"
								disabled={isDecisionBlocked}
								icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}
								label={selectedAccessLabel}
								onChange={rememberAccessChoice}
								options={ACCESS_OPTIONS}
								value={accessChoice}
							/>
							<ComposerSelect
								ariaLabel="Model choice"
								disabled={isDecisionBlocked}
								icon={<Sparkles className="size-3.5" aria-hidden="true" />}
								label={selectedModelLabel}
								onChange={rememberModelChoice}
								options={modelOptions}
								value={modelChoice}
							/>
							<ComposerSelect
								ariaLabel="Effort level"
								disabled={isDecisionBlocked}
								icon={<Gauge className="size-3.5" aria-hidden="true" />}
								label={selectedEffortLabel}
								onChange={rememberEffortChoice}
								options={effortOptions}
								value={effortChoice}
							/>
							<button
								aria-label="Send message"
								className="ml-auto grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition hover:opacity-85 disabled:cursor-not-allowed disabled:bg-muted-foreground disabled:opacity-35"
								disabled={isDecisionBlocked || isSending || (message.trim().length === 0 && attachments.length === 0)}
								onClick={() => void sendMessage()}
								type="button"
							>
								{isSending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
							</button>
						</div>
					</div>
					{sendError && <p className="mt-2 text-xs text-destructive">{sendError}</p>}
				</div>
			</div>
		</div>
	);
}

function UserMessage({ text }: { text: string }) {
	return (
		<div className="ml-auto max-w-[82%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-sm leading-5 text-foreground">
			{text}
		</div>
	);
}

function OutputCard({ groups }: { groups: ConversationGroup[] }) {
	if (groups.length === 0) return null;
	return (
		<section aria-label="Output" aria-live="polite" className="rounded-xl border border-border bg-surface p-4">
			<div className="mb-3 flex items-center gap-3">
				<span className="text-xs font-semibold text-foreground">Output</span>
				<span className="h-px min-w-8 flex-1 bg-border" aria-hidden="true" />
			</div>
			<div className="space-y-3 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
				{groups.map((group) => (
					<div key={group.id}>{group.lines.join("\n")}</div>
				))}
			</div>
		</section>
	);
}

function ComposerSelect({
	ariaLabel,
	disabled,
	icon,
	label,
	onChange,
	options,
	value,
}: {
	ariaLabel: string;
	disabled: boolean;
	icon: ReactNode;
	label: string;
	onChange: (value: string) => void;
	options: ReadonlyArray<{ label: string; value: string }>;
	value: string;
}) {
	return (
		<label
			className={`relative inline-flex h-8 min-w-0 max-w-36 items-center gap-1 rounded-lg px-2 text-caption text-muted-foreground transition ${
				disabled ? "opacity-40" : "cursor-pointer hover:bg-interactive-hover hover:text-foreground"
			}`}
			title={label}
		>
			{icon}
			<span className="truncate">{label}</span>
			<ChevronDown className="size-3 shrink-0" aria-hidden="true" />
			<select
				aria-label={ariaLabel}
				className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				value={value}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}

function InputRequestCard({
	agentName,
	request,
	onOpenTerminal,
	onReply,
	onTerminalInput,
}: {
	agentName: string;
	request: ConversationInputRequest;
	onOpenTerminal?: () => void;
	onReply: () => void;
	onTerminalInput?: (input: string) => void;
}) {
	const isApproval = request.kind === "approval";
	const [sentChoice, setSentChoice] = useState<string | null>(null);
	const quickActions = isApproval ? request.actions : undefined;

	useEffect(() => {
		setSentChoice(null);
	}, [request.prompt]);

	const chooseAction = (label: string, input: string) => {
		onTerminalInput?.(input);
		setSentChoice(label);
	};

	return (
		<section
			aria-label="Action required"
			aria-live="polite"
			className="my-2 rounded-xl border border-border bg-surface p-4"
		>
			<div className="flex items-center gap-2">
				<span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
					<CircleAlert className="size-3.5" aria-hidden="true" />
				</span>
				<span className="text-xs font-semibold text-foreground">{isApproval ? "Approval needed" : "Input needed"}</span>
				<span className="ml-auto text-caption text-passive">{agentName} is waiting</span>
			</div>
			<div className="mt-3 pl-9">
				<h3 className="whitespace-pre-wrap break-words text-sm font-medium leading-6 text-foreground">
					{request.prompt}
				</h3>
				<p className="mt-1 text-xs leading-5 text-muted-foreground">
					{isApproval ? `Choose an option to let ${agentName} continue.` : "Reply below when you're ready."}
				</p>
				<div className="mt-4 flex flex-wrap justify-end gap-2">
					{quickActions?.map((action) => (
						<button
							className={
								action.tone === "primary"
									? "inline-flex min-h-8 max-w-full items-center rounded-lg bg-foreground px-3 py-1.5 text-left text-xs font-semibold text-background transition hover:opacity-85 disabled:opacity-40"
									: "inline-flex min-h-8 max-w-full items-center rounded-lg border border-border bg-background px-3 py-1.5 text-left text-xs font-semibold text-foreground transition hover:bg-interactive-hover disabled:opacity-40"
							}
							disabled={!onTerminalInput || sentChoice !== null}
							key={`${action.input}:${action.label}`}
							onClick={() => chooseAction(action.label, action.input)}
							type="button"
						>
							<span className="whitespace-normal">{action.label}</span>
						</button>
					))}
					{!isApproval ? (
						<button
							className="inline-flex h-8 items-center gap-2 rounded-lg bg-foreground px-3 text-xs font-semibold text-background transition hover:opacity-85"
							onClick={onReply}
							type="button"
						>
							<MessageSquareReply className="size-4" aria-hidden="true" />
							Reply below
						</button>
					) : null}
					{!isApproval && onOpenTerminal && (
						<button
							className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-semibold text-foreground transition hover:bg-interactive-hover"
							onClick={onOpenTerminal}
							type="button"
						>
							<SquareTerminal className="size-4" aria-hidden="true" />
							Open terminal
						</button>
					)}
				</div>
				{sentChoice && <p className="mt-3 text-xs font-medium text-success">Sent: {sentChoice}</p>}
			</div>
		</section>
	);
}

function ThinkingDisclosure({
	active,
	groups,
	expanded,
	onToggle,
	status,
}: {
	active: boolean;
	groups: ConversationGroup[];
	expanded: boolean;
	onToggle: () => void;
	status: string;
}) {
	const latestSummary = groups.at(-1)?.summary ?? (active ? "Waiting for the latest update..." : "No thinking captured.");
	return (
		<section className="py-1">
			<div className="flex items-center gap-3">
				<button
					aria-expanded={expanded}
					className="flex min-w-0 max-w-[86%] items-center gap-1.5 rounded-md py-1 text-left text-xs text-muted-foreground transition hover:text-foreground"
					onClick={onToggle}
					type="button"
				>
					{active ? (
						<Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden="true" />
					) : (
						<CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden="true" />
					)}
					<span aria-live="polite" className="shrink-0 font-medium text-foreground">
						{status}
					</span>
					<span className="min-w-0 whitespace-pre-wrap break-words text-passive">{latestSummary}</span>
					{expanded ? (
						<ChevronDown className="size-3.5 shrink-0 text-passive" aria-hidden="true" />
					) : (
						<ChevronRight className="size-3.5 shrink-0 text-passive" aria-hidden="true" />
					)}
				</button>
				<span className="h-px min-w-8 flex-1 bg-border" aria-hidden="true" />
			</div>
			{expanded && (
				<div className="mt-3 space-y-3 border-l border-border pl-4">
					{groups.length > 0 ? (
						groups.map((group) => (
							<div
								className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground"
								key={group.id}
							>
								{group.lines.join("\n")}
							</div>
						))
					) : (
						<p className="text-xs leading-5 text-muted-foreground">
							{active ? "The agent is working; detailed thinking has not arrived yet." : "No detailed thinking was captured."}
						</p>
					)}
				</div>
			)}
		</section>
	);
}
