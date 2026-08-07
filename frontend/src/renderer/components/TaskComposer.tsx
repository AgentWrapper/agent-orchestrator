import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Paperclip, X } from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type FormEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import type { components } from "../../api/schema";
import { apiClient, apiErrorCode, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { agentsQueryKey, agentsQueryOptions, refreshAgentsIfStale } from "../hooks/useAgentsQuery";
import { type FileAttachmentPayload, useFileAttachments } from "../hooks/useFileAttachments";
import {
	agentModelsQueryKey,
	agentModelsQueryOptions,
	refreshAgentModels,
	revalidateAgentModels,
	type AgentModelCatalog,
} from "../hooks/useAgentModelsQuery";
import { AgentModelCombobox } from "./settings/AgentModelCombobox";
import { SettingsOptionMenu } from "./settings/SettingsOptionMenu";
import { cn } from "../lib/utils";

type Project = components["schemas"]["Project"];
type DelegateAgent = components["schemas"]["DelegateTaskRequest"]["agent"];

type CreateTaskInput = {
	projectId: string;
	brief: string;
	agent?: DelegateAgent;
	model?: string;
	mode?: "tui";
	attachments?: FileAttachmentPayload[];
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
	const fileInputRef = useRef<HTMLInputElement>(null);
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
	const [isDragging, setIsDragging] = useState(false);
	const {
		attachments,
		error: attachmentError,
		addFiles,
		remove: removeAttachment,
		clear: clearAttachments,
		toSettledPayload,
	} = useFileAttachments();
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
						...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
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
	// remember. Both resolved values remain directly editable.
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

	useEffect(() => {
		if (!agentTouched) setAgent(defaultWorkerAgent);
	}, [agentTouched, defaultWorkerAgent]);
	useEffect(() => {
		if (!modelTouched) {
			setModel(defaultModelForSelectedAgent);
			setMode(defaultModeForSelectedAgent);
		}
	}, [defaultModelForSelectedAgent, defaultModeForSelectedAgent, modelTouched]);

	const isDirty = prompt.trim() !== "" || modelTouched || attachments.length > 0;
	useEffect(() => {
		onDirtyChange?.(isDirty);
	}, [isDirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	useEffect(() => {
		onSubmittingChange?.(isSubmitting);
	}, [isSubmitting, onSubmittingChange]);
	useEffect(() => () => onSubmittingChange?.(false), [onSubmittingChange]);
	useEffect(() => () => clearAttachments(), [clearAttachments]);

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
			const attachmentPayloads = await toSettledPayload();
			const sessionId = await createTask({
				projectId,
				brief: prompt,
				// The visible selection is authoritative: it is either the user's pick
				// or the resolved default, so spawning names it explicitly.
				agent: selectedAgent ? (selectedAgent as CreateTaskInput["agent"]) : undefined,
				model: requestedModel,
				mode: interfaceMode,
				attachments: attachmentPayloads.length > 0 ? attachmentPayloads : undefined,
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

	const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(event.clipboardData?.files ?? []);
		if (files.length === 0) return;
		event.preventDefault();
		void addFiles(files);
	};

	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setIsDragging(false);
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length > 0) void addFiles(files);
	};

	const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file")) {
			event.preventDefault();
			setIsDragging(true);
		}
	};

	return (
		<form onSubmit={submit} className="flex flex-col">
			{/* The task is the only thing with weight here: no field label, no border,
			    just the caret. Everything below it is a decision you usually skip. */}
			<label className="sr-only" htmlFor={promptId}>
				{t("newTask.task")}
			</label>
			<div
				className={cn("transition", isDragging && "bg-accent-weak ring-2 ring-inset ring-accent")}
				onDrop={handleDrop}
				onDragOver={handleDragOver}
				onDragLeave={() => setIsDragging(false)}
			>
				<textarea
					id={promptId}
					autoFocus={autoFocusTitle}
					className="min-h-textarea-min w-full resize-none bg-transparent px-(--size-modal-padding) pb-4 pt-1 text-md leading-relaxed text-foreground outline-none placeholder:text-passive"
					placeholder={t("newTask.taskPlaceholder")}
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
					onPaste={handlePaste}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
				/>
			</div>

			{attachments.length > 0 && (
				<ul className="mx-(--size-modal-padding) mb-3 grid max-h-40 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
					{attachments.map((attachment) => (
						<li
							key={attachment.id}
							className="flex items-center gap-2 rounded-md border border-border bg-surface p-1 text-xs text-foreground"
						>
							{attachment.dataUrl ? (
								<img src={attachment.dataUrl} alt="" className="size-7 shrink-0 rounded object-cover" />
							) : (
								<FileText
									className="size-7 shrink-0 rounded bg-input/60 p-1.5 text-muted-foreground"
									aria-hidden="true"
								/>
							)}
							<span className="min-w-0 flex-1 truncate font-medium">{attachment.name}</span>
							<button
								type="button"
								className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition hover:bg-border hover:text-foreground"
								aria-label={t("newTask.removeFile", { name: attachment.name })}
								onClick={() => removeAttachment(attachment.id)}
							>
								<X className="size-icon-sm" aria-hidden="true" />
							</button>
						</li>
					))}
				</ul>
			)}
			<input
				ref={fileInputRef}
				type="file"
				multiple
				className="hidden"
				onChange={(event) => {
					if (event.target.files) void addFiles(event.target.files);
					event.target.value = "";
				}}
			/>
			{attachmentError && (
				<p className="px-(--size-modal-padding) pb-3 text-caption text-destructive">{attachmentError}</p>
			)}

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
			<div className="composer-run-config border-t border-border/70 px-(--size-modal-padding) py-3">
				<div className="composer-run-row">
					{/* One sentence — "Runs with <agent> <model>" — states what will happen,
					    instead of two labelled fields the reader has to assemble themselves. */}
					<span className="eyebrow-label shrink-0">{t("newTask.runsWith")}</span>
					<div className="composer-run-target" role="group" aria-label={t("newTask.runsWith")}>
						<RequiredAgentField
							id={agentId}
							variant="chip"
							label={t("newTask.agent")}
							placeholder={t("newTask.selectAgent")}
							value={selectedAgent}
							authorized={agentCatalog?.authorized}
							installed={agentCatalog?.installed}
							supported={agentCatalog?.supported}
							disabled={agentsQuery.isFetching && agentCatalog === undefined}
							triggerClassName="composer-run-target-segment w-full justify-between bg-transparent!"
							onChange={(value) => {
								setAgent(value);
								setAgentTouched(true);
								// Never pair a newly selected agent with the previous agent's model.
								// The new catalog will resolve its own default into this cleared slot.
								setModel("");
								setMode("");
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
			</div>

			<div className="flex items-center justify-between gap-4 border-t border-border/70 px-(--size-modal-padding) py-3">
				<p className="min-w-0 truncate text-caption text-passive">
					<span key={prompt.trim() === "" ? "empty" : "writing"} className="composer-value-swap">
						{prompt.trim() === "" ? t("newTask.emptyHint") : t("newTask.newlineHint")}
					</span>
				</p>
				<div className="flex shrink-0 items-center gap-2">
					<button
						type="button"
						className="grid size-9 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground"
						aria-label={t("newTask.addFile")}
						onClick={() => fileInputRef.current?.click()}
					>
						<Paperclip className="size-icon-sm" aria-hidden="true" />
					</button>
					{onCancel && (
						<Button type="button" variant="secondary" disabled={isSubmitting} onClick={onCancel}>
							{t("newTask.cancel")}
						</Button>
					)}
					<Button
						type="submit"
						variant="primary"
						disabled={isSubmitting || !projectId}
						className="min-w-(--size-composer-start-button)"
					>
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
	const catalogLoading = agentId !== "" && query.isFetching && catalog === undefined;

	if (catalogLoading) {
		return (
			<span
				className="composer-chip composer-run-target-segment w-full bg-transparent!"
				role="status"
				aria-label={t("settings.models.loading")}
				aria-busy="true"
			>
				<span className="composer-model-skeleton" aria-hidden="true" />
			</span>
		);
	}

	if (catalog?.selectionMode === "mode") {
		const options = [
			{ value: "__default__", label: noOverrideLabel },
			...(catalog.models ?? []).map((item) => ({ value: item.id, label: item.label })),
		];
		const visibleModeLabel = mode
			? (options.find((option) => option.value === mode)?.label ?? mode)
			: t("newTask.autoModel");
		return (
			<SettingsOptionMenu
				aria-label={t("newTask.model")}
				value={mode || "__default__"}
				options={options}
				triggerClassName="composer-chip composer-run-target-segment w-full justify-between bg-transparent!"
				menuAlign="start"
				renderTrigger={() => (
					<span
						key={`${agentId}:${mode || "__default__"}`}
						className="composer-value-swap min-w-0 truncate text-foreground"
						title={visibleModeLabel}
					>
						{visibleModeLabel}
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
				key={agentId}
				aria-label={t("newTask.model")}
				value={value}
				models={catalog.models ?? []}
				allowCustom={catalog.allowCustom}
				emptyLabel={noOverrideLabel}
				onChange={selectCatalogModel}
				onCustom={selectCustomModel}
				onRefresh={agentId === "" ? undefined : () => refreshMutation.mutate()}
				refreshing={refreshMutation.isPending}
				recentScope={agentId}
				triggerClassName="composer-chip composer-run-target-segment w-full justify-between bg-transparent!"
				menuAlign="start"
				renderTrigger={(label) => {
					const visibleLabel = value ? label : t("newTask.autoModel");
					return (
						<span
							key={`${agentId}:${value || "__default__"}`}
							className="composer-value-swap min-w-0 truncate text-foreground"
							title={visibleLabel}
						>
							{visibleLabel}
						</span>
					);
				}}
			/>
		);
	}

	// Free-text agents keep an input inside the same stable model track.
	return (
		<span className="inline-flex w-full min-w-0 items-center gap-1.5">
			<input
				id={id}
				aria-label={t("newTask.model")}
				className="composer-chip composer-run-target-segment min-w-0 flex-1 bg-transparent! placeholder:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
				value={value}
				disabled={agentId === ""}
				onChange={(event) => onModelChange(event.target.value)}
				placeholder={query.isFetching ? t("settings.models.loading") : t("newTask.autoModel")}
			/>
			{hasCatalog && (
				<AgentModelCombobox
					key={agentId}
					aria-label={t("settings.models.optionsAria", { label: t("newTask.model") })}
					value={value}
					models={catalog.models ?? []}
					allowCustom={catalog.allowCustom}
					emptyLabel={noOverrideLabel}
					onChange={selectCatalogModel}
					onCustom={selectCustomModel}
					onRefresh={agentId === "" ? undefined : () => refreshMutation.mutate()}
					refreshing={refreshMutation.isPending}
					recentScope={agentId}
					triggerLabel={t("settings.models.browse")}
					triggerClassName="shrink-0"
				/>
			)}
		</span>
	);
}
