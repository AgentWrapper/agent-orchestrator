import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	Bot,
	Fingerprint,
	FolderGit2,
	FolderOpen,
	GitBranch,
	Hash,
	Layers,
	Link,
	Network,
	RefreshCw,
	ScanEye,
	Shield,
	Sparkles,
	Tag,
	TriangleAlert,
	type LucideIcon,
} from "lucide-react";
import type { components } from "../../api/schema";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { buildRankedAgentOptions } from "../lib/agent-select-options";
import { captureRendererEvent } from "../lib/telemetry";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { cn } from "../lib/utils";
import { newestActiveOrchestrator } from "../types/workspace";
import { AgentAvatar } from "./AgentAvatar";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import { buildIntake, deriveGitHubRepo, IntakeFields, type IntakeForm, intakeNeedsRule } from "./IntakeFields";
import { AgentSelectMenuItem } from "./settings/AgentSelectMenuItem";
import { SettingsOptionMenu } from "./settings/SettingsOptionMenu";
import { SettingsPageShell } from "./settings/SettingsPageShell";
import { SettingsPanel } from "./settings/SettingsPanel";
import { SettingsRow } from "./settings/SettingsRow";
import { SettingsSection } from "./settings/SettingsSection";

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
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const closeSettings = () => navigate({ to: "/projects/$projectId", params: { projectId } });

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

	return (
		<SettingsPageShell>
			<SettingsPanel onClose={closeSettings} subtitle={query.data?.path}>
				{query.isLoading ? (
					<p className="text-sm text-settings-muted">Loading project settings…</p>
				) : query.isError || !query.data ? (
					<p className="text-sm text-error">
						{query.error instanceof Error ? query.error.message : "Could not load project."}
					</p>
				) : (
					<SettingsBody
						key={projectId}
						project={query.data}
						onSaved={() => queryClient.invalidateQueries({ queryKey: workspaceQueryKey })}
						projectId={projectId}
					/>
				)}
			</SettingsPanel>
		</SettingsPageShell>
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
			className="flex w-full flex-col gap-(--size-settings-section-gap)"
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
			<SettingsSection title="Identity">
				<SettingsInputRow
					icon={Tag}
					label="Project name"
					id="projectName"
					value={form.displayName}
					onChange={(value) => setForm((f) => ({ ...f, displayName: value }))}
				/>
				<SettingsValueRow icon={Fingerprint} label="id" value={project.id} />
				<SettingsValueRow icon={Layers} label="kind" value={projectKindLabel(project.kind)} />
				<SettingsValueRow icon={FolderOpen} label="path" value={project.path} />
				<SettingsValueRow icon={Link} label="repo" value={project.repo || "—"} />
			</SettingsSection>

			{project.kind === "workspace" && (
				<SettingsSection title="Workspace repos">
					{project.workspaceRepos?.length ? (
						project.workspaceRepos.map((repo) => (
							<SettingsRow key={repo.name} icon={FolderGit2} label={repo.name}>
								<span className="settings-row-value">
									{repo.relativePath}
									{repo.repo ? ` · ${repo.repo}` : ""}
								</span>
							</SettingsRow>
						))
					) : (
						<p className="px-1 text-xs text-settings-muted">No child repositories are registered.</p>
					)}
				</SettingsSection>
			)}

			{!isScratchProject && (
				<SettingsSection title="Worktrees">
					<SettingsInputRow
						icon={GitBranch}
						label="Default branch"
						id="defaultBranch"
						value={form.defaultBranch}
						placeholder="main"
						tooltip="Changes affect new worktrees and do not migrate an existing Canonical Orchestrator Branch."
						onChange={(value) => setForm((f) => ({ ...f, defaultBranch: value }))}
					/>
					<SettingsInputRow
						icon={Hash}
						label="Session prefix"
						id="sessionPrefix"
						value={form.sessionPrefix}
						placeholder="ao"
						onChange={(value) => setForm((f) => ({ ...f, sessionPrefix: value }))}
					/>
				</SettingsSection>
			)}

			<SettingsSection title="Agents">
				<RequiredAgentField
					id="workerAgent"
					variant="settings-row"
					icon={Bot}
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
					variant="settings-row"
					icon={Network}
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
				<SettingsRow icon={RefreshCw} label="Refresh agents">
					<button
						type="button"
						aria-label="Refresh agents"
						className="settings-option-trigger inline-flex items-center gap-1.5 disabled:pointer-events-none disabled:opacity-50"
						disabled={refreshAgentsMutation.isPending}
						onClick={() => refreshAgentsMutation.mutate()}
					>
						<RefreshCw className={cn("size-icon-base", refreshAgentsMutation.isPending && "animate-spin")} aria-hidden="true" />
						{refreshAgentsMutation.isPending ? "Refreshing…" : "Refresh"}
					</button>
				</SettingsRow>
				{refreshAgentsMutation.isError && (
					<p className="px-1 text-xs leading-row text-error">
						{refreshAgentsMutation.error instanceof Error
							? refreshAgentsMutation.error.message
							: "Could not refresh agent catalog."}
					</p>
				)}
				{missingRequiredAgent && (
					<p className="px-1 text-xs leading-row text-error">Worker and orchestrator agents are required.</p>
				)}
				<SettingsInputRow
					icon={Sparkles}
					label="Model override"
					id="model"
					value={form.model}
					placeholder="(agent default)"
					onChange={(value) => setForm((f) => ({ ...f, model: value }))}
				/>
				<SettingsRow icon={Shield} label="Permission mode">
					<PermissionModeSelect
						value={form.permissions}
						onChange={(v) => setForm((f) => ({ ...f, permissions: v }))}
					/>
				</SettingsRow>
				{isScratchProject && (
					<SaveChangesFooter
						isPending={mutation.isPending}
						validationError={validationError}
						mutationError={mutation.isError ? mutation.error : null}
						savedAt={savedAt}
						replacementError={replacementError}
					/>
				)}
			</SettingsSection>

			{!isScratchProject && (
				<SettingsSection title="Reviewers">
					<SettingsRow icon={ScanEye} label="Default reviewer agent">
						<ReviewerSelect
							value={form.reviewerHarness}
							onChange={(v) => setForm((f) => ({ ...f, reviewerHarness: v }))}
							authorized={agentCatalog?.authorized}
							installed={agentCatalog?.installed}
							supported={agentCatalog?.supported}
							disabled={agentsQuery.isFetching && agentCatalog === undefined}
						/>
					</SettingsRow>
				</SettingsSection>
			)}

			{!isScratchProject && (
				<SettingsSection title="Tracker intake">
					<IntakeFields
						variant="settings"
						form={intakeForm}
						onChange={patchIntake}
						repoPreview={{ value: effectiveIntakeRepo }}
					/>
					<SaveChangesFooter
						isPending={mutation.isPending}
						validationError={validationError}
						mutationError={mutation.isError ? mutation.error : null}
						savedAt={savedAt}
						replacementError={replacementError}
					/>
				</SettingsSection>
			)}
		</form>
	);
}

function SaveChangesFooter({
	isPending,
	validationError,
	mutationError,
	savedAt,
	replacementError,
}: {
	isPending: boolean;
	validationError: string | null;
	mutationError: unknown;
	savedAt: number | null;
	replacementError: string | null;
}) {
	return (
		<div className="flex flex-col items-start">
			<button
				type="submit"
				className="settings-footer-button settings-footer-button-primary"
				disabled={isPending}
			>
				{isPending ? "Saving…" : "Save changes"}
			</button>
			{validationError && (
				<span className="inline-flex items-center gap-1.5 text-xs text-error">
					<TriangleAlert className="size-3 shrink-0 text-error" aria-hidden="true" />
					{validationError}
				</span>
			)}
			{mutationError != null && (
				<span className="text-xs text-error">
					{mutationError instanceof Error ? mutationError.message : "Save failed"}
				</span>
			)}
			{savedAt && !isPending && !mutationError && <span className="text-xs text-success">Saved.</span>}
			{replacementError && !isPending && !mutationError && (
				<span className="text-xs text-warning">Orchestrator restart failed: {replacementError}</span>
			)}
		</div>
	);
}

function SettingsInputRow({
	icon,
	label,
	id,
	value,
	onChange,
	placeholder,
	tooltip,
}: {
	icon?: LucideIcon;
	label: string;
	id: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	tooltip?: string;
}) {
	return (
		<SettingsRow icon={icon} label={label} tooltip={tooltip}>
			<input
				id={id}
				aria-label={label}
				className="settings-inline-input"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
			/>
		</SettingsRow>
	);
}

function SettingsValueRow({
	icon,
	label,
	value,
}: {
	icon?: LucideIcon;
	label: string;
	value: string;
}) {
	return (
		<SettingsRow icon={icon} label={label}>
			<span className="settings-row-value" title={value}>
				{value}
			</span>
		</SettingsRow>
	);
}

function PermissionModeSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const options = [
		{ value: "__default__", label: "Project default" },
		...PERMISSION_MODE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label })),
	];

	return (
		<SettingsOptionMenu
			aria-label="Permission mode"
			value={value || "__default__"}
			options={options}
			onChange={(v) => onChange(v === "__default__" ? "" : v)}
		/>
	);
}

const REVIEWER_AGENT_PRIORITY = ["claude-code", "codex", "cursor", "opencode", "aider"] as const;
const REVIEWER_AGENT_PRIORITY_RANK = new Map<string, number>(
	REVIEWER_AGENT_PRIORITY.map((agent, index) => [agent, index]),
);

function ReviewerSelect({
	value,
	onChange,
	disabled = false,
	authorized,
	installed,
	supported,
}: {
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
	const options = buildRankedAgentOptions({
		supported: supportedAgents,
		installed,
		authorized,
		priorityRank: REVIEWER_AGENT_PRIORITY_RANK,
		fallbackAgents,
	});

	const menuOptions = [
		{ value: "__default__", label: "Project default" },
		...options.map((agent) => ({ value: agent.id, label: agent.label, disabled: agent.disabled })),
	];
	const selectedValue = value || "__default__";

	return (
		<SettingsOptionMenu
			aria-label="Default reviewer agent"
			value={selectedValue}
			options={menuOptions}
			disabled={disabled}
			menuClassName="settings-agent-menu-surface"
			menuItemClassName="settings-agent-menu-item"
			onChange={(v) => onChange(v === "__default__" ? "" : v)}
			renderTrigger={(selected) => (
				<>
					{selected && selected.value !== "__default__" ? (
						<AgentAvatar provider={selected.value} className="size-icon-lg" />
					) : null}
					<span className="min-w-0 truncate">{selected?.label ?? "Project default"}</span>
				</>
			)}
			renderMenuItem={(option, selected) => {
				if (option.value === "__default__") {
					return <AgentSelectMenuItem label={option.label} selected={selected} />;
				}
				const agent = options.find((entry) => entry.id === option.value);
				if (!agent) return option.label;
				return (
					<AgentSelectMenuItem
						agentId={agent.id}
						label={agent.label}
						selected={selected}
						status={agent.status}
						statusTone={agent.statusTone}
						disabled={agent.disabled}
					/>
				);
			}}
		/>
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

function blankToUndefined<T extends object>(obj: T): T | undefined {
	return Object.values(obj).some((v) => v !== undefined) ? obj : undefined;
}
