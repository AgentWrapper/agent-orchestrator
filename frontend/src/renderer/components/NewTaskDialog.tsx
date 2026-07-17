import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import type { AgentProvider } from "../types/workspace";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";

type Project = components["schemas"]["Project"];

type NewTaskDialogProps = {
	open: boolean;
	projectId?: string;
	onCreated: (sessionId: string) => void;
	onOpenChange: (open: boolean) => void;
};

export function NewTaskDialog({ open, projectId, onCreated, onOpenChange }: NewTaskDialogProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const titleId = useId();
	const promptId = useId();
	const branchId = useId();
	const agentId = useId();
	const [title, setTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [branch, setBranch] = useState("");
	const [agent, setAgent] = useState("");
	const [agentTouched, setAgentTouched] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const projectQuery = useQuery({
		queryKey: ["project", projectId],
		enabled: open && Boolean(projectId),
		queryFn: async () => {
			const { data, error: apiError } = await apiClient.GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId as string } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
			if (data?.status !== "ok") throw new Error(t("sessions.newTask.projectUnavailable"));
			return data.project as Project;
		},
	});
	const agentsQuery = useQuery({
		...agentsQueryOptions,
		enabled: open,
	});
	const refreshAgentsMutation = useMutation({
		mutationFn: refreshAgents,
		onSuccess: (next) => queryClient.setQueryData(agentsQueryKey, next),
	});
	const defaultWorkerAgent = projectQuery.data?.config?.worker?.agent ?? "";
	const agentCatalog = agentsQuery.data;

	useEffect(() => {
		if (!open) {
			setTitle("");
			setPrompt("");
			setBranch("");
			setAgent("");
			setAgentTouched(false);
			setError(undefined);
			setIsSubmitting(false);
		}
	}, [open]);

	useEffect(() => {
		if (open && !agentTouched) {
			setAgent(defaultWorkerAgent);
		}
	}, [open, agentTouched, defaultWorkerAgent]);

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!projectId || isSubmitting) return;

		const cleanTitle = title.trim();
		const cleanPrompt = prompt.trim();
		const cleanBranch = branch.trim();
		if (!cleanTitle || !cleanPrompt) {
			setError(t("sessions.newTask.required"));
			return;
		}

		setIsSubmitting(true);
		setError(undefined);
		void captureRendererEvent("ao.renderer.task_create_requested", { project_id: projectId });
		try {
			const { data, error: apiError } = await apiClient.POST("/api/v1/sessions", {
				body: {
					projectId,
					kind: "worker",
					harness: agentTouched && agent ? (agent as AgentProvider) : undefined,
					issueId: cleanTitle,
					prompt: cleanPrompt,
					branch: cleanBranch || undefined,
				},
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, t("sessions.newTask.startFailed")));
			if (!data?.session?.id) throw new Error(t("sessions.newTask.missingSession"));
			void captureRendererEvent("ao.renderer.task_create_succeeded", { project_id: projectId });
			onCreated(data.session.id);
			onOpenChange(false);
		} catch (err) {
			void captureRendererEvent("ao.renderer.task_create_failed", { project_id: projectId });
			void queryClient.invalidateQueries({ queryKey: agentsQueryKey });
			setError(err instanceof Error ? err.message : t("sessions.newTask.startFailed"));
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-overlay bg-scrim data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-xl -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
						<div className="min-w-0">
							<Dialog.Title className="text-subtitle font-semibold text-foreground">
								{t("sessions.newTask.title")}
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-xs text-muted-foreground">
								{t("sessions.newTask.description")}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground"
								aria-label={t("sessions.newTask.close")}
							>
								<X className="size-icon-base" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>

					<form onSubmit={submit} className="space-y-4 px-5 py-4">
						<div className="space-y-1.5">
							<label className="text-xs font-medium text-muted-foreground" htmlFor={titleId}>
								{t("sessions.newTask.titleLabel")}
							</label>
							<Input
								id={titleId}
								autoFocus
								placeholder={t("sessions.newTask.titlePlaceholder")}
								value={title}
								onChange={(event) => setTitle(event.target.value)}
							/>
						</div>

						<div className="space-y-1.5">
							<label className="text-xs font-medium text-muted-foreground" htmlFor={promptId}>
								{t("sessions.newTask.briefLabel")}
							</label>
							<textarea
								id={promptId}
								className="min-h-textarea-min w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-control leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak"
								placeholder={t("sessions.newTask.briefPlaceholder")}
								value={prompt}
								onChange={(event) => setPrompt(event.target.value)}
							/>
						</div>

						<div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
							<div className="space-y-1.5">
								<RequiredAgentField
									id={agentId}
									label={t("sessions.newTask.agent")}
									placeholder={t("sessions.newTask.projectDefault")}
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
									{refreshAgentsMutation.isPending
										? t("sessions.newTask.refreshingAgents")
										: t("sessions.newTask.refreshAgents")}
								</button>
							</div>
							<div className="space-y-1.5">
								<Label className="text-xs font-medium text-muted-foreground" htmlFor={branchId}>
									{t("sessions.newTask.branch")}
								</Label>
								<Input
									id={branchId}
									placeholder={t("sessions.newTask.optional")}
									value={branch}
									onChange={(event) => setBranch(event.target.value)}
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
									: t("sessions.newTask.refreshFailed")}
							</div>
						)}

						<div className="flex items-center justify-end gap-2 pt-1">
							<Dialog.Close asChild>
								<Button type="button" variant="ghost" disabled={isSubmitting}>
									{t("ui.cancel")}
								</Button>
							</Dialog.Close>
							<Button type="submit" disabled={isSubmitting || !projectId}>
								{isSubmitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
								{isSubmitting ? t("sessions.newTask.starting") : t("sessions.newTask.start")}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
