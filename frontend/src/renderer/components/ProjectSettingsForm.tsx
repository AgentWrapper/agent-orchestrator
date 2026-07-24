import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { components } from "../../api/schema";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { newestActiveOrchestrator } from "../types/workspace";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import { DashboardSubhead } from "./DashboardSubhead";
import { buildIntake, deriveGitHubRepo, IntakeFields, type IntakeForm, intakeNeedsRule } from "./IntakeFields";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type Project = components["schemas"]["Project"];
type ProjectConfig = components["schemas"]["ProjectConfig"];
type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

const PERMISSION_MODE_OPTIONS = [
	{ value: "default", label: "Default" },
	{ value: "accept-edits", label: "Accept edits" },
	{ value: "auto", label: "Auto" },
	{ value: "bypass-permissions", label: "Bypass permissions" },
] as const;

const KNOWN_REVIEWER_HARNESS_IDS = new Set(["claude-code", "codex", "opencode"]);

const projectQueryKey = (id: string) => ["project", id] as const;

export function ProjectSettingsForm({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: projectQueryKey(projectId),
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId } },
			});
			if (error) throw new Error(apiErrorMessage(error));
			if (data?.status !== "ok") throw new Error("Project config is unavailable (degraded).");
			return data.project as Project;
		},
	});

	if (query.isLoading) {
		return <CenteredNote>Loading project settings…</CenteredNote>;
	}
	if (query.isError || !query.data) {
		return (
			<CenteredNote>{query.error instanceof Error ? query.error.message : "Could not load project."}</CenteredNote>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead title="Settings" subtitle={query.data.path} />
			<div className="min-h-0 flex-1 overflow-y-auto p-4.5">
				<SettingsBody
					key={projectId}
					project={query.data}
					onSaved={() => queryClient.invalidateQueries({ queryKey: workspaceQueryKey })}
					projectId={projectId}
				/>
			</div>
		</div>
	);
}

function SettingsBody({ project, projectId, onSaved }: { project: Project; projectId: string; onSaved: () => void }) {
	const queryClient = useQueryClient();
	const workspaceQuery = useWorkspaceQuery();
	const config = project.config ?? {};
	const isScratchProject = project.kind === "scratch";
	const workspace = workspaceQuery.data?.find((item) => item.id === projectId);
	const activeOrchestrator = newestActiveOrchestrator(workspace?.sessions ?? []);
	const intake: TrackerIntakeConfig = config.trackerIntake ?? {};
	const [form, setForm] = useState({
		displayName: project.name,
		defaultBranch: config.defaultBranch ?? project.defaultBranch ?? "",
		sessionPrefix: config.sessionPrefix ?? "",
		workerAgent: config.worker?.agent ?? "",
		orchestratorAgent: config.orchestrator?.agent ?? "",
		model: config.agentConfig?.model ?? "",
		permissions: config.agentConfig?.permissions ?? "",
		reviewerHarness: config.reviewers?.[0]?.harness ?? "",
		intakeEnabled: intake.enabled ?? false,
		intakeRepo: intake.repo ?? "",
		intakeAssignee: intake.assignee ?? "",
	});
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [replacementError, setReplacementError] = useState<string | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);
	const initialOrchestratorAgent = config.orchestrator?.agent ?? "";
	const missingRequiredAgent = form.workerAgent === "" || form.orchestratorAgent === "";
	const agentsQuery = useQuery(agentsQueryOptions);
	const agentCatalog = agentsQuery.data;
	const refreshAgentsMutation = useMutation({
		mutationFn: refreshAgents,
		onSuccess: (next) => queryClient.setQueryData(agentsQueryKey, next),
	});

	// Git projects can derive owner/repo from origin when trackerIntake.repo is unset.
	// Scratch hides tracker intake entirely, so this display-only preview is only
	// rendered for git-backed projects.
	const intakeForm: IntakeForm = {
		enabled: form.intakeEnabled,
		repo: form.intakeRepo,
		assignee: form.intakeAssignee,
	};
	const patchIntake = (patch: Partial<IntakeForm>) =>
		setForm((f) => ({
			...f,
			intakeEnabled: patch.enabled ?? f.intakeEnabled,
			intakeRepo: patch.repo ?? f.intakeRepo,
			intakeAssignee: patch.assignee ?? f.intakeAssignee,
		}));
	const effectiveIntakeRepo = form.intakeRepo.trim() || deriveGitHubRepo(project.repo);
	const intakeIncomplete = !isScratchProject && intakeNeedsRule(intakeForm);

	const mutation = useMutation({
		mutationFn: async () => {
			void captureRendererEvent("ao.renderer.settings_save_requested", { project_id: projectId });
			const displayName = form.displayName.trim();
			// PUT replaces the whole config; merge the edited fields over what loaded
			// so we don't drop env/symlinks/postCreate the form doesn't expose.
			const next: ProjectConfig = isScratchProject
				? {
						...scratchSupportedConfig(config),
						worker: { ...config.worker, agent: form.workerAgent },
						orchestrator: { ...config.orchestrator, agent: form.orchestratorAgent },
						agentConfig: blankToUndefined({
							...config.agentConfig,
							model: form.model || undefined,
							permissions: form.permissions || undefined,
						}),
					}
				: {
						...config,
						defaultBranch: form.defaultBranch || undefined,
						sessionPrefix: form.sessionPrefix || undefined,
						worker: { ...config.worker, agent: form.workerAgent },
						orchestrator: { ...config.orchestrator, agent: form.orchestratorAgent },
						agentConfig: blankToUndefined({
							...config.agentConfig,
							model: form.model || undefined,
							permissions: form.permissions || undefined,
						}),
						reviewers: form.reviewerHarness ? [{ harness: form.reviewerHarness }] : undefined,
						trackerIntake: buildIntake(intakeForm),
					};
			const { error } = await apiClient.PUT("/api/v1/projects/{id}", {
				params: { path: { id: projectId } },
				body: { displayName, config: next },
			});
			if (error) throw new Error(apiErrorMessage(error));
			if (
				form.orchestratorAgent !== initialOrchestratorAgent ||
				(activeOrchestrator && activeOrchestrator.provider !== form.orchestratorAgent)
			) {
				try {
					await spawnOrchestrator(projectId, "settings", true);
				} catch (error) {
					return {
						replacementError: error instanceof Error ? error.message : "Could not replace orchestrator",
					};
				}
			}
			return { replacementError: null };
		},
		onSuccess: (result) => {
			void captureRendererEvent("ao.renderer.settings_save_succeeded", { project_id: projectId });
			setSavedAt(Date.now());
			setReplacementError(result.replacementError);
			setValidationError(null);
			void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
			onSaved();
		},
		onError: () => {
			void captureRendererEvent("ao.renderer.settings_save_failed", { project_id: projectId });
		},
	});

	return (
		<form
			className="mx-auto flex max-w-2xl flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				setSavedAt(null);
				setReplacementError(null);
				if (missingRequiredAgent) {
					setValidationError("Worker and orchestrator agents are required.");
					return;
				}
				if (form.displayName.trim() === "") {
					setValidationError("Project name is required.");
					return;
				}
				if (intakeIncomplete) {
					setValidationError("Enabling intake requires an assignee.");
					return;
				}
				setValidationError(null);
				mutation.mutate();
			}}
		>
			<Card>
				<CardHeader>
					<CardTitle className="text-control">Identity</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4 font-mono text-xs text-muted-foreground">
					<Field label="Project name" htmlFor="projectName">
						<input
							id="projectName"
							className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 font-sans text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.displayName}
							onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
						/>
					</Field>
					<ReadonlyRow label="id" value={project.id} />
					<ReadonlyRow label="kind" value={projectKindLabel(project.kind)} />
					<ReadonlyRow label="path" value={project.path} />
					<ReadonlyRow label="repo" value={project.repo || "—"} />
				</CardContent>
			</Card>

			{project.kind === "workspace" && (
				<Card>
					<CardHeader>
						<CardTitle className="text-[13px]">Workspace repos</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{project.workspaceRepos?.length ? (
							project.workspaceRepos.map((repo) => (
								<div
									key={repo.name}
									className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-3 rounded-md border border-border px-3 py-2 font-mono text-[12px]"
								>
									<span className="truncate text-foreground">{repo.name}</span>
									<span className="min-w-0 truncate text-muted-foreground">
										{repo.relativePath}
										{repo.repo ? ` · ${repo.repo}` : ""}
									</span>
								</div>
							))
						) : (
							<p className="text-[12px] text-muted-foreground">No child repositories are registered.</p>
						)}
					</CardContent>
				</Card>
			)}

			{!isScratchProject && (
				<Card>
					<CardHeader>
						<CardTitle className="text-control">Worktrees</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<Field label="Default branch" htmlFor="defaultBranch">
							<input
								id="defaultBranch"
								className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
								value={form.defaultBranch}
								onChange={(e) => setForm((f) => ({ ...f, defaultBranch: e.target.value }))}
								placeholder="main"
							/>
						</Field>
						<Field label="Session prefix" htmlFor="sessionPrefix">
							<input
								id="sessionPrefix"
								className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
								value={form.sessionPrefix}
								onChange={(e) => setForm((f) => ({ ...f, sessionPrefix: e.target.value }))}
								placeholder="ao"
							/>
						</Field>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<CardTitle className="text-control">Agents</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<RequiredAgentField
						id="workerAgent"
						value={form.workerAgent}
						placeholder="Select worker agent"
						label="Default worker agent"
						authorized={agentCatalog?.authorized}
						installed={agentCatalog?.installed}
						supported={agentCatalog?.supported}
						disabled={agentsQuery.isFetching && agentCatalog === undefined}
						invalid={validationError !== null && form.workerAgent === ""}
						onChange={(v) => setForm((f) => ({ ...f, workerAgent: v }))}
					/>
					<RequiredAgentField
						id="orchestratorAgent"
						value={form.orchestratorAgent}
						placeholder="Select orchestrator agent"
						label="Default orchestrator agent"
						authorized={agentCatalog?.authorized}
						installed={agentCatalog?.installed}
						supported={agentCatalog?.supported}
						disabled={agentsQuery.isFetching && agentCatalog === undefined}
						invalid={validationError !== null && form.orchestratorAgent === ""}
						onChange={(v) => setForm((f) => ({ ...f, orchestratorAgent: v }))}
					/>
					<div className="flex items-center justify-between gap-3 text-xs leading-row text-muted-foreground">
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
					{refreshAgentsMutation.isError && (
						<p className="text-xs leading-row text-error">
							{refreshAgentsMutation.error instanceof Error
								? refreshAgentsMutation.error.message
								: "Could not refresh agent catalog."}
						</p>
					)}
					{missingRequiredAgent && (
						<p className="text-xs leading-row text-error">Worker and orchestrator agents are required.</p>
					)}
					<Field label="Model override" htmlFor="model">
						<input
							id="model"
							className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.model}
							onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
							placeholder="(agent default)"
						/>
					</Field>
					<Field label="Permission mode" htmlFor="permissionMode">
						<PermissionModeSelect
							id="permissionMode"
							value={form.permissions}
							onChange={(v) => setForm((f) => ({ ...f, permissions: v }))}
						/>
					</Field>
				</CardContent>
			</Card>

			{!isScratchProject && (
				<Card>
					<CardHeader>
						<CardTitle className="text-control">Reviewers</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<Field label="Default reviewer agent" htmlFor="reviewerHarness">
							<ReviewerSelect
								id="reviewerHarness"
								value={form.reviewerHarness}
								onChange={(v) => setForm((f) => ({ ...f, reviewerHarness: v }))}
								authorized={agentCatalog?.authorized}
								installed={agentCatalog?.installed}
								supported={agentCatalog?.supported}
								disabled={agentsQuery.isFetching && agentCatalog === undefined}
							/>
						</Field>
					</CardContent>
				</Card>
			)}

			{!isScratchProject && (
				<Card>
					<CardHeader>
						<CardTitle className="text-control">Tracker intake</CardTitle>
					</CardHeader>
					<CardContent>
						<IntakeFields form={intakeForm} onChange={patchIntake} repoPreview={{ value: effectiveIntakeRepo }} />
					</CardContent>
				</Card>
			)}

			<div className="flex items-center gap-3">
				<Button type="submit" variant="primary" disabled={mutation.isPending}>
					{mutation.isPending ? "Saving…" : "Save changes"}
				</Button>
				{validationError && <span className="text-xs text-error">{validationError}</span>}
				{mutation.isError && (
					<span className="text-xs text-error">
						{mutation.error instanceof Error ? mutation.error.message : "Save failed"}
					</span>
				)}
				{savedAt && !mutation.isPending && !mutation.isError && <span className="text-xs text-success">Saved.</span>}
				{replacementError && !mutation.isPending && !mutation.isError && (
					<span className="text-xs text-warning">Orchestrator restart failed: {replacementError}</span>
				)}
			</div>
		</form>
	);
}

function PermissionModeSelect({
	id,
	value,
	onChange,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<Select value={value || "__default__"} onValueChange={(v) => onChange(v === "__default__" ? "" : v)}>
			<SelectTrigger id={id} className="h-control-form w-full text-control">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="__default__">Project default</SelectItem>
				{PERMISSION_MODE_OPTIONS.map((opt) => (
					<SelectItem key={opt.value} value={opt.value}>
						{opt.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

const REVIEWER_AGENT_PRIORITY = ["claude-code", "codex", "cursor", "opencode", "aider"] as const;
const REVIEWER_AGENT_PRIORITY_RANK = new Map<string, number>(
	REVIEWER_AGENT_PRIORITY.map((agent, index) => [agent, index]),
);

function agentLabelCompare(a: components["schemas"]["AgentInfo"], b: components["schemas"]["AgentInfo"]): number {
	return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

function ReviewerSelect({
	id,
	value,
	onChange,
	disabled = false,
	authorized,
	installed,
	supported,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	authorized?: components["schemas"]["AgentInfo"][];
	installed?: components["schemas"]["AgentInfo"][];
	supported?: components["schemas"]["AgentInfo"][];
}) {
	const fallbackAgents: components["schemas"]["AgentInfo"][] = [...KNOWN_REVIEWER_HARNESS_IDS].map((id) => ({
		id,
		label: id,
	}));
	const filteredSupported = (supported ?? fallbackAgents).filter((a) => KNOWN_REVIEWER_HARNESS_IDS.has(a.id));
	const supportedAgents = filteredSupported.length > 0 ? filteredSupported : fallbackAgents;
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
				priorityRank: REVIEWER_AGENT_PRIORITY_RANK.get(agent.id) ?? Number.MAX_SAFE_INTEGER,
				rank,
				reason: !installedAgent ? "Needs install" : isAuthUnknown ? "Auth unknown" : !isAuthorized ? "Needs auth" : "",
				warning: isAuthUnknown,
			};
		})
		.sort((a, b) => a.rank - b.rank || a.priorityRank - b.priorityRank || agentLabelCompare(a, b));

	return (
		<Select
			value={value || "__default__"}
			onValueChange={(v) => onChange(v === "__default__" ? "" : v)}
			disabled={disabled}
		>
			<SelectTrigger id={id} size="sm" className="w-full text-control">
				<SelectValue />
			</SelectTrigger>
			<SelectContent position="popper" side="bottom" align="start" sideOffset={4} className="max-h-select-menu-max!">
				<SelectItem value="__default__">Project default</SelectItem>
				{options.map((agent) => (
					<SelectItem key={agent.id} value={agent.id} disabled={agent.disabled} className="[&>span:last-child]:w-full">
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
	);
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
				{label}
			</Label>
			{children}
		</div>
	);
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-12 shrink-0 text-passive">{label}</span>
			<span className="min-w-0 flex-1 truncate text-foreground">{value}</span>
		</div>
	);
}

function CenteredNote({ children }: { children: React.ReactNode }) {
	return (
		<div className="grid h-full place-items-center bg-background p-6 text-center text-xs text-passive">{children}</div>
	);
}

function projectKindLabel(kind: string): string {
	switch (kind) {
		case "single_repo":
			return "single repo";
		case "workspace":
			return "workspace";
		case "scratch":
			return "scratch";
		default:
			return kind || "unknown";
	}
}

function scratchSupportedConfig(config: ProjectConfig): ProjectConfig {
	const { defaultBranch: _defaultBranch, reviewers: _reviewers, trackerIntake: _trackerIntake, ...supported } = config;
	return supported;
}

// Drop an object whose every value is undefined so we send `undefined` (omit)
// rather than an empty {} the daemon would persist.
function blankToUndefined<T extends object>(obj: T): T | undefined {
	return Object.values(obj).some((v) => v !== undefined) ? obj : undefined;
}
