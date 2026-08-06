import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import type { components } from "../../api/schema";
import { apiClient, apiErrorCode, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
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

const newTaskSelectSurfaceClass =
	"h-control-form w-full flex-1 justify-between rounded-md border border-transparent bg-input/50 px-3 py-2 text-control text-foreground transition-[color,box-shadow,background-color,border-color] hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30";

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
	const refreshAgentsMutation = useMutation({
		mutationFn: refreshAgents,
		onSuccess: (next) => queryClient.setQueryData(agentsQueryKey, next),
	});
	const defaultWorkerAgent = projectQuery.data?.config?.worker?.agent ?? "";
	const selectedAgent = agent || defaultWorkerAgent;
	const defaultWorkerModel =
		projectQuery.data?.config?.worker?.agentConfig?.model ?? projectQuery.data?.config?.agentConfig?.model ?? "";
	const defaultWorkerMode =
		projectQuery.data?.config?.worker?.agentConfig?.mode ?? projectQuery.data?.config?.agentConfig?.mode ?? "";
	const defaultModelForSelectedAgent = selectedAgent === defaultWorkerAgent ? defaultWorkerModel : "";
	const defaultModeForSelectedAgent = selectedAgent === defaultWorkerAgent ? defaultWorkerMode : "";
	const agentCatalog = agentsQuery.data;

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

		const cleanPrompt = prompt.trim();
		const cleanModel = model.trim();
		const cleanMode = mode.trim();
		const requestedModel =
			modelTouched && (cleanModel !== defaultModelForSelectedAgent || cleanMode !== defaultModeForSelectedAgent)
				? cleanModel || cleanMode || undefined
				: undefined;
		if (!cleanPrompt) {
			setError(t("newTask.taskRequired"));
			return;
		}

		setIsSubmitting(true);
		setError(undefined);
		setCanCreateAsTUI(false);
		try {
			const sessionId = await createTask({
				projectId,
				brief: prompt,
				agent: agentTouched && agent ? (agent as CreateTaskInput["agent"]) : undefined,
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
		<form onSubmit={submit} className="space-y-4 p-(--size-modal-padding)">
			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					<label className="text-xs font-medium text-muted-foreground" htmlFor={promptId}>
						{t("newTask.task")}
					</label>
				</div>
				<div className="rounded-md border border-border transition">
					<textarea
						id={promptId}
						autoFocus={autoFocusTitle}
						className="min-h-textarea-min w-full resize-y rounded-md bg-transparent px-3 py-2 text-control leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak"
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
				</div>
				<p className="text-caption text-muted-foreground">{t("newTask.enterHint")}</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
				<div className="space-y-1.5">
					<RequiredAgentField
						id={agentId}
						label={t("newTask.agent")}
						placeholder={t("newTask.projectDefault")}
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
					<button
						type="button"
						className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
						disabled={refreshAgentsMutation.isPending}
						onClick={() => refreshAgentsMutation.mutate()}
					>
						{refreshAgentsMutation.isPending ? t("newTask.refreshingAgents") : t("newTask.refreshAgents")}
					</button>
				</div>
				<div className="space-y-1.5">
					<Label className="text-xs font-medium text-muted-foreground" htmlFor={modelId}>
						{t("newTask.model")}
					</Label>
					<TaskModelPicker
						id={modelId}
						agentId={selectedAgent}
						projectId={projectId ?? ""}
						value={model}
						mode={mode}
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

			{error && (
				<div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					<span>{error}</span>
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

			{refreshAgentsMutation.isError && (
				<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{refreshAgentsMutation.error instanceof Error
						? refreshAgentsMutation.error.message
						: t("newTask.refreshFailed")}
				</div>
			)}

			<div className="flex items-center justify-end gap-3 pt-1">
				{onCancel && (
					<Button type="button" variant="footer" disabled={isSubmitting} onClick={onCancel}>
						{t("newTask.cancel")}
					</Button>
				)}
				<Button type="submit" variant="footer-primary" disabled={isSubmitting || !projectId}>
					{isSubmitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
					{isSubmitting ? t("newTask.starting") : t("newTask.start")}
				</Button>
			</div>
		</form>
	);
}

function TaskModelPicker({
	id,
	agentId,
	projectId,
	value,
	mode,
	onModelChange,
	onModeChange,
}: {
	id: string;
	agentId: string;
	projectId: string;
	value: string;
	mode: string;
	onModelChange: (value: string) => void;
	onModeChange: (value: string) => void;
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

	if (catalog?.selectionMode === "mode") {
		const options = [
			{ value: "__default__", label: t("settings.models.agentDefault") },
			...(catalog.models ?? []).map((item) => ({ value: item.id, label: item.label })),
		];
		return (
			<>
				<div className="flex min-w-0 items-center gap-2">
					<SettingsOptionMenu
						aria-label={t("newTask.model")}
						value={mode || "__default__"}
						options={options}
						triggerClassName={newTaskSelectSurfaceClass}
						onChange={(nextMode) => onModeChange(nextMode === "__default__" ? "" : nextMode)}
					/>
				</div>
				<TaskModelRefreshButton
					pending={refreshMutation.isPending}
					disabled={agentId === ""}
					onClick={() => refreshMutation.mutate()}
				/>
				{warning && <p className="text-xs text-warning">{warning}</p>}
			</>
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

	return (
		<>
			<div className="flex min-w-0 items-center gap-2">
				{hasCatalog && !showCustomInput ? (
					<AgentModelCombobox
						aria-label={t("newTask.model")}
						value={value}
						models={catalog.models ?? []}
						allowCustom={catalog.allowCustom}
						onChange={selectCatalogModel}
						onCustom={selectCustomModel}
						triggerClassName={newTaskSelectSurfaceClass}
					/>
				) : (
					<>
						<input
							id={id}
							className="h-control-form flex min-w-0 flex-1 rounded-md border border-transparent bg-input/50 px-3 py-2 text-control text-foreground outline-none transition-[color,box-shadow,background-color,border-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
							value={value}
							disabled={agentId === ""}
							onChange={(event) => onModelChange(event.target.value)}
							placeholder={query.isFetching ? t("settings.models.loading") : t("newTask.projectDefault")}
						/>
						{hasCatalog && (
							<AgentModelCombobox
								aria-label={t("settings.models.optionsAria", { label: t("newTask.model") })}
								value={value}
								models={catalog.models ?? []}
								allowCustom={catalog.allowCustom}
								onChange={selectCatalogModel}
								onCustom={selectCustomModel}
								triggerLabel={t("settings.models.browse")}
								triggerClassName="shrink-0"
							/>
						)}
					</>
				)}
			</div>
			<TaskModelRefreshButton
				pending={refreshMutation.isPending}
				disabled={agentId === ""}
				onClick={() => refreshMutation.mutate()}
			/>
			{warning && <p className="text-xs text-warning">{warning}</p>}
		</>
	);
}

function TaskModelRefreshButton({
	pending,
	disabled,
	onClick,
}: {
	pending: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
			disabled={disabled || pending}
			onClick={onClick}
		>
			{pending ? t("newTask.refreshingModels") : t("newTask.refreshModels")}
		</button>
	);
}
