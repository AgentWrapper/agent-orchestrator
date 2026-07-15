import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, MessageSquareText, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { components } from "../../api/schema";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { readRuntimePreferences, writeRuntimePreferences } from "../lib/runtime-preferences";
import { SUGGESTION_DISCUSSION_ISSUE_PREFIX, type AgentProvider } from "../types/workspace";
import { RequiredAgentField } from "./CreateProjectAgentSheet";

type Project = components["schemas"]["Project"];

const PROJECT_DEFAULT = "__project_default__";
const CUSTOM_MODEL = "__custom_model__";
const MAX_SESSION_PROMPT_BYTES = 4096;

const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
	codex: [
		{ value: "gpt-5.5", label: "GPT-5.5" },
		{ value: "gpt-5.4", label: "GPT-5.4" },
	],
	"claude-code": [
		{ value: "opus", label: "Claude Opus (latest)" },
		{ value: "sonnet", label: "Claude Sonnet (latest)" },
		{ value: "fable", label: "Claude Fable (latest)" },
	],
};

const EFFORT_OPTIONS = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "Extra high" },
] as const;

const ACCESS_OPTIONS = [
	{ value: "default", label: "Agent default" },
	{ value: "accept-edits", label: "Accept edits" },
	{ value: "auto", label: "Automatic" },
	{ value: "bypass-permissions", label: "Full access" },
] as const;

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

export function buildSuggestionDiscussionPrompt(title: string, note: string): string {
	const prefix = `You are a dedicated suggestion discussion agent. Help the user question, refine, and sharpen this draft before it is submitted to the project suggestion backlog.

This is a discussion-only session. Do not edit files, run mutating commands, commit, push, create a pull request, submit the suggestion, or begin implementing it. You may inspect the repository read-only when evidence would improve the discussion. Preserve the user's intent and ask concise clarifying questions instead of replacing it with your own proposal.

When the user is satisfied, end with copy-ready fields labeled "Suggested title" and "Suggested note". Keep the conversation natural and retain prior turns as context.

Draft title: ${title.trim()}

Draft note:
`;
	const cleanNote = note.trim() || "No note yet. Help the user identify the motivation, constraints, and useful evidence.";
	const truncationMarker = "\n\n[Draft note truncated to fit the session prompt.]";
	const available = MAX_SESSION_PROMPT_BYTES - utf8Length(prefix);
	if (utf8Length(cleanNote) <= available) return prefix + cleanNote;
	return prefix + truncateUtf8(cleanNote, Math.max(0, available - utf8Length(truncationMarker))) + truncationMarker;
}

export function SuggestionDiscussionPanel({
	projectId,
	title,
	note,
	lastSessionId,
	onOpenSession,
	onStarted,
}: {
	projectId: string;
	title: string;
	note: string;
	lastSessionId?: string;
	onOpenSession: (sessionId: string) => void;
	onStarted: (sessionId: string) => void;
}) {
	const queryClient = useQueryClient();
	const agentId = useId();
	const modelId = useId();
	const effortId = useId();
	const accessId = useId();
	const [expanded, setExpanded] = useState(false);
	const [agent, setAgent] = useState("");
	const [agentTouched, setAgentTouched] = useState(false);
	const [modelChoice, setModelChoice] = useState(PROJECT_DEFAULT);
	const [customModel, setCustomModel] = useState("");
	const [effortChoice, setEffortChoice] = useState(PROJECT_DEFAULT);
	const [accessChoice, setAccessChoice] = useState(PROJECT_DEFAULT);
	const [isStarting, setIsStarting] = useState(false);
	const [error, setError] = useState<string>();

	const projectQuery = useQuery({
		queryKey: ["project", projectId],
		enabled: expanded,
		queryFn: async () => {
			const { data, error: apiError } = await apiClient.GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not load discussion defaults"));
			if (data?.status !== "ok") throw new Error("Project config is unavailable.");
			return data.project as Project;
		},
	});
	const agentsQuery = useQuery({ ...agentsQueryOptions, enabled: expanded });
	const refreshAgentsMutation = useMutation({
		mutationFn: refreshAgents,
		onSuccess: (next) => queryClient.setQueryData(agentsQueryKey, next),
	});

	const baseAgentConfig = projectQuery.data?.config?.agentConfig;
	const workerConfig = projectQuery.data?.config?.worker;
	const workerAgentConfig = workerConfig?.agentConfig;
	const defaultWorkerAgent = workerConfig?.agent ?? "";
	const selectedHarness = agent || defaultWorkerAgent;
	const modelOptions = MODEL_OPTIONS[selectedHarness] ?? [];
	const projectModel = workerAgentConfig?.model || baseAgentConfig?.model || "";
	const projectEffort = workerAgentConfig?.reasoningEffort || baseAgentConfig?.reasoningEffort || "";
	const projectAccess = workerAgentConfig?.permissions || baseAgentConfig?.permissions || "";
	const autoBypassWorkerPermissions = projectQuery.data?.config?.autoBypassWorkerPermissions ?? false;

	useEffect(() => {
		if (expanded && !agentTouched) setAgent(defaultWorkerAgent);
	}, [agentTouched, defaultWorkerAgent, expanded]);

	useEffect(() => {
		if (!expanded || !selectedHarness) return;
		const saved = readRuntimePreferences(projectId, selectedHarness, "suggestion-discussion");
		setModelChoice(saved.modelChoice ?? PROJECT_DEFAULT);
		setCustomModel(saved.customModel ?? "");
		setEffortChoice(saved.effortChoice ?? PROJECT_DEFAULT);
		setAccessChoice(saved.permissionChoice ?? PROJECT_DEFAULT);
	}, [expanded, projectId, selectedHarness]);

	const rememberPreference = (
		patch: { customModel?: string; effortChoice?: string; modelChoice?: string; permissionChoice?: string },
	) => {
		if (selectedHarness) writeRuntimePreferences(projectId, selectedHarness, "suggestion-discussion", patch);
	};

	const startDiscussion = async () => {
		const cleanTitle = title.trim();
		if (!cleanTitle || isStarting) return;
		const selectedModel =
			modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice === PROJECT_DEFAULT ? "" : modelChoice;
		const selectedEffort = effortChoice === PROJECT_DEFAULT ? "" : effortChoice;
		const selectedAccess = autoBypassWorkerPermissions
			? "bypass-permissions"
			: accessChoice === PROJECT_DEFAULT
				? ""
				: accessChoice;
		const agentConfig =
			selectedModel || selectedEffort || selectedAccess
				? {
						model: selectedModel || undefined,
						reasoningEffort: selectedEffort || undefined,
						permissions: selectedAccess || undefined,
					}
				: undefined;

		setIsStarting(true);
		setError(undefined);
		try {
			const { data, error: apiError } = await apiClient.POST("/api/v1/sessions", {
				body: {
					projectId,
					kind: "worker",
					harness: agentTouched && agent ? (agent as AgentProvider) : undefined,
					issueId: `${SUGGESTION_DISCUSSION_ISSUE_PREFIX}${cleanTitle}`,
					displayName: "Discuss suggestion",
					prompt: buildSuggestionDiscussionPrompt(cleanTitle, note),
					agentConfig,
				},
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not start discussion agent"));
			if (!data?.session?.id) throw new Error("Discussion agent returned no session");
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			onStarted(data.session.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not start discussion agent");
		} finally {
			setIsStarting(false);
		}
	};

	return (
		<section className="mt-4 rounded-lg border border-accent/25 bg-accent/5 p-3" aria-label="Suggestion discussion agent">
			<div className="flex flex-wrap items-start gap-3">
				<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
					<MessageSquareText className="size-4" aria-hidden="true" />
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="text-sm font-semibold text-foreground">Discuss before submitting</h2>
					<p className="mt-1 text-xs leading-5 text-muted-foreground">
						A dedicated agent can inspect context, ask questions, and return a refined title and note. It
						cannot submit or implement the suggestion.
					</p>
				</div>
				{lastSessionId ? (
					<button
						className="h-8 rounded-md border border-border px-3 text-xs font-semibold text-foreground hover:bg-interactive-hover"
						onClick={() => onOpenSession(lastSessionId)}
						type="button"
					>
						Open discussion
					</button>
				) : null}
				<button
					aria-expanded={expanded}
					className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-semibold text-foreground hover:bg-interactive-hover"
					onClick={() => setExpanded((current) => !current)}
					type="button"
				>
					{expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
					{expanded ? "Hide setup" : "Set up discussion"}
				</button>
			</div>

			{expanded ? (
				<div className="mt-4 border-t border-border/70 pt-4">
					<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
						<div>
							<RequiredAgentField
								id={agentId}
								label="Agent"
								placeholder="Project default"
								value={agent}
								authorized={agentsQuery.data?.authorized}
								installed={agentsQuery.data?.installed}
								supported={agentsQuery.data?.supported}
								disabled={agentsQuery.isFetching && agentsQuery.data === undefined}
								onChange={(value) => {
									setAgent(value);
									setAgentTouched(true);
								}}
							/>
							<button
								className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
								disabled={refreshAgentsMutation.isPending}
								onClick={() => refreshAgentsMutation.mutate()}
								type="button"
							>
								{refreshAgentsMutation.isPending ? "Refreshing agents..." : "Refresh agents"}
							</button>
						</div>
						<RuntimeSelect
							id={modelId}
							label="Model"
							onChange={(value) => {
								setModelChoice(value);
								rememberPreference({ modelChoice: value });
							}}
							value={modelChoice}
						>
							<option value={PROJECT_DEFAULT}>
								{projectModel ? `Project default: ${projectModel}` : "Agent default"}
							</option>
							{modelOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
							<option value={CUSTOM_MODEL}>Custom model...</option>
						</RuntimeSelect>
						<RuntimeSelect
							id={effortId}
							label="Effort"
							onChange={(value) => {
								setEffortChoice(value);
								rememberPreference({ effortChoice: value });
							}}
							value={effortChoice}
						>
							<option value={PROJECT_DEFAULT}>
								{projectEffort ? `Project default: ${projectEffort}` : "Model default"}
							</option>
							{EFFORT_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
							{selectedHarness === "claude-code" ? <option value="max">Maximum</option> : null}
						</RuntimeSelect>
						<RuntimeSelect
							disabled={autoBypassWorkerPermissions}
							id={accessId}
							label="Access"
							value={autoBypassWorkerPermissions ? "bypass-permissions" : accessChoice}
							onChange={(value) => {
								setAccessChoice(value);
								rememberPreference({ permissionChoice: value });
							}}
						>
							<option value={PROJECT_DEFAULT}>
								{projectAccess ? `Project default: ${projectAccess}` : "Project default"}
							</option>
							{ACCESS_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</RuntimeSelect>
					</div>

					{modelChoice === CUSTOM_MODEL ? (
						<input
							aria-label="Discussion custom model"
							className="mt-3 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-accent md:max-w-sm"
							onChange={(event) => {
								setCustomModel(event.target.value);
								rememberPreference({ customModel: event.target.value });
							}}
							placeholder="Model ID or alias"
							value={customModel}
						/>
					) : null}

					{autoBypassWorkerPermissions ? (
						<p className="mt-2 text-xs font-medium text-warning">All subagents have complete access.</p>
					) : null}
					{projectQuery.isError || agentsQuery.isError || refreshAgentsMutation.isError || error ? (
						<p className="mt-3 text-xs text-destructive">
							{error ??
								(projectQuery.error instanceof Error ? projectQuery.error.message : undefined) ??
								(agentsQuery.error instanceof Error ? agentsQuery.error.message : undefined) ??
								(refreshAgentsMutation.error instanceof Error
									? refreshAgentsMutation.error.message
									: "Could not load discussion setup")}
						</p>
					) : null}

					<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
						<p className="text-xs text-muted-foreground">
							Your draft stays here and is not submitted when the chat starts.
						</p>
						<button
							className="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-4 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50"
							disabled={!title.trim() || isStarting || projectQuery.isLoading}
							onClick={() => void startDiscussion()}
							type="button"
						>
							{isStarting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
							{isStarting ? "Starting..." : lastSessionId ? "Start new discussion" : "Start discussion"}
						</button>
					</div>
				</div>
			) : null}
		</section>
	);
}

function RuntimeSelect({
	id,
	label,
	value,
	onChange,
	disabled = false,
	children,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<label className="grid content-start gap-1.5 text-xs font-medium text-muted-foreground" htmlFor={id}>
			{label}
			<select
				className="h-9 min-w-0 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-accent disabled:opacity-60"
				disabled={disabled}
				id={id}
				onChange={(event) => onChange(event.target.value)}
				value={value}
			>
				{children}
			</select>
		</label>
	);
}
