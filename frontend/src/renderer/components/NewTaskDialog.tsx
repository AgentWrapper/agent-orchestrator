import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { readRuntimePreferences, writeRuntimePreferences } from "../lib/runtime-preferences";
import type { AgentProvider } from "../types/workspace";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";

type Project = components["schemas"]["Project"];

const PROJECT_DEFAULT = "__project_default__";
const CUSTOM_MODEL = "__custom_model__";

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

const PERMISSION_OPTIONS = [
	{ value: "default", label: "Agent default" },
	{ value: "accept-edits", label: "Accept edits" },
	{ value: "auto", label: "Automatic" },
	{ value: "bypass-permissions", label: "Bypass permissions" },
] as const;

type NewTaskDialogProps = {
	open: boolean;
	projectId?: string;
	onCreated: (sessionId: string) => void;
	onOpenChange: (open: boolean) => void;
};

export function NewTaskDialog({ open, projectId, onCreated, onOpenChange }: NewTaskDialogProps) {
	const queryClient = useQueryClient();
	const titleId = useId();
	const promptId = useId();
	const branchId = useId();
	const agentId = useId();
	const modelId = useId();
	const effortId = useId();
	const permissionId = useId();
	const [title, setTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [branch, setBranch] = useState("");
	const [agent, setAgent] = useState("");
	const [agentTouched, setAgentTouched] = useState(false);
	const [modelChoice, setModelChoice] = useState(PROJECT_DEFAULT);
	const [customModel, setCustomModel] = useState("");
	const [reasoningEffort, setReasoningEffort] = useState(PROJECT_DEFAULT);
	const [permissions, setPermissions] = useState(PROJECT_DEFAULT);
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
			if (data?.status !== "ok") throw new Error("Project config is unavailable.");
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
	const baseAgentConfig = projectQuery.data?.config?.agentConfig;
	const workerAgentConfig = projectQuery.data?.config?.worker?.agentConfig;
	const projectModel = workerAgentConfig?.model || baseAgentConfig?.model || "";
	const projectEffort = workerAgentConfig?.reasoningEffort || baseAgentConfig?.reasoningEffort || "";
	const projectPermissions = workerAgentConfig?.permissions || baseAgentConfig?.permissions || "";
	const autoBypassWorkerPermissions = projectQuery.data?.config?.autoBypassWorkerPermissions ?? false;
	const selectedHarness = agent || defaultWorkerAgent;
	const modelOptions = MODEL_OPTIONS[selectedHarness] ?? [];

	useEffect(() => {
		if (!open) {
			setTitle("");
			setPrompt("");
			setBranch("");
			setAgent("");
			setAgentTouched(false);
			setModelChoice(PROJECT_DEFAULT);
			setCustomModel("");
			setReasoningEffort(PROJECT_DEFAULT);
			setPermissions(PROJECT_DEFAULT);
			setError(undefined);
			setIsSubmitting(false);
		}
	}, [open]);

	useEffect(() => {
		if (open && !agentTouched) {
			setAgent(defaultWorkerAgent);
		}
	}, [open, agentTouched, defaultWorkerAgent]);

	useEffect(() => {
		if (!open || !projectId || !selectedHarness) return;
		const saved = readRuntimePreferences(projectId, selectedHarness, "new-task");
		setModelChoice(saved.modelChoice ?? PROJECT_DEFAULT);
		setCustomModel(saved.customModel ?? "");
		setReasoningEffort(saved.effortChoice ?? PROJECT_DEFAULT);
		setPermissions(saved.permissionChoice ?? PROJECT_DEFAULT);
	}, [open, projectId, selectedHarness]);

	const rememberModelChoice = (value: string) => {
		setModelChoice(value);
		if (projectId && selectedHarness) {
			writeRuntimePreferences(projectId, selectedHarness, "new-task", { modelChoice: value });
		}
	};
	const rememberCustomModel = (value: string) => {
		setCustomModel(value);
		if (projectId && selectedHarness) {
			writeRuntimePreferences(projectId, selectedHarness, "new-task", { customModel: value });
		}
	};
	const rememberEffortChoice = (value: string) => {
		setReasoningEffort(value);
		if (projectId && selectedHarness) {
			writeRuntimePreferences(projectId, selectedHarness, "new-task", { effortChoice: value });
		}
	};
	const rememberPermissionChoice = (value: string) => {
		setPermissions(value);
		if (projectId && selectedHarness) {
			writeRuntimePreferences(projectId, selectedHarness, "new-task", { permissionChoice: value });
		}
	};

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!projectId || isSubmitting) return;

		const cleanTitle = title.trim();
		const cleanPrompt = prompt.trim();
		const cleanBranch = branch.trim();
		const selectedModel =
			modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice === PROJECT_DEFAULT ? "" : modelChoice;
		const selectedEffort = reasoningEffort === PROJECT_DEFAULT ? "" : reasoningEffort;
		const selectedPermissions = autoBypassWorkerPermissions
			? "bypass-permissions"
			: permissions === PROJECT_DEFAULT
				? ""
				: permissions;
		const agentConfig =
			selectedModel || selectedEffort || selectedPermissions
				? {
						model: selectedModel || undefined,
						reasoningEffort: selectedEffort || undefined,
						permissions: selectedPermissions || undefined,
					}
				: undefined;
		if (!cleanTitle || !cleanPrompt) {
			setError("Title and brief are required.");
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
					agentConfig,
				},
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Unable to start task"));
			if (!data?.session?.id) throw new Error("Task creation returned no session");
			void captureRendererEvent("ao.renderer.task_create_succeeded", { project_id: projectId });
			onCreated(data.session.id);
			onOpenChange(false);
		} catch (err) {
			void captureRendererEvent("ao.renderer.task_create_failed", { project_id: projectId });
			void queryClient.invalidateQueries({ queryKey: agentsQueryKey });
			setError(err instanceof Error ? err.message : "Unable to start task");
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
							<Dialog.Title className="text-subtitle font-semibold text-foreground">New task</Dialog.Title>
							<Dialog.Description className="mt-1 text-xs text-muted-foreground">
								Start a worker directly from this project.
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground"
								aria-label="Close new task dialog"
							>
								<X className="size-icon-base" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>

					<form onSubmit={submit} className="space-y-4 px-5 py-4">
						<div className="space-y-1.5">
							<label className="text-xs font-medium text-muted-foreground" htmlFor={titleId}>
								Title
							</label>
							<Input
								id={titleId}
								autoFocus
								placeholder="Fix WebGL fallback renderer"
								value={title}
								onChange={(event) => setTitle(event.target.value)}
							/>
						</div>

						<div className="space-y-1.5">
							<label className="text-xs font-medium text-muted-foreground" htmlFor={promptId}>
								Brief
							</label>
							<textarea
								id={promptId}
								className="min-h-textarea-min w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-control leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak"
								placeholder="Describe the change, constraints, and expected verification."
								value={prompt}
								onChange={(event) => setPrompt(event.target.value)}
							/>
						</div>

						<div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
							<div className="space-y-1.5">
								<RequiredAgentField
									id={agentId}
									label="Agent"
									placeholder="Project default"
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
									{refreshAgentsMutation.isPending ? "Refreshing agents..." : "Refresh agents"}
								</button>
							</div>
							<div className="space-y-1.5">
								<Label className="text-xs font-medium text-muted-foreground" htmlFor={branchId}>
									Branch
								</Label>
								<Input
									id={branchId}
									placeholder="optional"
									value={branch}
									onChange={(event) => setBranch(event.target.value)}
								/>
							</div>
						</div>

						<div className="space-y-3 rounded-lg border border-border bg-surface/40 p-3">
							<div>
								<p className="text-xs font-semibold text-foreground">Task runtime</p>
								<p className="mt-0.5 text-caption text-muted-foreground">Override this worker's project defaults.</p>
							</div>
							<div className="grid gap-3 sm:grid-cols-3">
								<div className="space-y-1.5">
									<Label className="text-xs font-medium text-muted-foreground" htmlFor={modelId}>
										Model
									</Label>
									<Select value={modelChoice} onValueChange={rememberModelChoice}>
										<SelectTrigger id={modelId} size="sm" className="w-full text-control">
											<SelectValue />
										</SelectTrigger>
										<SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
											<SelectItem value={PROJECT_DEFAULT}>
												{projectModel ? `Project default · ${projectModel}` : "Agent default"}
											</SelectItem>
											{modelOptions.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
											<SelectItem value={CUSTOM_MODEL}>Custom model…</SelectItem>
										</SelectContent>
									</Select>
									{modelChoice === CUSTOM_MODEL && (
										<Input
											aria-label="Custom model"
											className="mt-2"
											placeholder="Model ID or alias"
											value={customModel}
											onChange={(event) => rememberCustomModel(event.target.value)}
										/>
									)}
								</div>

								<div className="space-y-1.5">
									<Label className="text-xs font-medium text-muted-foreground" htmlFor={effortId}>
										Effort
									</Label>
									<Select value={reasoningEffort} onValueChange={rememberEffortChoice}>
										<SelectTrigger id={effortId} size="sm" className="w-full text-control">
											<SelectValue />
										</SelectTrigger>
										<SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
											<SelectItem value={PROJECT_DEFAULT}>
												{projectEffort ? `Project default · ${projectEffort}` : "Model default"}
											</SelectItem>
											{EFFORT_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
											{selectedHarness === "claude-code" && <SelectItem value="max">Maximum</SelectItem>}
										</SelectContent>
									</Select>
								</div>

								<div className="space-y-1.5">
									<Label className="text-xs font-medium text-muted-foreground" htmlFor={permissionId}>
										Permission
									</Label>
									<Select
										disabled={autoBypassWorkerPermissions}
										onValueChange={rememberPermissionChoice}
										value={autoBypassWorkerPermissions ? "bypass-permissions" : permissions}
									>
										<SelectTrigger id={permissionId} size="sm" className="w-full text-control">
											<SelectValue />
										</SelectTrigger>
										<SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
											<SelectItem value={PROJECT_DEFAULT}>
												{projectPermissions ? `Project default · ${projectPermissions}` : "Project default"}
											</SelectItem>
											{PERMISSION_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									{autoBypassWorkerPermissions && (
										<p className="text-caption text-warning">All subagents have complete access.</p>
									)}
								</div>
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
									: "Could not refresh agent catalog."}
							</div>
						)}

						<div className="flex items-center justify-end gap-2 pt-1">
							<Dialog.Close asChild>
								<Button type="button" variant="ghost" disabled={isSubmitting}>
									Cancel
								</Button>
							</Dialog.Close>
							<Button type="submit" disabled={isSubmitting || !projectId}>
								{isSubmitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
								{isSubmitting ? "Starting..." : "Start task"}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
