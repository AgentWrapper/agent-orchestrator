import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { TriangleAlert, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import {
	fetchModelAvailability,
	modelAvailabilityQueryKey,
	useModelAvailabilityQuery,
} from "../hooks/useModelAvailabilityQuery";
import { AGENT_OPTIONS } from "../lib/agent-options";
import type { ProjectKind } from "../types/workspace";
import { buildIntake, type IntakeForm, IntakeFields } from "./IntakeFields";
import { ModelAvailabilityField } from "./ModelAvailabilityField";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

type AgentInfo = components["schemas"]["AgentInfo"];

export type CreateProjectAgentSelection = {
	workerAgent: string;
	orchestratorAgent: string;
	permissions: string;
	model: string;
	trackerIntake?: TrackerIntakeConfig;
};

// NEW_PROJECT_DEFAULTS is this deployment's standard baseline for a project born
// through the web UI, mirroring what /nickify applies when it onboards a repo:
// bypass-permissions so the orchestrator runs unattended instead of stalling on
// a permission prompt, and opus pinned so no claude-code role inherits the
// account default (fable — see #61). The model is a scalar fallback resolved at
// spawn (manager.go effectiveAgentConfig): the provider gate applies it to a
// claude-provider role (claude-code) and drops it for a role on a
// known-incompatible provider (codex → openai, codex-fugu → fugu). A harness
// with an unclassified provider is treated as compatible, so the pin can still
// pass through there — harmless, and the model field below is editable for a
// non-claude worker mix. Surfaced in the create form, pre-filled and editable,
// so what a project comes up with is visible at creation rather than a hidden
// bare default.
export const NEW_PROJECT_DEFAULTS = {
	permissions: "bypass-permissions",
	model: "opus",
} as const;

type AgentConfig = components["schemas"]["AgentConfig"];

// buildProjectAgentConfig assembles the agentConfig for the POST /api/v1/projects
// body from the create form's permission mode and model. Blank fields are
// omitted, and an all-blank result returns undefined so the daemon persists no
// agentConfig at all rather than an empty {}. Kept as a pure, exported function
// so the create flow's integration point is unit-testable without mounting the
// whole shell route.
export function buildProjectAgentConfig(permissions: string, model: string): AgentConfig | undefined {
	const trimmedModel = model.trim();
	const agentConfig: AgentConfig = {
		...(permissions ? { permissions } : {}),
		...(trimmedModel ? { model: trimmedModel } : {}),
	};
	return Object.keys(agentConfig).length > 0 ? agentConfig : undefined;
}

const PERMISSION_MODE_OPTIONS = [
	{ value: "default", label: "Default" },
	{ value: "accept-edits", label: "Accept edits" },
	{ value: "auto", label: "Auto" },
	{ value: "bypass-permissions", label: "Bypass permissions" },
] as const;

// The create sheet is compact and does not render the opt-out label editor, so
// optOutLabels stays empty here — a new project's ExcludeLabels is left unset and
// the daemon materializes the default opt-out taxonomy (domain.WithDefaults).
const EMPTY_INTAKE: IntakeForm = { enabled: false, repo: "", assignee: "", maxConcurrent: "", optOutLabels: [] };

type CreateProjectAgentSheetProps = {
	error?: string | null;
	isCreating: boolean;
	isInitializing?: boolean;
	kind: ProjectKind;
	onOpenChange: (open: boolean) => void;
	onSubmit: (selection: CreateProjectAgentSelection) => Promise<void>;
	open: boolean;
	path: string | null;
	repositorySetupNeeded?: boolean;
};

type SheetError = {
	title: string;
	message: string;
	tone: "warning" | "error";
};

function projectSheetError(error: string): SheetError {
	const setupMessage = error.replace(/^Setup failed:\s*/i, "").trim();
	const codeMatch = setupMessage.match(/\(([A-Z0-9_]+)\)\s*$/);
	const code = codeMatch?.[1];
	const message = codeMatch ? setupMessage.slice(0, codeMatch.index).trim() : setupMessage;

	switch (code) {
		case "PROJECT_PATH_NOT_REPO_ROOT":
			return {
				title: "Select the repository root",
				message: "This folder is inside another Git repository. Choose the top-level folder and try again.",
				tone: "warning",
			};
		case "PROJECT_BARE_REPOSITORY":
			return {
				title: "Choose a normal checkout",
				message: "AO needs a regular working folder, not a bare Git repository.",
				tone: "warning",
			};
		case "UNSUPPORTED_GIT_REPO":
			return {
				title: "Choose a valid Git folder",
				message: "AO could not read the Git metadata here. Repair the repository or choose a plain folder.",
				tone: "warning",
			};
		default:
			return {
				title: error.toLowerCase().startsWith("setup failed:") ? "Repository setup failed" : "Could not create project",
				message: message || "Try again, or choose a different folder.",
				tone: "error",
			};
	}
}

export function CreateProjectAgentSheet({
	error,
	isCreating,
	isInitializing = false,
	kind,
	onOpenChange,
	onSubmit,
	open,
	path,
	repositorySetupNeeded = false,
}: CreateProjectAgentSheetProps) {
	const queryClient = useQueryClient();
	const agentsQuery = useQuery({
		...agentsQueryOptions,
		enabled: open,
	});
	const modelAvailabilityQuery = useModelAvailabilityQuery(open);
	const refreshAgentsMutation = useMutation({
		mutationFn: refreshAgents,
		onSuccess: (next) => queryClient.setQueryData(agentsQueryKey, next),
	});
	const refreshModelsMutation = useMutation({
		mutationFn: () => fetchModelAvailability({ force: true }),
		onSuccess: (next) => queryClient.setQueryData(modelAvailabilityQueryKey, next),
	});
	const agents = agentsQuery.data;
	const installedAgents = agents?.installed ?? [];
	const agentOptions = agents?.authorized ?? [];
	const supportedAgents = agents?.supported ?? [];
	const isLoadingAgents = agents === undefined && agentsQuery.isFetching;
	const agentsError = agentsQuery.isError
		? agentsQuery.error instanceof Error
			? agentsQuery.error.message
			: "Could not load agent catalog."
		: null;
	const displayError = refreshModelsMutation.isError
		? refreshModelsMutation.error instanceof Error
			? refreshModelsMutation.error.message
			: "Could not refresh model availability."
		: refreshAgentsMutation.isError
			? refreshAgentsMutation.error instanceof Error
				? refreshAgentsMutation.error.message
				: "Could not refresh agent catalog."
			: agentsError;
	const [workerAgent, setWorkerAgent] = useState("");
	const [orchestratorAgent, setOrchestratorAgent] = useState("");
	const [permissions, setPermissions] = useState<string>(NEW_PROJECT_DEFAULTS.permissions);
	const [model, setModel] = useState<string>(NEW_PROJECT_DEFAULTS.model);
	const [intake, setIntake] = useState<IntakeForm>(EMPTY_INTAKE);
	const isBusy = isCreating || isInitializing;
	const canSubmit = workerAgent !== "" && orchestratorAgent !== "" && !isBusy && !isLoadingAgents;
	const sheetError = error ? projectSheetError(error) : null;

	useEffect(() => {
		if (!open) {
			setWorkerAgent("");
			setOrchestratorAgent("");
			setPermissions(NEW_PROJECT_DEFAULTS.permissions);
			setModel(NEW_PROJECT_DEFAULTS.model);
			setIntake(EMPTY_INTAKE);
		}
	}, [open, path]);

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !isBusy && onOpenChange(next)}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
						<div className="min-w-0">
							<Dialog.Title className="text-subtitle font-semibold text-foreground">
								{kind === "workspace" ? "Workspace agents" : "Project agents"}
							</Dialog.Title>
							<Dialog.Description className="mt-1 break-all text-xs text-muted-foreground">
								{path ?? ""}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label="Close project agents dialog"
								disabled={isBusy}
							>
								<X className="size-icon-base" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>
					<form
						className="space-y-4 px-5 py-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!canSubmit) return;
							void onSubmit({
								workerAgent,
								orchestratorAgent,
								permissions,
								model: model.trim(),
								trackerIntake: buildIntake(intake),
							});
						}}
					>
						<div className="grid gap-3 sm:grid-cols-2">
							<RequiredAgentField
								id="newProjectWorkerAgent"
								label="Worker agent"
								placeholder="Select worker agent"
								value={workerAgent}
								authorized={agentOptions}
								installed={installedAgents}
								supported={supportedAgents}
								disabled={isLoadingAgents}
								onChange={setWorkerAgent}
							/>
							<RequiredAgentField
								id="newProjectOrchestratorAgent"
								label="Orchestrator agent"
								placeholder="Select orchestrator agent"
								value={orchestratorAgent}
								authorized={agentOptions}
								installed={installedAgents}
								supported={supportedAgents}
								disabled={isLoadingAgents}
								onChange={setOrchestratorAgent}
							/>
						</div>

						{isLoadingAgents && <p className="text-xs leading-row text-muted-foreground">Loading agents...</p>}

						<div className="grid gap-3 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="newProjectPermissions" className="text-[12px] font-medium text-muted-foreground">
									Permission mode
								</Label>
								<Select value={permissions} onValueChange={setPermissions}>
									<SelectTrigger id="newProjectPermissions" className="h-8 w-full text-[13px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent position="popper" align="start" sideOffset={4}>
										{PERMISSION_MODE_OPTIONS.map((opt) => (
											<SelectItem key={opt.value} value={opt.value}>
												{opt.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<ModelAvailabilityField
								id="newProjectModel"
								label="Model"
								value={model}
								onChange={setModel}
								availability={modelAvailabilityQuery.data}
								isRefreshing={refreshModelsMutation.isPending || modelAvailabilityQuery.isFetching}
								onRefresh={() => refreshModelsMutation.mutate()}
							/>
						</div>
						<p className="text-[12px] leading-5 text-muted-foreground">
							Standard defaults keep a new project runnable unattended. The model applies to claude-code roles; codex
							and codex-fugu keep their own default.
						</p>

						<div className="flex items-center justify-between gap-3 text-[12px] leading-5 text-muted-foreground">
							<span>Agent availability is cached.</span>
							<button
								type="button"
								className="shrink-0 rounded text-foreground underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
								disabled={refreshAgentsMutation.isPending}
								onClick={() => refreshAgentsMutation.mutate()}
							>
								{refreshAgentsMutation.isPending ? "Refreshing..." : "Refresh agents"}
							</button>
						</div>

						{displayError && (
							<div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-row text-destructive">
								<span>{displayError}</span>
								<button
									type="button"
									className="shrink-0 rounded text-foreground underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
									disabled={refreshAgentsMutation.isPending}
									onClick={() => refreshAgentsMutation.mutate()}
								>
									Retry
								</button>
							</div>
						)}

						<div className="border-t border-border pt-4">
							<IntakeFields form={intake} onChange={(patch) => setIntake((f) => ({ ...f, ...patch }))} compact />
						</div>

						{repositorySetupNeeded && (
							<div className="rounded-md border border-border bg-surface/80 px-3 py-2.5 text-xs leading-body-md text-muted-foreground">
								If this folder needs Git setup, AO will initialize it and create the first commit before starting.
							</div>
						)}

						{sheetError && (
							<div
								role="alert"
								className={
									sheetError.tone === "warning"
										? "flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs leading-body-md"
										: "flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs leading-body-md"
								}
							>
								<TriangleAlert
									className={
										sheetError.tone === "warning"
											? "mt-0.5 size-icon-sm shrink-0 text-warning"
											: "mt-0.5 size-icon-sm shrink-0 text-destructive"
									}
									aria-hidden="true"
								/>
								<div className="min-w-0 space-y-0.5">
									<p
										className={
											sheetError.tone === "warning" ? "font-medium text-foreground" : "font-medium text-destructive"
										}
									>
										{sheetError.title}
									</p>
									<p className="text-muted-foreground">{sheetError.message}</p>
								</div>
							</div>
						)}

						<div className="flex items-center justify-end gap-2 pt-1">
							<Button type="button" variant="ghost" disabled={isBusy} onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" disabled={!canSubmit}>
								{isInitializing
									? "Setting up..."
									: isCreating
										? "Creating..."
										: kind === "workspace"
											? "Create workspace and start"
											: "Create and start"}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export const RequiredAgentField = memo(function RequiredAgentField({
	authorized,
	disabled = false,
	id,
	invalid = false,
	installed,
	label,
	onChange,
	placeholder,
	supported,
	value,
}: {
	authorized?: AgentInfo[];
	disabled?: boolean;
	id: string;
	invalid?: boolean;
	installed?: AgentInfo[];
	label: string;
	onChange: (value: string) => void;
	placeholder: string;
	supported?: AgentInfo[];
	value: string;
}) {
	const fallbackAgents: AgentInfo[] = AGENT_OPTIONS.map((agent) => ({ id: agent, label: agent }));
	const supportedAgents = supported ?? fallbackAgents;
	const installedAgents = installed ?? supportedAgents;
	const authorizedAgents = authorized ?? supportedAgents;
	const authorizedIds = new Set(authorizedAgents.map((agent) => agent.id));
	const installedById = new Map(installedAgents.map((agent) => [agent.id, agent]));
	const options = supportedAgents
		.map((agent) => {
			const installedAgent = installedById.get(agent.id);
			const authStatus = installedAgent?.authStatus;
			const isAuthorized = authorizedIds.has(agent.id) || authStatus === "authorized";
			const isAuthUnknown = Boolean(installedAgent) && !isAuthorized && authStatus !== "unauthorized";
			const isSelectable = isAuthorized || isAuthUnknown;
			const rank = isAuthorized ? 0 : isAuthUnknown ? 1 : installedAgent ? 2 : 3;
			return {
				...agent,
				disabled: !isSelectable,
				rank,
				reason: !installedAgent ? "Needs install" : isAuthUnknown ? "Auth unknown" : !isAuthorized ? "Needs auth" : "",
				warning: isAuthUnknown,
			};
		})
		.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
				{label}
			</Label>
			<Select value={value} onValueChange={onChange} disabled={disabled}>
				<SelectTrigger id={id} size="sm" className="w-full text-control" aria-invalid={invalid || undefined}>
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent position="popper" side="bottom" align="start" sideOffset={4} className="max-h-select-menu-max!">
					{options.map((agent) => (
						<SelectItem
							key={agent.id}
							value={agent.id}
							disabled={agent.disabled}
							className="[&>span:last-child]:w-full"
						>
							<span className="flex min-w-0 w-full items-center justify-between gap-4">
								<span className="truncate">{agent.label}</span>
								{agent.reason && (
									<span className="inline-flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
										{agent.warning && <TriangleAlert className="size-3 text-warning" aria-hidden="true" />}
										{agent.reason}
									</span>
								)}
							</span>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
});
