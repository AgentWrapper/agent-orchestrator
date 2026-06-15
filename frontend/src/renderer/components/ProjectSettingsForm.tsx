import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import { agentsQueryKey, type AgentCatalog, useAgentsQuery } from "../hooks/useAgentsQuery";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { findProjectOrchestrator } from "../types/workspace";
import { DashboardSubhead } from "./DashboardSubhead";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type Project = components["schemas"]["Project"];
type ProjectConfig = components["schemas"]["ProjectConfig"];
type AgentInfo = components["schemas"]["AgentInfo"];
type AgentCatalogWithAuth = AgentCatalog & {
	authorized?: AgentInfo[];
};
type Session = components["schemas"]["ControllersSessionView"];
type ReplacementResult = {
	incomplete: boolean;
	notice: string | null;
	recoveryRequired: boolean;
};

const PERMISSION_MODE_OPTIONS = [
	{ value: "default", label: "Default" },
	{ value: "accept-edits", label: "Accept edits" },
	{ value: "auto", label: "Auto" },
	{ value: "bypass-permissions", label: "Bypass permissions" },
] as const;

const REVIEWER_OPTIONS = ["claude-code"] as const;

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
	const agentsQuery = useAgentsQuery();

	if (query.isLoading || agentsQuery.isLoading) {
		return <CenteredNote>Loading project settings…</CenteredNote>;
	}
	if (query.isError || !query.data) {
		return (
			<CenteredNote>{query.error instanceof Error ? query.error.message : "Could not load project."}</CenteredNote>
		);
	}
	if (agentsQuery.isError || !agentsQuery.data) {
		return (
			<CenteredNote>
				{agentsQuery.error instanceof Error ? agentsQuery.error.message : "Could not load agent catalog."}
			</CenteredNote>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead title="Settings" subtitle={query.data.path} />
			<div className="min-h-0 flex-1 overflow-y-auto p-[18px]">
				<SettingsBody
					key={projectId}
					project={query.data}
					agents={agentsQuery.data}
					isReloadingAgents={agentsQuery.isFetching}
					onReloadAgents={() => queryClient.invalidateQueries({ queryKey: agentsQueryKey })}
					onSaved={() => queryClient.invalidateQueries({ queryKey: workspaceQueryKey })}
					projectId={projectId}
				/>
			</div>
		</div>
	);
}

function SettingsBody({
	project,
	projectId,
	agents,
	isReloadingAgents,
	onReloadAgents,
	onSaved,
}: {
	project: Project;
	projectId: string;
	agents: AgentCatalog;
	isReloadingAgents: boolean;
	onReloadAgents: () => void;
	onSaved: () => void;
}) {
	const queryClient = useQueryClient();
	const workspaces = useWorkspaceQuery().data ?? [];
	const config = project.config ?? {};
	const agentCatalog = agents as AgentCatalogWithAuth;
	const installedAgents = agents.installed ?? [];
	const agentOptions = agentCatalog.authorized ?? [];
	const supportedAgents = agents.supported ?? [];
	const agentLabels = new Map(
		[...supportedAgents, ...installedAgents, ...agentOptions].map((agent) => [agent.id, agent.label] as const),
	);
	const authStatusUnavailable = agentCatalog.authorized === undefined && installedAgents.length > 0;
	const liveOrchestrator = findProjectOrchestrator(workspaces, projectId);
	const savedOrchestratorAgent = effectiveDesiredOrchestratorAgent(project);
	const runningOrchestratorAgent = liveOrchestrator?.provider ?? "";
	const spawnFailurePending = liveOrchestrator !== undefined && savedOrchestratorAgent !== runningOrchestratorAgent;
	const replacementNeeded = spawnFailurePending;
	const retryRequiresIdle = spawnFailurePending;
	const retryBlockedUntilIdle =
		retryRequiresIdle && liveOrchestrator !== undefined && workspaceOrchestratorRestartBlocked(liveOrchestrator);
	const [form, setForm] = useState({
		defaultBranch: config.defaultBranch ?? project.defaultBranch ?? "",
		sessionPrefix: config.sessionPrefix ?? "",
		workerAgent: config.worker?.agent ?? "",
		orchestratorAgent: config.orchestrator?.agent ?? "",
		model: config.agentConfig?.model ?? "",
		permissions: config.agentConfig?.permissions ?? "",
		reviewerHarness: config.reviewers?.[0]?.harness ?? "",
	});
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [restartedAt, setRestartedAt] = useState<number | null>(null);
	const [showAuthPrompt, setShowAuthPrompt] = useState(authStatusUnavailable);
	const [replacementNotice, setReplacementNotice] = useState<string | null>(null);
	const [replacementRecoveryRequired, setReplacementRecoveryRequired] = useState(false);
	const [validationError, setValidationError] = useState<string | null>(null);
	const missingRequiredAgent = form.workerAgent === "" || form.orchestratorAgent === "";

	const mutation = useMutation({
		mutationFn: async () => {
			const currentEffectiveOrchestratorAgent = effectiveOrchestratorAgentValue(
				config.orchestrator?.agent,
				project.agent,
			);
			const nextEffectiveOrchestratorAgent = effectiveOrchestratorAgentValue(
				form.orchestratorAgent || undefined,
				project.agent,
			);
			const orchestratorAgentChanged = currentEffectiveOrchestratorAgent !== nextEffectiveOrchestratorAgent;
			if (orchestratorAgentChanged) {
				await assertOrchestratorCanRestart(projectId);
			}
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
			};
			const { error } = await apiClient.PUT("/api/v1/projects/{id}/config", {
				params: { path: { id: projectId } },
				body: { config: next },
			});
			if (error) throw new Error(apiErrorMessage(error));
			if (orchestratorAgentChanged) {
				try {
					return {
						restarted: true,
						replacement: await restartOrchestrator(projectId),
					};
				} catch (error) {
					await invalidateReplacementQueries(queryClient, projectId);
					throw new Error(
						`Saved config. New orchestrator failed to start, and the previous orchestrator is still running: ${errorMessage(
							error,
						)}`,
					);
				}
			}
			return { restarted: false, replacement: replacementComplete() };
		},
		onSuccess: async ({ restarted, replacement }) => {
			setSavedAt(Date.now());
			setRestartedAt(restarted ? Date.now() : null);
			setReplacementNotice(replacement.notice);
			setReplacementRecoveryRequired(replacement.recoveryRequired);
			await invalidateReplacementQueries(queryClient, projectId);
			onSaved();
		},
		onError: () => {
			setReplacementNotice(null);
			setReplacementRecoveryRequired(false);
		},
	});
	const retryReplacementMutation = useMutation({
		mutationFn: async () => {
			await assertOrchestratorCanRestart(projectId);
			return restartOrchestrator(projectId);
		},
		onSuccess: async (replacement) => {
			setSavedAt(Date.now());
			setRestartedAt(Date.now());
			setReplacementNotice(replacement.notice);
			setReplacementRecoveryRequired(replacement.recoveryRequired);
			await invalidateReplacementQueries(queryClient, projectId);
			onSaved();
		},
		onError: () => {
			setReplacementNotice(null);
			setReplacementRecoveryRequired(false);
		},
	});
	const restartDaemonMutation = useMutation({
		mutationFn: restartDaemon,
		onSuccess: async () => {
			setReplacementNotice("AO daemon restart requested.");
			setReplacementRecoveryRequired(false);
			await invalidateReplacementQueries(queryClient, projectId);
			setValidationError(null);
			void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
			onSaved();
		},
	});
	const runningAgentLabel = agentName(runningOrchestratorAgent, agentLabels);
	const savedAgentLabel = desiredAgentLabel(project, agentLabels);

	return (
		<>
			{showAuthPrompt && authStatusUnavailable && (
				<div className="fixed inset-0 z-50 grid place-items-center bg-background/75 p-6">
					<div
						role="dialog"
						aria-modal="true"
						aria-labelledby="agent-auth-prompt-title"
						className="w-full max-w-md rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg"
					>
						<h2 id="agent-auth-prompt-title" className="mb-2 text-[14px] font-medium">
							Agent login needed
						</h2>
						<p className="mb-4 text-[13px] text-muted-foreground">
							AO found installed agents, but none are verified as authorized yet. Log in to one of{" "}
							<span className="text-foreground">{formatAgentList(installedAgents)}</span>, then reload settings.
						</p>
						<div className="flex justify-end">
							<Button type="button" variant="primary" onClick={() => setShowAuthPrompt(false)}>
								Dismiss
							</Button>
						</div>
					</div>
				</div>
			)}
			<form
				className="mx-auto flex max-w-2xl flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					setSavedAt(null);
					if (missingRequiredAgent) {
						setValidationError("Worker and orchestrator agents are required.");
						return;
					}
					setValidationError(null);
					mutation.mutate();
				}}
			>
				{replacementNeeded && (
					<Card className="border-warning/40 bg-warning/5">
						<CardHeader>
							<CardTitle className="text-[13px] text-warning">Orchestrator replacement pending</CardTitle>
						</CardHeader>
						<CardContent className="flex flex-col gap-3 text-[12px] text-muted-foreground">
							<div>
								Saved orchestrator agent is <span className="text-foreground">{savedAgentLabel}</span>, but the running
								orchestrator is still <span className="text-foreground">{runningAgentLabel}</span>.
							</div>
							<div>
								{retryBlockedUntilIdle
									? "The previous orchestrator was kept alive because the replacement failed to start. It must become idle before retry can run."
									: "The previous orchestrator was kept alive because the replacement failed to start."}
							</div>
							<div className="flex items-center gap-3">
								<Button
									type="button"
									variant="outline"
									disabled={
										retryReplacementMutation.isPending || restartDaemonMutation.isPending || retryBlockedUntilIdle
									}
									onClick={() => retryReplacementMutation.mutate()}
								>
									{retryReplacementMutation.isPending
										? "Retrying…"
										: retryBlockedUntilIdle
											? "Retry when idle"
											: "Retry orchestrator replacement"}
								</Button>
								{retryBlockedUntilIdle && <span>Current orchestrator must be idle before retrying.</span>}
								{retryReplacementMutation.isError && (
									<span className="text-error">
										{retryReplacementMutation.error instanceof Error
											? retryReplacementMutation.error.message
											: "Retry failed"}
									</span>
								)}
							</div>
						</CardContent>
					</Card>
				)}
				<Card>
					<CardHeader>
						<CardTitle className="text-[13px]">Identity</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-2 font-mono text-[12px] text-muted-foreground">
						<ReadonlyRow label="id" value={project.id} />
						<ReadonlyRow label="path" value={project.path} />
						<ReadonlyRow label="repo" value={project.repo || "—"} />
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-[13px]">Worktrees</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<Field label="Default branch" htmlFor="defaultBranch">
							<input
								id="defaultBranch"
								className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
								value={form.defaultBranch}
								onChange={(e) => setForm((f) => ({ ...f, defaultBranch: e.target.value }))}
								placeholder="main"
							/>
						</Field>
						<Field label="Session prefix" htmlFor="sessionPrefix">
							<input
								id="sessionPrefix"
								className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
								value={form.sessionPrefix}
								onChange={(e) => setForm((f) => ({ ...f, sessionPrefix: e.target.value }))}
								placeholder="ao"
							/>
						</Field>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<div className="flex items-center justify-between gap-3">
							<CardTitle className="text-[13px]">Agents</CardTitle>
							<Button type="button" variant="outline" disabled={isReloadingAgents} onClick={onReloadAgents}>
								{isReloadingAgents ? "Reloading..." : "Reload agents"}
							</Button>
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<Field label="Default worker agent" htmlFor="workerAgent">
							<AgentSelect
								id="workerAgent"
								value={form.workerAgent}
								authorized={agentOptions}
								installed={installedAgents}
								supported={supportedAgents}
								invalid={validationError !== null && form.workerAgent === ""}
								onChange={(v) => setForm((f) => ({ ...f, workerAgent: v }))}
							/>
						</Field>
						<Field label="Default orchestrator agent" htmlFor="orchestratorAgent">
							<AgentSelect
								id="orchestratorAgent"
								value={form.orchestratorAgent}
								authorized={agentOptions}
								installed={installedAgents}
								supported={supportedAgents}
								invalid={validationError !== null && form.orchestratorAgent === ""}
								onChange={(v) => setForm((f) => ({ ...f, orchestratorAgent: v }))}
							/>
						</Field>
						{missingRequiredAgent && (
							<p className="text-[12px] leading-5 text-error">Worker and orchestrator agents are required.</p>
						)}
						<Field label="Model override" htmlFor="model">
							<input
								id="model"
								className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
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

				<Card>
					<CardHeader>
						<CardTitle className="text-[13px]">Reviewers</CardTitle>
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

				<div className="flex items-center gap-3">
					<Button
						type="submit"
						variant="primary"
						disabled={mutation.isPending || retryReplacementMutation.isPending || restartDaemonMutation.isPending}
					>
						{mutation.isPending ? "Saving…" : "Save changes"}
					</Button>
					{validationError && <span className="text-[12px] text-error">{validationError}</span>}
					{mutation.isError && (
						<span className="text-[12px] text-error">
							{mutation.error instanceof Error ? mutation.error.message : "Save failed"}
						</span>
					)}
					{replacementNotice && !mutation.isPending && !mutation.isError && !retryReplacementMutation.isPending && (
						<div className="flex items-center gap-2 text-[12px] text-warning">
							<span>{replacementNotice}</span>
							{replacementRecoveryRequired && (
								<Button
									type="button"
									variant="outline"
									disabled={restartDaemonMutation.isPending}
									onClick={() => restartDaemonMutation.mutate()}
								>
									{restartDaemonMutation.isPending ? "Restarting…" : "Restart AO daemon"}
								</Button>
							)}
						</div>
					)}
					{restartDaemonMutation.isError && (
						<span className="text-[12px] text-error">
							{restartDaemonMutation.error instanceof Error ? restartDaemonMutation.error.message : "Restart failed"}
						</span>
					)}
					{savedAt &&
						!mutation.isPending &&
						!mutation.isError &&
						!replacementNotice &&
						!retryReplacementMutation.isPending &&
						!retryReplacementMutation.isError && (
							<span className="text-[12px] text-success">
								{restartedAt ? "Saved. Orchestrator restarted." : "Saved."}
							</span>
						)}
				</div>
			</form>
		</>
	);
}

async function assertOrchestratorCanRestart(projectId: string) {
	const { data, error } = await apiClient.GET("/api/v1/orchestrators");
	if (error) throw new Error(`Could not check orchestrator state: ${apiErrorMessage(error)}`);
	const busy = (data?.sessions ?? []).find(
		(session) =>
			session.projectId === projectId &&
			session.kind === "orchestrator" &&
			!session.isTerminated &&
			orchestratorRestartBlocked(session),
	);
	if (busy) {
		throw new Error("Orchestrator is currently active. Wait until it is idle before switching agents.");
	}
}

function orchestratorRestartBlocked(session: Session) {
	if (session.status === "idle" || session.status === "terminated") return false;
	return true;
}

function workspaceOrchestratorRestartBlocked(session: { status: string }) {
	return session.status !== "idle" && session.status !== "terminated";
}

async function restartOrchestrator(projectId: string) {
	const { error } = await apiClient.POST("/api/v1/orchestrators", {
		body: { projectId, clean: true },
	});
	if (!error) {
		return replacementComplete();
	}
	if (apiErrorCode(error) === "ORCHESTRATOR_REPLACEMENT_INCOMPLETE") {
		return {
			incomplete: true,
			notice: "Saved. New orchestrator started, but the previous orchestrator could not be retired yet.",
			recoveryRequired: false,
		};
	}
	if (apiErrorCode(error) === "ORCHESTRATOR_REPLACEMENT_RECOVERY_REQUIRED") {
		return {
			incomplete: true,
			notice:
				"Saved. New orchestrator started and the previous orchestrator was stopped, but its session state could not be updated.",
			recoveryRequired: true,
		};
	}
	throw new Error(apiErrorMessage(error));
}

function replacementComplete(): ReplacementResult {
	return { incomplete: false, notice: null, recoveryRequired: false };
}

async function restartDaemon() {
	await aoBridge.daemon.stop();
	const status = await aoBridge.daemon.start();
	if (status.state === "error") {
		throw new Error(status.message ?? "AO daemon restart failed.");
	}
}

async function invalidateReplacementQueries(queryClient: ReturnType<typeof useQueryClient>, projectId: string) {
	await Promise.all([
		queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
		queryClient.invalidateQueries({ queryKey: workspaceQueryKey }),
	]);
}

function agentName(agentID: string, labels: Map<string, string>) {
	if (agentID === "") return "daemon default";
	return labels.get(agentID) ?? agentID;
}

function effectiveDesiredOrchestratorAgent(project: Project) {
	return effectiveOrchestratorAgentValue(project.config?.orchestrator?.agent, project.agent);
}

function effectiveOrchestratorAgentValue(explicitAgent: string | undefined, defaultAgent: string | undefined) {
	return explicitAgent ?? defaultAgent ?? "";
}

function desiredAgentLabel(project: Project, labels: Map<string, string>) {
	const explicit = project.config?.orchestrator?.agent ?? "";
	if (explicit !== "") return agentName(explicit, labels);
	if (project.agent) return `${agentName(project.agent, labels)} (daemon default)`;
	return "daemon default";
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : apiErrorMessage(error);
}

function apiErrorCode(error: unknown) {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code !== "") return code;
	}
	return "";
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
			<SelectTrigger id={id} className="h-8 w-full text-[13px]">
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

function AgentSelect({
	id,
	value,
	authorized,
	installed,
	supported,
	invalid = false,
	onChange,
}: {
	id: string;
	value: string;
	authorized: AgentInfo[];
	installed: AgentInfo[];
	supported: AgentInfo[];
	invalid?: boolean;
	onChange: (value: string) => void;
}) {
	// "" sentinel → daemon default; Select can't hold an empty value, so map it.
	const authorizedIds = new Set(authorized.map((agent) => agent.id));
	const installedById = new Map(installed.map((agent) => [agent.id, agent]));
	const supportedById = new Map(supported.map((agent) => [agent.id, agent]));
	const configuredUnavailable = value !== "" && !authorizedIds.has(value);
	const needsFallbackOption = value !== "" && !supportedById.has(value);
	const current = supportedById.get(value);
	const currentInstalled = installedById.get(value);
	const options = supported
		.map((agent) => {
			const installedAgent = installedById.get(agent.id);
			const isAuthorized = authorizedIds.has(agent.id);
			const rank = isAuthorized ? 0 : installedAgent ? 1 : 2;
			return {
				...agent,
				disabled: !isAuthorized,
				rank,
				reason: !installedAgent ? "Needs install" : !isAuthorized ? "Needs auth" : "",
			};
		})
		.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
	const currentWarning = currentInstalled
		? `${current?.label ?? value} is configured but is not authorized on this machine.`
		: `${current?.label ?? value} is configured but was not detected on this machine.`;
	return (
		<div className="flex flex-col gap-1.5">
			<Select value={value || "__default__"} onValueChange={(v) => onChange(v === "__default__" ? "" : v)}>
				<SelectTrigger id={id} className="h-8 w-full text-[13px]" aria-invalid={invalid || undefined}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent position="popper" align="start" sideOffset={4} className="!max-h-80">
					<SelectItem value="__default__">Daemon default</SelectItem>
					{needsFallbackOption && (
						<SelectItem value={value} disabled className="[&>span:last-child]:w-full">
							<span className="flex min-w-0 w-full items-center justify-between gap-4">
								<span className="truncate">{value}</span>
								<span className="shrink-0 text-[11px] text-muted-foreground">Needs install</span>
							</span>
						</SelectItem>
					)}
					{options.map((agent) => (
						<SelectItem
							key={agent.id}
							value={agent.id}
							disabled={agent.disabled}
							className="[&>span:last-child]:w-full"
						>
							<span className="flex min-w-0 w-full items-center justify-between gap-4">
								<span className="truncate">{agent.label}</span>
								{agent.reason && <span className="shrink-0 text-[11px] text-muted-foreground">{agent.reason}</span>}
							</span>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{configuredUnavailable && <span className="text-[12px] text-warning">{currentWarning}</span>}
		</div>
	);
}

function ReviewerSelect({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
	return (
		<Select value={value || "__default__"} onValueChange={(v) => onChange(v === "__default__" ? "" : v)}>
			<SelectTrigger id={id} className="h-8 w-full text-[13px]">
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
			<Label htmlFor={htmlFor} className="text-[12px] text-muted-foreground">
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
		<div className="grid h-full place-items-center bg-background p-6 text-center text-[12px] text-passive">
			{children}
		</div>
	);
}

function formatAgentList(agents: AgentInfo[]) {
	const labels = agents.map((agent) => agent.label || agent.id).sort((a, b) => a.localeCompare(b));
	if (labels.length <= 2) return labels.join(" or ");
	return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

// Drop an object whose every value is undefined so we send `undefined` (omit)
// rather than an empty {} the daemon would persist.
function blankToUndefined<T extends object>(obj: T): T | undefined {
	return Object.values(obj).some((v) => v !== undefined) ? obj : undefined;
}
