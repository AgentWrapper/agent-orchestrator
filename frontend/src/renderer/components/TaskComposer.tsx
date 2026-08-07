import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import type { components } from "../../api/schema";
import { apiClient, apiErrorCode, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { agentsQueryKey, agentsQueryOptions, refreshAgentsIfStale } from "../hooks/useAgentsQuery";
import {
	agentModelsQueryKey,
	agentModelsQueryOptions,
	refreshAgentModels,
	revalidateAgentModels,
	type AgentModelCatalog,
} from "../hooks/useAgentModelsQuery";
import { AgentModelCombobox } from "./settings/AgentModelCombobox";
import { SettingsOptionMenu } from "./settings/SettingsOptionMenu";

type Project = components["schemas"]["Project"];
type DelegateAgent = components["schemas"]["DelegateTaskRequest"]["agent"];

type CreateTaskInput = {
	projectId: string;
	brief: string;
	agent?: DelegateAgent;
	model?: string;
	mode?: "tui";
};

const CHAT_PREFLIGHT_CODES = new Set([
	"SESSION_MODE_UNSUPPORTED",
	"CHAT_DRIVER_UNAVAILABLE",
	"CHAT_DRIVER_INCOMPATIBLE",
	"CHAT_AUTH_REQUIRED",
]);

class TaskCreateError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "TaskCreateError";
	}
}

export type TaskComposerProps = {
	projectId?: string;
	onCreated: (sessionId: string) => void;
	onCancel?: () => void;
	onDirtyChange?: (dirty: boolean) => void;
	onSubmittingChange?: (submitting: boolean) => void;
	autoFocusTitle?: boolean;
};

export function TaskComposer({
	projectId,
	onCreated,
	onCancel,
	onDirtyChange,
	onSubmittingChange,
	autoFocusTitle,
}: TaskComposerProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const promptId = useId();
	const modelId = useId();
	const agentId = useId();
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("");
	const [mode, setMode] = useState("");
	const [agent, setAgent] = useState("");
	const [agentTouched, setAgentTouched] = useState(false);
	const [modelTouched, setModelTouched] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [modelWarning, setModelWarning] = useState<string | undefined>();
	const [canCreateAsTUI, setCanCreateAsTUI] = useState(false);
	const createTask = useCallback(
		async (input: CreateTaskInput): Promise<string> => {
			void captureRendererEvent("ao.renderer.task_create_requested", { project_id: input.projectId });
			try {
				const { data, error } = await apiClient.POST("/api/v1/orchestrators/delegate", {
					body: {
						projectId: input.projectId,
						brief: input.brief,
						agent: input.agent,
						model: input.model,
						...(input.mode ? { mode: input.mode } : {}),
					},
				});
				if (error) {
					throw new TaskCreateError(
						apiErrorMessage(error, t("newTask.unableToStart")),
						apiErrorCode(error),
					);
				}
				if (!data?.workerId) throw new Error(t("newTask.noSession"));
				void captureRendererEvent("ao.renderer.task_create_succeeded", { project_id: input.projectId });
				return data.workerId;
			} catch (err) {
				void captureRendererEvent("ao.renderer.task_create_failed", { project_id: input.projectId });
				void queryClient.invalidateQueries({ queryKey: agentsQueryKey });
				throw err instanceof Error ? err : new Error(t("newTask.unableToStart"));
			}
		},
		[queryClient, t],
	);

	const projectQuery = useQuery({
		queryKey: ["project", projectId],
		enabled: Boolean(projectId),
		queryFn: async () => {
			const { data, error: apiError } = await apiClient.GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId as string } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
			if (data?.status !== "ok") throw new Error(t("newTask.configUnavailable"));
			return data.project as Project;
		},
	});
	const agentsQuery = useQuery(agentsQueryOptions);
	// Freshen the inventory on open so a just-installed or just-authenticated agent
	// is present without the user asking for it.
	useEffect(() => {
		void refreshAgentsIfStale().then((next) => {
			if (next) queryClient.setQueryData(agentsQueryKey, next);
		});
	}, [queryClient]);
	// The composer preselects the agent and model a spawn would actually use
	// instead of parking the controls on a "default" label the user has to
	// remember. A caption names where the preselection came from.
	const projectWorkerAgent = projectQuery.data?.config?.worker?.agent ?? "";
	const globalDefaultAgent = projectQuery.data?.agent ?? "";
	const defaultWorkerAgent = projectWorkerAgent || globalDefaultAgent;
	const selectedAgent = agent || defaultWorkerAgent;
	const defaultWorkerModel =
		projectQuery.data?.config?.worker?.agentConfig?.model ?? projectQuery.data?.config?.agentConfig?.model ?? "";
	const defaultWorkerMode =
		projectQuery.data?.config?.worker?.agentConfig?.mode ?? projectQuery.data?.config?.agentConfig?.mode ?? "";
	const projectModelForSelectedAgent = selectedAgent === defaultWorkerAgent ? defaultWorkerModel : "";
	const projectModeForSelectedAgent = selectedAgent === defaultWorkerAgent ? defaultWorkerMode : "";
	const agentCatalog = agentsQuery.data;

	// Shares the picker's query key, so this is the same fetch, not a second one.
	const modelCatalogQuery = useQuery(agentModelsQueryOptions(selectedAgent, projectId ?? ""));
	const catalogDefaultOption = modelCatalogQuery.data?.models?.find((item) => item.isDefault)?.id ?? "";
	const catalogUsesModes = modelCatalogQuery.data?.selectionMode === "mode";
	const defaultModelForSelectedAgent =
		projectModelForSelectedAgent || (catalogUsesModes ? "" : catalogDefaultOption);
	const defaultModeForSelectedAgent = projectModeForSelectedAgent || (catalogUsesModes ? catalogDefaultOption : "");

	const selectedAgentLabel =
		agentCatalog?.supported?.find((item) => item.id === selectedAgent)?.label || selectedAgent;

	// Says where each inherited value came from, in words. Only inherited values
	// are named: once you pick something yourself, there is nothing to explain.
	const agentProvenance =
		selectedAgent !== "" && selectedAgent === defaultWorkerAgent
			? projectWorkerAgent !== ""
				? t("newTask.fromProjectAgent")
				: t("newTask.fromGlobalAgent")
			: undefined;
	const hasResolvedModelDefault =
		defaultModelForSelectedAgent !== "" || defaultModeForSelectedAgent !== "";
	const modelIsDefault =
		hasResolvedModelDefault &&
		model === defaultModelForSelectedAgent &&
		mode === defaultModeForSelectedAgent;
	const modelProvenance =
		model === "" && mode === "" && selectedAgentLabel
			? t("newTask.fromAgentModel", { agent: selectedAgentLabel })
			: !modelIsDefault
				? undefined
				: projectModelForSelectedAgent !== "" || projectModeForSelectedAgent !== ""
					? t("newTask.fromProjectModel")
					: t("newTask.fromAgentModel", { agent: selectedAgentLabel });
	const provenance = [agentProvenance, modelProvenance].filter(Boolean).join(" · ");

	useEffect(() => {
		if (!agentTouched) setAgent(defaultWorkerAgent);
	}, [agentTouched, defaultWorkerAgent]);
	useEffect(() => {
		if (!modelTouched) {
			setModel(defaultModelForSelectedAgent);
			setMode(defaultModeForSelectedAgent);
		}
	}, [defaultModelForSelectedAgent, defaultModeForSelectedAgent, modelTouched]);

	const isDirty = prompt.trim() !== "" || modelTouched;
	useEffect(() => {
		onDirtyChange?.(isDirty);
	}, [isDirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	useEffect(() => {
		onSubmittingChange?.(isSubmitting);
	}, [isSubmitting, onSubmittingChange]);
	useEffect(() => () => onSubmittingChange?.(false), [onSubmittingChange]);

	const submitTask = async (interfaceMode?: "tui") => {
		if (!projectId || isSubmitting) return;

		const cleanModel = model.trim();
		const cleanMode = mode.trim();
		const requestedModel =
			modelTouched && (cleanModel !== defaultModelForSelectedAgent || cleanMode !== defaultModeForSelectedAgent)
				? cleanModel || cleanMode || undefined
				: undefined;

		setIsSubmitting(true);
		setError(undefined);
		setCanCreateAsTUI(false);
		try {
			const sessionId = await createTask({
				projectId,
				brief: prompt,
				// The visible selection is authoritative: it is either the user's pick
				// or the resolved default, so spawning names it explicitly.
				agent: selectedAgent ? (selectedAgent as CreateTaskInput["agent"]) : undefined,
				model: requestedModel,
				mode: interfaceMode,
			});
			onCreated(sessionId);
		} catch (err) {
			setCanCreateAsTUI(
				interfaceMode !== "tui" &&
					err instanceof TaskCreateError &&
					Boolean(err.code && CHAT_PREFLIGHT_CODES.has(err.code)),
			);
			setError(err instanceof Error ? err.message : t("newTask.unableToStart"));
		} finally {
			setIsSubmitting(false);
		}
	};

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void submitTask();
	};

	return (
		<form onSubmit={submit} className="flex flex-col">
			{/* The task is the only thing with weight here: no field label, no border,
			    just the caret. Everything below it is a decision you usually skip. */}
			<label className="sr-only" htmlFor={promptId}>
				{t("newTask.task")}
			</label>
			<textarea
				id={promptId}
				autoFocus={autoFocusTitle}
				className="min-h-textarea-min w-full resize-none bg-transparent px-(--size-modal-padding) pb-4 pt-1 text-md leading-relaxed text-foreground outline-none placeholder:text-passive"
				placeholder={t("newTask.taskPlaceholder")}
				value={prompt}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}
				}}
			/>

			{(error || modelWarning) && (
				<div className="px-(--size-modal-padding) pb-3">
					{error && (
						<div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
							<span>{error}</span>
							{/* Chat preflight failed for this agent: offer the terminal interface
							    rather than making the user rediscover the task. */}
							{canCreateAsTUI ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={isSubmitting}
									onClick={() => void submitTask("tui")}
									className="shrink-0"
								>
									{t("newTask.createAsTui")}
								</Button>
							) : null}
						</div>
					)}
					{!error && modelWarning && <p className="text-caption text-warning">{modelWarning}</p>}
				</div>
			)}

			{/* Two bands: what it will run with, then what you can do about it. One row
			    holding chips and buttons together reads as a crowded toolbar. */}
			<div className="border-t border-border/70 px-(--size-modal-padding) py-3">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					{/* One sentence — "Runs with <agent> <model>" — states what will happen,
					    instead of two labelled fields the reader has to assemble themselves. */}
					<span className="eyebrow-label shrink-0">{t("newTask.runsWith")}</span>
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<RequiredAgentField
							id={agentId}
							variant="chip"
							label={t("newTask.agent")}
							placeholder={t("newTask.selectAgent")}
							value={agent}
							authorized={agentCatalog?.authorized}
							installed={agentCatalog?.installed}
							supported={agentCatalog?.supported}
							disabled={agentsQuery.isFetching && agentCatalog === undefined}
							onChange={(value) => {
								setAgent(value);
								setAgentTouched(true);
								setModelTouched(false);
							}}
						/>
						<TaskModelPicker
							id={modelId}
							agentId={selectedAgent}
							agentLabel={selectedAgentLabel}
							projectId={projectId ?? ""}
							value={model}
							mode={mode}
							onWarningChange={setModelWarning}
							onModelChange={(value) => {
								setModel(value);
								setMode("");
								setModelTouched(true);
							}}
							onModeChange={(value) => {
								setMode(value);
								setModel("");
								setModelTouched(true);
							}}
						/>
					</div>
				</div>

				{/* Provenance in words, on its own line under the values it describes, so an
				    inherited value explains itself without turning a control into a label. */}
				{provenance && <p className="mt-1.5 text-caption text-passive">{provenance}</p>}
			</div>

			<div className="flex items-center justify-between gap-4 border-t border-border/70 px-(--size-modal-padding) py-3">
				<p className="text-caption text-passive">{t("newTask.newlineHint")}</p>
				<div className="flex shrink-0 items-center gap-2">
					{onCancel && (
						<Button type="button" variant="secondary" disabled={isSubmitting} onClick={onCancel}>
							{t("newTask.cancel")}
						</Button>
					)}
					<Button type="submit" variant="primary" disabled={isSubmitting || !projectId}>
						{isSubmitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
						{isSubmitting ? t("newTask.starting") : t("newTask.start")}
						{!isSubmitting && (
							<kbd className="composer-keycap" aria-hidden="true">
								↵
							</kbd>
						)}
					</Button>
				</div>
			</div>
		</form>
	);
}

function TaskModelPicker({
	id,
	agentId,
	agentLabel,
	projectId,
	value,
	mode,
	onModelChange,
	onModeChange,
	onWarningChange,
}: {
	id: string;
	agentId: string;
	agentLabel: string;
	projectId: string;
	value: string;
	mode: string;
	onModelChange: (value: string) => void;
	onModeChange: (value: string) => void;
	onWarningChange: (warning: string | undefined) => void;
}) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [customAgentId, setCustomAgentId] = useState<string | null>(null);
	const query = useQuery(agentModelsQueryOptions(agentId, projectId));
	const catalog: AgentModelCatalog | undefined = query.data;
	const revalidationQuery = useQuery({
		queryKey: ["agent-model-revalidation", agentId, projectId, catalog?.validatedAt ?? ""],
		queryFn: () => revalidateAgentModels(agentId, projectId),
		enabled: agentId !== "" && catalog?.refreshRecommended === true,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	useEffect(() => {
		if (revalidationQuery.data) {
			queryClient.setQueryData(agentModelsQueryKey(agentId, projectId), revalidationQuery.data);
		}
	}, [agentId, projectId, queryClient, revalidationQuery.data]);
	const refreshMutation = useMutation({
		mutationFn: () => refreshAgentModels(agentId, projectId),
		onSuccess: (catalog) => queryClient.setQueryData(agentModelsQueryKey(agentId, projectId), catalog),
	});
	const warning =
		(refreshMutation.isError
			? refreshMutation.error instanceof Error
				? refreshMutation.error.message
				: t("settings.models.refreshFailed")
			: undefined) ??
		(revalidationQuery.isError
			? revalidationQuery.error instanceof Error
				? revalidationQuery.error.message
				: t("settings.models.validateFailed")
			: undefined) ??
		catalog?.warning ??
		(query.isError ? (query.error instanceof Error ? query.error.message : t("settings.models.loadFailed")) : undefined);
	// The composer owns the one place warnings appear, so the chip row never grows
	// a second line and shifts the footer while you are typing.
	useEffect(() => {
		onWarningChange(warning);
	}, [onWarningChange, warning]);
	useEffect(() => () => onWarningChange(undefined), [onWarningChange]);

	// Says what happens with no override, rather than labelling it "Agent default".
	const noOverrideLabel = agentLabel
		? t("newTask.letAgentChoose", { agent: agentLabel })
		: t("settings.models.agentDefault");

	if (catalog?.selectionMode === "mode") {
		const options = [
			{ value: "__default__", label: noOverrideLabel },
			...(catalog.models ?? []).map((item) => ({ value: item.id, label: item.label })),
		];
		return (
			<SettingsOptionMenu
				aria-label={t("newTask.model")}
				value={mode || "__default__"}
				options={options}
				triggerClassName="composer-chip"
				menuAlign="start"
				renderTrigger={(selected) => (
					<span className="min-w-0 truncate text-foreground">
						{mode ? selected?.label : t("newTask.autoModel")}
					</span>
				)}
				onChange={(nextMode) => onModeChange(nextMode === "__default__" ? "" : nextMode)}
			/>
		);
	}

	const hasCatalog = catalog?.selectionMode === "catalog" && (catalog.models?.length ?? 0) > 0;
	const modelIsInCatalog = catalog?.models?.some((item) => item.id === value) ?? false;
	const showCustomInput = hasCatalog && (customAgentId === agentId || (value !== "" && !modelIsInCatalog));
	const selectCatalogModel = (nextModel: string) => {
		setCustomAgentId(null);
		onModelChange(nextModel);
	};
	const selectCustomModel = (nextModel: string) => {
		setCustomAgentId(agentId);
		onModelChange(nextModel);
	};

	if (hasCatalog && !showCustomInput) {
		return (
			<AgentModelCombobox
				aria-label={t("newTask.model")}
				value={value}
				models={catalog.models ?? []}
				allowCustom={catalog.allowCustom}
				emptyLabel={noOverrideLabel}
				onChange={selectCatalogModel}
				onCustom={selectCustomModel}
				onRefresh={agentId === "" ? undefined : () => refreshMutation.mutate()}
				refreshing={refreshMutation.isPending}
				triggerClassName="composer-chip"
				menuAlign="start"
				renderTrigger={(label) => (
					<span className="min-w-0 truncate text-foreground">
						{value ? label : t("newTask.autoModel")}
					</span>
				)}
			/>
		);
	}

	// Free-text agents keep an input, sized to the sentence rather than a column.
	return (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<input
				id={id}
				aria-label={t("newTask.model")}
				className="composer-chip w-(--size-composer-model-input) placeholder:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
				value={value}
				disabled={agentId === ""}
				onChange={(event) => onModelChange(event.target.value)}
				placeholder={query.isFetching ? t("settings.models.loading") : t("newTask.autoModel")}
			/>
			{hasCatalog && (
				<AgentModelCombobox
					aria-label={t("settings.models.optionsAria", { label: t("newTask.model") })}
					value={value}
					models={catalog.models ?? []}
					allowCustom={catalog.allowCustom}
					emptyLabel={noOverrideLabel}
					onChange={selectCatalogModel}
					onCustom={selectCustomModel}
					onRefresh={agentId === "" ? undefined : () => refreshMutation.mutate()}
					refreshing={refreshMutation.isPending}
					triggerLabel={t("settings.models.browse")}
					triggerClassName="shrink-0"
				/>
			)}
		</span>
	);
}
