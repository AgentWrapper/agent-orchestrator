import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
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
import {
	agentModelsQueryKey,
	agentModelsQueryOptions,
	refreshAgentModels,
	revalidateAgentModels,
	type AgentModelCatalog,
} from "../hooks/useAgentModelsQuery";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { cn } from "../lib/utils";
import { newestActiveOrchestrator } from "../types/workspace";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import { buildIntake, deriveGitHubRepo, IntakeFields, type IntakeForm, intakeNeedsRule } from "./IntakeFields";
import { ReviewerSelect } from "./ReviewerSelect";
import { AgentModelCombobox } from "./settings/AgentModelCombobox";
import { SettingsOptionMenu } from "./settings/SettingsOptionMenu";
import { SettingsRow } from "./settings/SettingsRow";
import { SettingsSection } from "./settings/SettingsSection";
import { Button } from "./ui/button";

type Project = components["schemas"]["Project"];
type ProjectConfig = components["schemas"]["ProjectConfig"];
type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

const PERMISSION_MODE_VALUES = ["default", "accept-edits", "auto", "bypass-permissions"] as const;


const projectQueryKey = (id: string) => ["project", id] as const;

export type ProjectSettingsSection = "general" | "agents" | "workflow" | "intake";

export function ProjectSettingsForm({ projectId, section = "general" }: { projectId: string; section?: ProjectSettingsSection }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: projectQueryKey(projectId),
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId } },
			});
			if (error) throw new Error(apiErrorMessage(error));
			if (data?.status !== "ok") throw new Error(t("settings.project.degraded"));
			return data.project as Project;
		},
	});

	return (
		<>
			{query.isLoading ? (
				<p className="text-sm text-settings-muted">{t("settings.project.loading")}</p>
			) : query.isError || !query.data ? (
				<p className="text-sm text-error">
					{query.error instanceof Error ? query.error.message : t("settings.project.loadFailed")}
				</p>
			) : (
				<SettingsBody
					key={projectId}
					project={query.data}
					onSaved={() => queryClient.invalidateQueries({ queryKey: workspaceQueryKey })}
					projectId={projectId}
					section={section}
				/>
			)}
		</>
	);
}

function SettingsBody({ project, projectId, onSaved, section = "general" }: { project: Project; projectId: string; onSaved: () => void; section?: ProjectSettingsSection }) {
	const { t } = useTranslation();
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
		workerModel: config.worker?.agentConfig?.model ?? config.agentConfig?.model ?? "",
		orchestratorModel: config.orchestrator?.agentConfig?.model ?? config.agentConfig?.model ?? "",
		workerMode: config.worker?.agentConfig?.mode ?? config.agentConfig?.mode ?? "",
		orchestratorMode: config.orchestrator?.agentConfig?.mode ?? config.agentConfig?.mode ?? "",
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
			const {
				model: _legacyModel,
				mode: _legacyMode,
				...sharedAgentConfig
			} = config.agentConfig ?? {};
			const next: ProjectConfig = isScratchProject
				? {
						...scratchSupportedConfig(config),
						worker: {
							...config.worker,
							agent: form.workerAgent,
							agentConfig: buildRoleAgentConfig(config.worker?.agentConfig, form.workerModel, form.workerMode),
						},
						orchestrator: {
							...config.orchestrator,
							agent: form.orchestratorAgent,
							agentConfig: buildRoleAgentConfig(
								config.orchestrator?.agentConfig,
								form.orchestratorModel,
								form.orchestratorMode,
							),
						},
						agentConfig: blankToUndefined({
							...sharedAgentConfig,
							permissions: form.permissions || undefined,
						}),
					}
				: {
						...config,
						defaultBranch: form.defaultBranch || undefined,
						sessionPrefix: form.sessionPrefix || undefined,
						worker: {
							...config.worker,
							agent: form.workerAgent,
							agentConfig: buildRoleAgentConfig(config.worker?.agentConfig, form.workerModel, form.workerMode),
						},
						orchestrator: {
							...config.orchestrator,
							agent: form.orchestratorAgent,
							agentConfig: buildRoleAgentConfig(
								config.orchestrator?.agentConfig,
								form.orchestratorModel,
								form.orchestratorMode,
							),
						},
						agentConfig: blankToUndefined({
							...sharedAgentConfig,
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
						replacementError:
							error instanceof Error ? error.message : t("settings.project.replaceOrchestratorFailed"),
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

	const saveFooter = (
		<SaveChangesFooter
			isPending={mutation.isPending}
			validationError={validationError}
			mutationError={mutation.isError ? mutation.error : null}
			savedAt={savedAt}
			replacementError={replacementError}
		/>
	);

	return (
		<form
			className="flex w-full flex-col gap-(--size-settings-section-gap)"
			onSubmit={(event) => {
				event.preventDefault();
				setSavedAt(null);
				setReplacementError(null);
				if (missingRequiredAgent) {
					setValidationError(t("settings.project.agentsRequired"));
					return;
				}
				if (form.displayName.trim() === "") {
					setValidationError(t("settings.project.nameRequired"));
					return;
				}
				if (intakeIncomplete) {
					setValidationError(t("settings.project.intakeAssigneeRequired"));
					return;
				}
				setValidationError(null);
				mutation.mutate();
			}}
		>
			{/* ── General: identity + workspace repos ───────────────────── */}
			{section === "general" && (
				<>
					<SettingsSection title={t("settings.project.identity")}>
						<SettingsInputRow
							icon={Tag}
							label={t("settings.project.name")}
							id="projectName"
							value={form.displayName}
							onChange={(value) => setForm((f) => ({ ...f, displayName: value }))}
						/>
						<SettingsValueRow icon={Fingerprint} label={t("settings.project.id")} value={project.id} />
						<SettingsValueRow icon={Layers} label={t("settings.project.kind")} value={projectKindLabel(project.kind, t)} />
						<SettingsValueRow icon={FolderOpen} label={t("settings.project.path")} value={project.path} />
						<SettingsValueRow icon={Link} label={t("settings.project.repo")} value={project.repo || "—"} />
					</SettingsSection>
					{project.kind === "workspace" && (
						<SettingsSection title={t("settings.project.workspaceRepos")}>
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
								<p className="px-1 text-xs text-settings-muted">{t("settings.project.childReposEmpty")}</p>
							)}
						</SettingsSection>
					)}
					{saveFooter}
				</>
			)}

			{/* ── Agents: worker, orchestrator, model, permissions ───────── */}
			{section === "agents" && (
				<>
					<SettingsSection title={t("settings.project.agents")}>
						<RequiredAgentField
							id="workerAgent"
							variant="settings-row"
							icon={Bot}
							value={form.workerAgent}
							placeholder={t("settings.project.selectWorker")}
							label={t("settings.project.defaultWorker")}
							authorized={agentCatalog?.authorized}
							installed={agentCatalog?.installed}
							supported={agentCatalog?.supported}
							disabled={agentsQuery.isFetching && agentCatalog === undefined}
							invalid={validationError !== null && form.workerAgent === ""}
							onChange={(v) =>
								setForm((f) => ({ ...f, workerAgent: v, workerModel: "", workerMode: "" }))
							}
						/>
						<AgentModelField
							role="worker"
							agentId={form.workerAgent}
							projectId={projectId}
							model={form.workerModel}
							mode={form.workerMode}
							onModelChange={(workerModel) => setForm((f) => ({ ...f, workerModel }))}
							onModeChange={(workerMode) => setForm((f) => ({ ...f, workerMode }))}
						/>
						<RequiredAgentField
							id="orchestratorAgent"
							variant="settings-row"
							icon={Network}
							value={form.orchestratorAgent}
							placeholder={t("settings.project.selectOrchestrator")}
							label={t("settings.project.defaultOrchestrator")}
							authorized={agentCatalog?.authorized}
							installed={agentCatalog?.installed}
							supported={agentCatalog?.supported}
							disabled={agentsQuery.isFetching && agentCatalog === undefined}
							invalid={validationError !== null && form.orchestratorAgent === ""}
							onChange={(v) =>
								setForm((f) => ({ ...f, orchestratorAgent: v, orchestratorModel: "", orchestratorMode: "" }))
							}
						/>
						<AgentModelField
							role="orchestrator"
							agentId={form.orchestratorAgent}
							projectId={projectId}
							model={form.orchestratorModel}
							mode={form.orchestratorMode}
							onModelChange={(orchestratorModel) => setForm((f) => ({ ...f, orchestratorModel }))}
							onModeChange={(orchestratorMode) => setForm((f) => ({ ...f, orchestratorMode }))}
						/>
						<SettingsRow icon={Shield} label={t("settings.project.permissionMode")}>
							<PermissionModeSelect
								value={form.permissions}
								onChange={(v) => setForm((f) => ({ ...f, permissions: v }))}
							/>
						</SettingsRow>
						<SettingsRow icon={RefreshCw} label={t("settings.project.refreshAgents")}>
							<button
								type="button"
								aria-label={t("settings.project.refreshAgents")}
								className="settings-option-trigger inline-flex items-center gap-1.5 disabled:pointer-events-none disabled:opacity-50"
								disabled={refreshAgentsMutation.isPending}
								onClick={() => refreshAgentsMutation.mutate()}
							>
								<RefreshCw className={cn("size-icon-base", refreshAgentsMutation.isPending && "animate-spin")} aria-hidden="true" />
								{refreshAgentsMutation.isPending ? t("settings.project.refreshing") : t("settings.project.refresh")}
							</button>
						</SettingsRow>
						{refreshAgentsMutation.isError && (
							<p className="px-1 text-xs leading-row text-error">
								{refreshAgentsMutation.error instanceof Error
									? refreshAgentsMutation.error.message
									: t("settings.project.refreshFailed")}
							</p>
						)}
						{missingRequiredAgent && (
							<p className="px-1 text-xs leading-row text-error">{t("settings.project.agentsRequired")}</p>
						)}
					</SettingsSection>
					{saveFooter}
				</>
			)}

			{/* ── Workflow: branch, prefix, reviewer ────────────────────── */}
			{section === "workflow" && (
				<>
					{!isScratchProject ? (
						<>
							<SettingsSection title={t("settings.project.worktrees")}>
								<SettingsInputRow
									icon={GitBranch}
									label={t("settings.project.defaultBranch")}
									id="defaultBranch"
									value={form.defaultBranch}
									placeholder="main"
									onChange={(value) => setForm((f) => ({ ...f, defaultBranch: value }))}
								/>
								<SettingsInputRow
									icon={Hash}
									label={t("settings.project.sessionPrefix")}
									id="sessionPrefix"
									value={form.sessionPrefix}
									placeholder="ao"
									onChange={(value) => setForm((f) => ({ ...f, sessionPrefix: value }))}
								/>
							</SettingsSection>
							<SettingsSection title={t("settings.project.reviewers")}>
								<SettingsRow icon={ScanEye} label={t("settings.project.defaultReviewer")}>
									<ReviewerSelect
										value={form.reviewerHarness}
										onChange={(v) => setForm((f) => ({ ...f, reviewerHarness: v }))}
										ariaLabel={t("settings.project.defaultReviewer")}
										authorized={agentCatalog?.authorized}
										defaultOptionLabel={t("settings.project.default")}
										defaultTriggerLabel={t("settings.project.default")}
										installed={agentCatalog?.installed}
										supported={agentCatalog?.supported}
										disabled={agentsQuery.isFetching && agentCatalog === undefined}
									/>
								</SettingsRow>
							</SettingsSection>
							{saveFooter}
						</>
					) : (
						<p className="px-1 text-xs text-settings-muted">{t("settings.project.workflow")}</p>
					)}
				</>
			)}

			{/* ── Intake: tracker intake ────────────────────────────────── */}
			{section === "intake" && (
				<>
					{!isScratchProject ? (
						<SettingsSection title={t("settings.project.trackerIntake")}>
							<IntakeFields
								variant="settings"
								form={intakeForm}
								onChange={patchIntake}
								repoPreview={{ value: effectiveIntakeRepo }}
							/>
						</SettingsSection>
					) : (
						<p className="px-1 text-xs text-settings-muted">{t("settings.project.trackerIntake")}</p>
					)}
					{!isScratchProject && saveFooter}
				</>
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
	const { t } = useTranslation();
	return (
		<div className="flex flex-col items-start">
			<Button type="submit" variant="footer-primary" disabled={isPending}>
				{isPending ? t("settings.project.saving") : t("settings.project.saveChanges")}
			</Button>
			{validationError && (
				<span className="inline-flex items-center gap-1.5 text-xs text-error">
					<TriangleAlert className="size-3 shrink-0 text-error" aria-hidden="true" />
					{validationError}
				</span>
			)}
			{mutationError != null && (
				<span className="text-xs text-error">
					{mutationError instanceof Error ? mutationError.message : t("settings.project.saveFailed")}
				</span>
			)}
			{savedAt && !isPending && !mutationError && (
				<span className="text-xs text-success">{t("settings.project.saved")}</span>
			)}
			{replacementError && !isPending && !mutationError && (
				<span className="text-xs text-warning">{t("settings.project.restartFailed", { error: replacementError })}</span>
			)}
		</div>
	);
}

function AgentModelField({
	role,
	agentId,
	projectId,
	model,
	mode,
	onModelChange,
	onModeChange,
}: {
	role: "worker" | "orchestrator";
	agentId: string;
	projectId: string;
	model: string;
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
	const isMode = catalog?.selectionMode === "mode";
	const label = t(`settings.models.${role}${isMode ? "Mode" : "Model"}`);
	const datalistID = `${role}-model-options`;
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

	if (isMode) {
		const options = [
			{ value: "__default__", label: t("settings.models.agentDefault") },
			...(catalog.models ?? []).map((item) => ({ value: item.id, label: item.label })),
		];
		return (
			<>
				<SettingsRow icon={Sparkles} label={label}>
					<div className="flex min-w-0 items-center gap-2">
						<ModelRefreshButton
							label={label}
							pending={refreshMutation.isPending}
							disabled={agentId === ""}
							onClick={() => refreshMutation.mutate()}
						/>
						<SettingsOptionMenu
							aria-label={label}
							value={mode || "__default__"}
							options={options}
							triggerClassName="justify-end"
							onChange={(value) => {
								onModeChange(value === "__default__" ? "" : value);
								onModelChange("");
							}}
						/>
					</div>
				</SettingsRow>
				{warning && <p className="px-1 text-xs leading-row text-warning">{warning}</p>}
			</>
		);
	}

	const hasCatalog = catalog?.selectionMode === "catalog" && (catalog.models?.length ?? 0) > 0;
	const modelIsInCatalog = catalog?.models?.some((item) => item.id === model) ?? false;
	const showCustomInput = hasCatalog && (customAgentId === agentId || (model !== "" && !modelIsInCatalog));
	const selectCatalogModel = (value: string) => {
		setCustomAgentId(null);
		onModelChange(value);
		onModeChange("");
	};
	const selectCustomModel = (value: string) => {
		setCustomAgentId(agentId);
		onModelChange(value);
		onModeChange("");
	};
	return (
		<>
			<SettingsRow icon={Sparkles} label={label}>
				<div className="flex min-w-0 items-center gap-2">
					<ModelRefreshButton
						label={label}
						pending={refreshMutation.isPending}
						disabled={agentId === ""}
						onClick={() => refreshMutation.mutate()}
					/>
					{hasCatalog && !showCustomInput ? (
						<AgentModelCombobox
							aria-label={label}
							value={model}
							models={catalog.models}
							allowCustom={catalog.allowCustom}
							onChange={selectCatalogModel}
							onCustom={selectCustomModel}
							triggerClassName="justify-end"
						/>
					) : (
						<>
							<input
								id={datalistID}
								aria-label={label}
								className="settings-inline-input settings-model-control"
								value={model}
								disabled={agentId === ""}
								onChange={(event) => {
									onModelChange(event.target.value);
									onModeChange("");
								}}
								placeholder={query.isFetching ? t("settings.models.loading") : t("settings.project.agentDefault")}
							/>
							{hasCatalog && (
								<AgentModelCombobox
									aria-label={t("settings.models.optionsAria", { label })}
									value={model}
									models={catalog.models}
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
			</SettingsRow>
			{warning && <p className="px-1 text-xs leading-row text-warning">{warning}</p>}
		</>
	);
}

function ModelRefreshButton({
	label,
	pending,
	disabled,
	onClick,
}: {
	label: string;
	pending: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			aria-label={t("settings.models.refreshAria", { label: label.toLocaleLowerCase() })}
			title={t("settings.models.refreshAria", { label: label.toLocaleLowerCase() })}
			className="settings-option-trigger shrink-0 disabled:pointer-events-none disabled:opacity-50"
			disabled={disabled || pending}
			onClick={onClick}
		>
			<RefreshCw className={cn("size-icon-sm", pending && "animate-spin")} aria-hidden="true" />
		</button>
	);
}

function SettingsInputRow({
	icon,
	label,
	id,
	value,
	onChange,
	placeholder,
}: {
	icon?: LucideIcon;
	label: string;
	id: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	return (
		<SettingsRow icon={icon} label={label}>
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
	const { t } = useTranslation();
	const options = [
		{ value: "__default__", label: t("settings.project.default") },
		...PERMISSION_MODE_VALUES.map((value) => ({
			value,
			label:
				value === "default"
					? t("settings.project.permissionDefault")
					: value === "accept-edits"
						? t("settings.project.permissionAcceptEdits")
						: value === "auto"
							? t("settings.project.permissionAuto")
							: t("settings.project.permissionBypass"),
		})),
	];

	return (
		<SettingsOptionMenu
			aria-label={t("settings.project.permissionMode")}
			value={value || "__default__"}
			options={options}
			onChange={(v) => onChange(v === "__default__" ? "" : v)}
		/>
	);
}

function projectKindLabel(kind: string, t: TFunction): string {
	switch (kind) {
		case "single_repo":
			return t("settings.project.kind.singleRepo");
		case "workspace":
			return t("settings.project.kind.workspace");
		case "scratch":
			return t("settings.project.kind.scratch");
		default:
			return kind || t("settings.project.kind.unknown");
	}
}

function scratchSupportedConfig(config: ProjectConfig): ProjectConfig {
	const { defaultBranch: _defaultBranch, reviewers: _reviewers, trackerIntake: _trackerIntake, ...supported } = config;
	return supported;
}

function blankToUndefined<T extends object>(obj: T): T | undefined {
	return Object.values(obj).some((v) => v !== undefined) ? obj : undefined;
}

function buildRoleAgentConfig(
	existing: components["schemas"]["AgentConfig"] | undefined,
	model: string,
	mode: string,
): components["schemas"]["AgentConfig"] | undefined {
	const next = { ...existing };
	if (model) next.model = model;
	else delete next.model;
	if (mode) next.mode = mode;
	else delete next.mode;
	return Object.keys(next).length > 0 ? next : undefined;
}
