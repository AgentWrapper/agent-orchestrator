import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import {
	fetchModelAvailability,
	modelAvailabilityQueryKey,
	type AgentModelAvailabilityResponse,
	useModelAvailabilityQuery,
} from "../hooks/useModelAvailabilityQuery";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { useBuildFreshness } from "../lib/build-freshness";
import { captureRendererEvent } from "../lib/telemetry";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import { DashboardSubhead } from "./DashboardSubhead";
import { buildIntake, deriveGitHubRepo, IntakeFields, type IntakeForm, intakeIsValid } from "./IntakeFields";
import { ModelAvailabilityField, modelAvailabilityStatusLabel } from "./ModelAvailabilityField";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type Project = components["schemas"]["Project"];
type ProjectConfig = components["schemas"]["ProjectConfig"];
type AgentConfig = components["schemas"]["AgentConfig"];
type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

const PERMISSION_MODE_OPTIONS = [
	{ value: "default", label: "Default" },
	{ value: "accept-edits", label: "Accept edits" },
	{ value: "auto", label: "Auto" },
	{ value: "bypass-permissions", label: "Bypass permissions" },
] as const;

const REVIEWER_OPTIONS = ["claude-code", "codex", "opencode"] as const;

const ISSUE_LABEL_GROUPS = [
	{
		title: "Status labels",
		scope: "Informational only; assignment controls intake.",
		labels: [
			{ name: "deferred", meaning: "Deferred for future consideration." },
			{ name: "charter", meaning: "Charter-managed work." },
			{ name: "charter-audit", meaning: "Charter audit work." },
			{ name: "human-review", meaning: "Human review requested." },
		],
	},
	{
		title: "Agent routing labels",
		scope: "Per assigned ticket; always consumes normal project capacity.",
		labels: [
			{ name: "agent:codex", meaning: "Dispatch on codex." },
			{ name: "agent:fugu", meaning: "Dispatch on codex-fugu." },
			{ name: "agent:codex-fugu", meaning: "Accepted optional alias for codex-fugu." },
			{ name: "agent:claude", meaning: "Dispatch on claude-code." },
		],
	},
] as const;

// MIX_OPTIONS are the agent/model buckets a worker-mix row can select. Each is a
// flattened agent+model pair (issue #62: "type a % and select a model"). Fable is
// intentionally offered — a user may explicitly weight it in; the no-default rule
// (GH #61) only bans the system auto-selecting it, which the mix never does.
const MIX_OPTIONS = [
	{ value: "claude-code::claude-opus-4-8", label: "Claude — Opus", agent: "claude-code", model: "claude-opus-4-8" },
	{ value: "claude-code::claude-sonnet-5", label: "Claude — Sonnet", agent: "claude-code", model: "claude-sonnet-5" },
	{
		value: "claude-code::claude-haiku-4-5-20251001",
		label: "Claude — Haiku",
		agent: "claude-code",
		model: "claude-haiku-4-5-20251001",
	},
	{ value: "claude-code::claude-fable-5", label: "Claude — Fable", agent: "claude-code", model: "claude-fable-5" },
	{ value: "codex::", label: "Codex", agent: "codex", model: "" },
	{ value: "codex-fugu::", label: "Codex Fugu", agent: "codex-fugu", model: "" },
] as const;

type MixRow = { agent: string; model: string; weight: number };
type MixOption = { value: string; label: string; agent: string; model: string };
type EnvRow = { key: string; value: string };

const mixOptionValue = (row: { agent: string; model: string }) => `${row.agent}::${row.model}`;

// mixTotal sums the row percentages; the save gate requires it to equal 100.
const mixTotal = (rows: MixRow[]) => rows.reduce((sum, r) => sum + (Number.isFinite(r.weight) ? r.weight : 0), 0);

// mixIsValid mirrors the daemon guard client-side: a non-empty mix needs every
// row to name an agent with a 1..100 weight, and the weights must sum to 100.
function mixIsValid(rows: MixRow[]): boolean {
	if (rows.length === 0) return true;
	if (rows.some((r) => r.agent === "" || !Number.isInteger(r.weight) || r.weight < 1 || r.weight > 100)) return false;
	return mixTotal(rows) === 100;
}

function permissionsRequiredForConfiguredHarnesses(
	form: {
		orchestratorAgent: string;
		workerAgent: string;
		workerMix: MixRow[];
	},
	config: ProjectConfig,
): boolean {
	if (form.orchestratorAgent === "claude-code" && !config.orchestrator?.agentConfig?.permissions) return true;
	const workerRoleHasPermissions = Boolean(config.worker?.agentConfig?.permissions);
	if (form.workerMix.length > 0)
		return form.workerMix.some((r) => r.agent === "claude-code") && !workerRoleHasPermissions;
	return form.workerAgent === "claude-code" && !workerRoleHasPermissions;
}

const projectQueryKey = (id: string) => ["project", id] as const;

export function ProjectSettingsForm({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	// Lives in the parent on purpose: SettingsBody is keyed by the config token, so
	// pulling in the newer config remounts it and would drop a notice it set itself.
	const [staleNotice, setStaleNotice] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [replacementError, setReplacementError] = useState<string | null>(null);
	const [formGeneration, setFormGeneration] = useState(0);

	useEffect(() => {
		setStaleNotice(false);
		setSavedAt(null);
		setReplacementError(null);
		setFormGeneration(0);
	}, [projectId]);

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
				{staleNotice ? (
					<div
						role="alert"
						className="mx-auto mb-4 max-w-2xl rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
					>
						This project's config changed while you had Settings open, so your save was not applied. The latest config
						has been reloaded — reapply your change and save again.
					</div>
				) : null}
				<SettingsBody
					// The form seeds its editable state once. Advance the key only after a
					// save outcome, not on every background refetch, so another writer's
					// config update cannot silently discard in-progress operator edits.
					key={`${projectId}:${formGeneration}`}
					project={query.data}
					savedAt={savedAt}
					setSavedAt={setSavedAt}
					replacementError={replacementError}
					setReplacementError={setReplacementError}
					onSaved={() => {
						setStaleNotice(false);
						setFormGeneration((generation) => generation + 1);
						return queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
					}}
					onStaleConfig={() => {
						setStaleNotice(true);
						setFormGeneration((generation) => generation + 1);
					}}
					projectId={projectId}
				/>
			</div>
		</div>
	);
}

// StaleConfigError marks the one failure the operator can actually act on: the
// config moved under an open Settings page, so the save was refused rather than
// allowed to clobber it.
class StaleConfigError extends Error {
	constructor() {
		super("The project config changed since this page loaded.");
		this.name = "StaleConfigError";
	}
}

function SettingsBody({
	project,
	projectId,
	savedAt,
	setSavedAt,
	replacementError,
	setReplacementError,
	onSaved,
	onStaleConfig,
}: {
	project: Project;
	projectId: string;
	savedAt: number | null;
	setSavedAt: (value: number | null) => void;
	replacementError: string | null;
	setReplacementError: (value: string | null) => void;
	onSaved: () => void;
	onStaleConfig: () => void;
}) {
	const queryClient = useQueryClient();
	const config = project.config ?? {};
	const [configETag] = useState(project.configETag);
	const intake: TrackerIntakeConfig = config.trackerIntake ?? {};
	const projectPrefix = config.projectPrefix ?? config.sessionPrefix ?? "";
	const [form, setForm] = useState({
		defaultBranch: config.defaultBranch ?? project.defaultBranch ?? "",
		projectPrefix,
		workspaceMode: config.workspace ?? "",
		envRows: envRowsFromConfig(config.env),
		workerAgent: config.worker?.agent ?? "",
		workerModel: modelForHarness(config.worker?.agentConfig, config.worker?.agent ?? ""),
		orchestratorAgent: config.orchestrator?.agent ?? "",
		orchestratorModel: modelForHarness(config.orchestrator?.agentConfig, config.orchestrator?.agent ?? ""),
		model: config.agentConfig?.model ?? "",
		permissions: initialPermissionMode(config),
		reviewerHarness: config.reviewers?.[0]?.harness ?? "",
		workerMix: (config.workerMix ?? []).map((r) => ({ agent: r.agent, model: r.model ?? "", weight: r.weight })),
		autonomousMerge: config.autonomousMerge ?? false,
		intakeEnabled: intake.enabled ?? false,
		intakeRepo: intake.repo ?? "",
		intakeAssignee: intake.assignee ?? "",
		intakeMaxConcurrent: intake.maxConcurrent ? String(intake.maxConcurrent) : "",
	});
	const [validationError, setValidationError] = useState<string | null>(null);
	const initialOrchestratorAgent = config.orchestrator?.agent ?? "";
	const initialOrchestratorModel = modelForHarness(config.orchestrator?.agentConfig, initialOrchestratorAgent);
	const [intakeDisableRequested, setIntakeDisableRequested] = useState(false);
	// A non-empty worker mix resolves the worker harness on its own, so the single
	// default worker agent is only required when no mix is configured. The
	// orchestrator agent is always required.
	const mixConfigured = form.workerMix.length > 0;
	const missingWorkerAgent = form.workerAgent === "" && !mixConfigured;
	const missingRequiredAgent = missingWorkerAgent || form.orchestratorAgent === "";
	const agentsQuery = useQuery(agentsQueryOptions);
	const modelAvailabilityQuery = useModelAvailabilityQuery();
	const buildFreshnessQuery = useBuildFreshness();
	const staleBuild = buildFreshnessQuery.data?.state === "stale";
	const agentCatalog = agentsQuery.data;
	const refreshAgentsMutation = useMutation({
		mutationFn: refreshAgents,
		onSuccess: (next) => queryClient.setQueryData(agentsQueryKey, next),
	});
	const refreshModelsMutation = useMutation({
		mutationFn: () => fetchModelAvailability({ force: true }),
		onSuccess: (next) => queryClient.setQueryData(modelAvailabilityQueryKey, next),
	});

	// The Electron app only registers git projects today, so the daemon always has a usable
	// git origin to derive owner/repo from (trackerRepo() in observer.go) when
	// trackerIntake.repo is unset — there's no manual override input here. This mirrors that
	// same derivation client-side purely for display (a link to the repo being polled).
	const intakeForm: IntakeForm = {
		enabled: form.intakeEnabled,
		repo: form.intakeRepo,
		assignee: form.intakeAssignee,
		maxConcurrent: form.intakeMaxConcurrent,
	};
	const patchIntake = (patch: Partial<IntakeForm>) => {
		if (patch.enabled !== undefined) {
			setIntakeDisableRequested(!patch.enabled);
		}
		setForm((f) => ({
			...f,
			intakeEnabled: patch.enabled ?? f.intakeEnabled,
			intakeRepo: patch.repo ?? f.intakeRepo,
			intakeAssignee:
				patch.assignee ?? (patch.enabled === true && f.intakeAssignee.trim() === "" ? "*" : f.intakeAssignee),
			intakeMaxConcurrent:
				patch.maxConcurrent ??
				(patch.enabled === true && f.intakeMaxConcurrent.trim() === "" ? "2" : f.intakeMaxConcurrent),
		}));
	};
	const effectiveIntakeRepo = form.intakeRepo.trim() || deriveGitHubRepo(project.repo);

	const mutation = useMutation({
		mutationFn: async () => {
			void captureRendererEvent("ao.renderer.settings_save_requested", { project_id: projectId });
			// PUT replaces the whole config; merge the edited fields over what loaded
			// so we don't drop env/symlinks/postCreate the form doesn't expose.
			const next: ProjectConfig = {
				...config,
				defaultBranch: form.defaultBranch || undefined,
				projectPrefix: form.projectPrefix || undefined,
				sessionPrefix: undefined,
				workspace: workspaceModeToConfig(form.workspaceMode),
				env: envRowsToConfig(form.envRows),
				worker: {
					...config.worker,
					agent: form.workerAgent,
					agentConfig: withHarnessModel(config.worker?.agentConfig, form.workerAgent, form.workerModel),
				},
				orchestrator: {
					...config.orchestrator,
					agent: form.orchestratorAgent,
					agentConfig: withHarnessModel(
						config.orchestrator?.agentConfig,
						form.orchestratorAgent,
						form.orchestratorModel,
					),
				},
				agentConfig: blankToUndefined({
					...config.agentConfig,
					model: form.model || undefined,
					permissions: form.permissions || undefined,
				}),
				reviewers: form.reviewerHarness ? [{ harness: form.reviewerHarness }] : undefined,
				workerMix:
					form.workerMix.length > 0
						? form.workerMix.map((r) => ({ agent: r.agent, model: r.model || undefined, weight: r.weight }))
						: undefined,
				// Pass the loaded intake as base for compatibility fields; buildIntake
				// deliberately strips legacy label admission controls.
				trackerIntake: buildIntake(intakeForm, intake, {
					explicitDisable: intakeDisableRequested,
				}),
			};
			if (form.autonomousMerge) {
				next.autonomousMerge = true;
			} else {
				delete next.autonomousMerge;
			}
			// The PUT replaces the whole config, and this form's base is a snapshot
			// taken when it mounted. If-Match carries the token from that read, so a
			// save built on a config another writer has since changed is refused
			// instead of silently reverting every field this form never showed.
			const { data, error, response } = await apiClient.PUT("/api/v1/projects/{id}/config", {
				params: { path: { id: projectId } },
				body: { config: next },
				headers: configETag ? { "If-Match": configETag } : undefined,
			});
			if (error) {
				if (response?.status === 409) {
					// Pull the newer config in so the operator can see what changed and
					// reapply on top of it, rather than being told to guess.
					await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
					throw new StaleConfigError();
				}
				throw new Error(apiErrorMessage(error));
			}
			if (data?.project?.configETag) {
				queryClient.setQueryData(projectQueryKey(projectId), data.project as Project);
			}
			// Replace the running orchestrator only when the operator actually changed
			// its harness or model. The old third clause — "the live orchestrator's
			// provider differs from the configured one" — was independent of what was
			// edited, so a project whose orchestrator had drifted from config for any
			// reason got its orchestrator killed mid-work by an unrelated env-var edit,
			// with no confirmation and nothing in the UI saying so.
			if (form.orchestratorAgent !== initialOrchestratorAgent || form.orchestratorModel !== initialOrchestratorModel) {
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
		onError: (error) => {
			void captureRendererEvent("ao.renderer.settings_save_failed", { project_id: projectId });
			if (error instanceof StaleConfigError) {
				onStaleConfig();
			}
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
				const envError = validateEnvRows(form.envRows);
				if (envError) {
					setValidationError(envError);
					return;
				}
				if (!mixIsValid(form.workerMix)) {
					setValidationError("Worker mix percentages must sum to 100% and every row needs an agent.");
					return;
				}
				if (!intakeIsValid(intakeForm)) {
					setValidationError("Enabled tracker intake requires an assignee and a positive concurrency cap.");
					return;
				}
				if (form.permissions === "" && permissionsRequiredForConfiguredHarnesses(form, config)) {
					setValidationError("Permission mode is required for claude-code sessions.");
					return;
				}
				if (staleBuild) {
					setValidationError("Reload AO before saving settings.");
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
				<CardContent className="flex flex-col gap-2 font-mono text-xs text-muted-foreground">
					<ReadonlyRow label="id" value={project.id} />
					<ReadonlyRow label="kind" value={project.kind === "workspace" ? "workspace" : "single repo"} />
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

			<Card>
				<CardHeader>
					<CardTitle className="text-control">Worktrees</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<Field label="Workspace mode" htmlFor="workspaceMode">
						<WorkspaceModeSelect
							id="workspaceMode"
							value={form.workspaceMode}
							onChange={(v) => setForm((f) => ({ ...f, workspaceMode: v }))}
						/>
					</Field>
					<Field label="Default branch" htmlFor="defaultBranch">
						<input
							id="defaultBranch"
							className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.defaultBranch}
							onChange={(e) => setForm((f) => ({ ...f, defaultBranch: e.target.value }))}
							placeholder="main"
						/>
					</Field>
					<Field label="Project prefix" htmlFor="projectPrefix">
						<input
							id="projectPrefix"
							className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.projectPrefix}
							onChange={(e) => setForm((f) => ({ ...f, projectPrefix: e.target.value }))}
							placeholder="ao"
						/>
					</Field>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-control">Project environment</CardTitle>
				</CardHeader>
				<CardContent>
					<EnvEditor rows={form.envRows} onChange={(envRows) => setForm((f) => ({ ...f, envRows }))} />
				</CardContent>
			</Card>

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
						invalid={validationError !== null && missingWorkerAgent}
						onChange={(v) =>
							setForm((f) => ({
								...f,
								workerAgent: v,
								workerModel:
									v === f.workerAgent ? f.workerModel : modelForHarnessSelection(config.worker?.agentConfig, v),
							}))
						}
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
						onChange={(v) =>
							setForm((f) => ({
								...f,
								orchestratorAgent: v,
								orchestratorModel:
									v === f.orchestratorAgent
										? f.orchestratorModel
										: modelForHarnessSelection(config.orchestrator?.agentConfig, v),
							}))
						}
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
					<ModelAvailabilityField
						id="model"
						label="Model override"
						value={form.model}
						onChange={(model) => setForm((f) => ({ ...f, model }))}
						availability={modelAvailabilityQuery.data}
						isRefreshing={refreshModelsMutation.isPending || modelAvailabilityQuery.isFetching}
						onRefresh={() => refreshModelsMutation.mutate()}
					/>
					<ModelAvailabilityField
						id="workerModel"
						label="Worker model override"
						value={form.workerModel}
						onChange={(model) => setForm((f) => ({ ...f, workerModel: model }))}
						availability={modelAvailabilityQuery.data}
						isRefreshing={refreshModelsMutation.isPending || modelAvailabilityQuery.isFetching}
						onRefresh={() => refreshModelsMutation.mutate()}
					/>
					<ModelAvailabilityField
						id="orchestratorModel"
						label="Orchestrator model override"
						value={form.orchestratorModel}
						onChange={(model) => setForm((f) => ({ ...f, orchestratorModel: model }))}
						availability={modelAvailabilityQuery.data}
						isRefreshing={refreshModelsMutation.isPending || modelAvailabilityQuery.isFetching}
						onRefresh={() => refreshModelsMutation.mutate()}
					/>
					<Field label="Permission mode" htmlFor="permissionMode">
						<PermissionModeSelect
							id="permissionMode"
							value={form.permissions}
							onChange={(v) => setForm((f) => ({ ...f, permissions: v }))}
						/>
					</Field>
				</CardContent>
			</Card>

			<WorkerMixCard
				rows={form.workerMix}
				onChange={(rows) => setForm((f) => ({ ...f, workerMix: rows }))}
				invalid={validationError !== null && !mixIsValid(form.workerMix)}
				modelAvailability={modelAvailabilityQuery.data}
			/>

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
						/>
					</Field>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-[13px]">Merge policy</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<label className="flex items-center gap-2.5 text-[13px] text-foreground">
						<input
							type="checkbox"
							className="h-4 w-4 accent-accent"
							checked={form.autonomousMerge}
							onChange={(e) => setForm((f) => ({ ...f, autonomousMerge: e.target.checked }))}
						/>
						Autonomous merge
					</label>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-[13px]">Tracker intake</CardTitle>
				</CardHeader>
				<CardContent>
					<IntakeFields form={intakeForm} onChange={patchIntake} repoPreview={{ value: effectiveIntakeRepo }} />
				</CardContent>
			</Card>

			<LabelReferenceCard />

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

function LabelReferenceCard() {
	return (
		<Card>
			<CardHeader>
				<CardTitle role="heading" aria-level={2} className="text-[13px]">
					Issue labels
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-[12px] leading-5 text-muted-foreground">
					Assignment controls admission. Status labels are informational; routing labels select a harness only after an
					assigned ticket is admitted, and every worker consumes normal capacity.
				</p>
				{ISSUE_LABEL_GROUPS.map((group) => (
					<section key={group.title} className="flex flex-col gap-2">
						<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
							<h3 className="text-[12px] font-medium text-foreground">{group.title}</h3>
							<span className="text-[11px] text-muted-foreground">{group.scope}</span>
						</div>
						<div className="divide-y divide-border rounded-md border border-border">
							{group.labels.map((label) => (
								<div key={label.name} className="grid grid-cols-[minmax(130px,0.45fr)_1fr] gap-3 px-3 py-2">
									<code className="break-words text-[12px] text-foreground">{label.name}</code>
									<span className="text-[12px] leading-5 text-muted-foreground">{label.meaning}</span>
								</div>
							))}
						</div>
					</section>
				))}
			</CardContent>
		</Card>
	);
}

// WorkerMixCard renders the weighted worker-mix table (issue #62): a row per
// agent/model bucket with its percentage, add/remove controls, and a live
// running total. An empty table means the feature is off — worker spawns fall
// back to the single default worker agent. The daemon re-validates on save; the
// running total here blocks the save button's mutation before it is sent.
function WorkerMixCard({
	rows,
	onChange,
	invalid,
	modelAvailability,
}: {
	rows: MixRow[];
	onChange: (rows: MixRow[]) => void;
	invalid: boolean;
	modelAvailability?: AgentModelAvailabilityResponse;
}) {
	const total = mixTotal(rows);
	const totalOff = rows.length > 0 && total !== 100;
	const options = mixOptions(modelAvailability);
	const addRow = () => onChange([...rows, { agent: "", model: "", weight: 0 }]);
	const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
	const patchRow = (i: number, patch: Partial<MixRow>) =>
		onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-[13px]">Worker mix</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<p className="text-[12px] leading-5 text-muted-foreground">
					Distribute worker spawns across agents/models by percentage. Leave empty to always use the default worker
					agent. Percentages must sum to 100%.
				</p>
				{rows.map((row, i) => (
					<div key={i} className="flex items-center gap-2">
						<div className="flex items-center gap-1">
							<input
								type="number"
								min={0}
								max={100}
								aria-label={`Row ${i + 1} percentage`}
								className="h-8 w-16 rounded-md border border-input bg-transparent px-2 text-right text-[13px] text-foreground focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
								value={Number.isFinite(row.weight) ? row.weight : 0}
								onChange={(e) => patchRow(i, { weight: Math.trunc(Number(e.target.value)) })}
							/>
							<span className="text-[12px] text-muted-foreground">%</span>
						</div>
						<div className="min-w-0 flex-1">
							<MixBucketSelect
								id={`mix-agent-${i}`}
								ariaLabel={`Row ${i + 1} agent`}
								row={row}
								options={options}
								onChange={(agent, model) => patchRow(i, { agent, model })}
							/>
						</div>
						<button
							type="button"
							aria-label={`Remove row ${i + 1}`}
							className="shrink-0 rounded px-2 text-[12px] text-muted-foreground underline-offset-2 hover:text-error hover:underline"
							onClick={() => removeRow(i)}
						>
							Remove
						</button>
					</div>
				))}
				<div className="flex items-center justify-between gap-3">
					<Button type="button" variant="secondary" onClick={addRow}>
						Add row
					</Button>
					{rows.length > 0 && (
						<span className={`text-[12px] ${totalOff || invalid ? "text-error" : "text-muted-foreground"}`}>
							Total: {total}% {total === 100 ? "" : "(must equal 100%)"}
						</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

// MixBucketSelect is the agent/model dropdown for one mix row. It renders the
// live availability list when present, falls back to curated MIX_OPTIONS, and
// keeps a synthetic option for exotic loaded pairs so existing config stays
// visible and editable rather than silently reset.
function MixBucketSelect({
	id,
	ariaLabel,
	row,
	options,
	onChange,
}: {
	id: string;
	ariaLabel: string;
	row: MixRow;
	options: MixOption[];
	onChange: (agent: string, model: string) => void;
}) {
	const current = mixOptionValue(row);
	const known = options.some((o) => o.value === current);
	return (
		<Select
			value={row.agent === "" ? undefined : current}
			onValueChange={(v) => {
				const [agent, model = ""] = v.split("::");
				onChange(agent, model);
			}}
		>
			<SelectTrigger id={id} aria-label={ariaLabel} className="h-8 w-full text-[13px]">
				<SelectValue placeholder="Select agent/model" />
			</SelectTrigger>
			<SelectContent>
				{!known && row.agent !== "" && (
					<SelectItem value={current}>{row.model ? `${row.agent} — ${row.model}` : row.agent}</SelectItem>
				)}
				{options.map((opt) => (
					<SelectItem key={opt.value} value={opt.value}>
						{opt.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function mixOptions(availability?: AgentModelAvailabilityResponse): MixOption[] {
	const out = new Map<string, MixOption>();
	for (const opt of MIX_OPTIONS) {
		out.set(opt.value, opt);
	}
	for (const harness of availability?.harnesses ?? []) {
		if (harness.id === "codex" || harness.id === "codex-fugu") {
			const key = `${harness.id}::`;
			if (!out.has(key)) out.set(key, { value: key, label: harness.label || harness.id, agent: harness.id, model: "" });
		}
		for (const model of harness.models ?? []) {
			const value = `${harness.id}::${model.model}`;
			const status = modelAvailabilityStatusLabel(model);
			out.set(value, {
				value,
				label: `${harness.label || harness.id} — ${model.model}${status ? ` (${status})` : ""}`,
				agent: harness.id,
				model: model.model,
			});
		}
	}
	return Array.from(out.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function WorkspaceModeSelect({
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
				<SelectItem value="__default__">Default (worktree)</SelectItem>
				<SelectItem value="worktree">Worktree</SelectItem>
				<SelectItem value="in-place">In place</SelectItem>
			</SelectContent>
		</Select>
	);
}

function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
	const addRow = () => onChange([...rows, { key: "", value: "" }]);
	const removeRow = (index: number) => onChange(rows.filter((_, i) => i !== index));
	const patchRow = (index: number, patch: Partial<EnvRow>) =>
		onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[12px] leading-5 text-muted-foreground">
				Extra environment variables forwarded into new sessions for this project.
			</p>
			{rows.map((row, index) => (
				<div key={index} className="grid grid-cols-[minmax(0,0.42fr)_minmax(0,1fr)_auto] items-center gap-2">
					<input
						aria-label={`Environment key ${index + 1}`}
						className="h-8 rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
						value={row.key}
						onChange={(e) => patchRow(index, { key: e.target.value })}
						placeholder="KEY"
					/>
					<input
						aria-label={`Environment value ${index + 1}`}
						className="h-8 rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
						value={row.value}
						onChange={(e) => patchRow(index, { value: e.target.value })}
						placeholder="value"
					/>
					<button
						type="button"
						aria-label={`Remove environment variable ${row.key || index + 1}`}
						className="shrink-0 rounded px-2 text-[12px] text-muted-foreground underline-offset-2 hover:text-error hover:underline"
						onClick={() => removeRow(index)}
					>
						Remove
					</button>
				</div>
			))}
			<Button type="button" variant="secondary" onClick={addRow}>
				Add environment variable
			</Button>
		</div>
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

function ReviewerSelect({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
	return (
		<Select value={value || "__default__"} onValueChange={(v) => onChange(v === "__default__" ? "" : v)}>
			<SelectTrigger id={id} className="h-control-form w-full text-control">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="__default__">Project default</SelectItem>
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

function envRowsFromConfig(env?: Record<string, string>): EnvRow[] {
	return Object.entries(env ?? {}).map(([key, value]) => ({ key, value }));
}

function envRowsToConfig(rows: EnvRow[]): Record<string, string> | undefined {
	const entries = rows.map((row) => [row.key.trim(), row.value] as const).filter(([key]) => key !== "");
	if (entries.length === 0) return undefined;
	return Object.fromEntries(entries);
}

function validateEnvRows(rows: EnvRow[]): string | null {
	const seen = new Set<string>();
	for (const row of rows) {
		const key = row.key.trim();
		if (key === "") continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			return "Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores.";
		}
		if (seen.has(key)) {
			return "Environment variable names must be unique.";
		}
		seen.add(key);
	}
	return null;
}

function workspaceModeToConfig(value: string): ProjectConfig["workspace"] | undefined {
	return value === "worktree" || value === "in-place" ? value : undefined;
}

function modelForHarness(config: AgentConfig | undefined, harness: string): string {
	return config?.modelByHarness?.[harness]?.model ?? config?.model ?? "";
}

function modelForHarnessSelection(config: AgentConfig | undefined, harness: string): string {
	return config?.modelByHarness?.[harness]?.model ?? "";
}

function initialPermissionMode(config: ProjectConfig): string {
	if (config.agentConfig?.permissions) return config.agentConfig.permissions;
	if (
		permissionsRequiredForConfiguredHarnesses(
			{
				orchestratorAgent: config.orchestrator?.agent ?? "",
				workerAgent: config.worker?.agent ?? "",
				workerMix: (config.workerMix ?? []).map((row) => ({
					agent: row.agent ?? "",
					model: row.model ?? "",
					weight: row.weight ?? 0,
				})),
			},
			config,
		)
	) {
		return "bypass-permissions";
	}
	return "";
}

function withHarnessModel(config: AgentConfig | undefined, harness: string, model: string): AgentConfig | undefined {
	const trimmed = model.trim();
	if (!config?.modelByHarness || Object.keys(config.modelByHarness).length === 0) {
		return blankToUndefined({ ...(config ?? {}), model: trimmed || undefined });
	}
	const next: AgentConfig = { ...(config ?? {}) };
	const modelByHarness = { ...(next.modelByHarness ?? {}) };
	if (harness !== "") {
		const current = modelByHarness[harness] ?? {};
		const updated = { ...current, model: trimmed || undefined };
		if (blankToUndefined(updated)) {
			modelByHarness[harness] = updated;
		} else {
			delete modelByHarness[harness];
		}
	} else if (trimmed !== "") {
		next.model = trimmed;
	}
	next.modelByHarness = Object.keys(modelByHarness).length > 0 ? modelByHarness : undefined;
	return blankToUndefined(next);
}

// Drop an object whose every value is undefined so we send `undefined` (omit)
// rather than an empty {} the daemon would persist.
function blankToUndefined<T extends object>(obj: T): T | undefined {
	return Object.values(obj).some((v) => v !== undefined) ? obj : undefined;
}
