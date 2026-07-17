import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { newestActiveOrchestrator } from "../types/workspace";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import { DashboardSubhead } from "./DashboardSubhead";
import {
	buildIntake,
	deriveProviderRepo,
	deriveRepositoryHref,
	IntakeFields,
	type IntakeForm,
	intakeNeedsRule,
} from "./IntakeFields";
import { SCMConnectionFields, scmSelectionConfig, type SCMSelection } from "./SCMConnectionFields";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type Project = components["schemas"]["Project"];
type ProjectConfig = components["schemas"]["ProjectConfig"];
type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

const PERMISSION_MODE_OPTIONS = ["default", "accept-edits", "auto", "bypass-permissions"] as const;

const REVIEWER_OPTIONS = ["claude-code", "codex", "opencode"] as const;

const projectQueryKey = (id: string) => ["project", id] as const;

export function ProjectSettingsForm({ projectId }: { projectId: string }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();

	const query = useQuery({
		queryKey: projectQueryKey(projectId),
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId } },
			});
			if (error) throw error;
			if (data?.status !== "ok") throw new Error("PROJECT_CONFIG_UNAVAILABLE");
			return data.project as Project;
		},
	});

	if (query.isLoading) {
		return <CenteredNote>{t("projects.settings.loading")}</CenteredNote>;
	}
	if (query.isError || !query.data) {
		return <CenteredNote>{t("projects.settings.loadFailed")}</CenteredNote>;
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead title={t("projects.settings.title")} subtitle={query.data.path} />
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
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const workspaceQuery = useWorkspaceQuery();
	const config = project.config ?? {};
	const workspace = workspaceQuery.data?.find((item) => item.id === projectId);
	const activeOrchestrator = newestActiveOrchestrator(workspace?.sessions ?? []);
	const intake: TrackerIntakeConfig = config.trackerIntake ?? {};
	const [form, setForm] = useState({
		defaultBranch: config.defaultBranch ?? project.defaultBranch ?? "",
		sessionPrefix: config.sessionPrefix ?? "",
		workerAgent: config.worker?.agent ?? "",
		orchestratorAgent: config.orchestrator?.agent ?? "",
		model: config.agentConfig?.model ?? "",
		permissions: config.agentConfig?.permissions ?? "",
		reviewerHarness: config.reviewers?.[0]?.harness ?? "",
		coordinatorAutoWake: config.coordinator?.autoWake ?? false,
		intakeEnabled: intake.enabled ?? false,
		intakeRepo: intake.repo ?? "",
		intakeAssignee: intake.assignee ?? "",
		intakeLabels: intake.labels?.join(", ") ?? "",
		scmProvider: config.scm?.provider ?? "github",
		scmConnectionId: config.scm?.connectionId ?? "github-default",
		scmRepo: config.scm?.repo ?? "",
	});
	const [scmValidated, setSCMValidated] = useState(
		form.scmProvider === "github" && form.scmConnectionId === "github-default",
	);
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [replacementError, setReplacementError] = useState<{ detail?: string } | null>(null);
	const [validationError, setValidationError] = useState<"agents" | "intake" | "scm" | null>(null);
	const initialOrchestratorAgent = config.orchestrator?.agent ?? "";
	const missingRequiredAgent = form.workerAgent === "" || form.orchestratorAgent === "";
	const agentsQuery = useQuery(agentsQueryOptions);
	const agentCatalog = agentsQuery.data;
	const refreshAgentsMutation = useMutation({
		mutationFn: refreshAgents,
		onSuccess: (next) => queryClient.setQueryData(agentsQueryKey, next),
	});

	const intakeProvider = form.scmProvider;
	const intakeForm: IntakeForm = {
		enabled: form.intakeEnabled,
		provider: intakeProvider,
		repo: form.intakeRepo,
		assignee: form.intakeAssignee,
		labels: form.intakeLabels,
	};
	const patchIntake = (patch: Partial<IntakeForm>) =>
		setForm((f) => ({
			...f,
			intakeEnabled: patch.enabled ?? f.intakeEnabled,
			intakeRepo: patch.repo ?? f.intakeRepo,
			intakeAssignee: patch.assignee ?? f.intakeAssignee,
			intakeLabels: patch.labels ?? f.intakeLabels,
		}));
	const effectiveIntakeRepo =
		form.scmRepo.trim() || form.intakeRepo.trim() || deriveProviderRepo(project.repo, intakeProvider);
	const intakeRepoHref = deriveRepositoryHref(project.repo, effectiveIntakeRepo);
	const intakeIncomplete = intakeNeedsRule(intakeForm);

	const mutation = useMutation({
		mutationFn: async () => {
			void captureRendererEvent("ao.renderer.settings_save_requested", { project_id: projectId });
			// PUT replaces the whole config; merge the edited fields over what loaded
			// so we don't drop env/symlinks/postCreate the form doesn't expose.
			const next: ProjectConfig = {
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
				coordinator: blankToUndefined({
					...config.coordinator,
					autoWake: form.coordinatorAutoWake || undefined,
				}),
				scm: scmSelectionConfig({
					provider: form.scmProvider,
					connectionId: form.scmConnectionId,
					repo: form.scmRepo,
				}),
				trackerIntake: buildIntake(intakeForm),
			};
			const { error } = await apiClient.PUT("/api/v1/projects/{id}/config", {
				params: { path: { id: projectId } },
				body: { config: next },
			});
			if (error) throw error;
			if (
				form.orchestratorAgent !== initialOrchestratorAgent ||
				(activeOrchestrator && activeOrchestrator.provider !== form.orchestratorAgent)
			) {
				try {
					await spawnOrchestrator(projectId, "settings", true);
				} catch (error) {
					return { replacementError: { detail: error instanceof Error ? error.message : undefined } };
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
					setValidationError("agents");
					return;
				}
				if (intakeIncomplete) {
					setValidationError("intake");
					return;
				}
				if (!scmValidated) {
					setValidationError("scm");
					return;
				}
				setValidationError(null);
				mutation.mutate();
			}}
		>
			<Card>
				<CardHeader>
					<CardTitle className="text-control">{t("projects.settings.identity")}</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-2 font-mono text-xs text-muted-foreground">
					<ReadonlyRow label={t("projects.settings.identityId")} value={project.id} />
					<ReadonlyRow
						label={t("projects.settings.identityKind")}
						value={
							project.kind === "workspace"
								? t("projects.settings.workspaceKind")
								: t("projects.settings.singleRepoKind")
						}
					/>
					<ReadonlyRow label={t("projects.settings.identityPath")} value={project.path} />
					<ReadonlyRow label={t("projects.settings.identityRepo")} value={project.repo || "—"} />
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-control">{t("projects.settings.sourceControl")}</CardTitle>
				</CardHeader>
				<CardContent>
					<SCMConnectionFields
						value={{
							provider: form.scmProvider,
							connectionId: form.scmConnectionId,
							repo: form.scmRepo,
						}}
						origin={project.repo}
						onValidationChange={setSCMValidated}
						onChange={(next: SCMSelection) => {
							setSCMValidated(next.provider === "github" && next.connectionId === "github-default");
							setForm((current) => ({
								...current,
								scmProvider: next.provider,
								scmConnectionId: next.connectionId,
								scmRepo: next.repo,
							}));
						}}
					/>
				</CardContent>
			</Card>

			{project.kind === "workspace" && (
				<Card>
					<CardHeader>
						<CardTitle className="text-[13px]">{t("projects.settings.workspaceRepos")}</CardTitle>
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
							<p className="text-[12px] text-muted-foreground">{t("projects.settings.noChildRepos")}</p>
						)}
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<CardTitle className="text-control">{t("projects.settings.worktrees")}</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<Field label={t("projects.settings.defaultBranch")} htmlFor="defaultBranch">
						<input
							id="defaultBranch"
							className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.defaultBranch}
							onChange={(e) => setForm((f) => ({ ...f, defaultBranch: e.target.value }))}
							placeholder="main"
						/>
					</Field>
					<Field label={t("projects.settings.sessionPrefix")} htmlFor="sessionPrefix">
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

			<Card>
				<CardHeader>
					<CardTitle className="text-control">{t("projects.settings.agents")}</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<RequiredAgentField
						id="workerAgent"
						value={form.workerAgent}
						placeholder={t("projects.agents.workerPlaceholder")}
						label={t("projects.settings.defaultWorker")}
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
						placeholder={t("projects.agents.orchestratorPlaceholder")}
						label={t("projects.settings.defaultOrchestrator")}
						authorized={agentCatalog?.authorized}
						installed={agentCatalog?.installed}
						supported={agentCatalog?.supported}
						disabled={agentsQuery.isFetching && agentCatalog === undefined}
						invalid={validationError !== null && form.orchestratorAgent === ""}
						onChange={(v) => setForm((f) => ({ ...f, orchestratorAgent: v }))}
					/>
					<label className="flex items-center gap-2.5 text-control text-foreground">
						<input
							type="checkbox"
							className="size-icon-base accent-accent"
							checked={form.coordinatorAutoWake}
							onChange={(event) =>
								setForm((current) => ({ ...current, coordinatorAutoWake: event.target.checked }))
							}
						/>
						{t("projects.agents.autoWake")}
					</label>
					<div className="flex items-center justify-between gap-3 text-xs leading-row text-muted-foreground">
						<span>{t("projects.agents.availabilityCached")}</span>
						<button
							type="button"
							className="shrink-0 rounded text-foreground underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
							disabled={refreshAgentsMutation.isPending}
							onClick={() => refreshAgentsMutation.mutate()}
						>
							{refreshAgentsMutation.isPending ? t("projects.agents.refreshing") : t("projects.agents.refresh")}
						</button>
					</div>
					{refreshAgentsMutation.isError && (
						<p className="text-xs leading-row text-error">
							{t("projects.agents.refreshFailed")}
						</p>
					)}
					{missingRequiredAgent && (
					<p className="text-xs leading-row text-error">{t("projects.settings.agentsRequired")}</p>
					)}
					<Field label={t("projects.settings.modelOverride")} htmlFor="model">
						<input
							id="model"
							className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.model}
							onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
							placeholder={t("projects.settings.agentDefault")}
						/>
					</Field>
					<Field label={t("projects.settings.permissionMode")} htmlFor="permissionMode">
						<PermissionModeSelect
							id="permissionMode"
							value={form.permissions}
							onChange={(v) => setForm((f) => ({ ...f, permissions: v }))}
						/>
					</Field>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-control">{t("projects.settings.reviewers")}</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<Field label={t("projects.settings.defaultReviewer")} htmlFor="reviewerHarness">
						<ReviewerSelect
							id="reviewerHarness"
							value={form.reviewerHarness}
							onChange={(v) => setForm((f) => ({ ...f, reviewerHarness: v }))}
						/>
					</Field>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-control">{t("projects.settings.trackerIntake")}</CardTitle>
				</CardHeader>
				<CardContent>
					<IntakeFields
						form={intakeForm}
						onChange={patchIntake}
						repoPreview={{ provider: intakeProvider, value: effectiveIntakeRepo, href: intakeRepoHref }}
					/>
				</CardContent>
			</Card>

			<div className="flex items-center gap-3">
				<Button type="submit" variant="primary" disabled={mutation.isPending}>
					{mutation.isPending ? t("projects.settings.saving") : t("projects.settings.save")}
				</Button>
				{validationError && (
					<span className="text-xs text-error">
						{validationError === "agents"
							? t("projects.settings.agentsRequired")
							: validationError === "intake"
								? t("projects.settings.intakeAssigneeRequired")
								: t("projects.settings.testSCMRequired")}
					</span>
				)}
				{mutation.isError && (
					<span className="text-xs text-error">
						{apiErrorMessage(mutation.error, t("projects.settings.saveFailed"))}
					</span>
				)}
				{savedAt && !mutation.isPending && !mutation.isError && (
					<span className="text-xs text-success">{t("projects.settings.saved")}</span>
				)}
				{replacementError && !mutation.isPending && !mutation.isError && (
					<span className="text-xs text-warning">
						{t("projects.settings.restartFailed", {
							detail: replacementError.detail ?? t("projects.replacement.fallback"),
						})}
					</span>
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
	const { t } = useTranslation();
	return (
		<Select value={value || "__default__"} onValueChange={(v) => onChange(v === "__default__" ? "" : v)}>
			<SelectTrigger id={id} className="h-control-form w-full text-control">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="__default__">{t("projects.settings.projectDefault")}</SelectItem>
				{PERMISSION_MODE_OPTIONS.map((opt) => (
					<SelectItem key={opt} value={opt}>
						{opt === "default"
							? t("projects.settings.permissionDefault")
							: opt === "accept-edits"
								? t("projects.settings.permissionAcceptEdits")
								: opt === "auto"
									? t("projects.settings.permissionAuto")
									: t("projects.settings.permissionBypass")}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function ReviewerSelect({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
	const { t } = useTranslation();
	return (
		<Select value={value || "__default__"} onValueChange={(v) => onChange(v === "__default__" ? "" : v)}>
			<SelectTrigger id={id} className="h-control-form w-full text-control">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="__default__">{t("projects.settings.projectDefault")}</SelectItem>
				{REVIEWER_OPTIONS.map((reviewer) => (
					<SelectItem key={reviewer} value={reviewer}>
						{reviewer}
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

// Drop an object whose every value is undefined so we send `undefined` (omit)
// rather than an empty {} the daemon would persist.
function blankToUndefined<T extends object>(obj: T): T | undefined {
	return Object.values(obj).some((v) => v !== undefined) ? obj : undefined;
}
