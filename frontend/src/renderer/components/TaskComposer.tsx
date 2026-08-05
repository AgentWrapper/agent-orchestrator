import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";

type Project = components["schemas"]["Project"];
type DelegateAgent = components["schemas"]["DelegateTaskRequest"]["agent"];

type CreateTaskInput = {
	projectId: string;
	brief: string;
	agent?: DelegateAgent;
	model?: string;
};

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
	const [agent, setAgent] = useState("");
	const [agentTouched, setAgentTouched] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | undefined>();
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
					},
				});
				if (error) throw new Error(apiErrorMessage(error, t("newTask.unableToStart")));
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
	const agentCatalog = agentsQuery.data;

	useEffect(() => {
		if (!agentTouched) setAgent(defaultWorkerAgent);
	}, [agentTouched, defaultWorkerAgent]);

	const isDirty = prompt.trim() !== "" || model.trim() !== "";
	useEffect(() => {
		onDirtyChange?.(isDirty);
	}, [isDirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	useEffect(() => {
		onSubmittingChange?.(isSubmitting);
	}, [isSubmitting, onSubmittingChange]);
	useEffect(() => () => onSubmittingChange?.(false), [onSubmittingChange]);

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!projectId || isSubmitting) return;

		const cleanPrompt = prompt.trim();
		const cleanModel = model.trim();
		if (!cleanPrompt) {
			setError(t("newTask.taskRequired"));
			return;
		}

		setIsSubmitting(true);
		setError(undefined);
		try {
			const sessionId = await createTask({
				projectId,
				brief: prompt,
				agent: agentTouched && agent ? (agent as CreateTaskInput["agent"]) : undefined,
				model: cleanModel || undefined,
			});
			onCreated(sessionId);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("newTask.unableToStart"));
		} finally {
			setIsSubmitting(false);
		}
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
					<Input
						id={modelId}
						placeholder={t("newTask.projectDefault")}
						value={model}
						onChange={(event) => setModel(event.target.value)}
					/>
				</div>
			</div>

			{error && (
				<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{error}
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
