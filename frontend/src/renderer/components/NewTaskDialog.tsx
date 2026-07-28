import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2, X } from "lucide-react";
import { type ClipboardEvent, type DragEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import type { AgentProvider } from "../types/workspace";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { useImageAttachments } from "../hooks/useImageAttachments";
import { cloudCapabilities, refreshCloudSessions, cloudBoardId } from "../lib/cloud-sessions";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { cn } from "../lib/utils";

type Project = components["schemas"]["Project"];

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
	const [title, setTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [branch, setBranch] = useState("");
	const [agent, setAgent] = useState("");
	const [agentTouched, setAgentTouched] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [isDragging, setIsDragging] = useState(false);
	// Where this session runs: locally (default) or in a per-session Daytona
	// sandbox. Cloud sessions survive app/laptop shutdown and are shareable.
	const [runTarget, setRunTarget] = useState<"local" | "cloud">("local");
	const fileInputRef = useRef<HTMLInputElement>(null);
	const {
		attachments,
		error: attachmentError,
		addFiles,
		remove: removeAttachment,
		clear: clearAttachments,
		toPayload,
	} = useImageAttachments();

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
	const isScratchProject = projectQuery.data?.kind === "scratch";
	const agentCatalog = agentsQuery.data;

	// Cloud eligibility: the daemon has a Daytona key AND the harness this task
	// would use has a verified cloud recipe. Otherwise the Local/Cloud toggle hides.
	const cloudCapsQuery = useQuery({
		queryKey: ["cloud-capabilities"],
		enabled: open,
		queryFn: cloudCapabilities,
		staleTime: 60_000,
	});
	const effectiveHarness = (agentTouched && agent ? agent : defaultWorkerAgent) || "";
	const cloudEligible = Boolean(cloudCapsQuery.data?.configured) && cloudCapsQuery.data!.harnesses.includes(effectiveHarness);
	const runInCloud = runTarget === "cloud" && cloudEligible;

	useEffect(() => {
		if (!open) {
			setTitle("");
			setPrompt("");
			setBranch("");
			setAgent("");
			setAgentTouched(false);
			setError(undefined);
			setIsSubmitting(false);
			setIsDragging(false);
			setRunTarget("local");
			clearAttachments();
		}
	}, [open, clearAttachments]);

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
			setError("Title and brief are required.");
			return;
		}

		setIsSubmitting(true);
		setError(undefined);
		void captureRendererEvent("ao.renderer.task_create_requested", { project_id: projectId });
		try {
			// Cloud: provision a per-session sandbox and start the worker in it. The
			// card then behaves like any local session (its state/terminal stream from
			// the sandbox). Provisioning blocks for ~15-20s.
			if (runInCloud) {
				const { data, error: apiError } = await apiClient.POST("/api/v1/cloud/sessions", {
					body: {
						harness: effectiveHarness,
						localProjectId: projectId,
						projectPath: projectQuery.data?.path ?? "",
						// The control plane can't read our local path — send the git remote so
						// the sandbox clones real code instead of an empty repo.
						remoteUrl: projectQuery.data?.repo ?? "",
						prompt: cleanPrompt,
						displayName: cleanTitle.slice(0, 20),
						branch: !isScratchProject && cleanBranch ? cleanBranch : undefined,
					},
				});
				if (apiError) throw new Error(apiErrorMessage(apiError, "Unable to start cloud task"));
				if (!data?.sandboxId) throw new Error("Cloud task returned no sandbox");
				void captureRendererEvent("ao.renderer.task_create_succeeded", { project_id: projectId });
				await refreshCloudSessions();
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				onCreated(cloudBoardId(data.sandboxId));
				onOpenChange(false);
				return;
			}
			const body: components["schemas"]["SpawnSessionRequest"] = {
				projectId,
				kind: "worker",
				harness: agentTouched && agent ? (agent as AgentProvider) : undefined,
				issueId: cleanTitle,
				prompt: cleanPrompt,
			};
			if (!isScratchProject && cleanBranch) {
				body.branch = cleanBranch;
			}
			if (attachments.length > 0) {
				body.attachments = toPayload();
			}
			const { data, error: apiError } = await apiClient.POST("/api/v1/sessions", {
				body,
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

	const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
		if (files.length === 0) return;
		// An image is on the clipboard: attach it instead of pasting a file path
		// or nothing into the textarea.
		event.preventDefault();
		void addFiles(files);
	};

	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setIsDragging(false);
		const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/"));
		if (files.length > 0) void addFiles(files);
	};

	const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file")) {
			event.preventDefault();
			setIsDragging(true);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in" />
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
							<div className="flex items-center justify-between">
								<label className="text-xs font-medium text-muted-foreground" htmlFor={promptId}>
									Brief
								</label>
								<button
									type="button"
									className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
									onClick={() => fileInputRef.current?.click()}
								>
									<ImagePlus className="size-icon-sm" aria-hidden="true" />
									Add image
								</button>
							</div>
							<div
								className={cn(
									"rounded-md border border-border transition",
									isDragging && "border-accent ring-2 ring-accent-weak",
								)}
								onDrop={handleDrop}
								onDragOver={handleDragOver}
								onDragLeave={() => setIsDragging(false)}
							>
								<textarea
									id={promptId}
									className="min-h-textarea-min w-full resize-y rounded-md bg-transparent px-3 py-2 text-control leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak"
									placeholder="Describe the change, constraints, and expected verification. Paste or drop images to attach them."
									value={prompt}
									onChange={(event) => setPrompt(event.target.value)}
									onPaste={handlePaste}
									onKeyDown={(event) => {
										// Chat-style, matching Claude Code / Codex. Submit affordances:
										// plain Enter, and Cmd+Enter / Ctrl+Enter (common chat-send combos)
										// which pass this guard because we only exclude Shift and Alt.
										// Do NOT submit: Shift+Enter and Alt+Enter — both insert a newline
										// (Alt is excluded so it can't submit by accident). Guard against IME
										// composition so committing a CJK candidate with Enter doesn't submit.
										if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
											event.preventDefault();
											event.currentTarget.form?.requestSubmit();
										}
									}}
								/>
								{attachments.length > 0 && (
									<ul className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto border-t border-border p-2 sm:grid-cols-3">
										{attachments.map((attachment, index) => (
											<li
												key={attachment.id}
												className="flex items-center gap-2 rounded-md border border-border bg-surface p-1 text-xs text-foreground"
											>
												<img
													src={attachment.dataUrl}
													alt={`Image ${index + 1}`}
													className="size-7 shrink-0 rounded object-cover"
												/>
												<span className="min-w-0 flex-1 truncate font-medium">Image {index + 1}</span>
												<button
													type="button"
													className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition hover:bg-border hover:text-foreground"
													aria-label={`Remove image ${index + 1}`}
													onClick={() => removeAttachment(attachment.id)}
												>
													<X className="size-icon-sm" aria-hidden="true" />
												</button>
											</li>
										))}
									</ul>
								)}
							</div>
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*"
								multiple
								className="hidden"
								onChange={(event) => {
									if (event.target.files) void addFiles(event.target.files);
									event.target.value = "";
								}}
							/>
							{attachmentError && <p className="text-caption text-destructive">{attachmentError}</p>}
							<p className="text-caption text-muted-foreground">Enter to start · Shift+Enter for a new line</p>
						</div>

						<div className={isScratchProject ? "grid gap-3" : "grid gap-3 sm:grid-cols-[1fr_1fr]"}>
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
							{!isScratchProject && (
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
							)}
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

						<div className="flex items-center justify-between gap-2 pt-1">
							{cloudEligible ? (
								<div className="inline-flex items-center rounded-md border border-border p-0.5 text-xs" role="group" aria-label="Run location">
									<button
										type="button"
										onClick={() => setRunTarget("local")}
										disabled={isSubmitting}
										className={cn(
											"rounded px-2.5 py-1 font-medium transition-colors",
											runTarget === "local" ? "bg-interactive-active text-foreground" : "text-passive hover:text-foreground",
										)}
									>
										Local
									</button>
									<button
										type="button"
										onClick={() => setRunTarget("cloud")}
										disabled={isSubmitting}
										className={cn(
											"rounded px-2.5 py-1 font-medium transition-colors",
											runTarget === "cloud" ? "bg-interactive-active text-foreground" : "text-passive hover:text-foreground",
										)}
										title="Run in a per-session cloud sandbox — survives app/laptop shutdown and is shareable"
									>
										Cloud
									</button>
								</div>
							) : (
								<span />
							)}
							<div className="flex items-center gap-2">
								<Dialog.Close asChild>
									<Button type="button" variant="ghost" disabled={isSubmitting}>
										Cancel
									</Button>
								</Dialog.Close>
								<Button type="submit" disabled={isSubmitting || !projectId}>
									{isSubmitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
									{isSubmitting ? (runInCloud ? "Provisioning sandbox…" : "Starting…") : runInCloud ? "Start in cloud" : "Start task"}
								</Button>
							</div>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
