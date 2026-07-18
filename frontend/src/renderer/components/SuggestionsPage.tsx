import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, CircleAlert, Lightbulb, Loader2, Play, Plus, RotateCcw, Sparkles } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { cn } from "../lib/utils";
import { SuggestionDiscussionPanel } from "./SuggestionDiscussionPanel";

type Suggestion = components["schemas"]["Suggestion"];
type SuggestionPriority = Suggestion["priority"];
type SuggestionStatus = Suggestion["status"];

export const suggestionsQueryKey = (projectId: string) => ["suggestions", projectId] as const;
const SUGGESTION_ACTION_CLASS =
	"inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-50";
const SUGGESTION_PRIMARY_ACTION_CLASS =
	"border-accent/35 bg-accent/10 text-accent hover:bg-accent/15 hover:text-accent";
const SUGGESTION_DRAFT_STORAGE_PREFIX = "ao.suggestion-draft.v1";

type SuggestionDraft = {
	title: string;
	note: string;
	priority: SuggestionPriority;
};

function suggestionDraftStorageKey(projectId: string): string {
	return `${SUGGESTION_DRAFT_STORAGE_PREFIX}.${encodeURIComponent(projectId)}`;
}

function readSuggestionDraft(projectId: string): SuggestionDraft {
	const empty: SuggestionDraft = { title: "", note: "", priority: "normal" };
	if (typeof window === "undefined") return empty;
	try {
		const raw = window.localStorage?.getItem(suggestionDraftStorageKey(projectId));
		if (!raw) return empty;
		const value = JSON.parse(raw) as Partial<SuggestionDraft>;
		const priority = value.priority;
		return {
			title: typeof value.title === "string" ? value.title : "",
			note: typeof value.note === "string" ? value.note : "",
			priority: priority === "later" || priority === "important" ? priority : "normal",
		};
	} catch {
		return empty;
	}
}

function writeSuggestionDraft(projectId: string, draft: SuggestionDraft): void {
	if (typeof window === "undefined") return;
	try {
		if (!draft.title && !draft.note && draft.priority === "normal") {
			window.localStorage?.removeItem(suggestionDraftStorageKey(projectId));
			return;
		}
		window.localStorage?.setItem(suggestionDraftStorageKey(projectId), JSON.stringify(draft));
	} catch {
		// Draft persistence is a navigation convenience, never a submission gate.
	}
}

export function SuggestionsPage({
	projectId,
	onSessionStarted,
	onOpenProject,
}: {
	projectId: string;
	onSessionStarted: (sessionId: string) => void;
	onOpenProject: () => void;
}) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState(() => readSuggestionDraft(projectId).title);
	const [note, setNote] = useState(() => readSuggestionDraft(projectId).note);
	const [priority, setPriority] = useState<SuggestionPriority>(() => readSuggestionDraft(projectId).priority);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		writeSuggestionDraft(projectId, { title, note, priority });
	}, [note, priority, projectId, title]);

	const suggestions = useQuery({
		queryKey: suggestionsQueryKey(projectId),
		queryFn: async () => {
			const { data, error: apiError } = await apiClient.GET("/api/v1/projects/{projectId}/suggestions", {
				params: { path: { projectId } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not load suggestions"));
			return data?.suggestions ?? [];
		},
		refetchInterval: 5000,
	});

	const refresh = async () => {
		await queryClient.invalidateQueries({ queryKey: suggestionsQueryKey(projectId) });
	};

	const create = useMutation({
		mutationFn: async () => {
			const { data, error: apiError } = await apiClient.POST("/api/v1/projects/{projectId}/suggestions", {
				params: { path: { projectId } },
				body: { title: title.trim(), note: note.trim() || undefined, priority },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not add suggestion"));
			return data?.suggestion;
		},
		onSuccess: async () => {
			setTitle("");
			setNote("");
			setPriority("normal");
			setError(null);
			await refresh();
		},
		onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not add suggestion"),
	});

	const update = useMutation({
		mutationFn: async ({ id, status }: { id: string; status: SuggestionStatus }) => {
			const { error: apiError } = await apiClient.PATCH("/api/v1/projects/{projectId}/suggestions/{suggestionId}", {
				params: { path: { projectId, suggestionId: id } },
				body: { status },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not update suggestion"));
		},
		onSuccess: refresh,
		onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not update suggestion"),
	});

	const start = useMutation({
		mutationFn: async (id: string) => {
			const { data, error: apiError } = await apiClient.POST(
				"/api/v1/projects/{projectId}/suggestions/{suggestionId}/start",
				{ params: { path: { projectId, suggestionId: id } } },
			);
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not start suggestion worker"));
			if (!data?.sessionId) throw new Error("Suggestion worker returned no session");
			return data.sessionId;
		},
		onSuccess: async (sessionId) => {
			setError(null);
			await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: workspaceQueryKey })]);
			onSessionStarted(sessionId);
		},
		onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not start suggestion worker"),
	});

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!title.trim() || create.isPending) return;
		create.mutate();
	};

	const items = suggestions.data ?? [];
	const backlog = items.filter((item) => item.status === "backlog");
	const active = items.filter((item) => item.status === "in_progress");
	const finished = items.filter((item) => item.status === "done" || item.status === "dismissed");

	return (
		<main className="h-full overflow-y-auto bg-background px-6 py-6 lg:px-9">
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
				<section className="flex flex-wrap items-start justify-between gap-4">
					<div className="max-w-2xl">
						<div className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">
							<Lightbulb className="size-4" aria-hidden="true" />
							Grand workflow
						</div>
						<h1 className="text-2xl font-semibold tracking-tight text-foreground">Suggestions</h1>
						<p className="mt-2 text-sm leading-6 text-muted-foreground">
							Keep useful ideas without interrupting current implementation. Start one when worker capacity is free.
						</p>
					</div>
					<div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
						<span className="font-semibold text-foreground">{backlog.length}</span> waiting · {active.length} active
					</div>
				</section>

				<form className="rounded-xl border border-border bg-surface p-4 shadow-sm" onSubmit={submit}>
					<div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
						<Sparkles className="size-4 text-accent" aria-hidden="true" />
						Draft a suggestion
					</div>
					<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_160px_auto]">
						<div className="grid gap-2">
							<input
								aria-label="Suggestion title"
								className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-passive focus:border-accent"
								maxLength={120}
								onChange={(event) => setTitle(event.target.value)}
								placeholder="A useful improvement to revisit later"
								value={title}
							/>
							<textarea
								aria-label="Suggestion note"
								className="min-h-20 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-passive focus:border-accent"
								maxLength={4000}
								onChange={(event) => setNote(event.target.value)}
								placeholder="Why this matters to the broader workflow, constraints, or evidence to inspect"
								value={note}
							/>
						</div>
						<select
							aria-label="Suggestion priority"
							className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-accent"
							onChange={(event) => setPriority(event.target.value as SuggestionPriority)}
							value={priority}
						>
							<option value="later">Later</option>
							<option value="normal">Normal</option>
							<option value="important">Important</option>
						</select>
						<button
							className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
							disabled={!title.trim() || create.isPending}
							type="submit"
						>
							{create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
							Submit suggestion
						</button>
					</div>
					<SuggestionDiscussionPanel
						note={note}
						onOpenProject={onOpenProject}
						onOpenSession={onSessionStarted}
						projectId={projectId}
						title={title}
					/>
				</form>

				{error ? (
					<div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
						<CircleAlert className="size-4" aria-hidden="true" />
						{error}
					</div>
				) : null}

				{suggestions.isLoading ? (
					<div className="grid min-h-52 place-items-center text-sm text-muted-foreground">
						<Loader2 className="size-5 animate-spin" aria-label="Loading suggestions" />
					</div>
				) : suggestions.isError ? (
					<div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
						{suggestions.error instanceof Error ? suggestions.error.message : "Could not load suggestions"}
					</div>
				) : items.length === 0 ? (
					<div className="grid min-h-56 place-items-center rounded-xl border border-dashed border-border bg-surface/40 p-8 text-center">
						<div>
							<Lightbulb className="mx-auto size-8 text-passive" aria-hidden="true" />
							<p className="mt-3 text-sm font-semibold text-foreground">No suggestions yet</p>
							<p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
								The orchestrator can save ideas here with ao suggestion add, or you can add one above.
							</p>
						</div>
					</div>
				) : (
					<div className="grid items-start gap-4 xl:grid-cols-3">
						<SuggestionLane
							title="Backlog"
							description="Waiting for free capacity"
							items={backlog}
							empty="Nothing waiting"
							renderActions={(item) => (
								<>
									<button
										className={cn(SUGGESTION_ACTION_CLASS, SUGGESTION_PRIMARY_ACTION_CLASS)}
										disabled={start.isPending}
										onClick={() => start.mutate(item.id)}
										type="button"
									>
										<Play className="size-3.5" /> Start worker
									</button>
									<button
										className={SUGGESTION_ACTION_CLASS}
										onClick={() => update.mutate({ id: item.id, status: "dismissed" })}
										type="button"
									>
										<Archive className="size-3.5" /> Dismiss
									</button>
								</>
							)}
						/>
						<SuggestionLane
							title="In progress"
							description="Linked to a worker task"
							items={active}
							empty="No suggestion workers"
							renderActions={(item) => (
								<>
									{item.sessionId ? (
										<button
											className={cn(SUGGESTION_ACTION_CLASS, SUGGESTION_PRIMARY_ACTION_CLASS)}
											onClick={() => onSessionStarted(item.sessionId!)}
											type="button"
										>
											<Play className="size-3.5" /> Open worker
										</button>
									) : null}
									<button
										className={SUGGESTION_ACTION_CLASS}
										onClick={() => update.mutate({ id: item.id, status: "done" })}
										type="button"
									>
										<Check className="size-3.5" /> Done
									</button>
								</>
							)}
						/>
						<SuggestionLane
							title="Finished"
							description="Completed or set aside"
							items={finished}
							empty="No finished suggestions"
							renderActions={(item) => (
								<button
									className={SUGGESTION_ACTION_CLASS}
									onClick={() => update.mutate({ id: item.id, status: "backlog" })}
									type="button"
								>
									<RotateCcw className="size-3.5" /> Return to backlog
								</button>
							)}
						/>
					</div>
				)}
			</div>
		</main>
	);
}

function SuggestionLane({
	title,
	description,
	items,
	empty,
	renderActions,
}: {
	title: string;
	description: string;
	items: Suggestion[];
	empty: string;
	renderActions: (item: Suggestion) => ReactNode;
}) {
	return (
		<section className="rounded-xl border border-border bg-surface/55 p-3">
			<header className="mb-3 flex items-start justify-between gap-3 px-1">
				<div>
					<h2 className="text-sm font-semibold text-foreground">{title}</h2>
					<p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
				</div>
				<span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
					{items.length}
				</span>
			</header>
			<div className="grid gap-2">
				{items.length === 0 ? (
					<div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-passive">
						{empty}
					</div>
				) : (
					items.map((item) => (
						<article className="rounded-lg border border-border bg-background p-3 shadow-sm" key={item.id}>
							<div className="flex items-start justify-between gap-3">
								<h3 className="text-sm font-semibold leading-5 text-foreground">{item.title}</h3>
								<span
									className={cn(
										"shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
										item.priority === "important"
											? "bg-warning/15 text-warning"
											: item.priority === "later"
												? "bg-surface text-passive"
												: "bg-accent/12 text-accent",
									)}
								>
									{item.priority}
								</span>
							</div>
							{item.note ? (
								<p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{item.note}</p>
							) : null}
							{item.status === "dismissed" ? (
								<p className="mt-2 text-[11px] font-medium text-passive">Dismissed</p>
							) : null}
							<div className="mt-3 flex flex-wrap items-center gap-1.5">{renderActions(item)}</div>
						</article>
					))
				)}
			</div>
		</section>
	);
}
