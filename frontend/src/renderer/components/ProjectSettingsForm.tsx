import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { components } from "../../api/schema";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import {
	fetchModelAvailability,
	modelAvailabilityQueryKey,
	type AgentModelAvailabilityResponse,
	useModelAvailabilityQuery,
} from "../hooks/useModelAvailabilityQuery";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { newestActiveOrchestrator } from "../types/workspace";
import { RequiredAgentField } from "./CreateProjectAgentSheet";
import { DashboardSubhead } from "./DashboardSubhead";
import { buildIntake, DEFAULT_OPT_OUT_LABELS, deriveGitHubRepo, IntakeFields, type IntakeForm } from "./IntakeFields";
import { ModelAvailabilityField, modelAvailabilityStatusLabel } from "./ModelAvailabilityField";
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

const REVIEWER_OPTIONS = ["claude-code", "codex", "opencode"] as const;

const ISSUE_LABEL_GROUPS = [
	{
		title: "Opt-out labels",
		scope: "Per-project with a global default.",
		labels: [
			{ name: "no-ao", meaning: "Never dispatch automatically." },
			{ name: "deferred", meaning: "Parked for future work." },
			{ name: "charter", meaning: "Excludes charter and charter:* work." },
			{ name: "charter-audit", meaning: "Audit work handled outside intake." },
			{ name: "human-review", meaning: "Needs a person before automation." },
		],
	},
	{
		title: "Agent routing labels",
		scope: "Per ticket; consumes the normal project pool unless nopool is also present.",
		labels: [
			{ name: "agent:codex", meaning: "Dispatch on codex." },
			{ name: "agent:fugu", meaning: "Dispatch on codex-fugu." },
			{ name: "agent:codex-fugu", meaning: "Accepted optional alias for codex-fugu." },
			{ name: "agent:claude", meaning: "Dispatch on claude-code." },
		],
	},
	{
		title: "Pool escape labels",
		scope: "Per ticket; bypasses the normal project pool cap.",
		labels: [{ name: "nopool", meaning: "Launch outside MaxConcurrent capacity." }],
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
	const workspace = workspaceQuery.data?.find((item) => item.id === projectId);
	const activeOrchestrator = newestActiveOrchestrator(workspace?.sessions ?? []);
	const intake: TrackerIntakeConfig = config.trackerIntake ?? {};
	const projectPrefix = config.projectPrefix ?? config.sessionPrefix ?? "";
	const [form, setForm] = useState({
		defaultBranch: config.defaultBranch ?? project.defaultBranch ?? "",
		projectPrefix,
		workerAgent: config.worker?.agent ?? "",
		orchestratorAgent: config.orchestrator?.agent ?? "",
		model: config.agentConfig?.model ?? "",
		permissions: config.agentConfig?.permissions ?? "",
		reviewerHarness: config.reviewers?.[0]?.harness ?? "",
		workerMix: (config.workerMix ?? []).map((r) => ({ agent: r.agent, model: r.model ?? "", weight: r.weight })),
		autonomousMerge: config.autonomousMerge ?? false,
		intakeEnabled: intake.enabled ?? false,
		intakeRepo: intake.repo ?? "",
		intakeAssignee: intake.assignee ?? "",
		// Unconfigured projects show the default opt-out taxonomy the daemon would
		// apply anyway, so the list is visible and editable rather than implicit.
		intakeOptOutLabels: intake.excludeLabels ?? [...DEFAULT_OPT_OUT_LABELS],
	});
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [replacementError, setReplacementError] = useState<string | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);
	const initialOrchestratorAgent = config.orchestrator?.agent ?? "";
	const [intakeDisableRequested, setIntakeDisableRequested] = useState(false);
	// A non-empty worker mix resolves the worker harness on its own, so the single
	// default worker agent is only required when no mix is configured. The
	// orchestrator agent is always required.
	const mixConfigured = form.workerMix.length > 0;
	const missingWorkerAgent = form.workerAgent === "" && !mixConfigured;
	const missingRequiredAgent = missingWorkerAgent || form.orchestratorAgent === "";
	const agentsQuery = useQuery(agentsQueryOptions);
	const modelAvailabilityQuery = useModelAvailabilityQuery();
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
		optOutLabels: form.intakeOptOutLabels,
	};
	const patchIntake = (patch: Partial<IntakeForm>) => {
		if (patch.enabled !== undefined) {
			setIntakeDisableRequested(!patch.enabled);
		}
		setForm((f) => ({
			...f,
			intakeEnabled: patch.enabled ?? f.intakeEnabled,
			intakeRepo: patch.repo ?? f.intakeRepo,
			intakeAssignee: patch.assignee ?? f.intakeAssignee,
			intakeOptOutLabels: patch.optOutLabels ?? f.intakeOptOutLabels,
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
				worker: { ...config.worker, agent: form.workerAgent },
				orchestrator: { ...config.orchestrator, agent: form.orchestratorAgent },
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
				// Pass the loaded intake as base so fields the form doesn't expose
				// (labels, maxConcurrent) survive the save instead of being wiped.
				trackerIntake: buildIntake(intakeForm, intake, {
					explicitDisable: intakeDisableRequested,
				}),
			};
			if (form.autonomousMerge) {
				next.autonomousMerge = true;
			} else {
				delete next.autonomousMerge;
			}
			const { error } = await apiClient.PUT("/api/v1/projects/{id}/config", {
				params: { path: { id: projectId } },
				body: { config: next },
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
				if (!mixIsValid(form.workerMix)) {
					setValidationError("Worker mix percentages must sum to 100% and every row needs an agent.");
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
					<ModelAvailabilityField
						id="model"
						label="Model override"
						value={form.model}
						onChange={(model) => setForm((f) => ({ ...f, model }))}
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
					Opt-out labels are per-project settings with a global default. Routing and pool-escape labels are read from
					each ticket during dispatch.
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

// Drop an object whose every value is undefined so we send `undefined` (omit)
// rather than an empty {} the daemon would persist.
function blankToUndefined<T extends object>(obj: T): T | undefined {
	return Object.values(obj).some((v) => v !== undefined) ? obj : undefined;
}
