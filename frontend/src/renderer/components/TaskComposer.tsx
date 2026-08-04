import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Loader2, X } from "lucide-react";
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
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { useImageAttachments, type ImageAttachmentPayload } from "../hooks/useImageAttachments";
import { cn } from "../lib/utils";

type Project = components["schemas"]["Project"];
type SpawnHarness = components["schemas"]["SpawnSessionRequest"]["harness"];

type CreateTaskInput = {
	projectId: string;
	title: string;
	prompt: string;
	branch?: string;
	harness?: SpawnHarness;
	attachments?: ImageAttachmentPayload[];
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
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { attachments, error: attachmentError, addFiles, remove: removeAttachment, toPayload } = useImageAttachments();
	const createTask = useCallback(
		async (input: CreateTaskInput): Promise<string> => {
			void captureRendererEvent("ao.renderer.task_create_requested", { project_id: input.projectId });
			try {
				const { data, error } = await apiClient.POST("/api/v1/sessions", {
					body: {
						projectId: input.projectId,
						kind: "worker",
						harness: input.harness,
						issueId: input.title,
						prompt: input.prompt,
						...(input.branch ? { branch: input.branch } : {}),
						attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
					},
				});
				if (error) throw new Error(apiErrorMessage(error, t("newTask.unableToStart")));
				if (!data?.session?.id) throw new Error(t("newTask.noSession"));
				void captureRendererEvent("ao.renderer.task_create_succeeded", { project_id: input.projectId });
				return data.session.id;
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
	const isScratchProject = projectQuery.data?.kind === "scratch";
	const agentCatalog = agentsQuery.data;

	useEffect(() => {
		if (!agentTouched) setAgent(defaultWorkerAgent);
	}, [agentTouched, defaultWorkerAgent]);

	const isDirty = title.trim() !== "" || prompt.trim() !== "" || branch.trim() !== "" || attachments.length > 0;
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

		const cleanTitle = title.trim();
		const cleanPrompt = prompt.trim();
		const cleanBranch = branch.trim();
		if (!cleanTitle || !cleanPrompt) {
			setError(t("newTask.titleRequired"));
			return;
		}

		setIsSubmitting(true);
		setError(undefined);
		try {
			const sessionId = await createTask({
				projectId,
				title: cleanTitle,
				prompt: cleanPrompt,
				branch: !isScratchProject && cleanBranch ? cleanBranch : undefined,
				harness: agentTouched && agent ? (agent as CreateTaskInput["harness"]) : undefined,
				attachments: attachments.length > 0 ? toPayload() : undefined,
			});
			onCreated(sessionId);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("newTask.unableToStart"));
		} finally {
			setIsSubmitting(false);
		}
	};

	const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
		if (files.length === 0) return;
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
		<form onSubmit={submit} className="space-y-4 px-5 py-4">
			<div className="space-y-1.5">
				<label className="text-xs font-medium text-muted-foreground" htmlFor={titleId}>
					{t("newTask.titleLabel")}
				</label>
				<Input
					id={titleId}
					autoFocus={autoFocusTitle}
					placeholder={t("newTask.titlePlaceholder")}
					value={title}
					onChange={(event) => setTitle(event.target.value)}
				/>
			</div>

			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					<label className="text-xs font-medium text-muted-foreground" htmlFor={promptId}>
						{t("newTask.brief")}
					</label>
					<button
						type="button"
						className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
						onClick={() => fileInputRef.current?.click()}
					>
						<ImagePlus className="size-icon-sm" aria-hidden="true" />
						{t("newTask.addImage")}
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
						placeholder={t("newTask.briefPlaceholder")}
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
					{attachments.length > 0 && (
						<ul className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto border-t border-border p-2 sm:grid-cols-3">
							{attachments.map((attachment, index) => (
								<li
									key={attachment.id}
									className="flex items-center gap-2 rounded-md border border-border bg-surface p-1 text-xs text-foreground"
								>
									<img
										src={attachment.dataUrl}
										alt={t("newTask.image", { number: index + 1 })}
										className="size-7 shrink-0 rounded object-cover"
									/>
									<span className="min-w-0 flex-1 truncate font-medium">
										{t("newTask.image", { number: index + 1 })}
									</span>
									<button
										type="button"
										className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition hover:bg-border hover:text-foreground"
										aria-label={t("newTask.removeImage", { number: index + 1 })}
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
				<p className="text-caption text-muted-foreground">{t("newTask.enterHint")}</p>
			</div>

			<div className={isScratchProject ? "grid gap-3" : "grid gap-3 sm:grid-cols-[1fr_1fr]"}>
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
				{!isScratchProject && (
					<div className="space-y-1.5">
						<Label className="text-xs font-medium text-muted-foreground" htmlFor={branchId}>
							{t("newTask.branch")}
						</Label>
						<Input
							id={branchId}
							placeholder={t("newTask.optional")}
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
						: t("newTask.refreshFailed")}
				</div>
			)}

			<div className="flex items-center justify-end gap-2 pt-1">
				{onCancel && (
					<Button type="button" variant="ghost" disabled={isSubmitting} onClick={onCancel}>
						{t("newTask.cancel")}
					</Button>
				)}
				<Button type="submit" disabled={isSubmitting || !projectId}>
					{isSubmitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
					{isSubmitting ? t("newTask.starting") : t("newTask.start")}
				</Button>
			</div>
		</form>
	);
}
