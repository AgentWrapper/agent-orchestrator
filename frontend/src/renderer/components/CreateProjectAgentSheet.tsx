import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { TriangleAlert, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { components } from "../../api/schema";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { AGENT_OPTIONS } from "../lib/agent-options";
import { buildIntake, type IntakeForm, IntakeFields, intakeNeedsRule } from "./IntakeFields";
import { SCMConnectionFields, scmSelectionConfig, type SCMSelection } from "./SCMConnectionFields";
import type { ProjectKind } from "../types/workspace";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];
type SCMProjectConfig = components["schemas"]["DomainSCMProjectConfig"];
type CoordinatorConfig = components["schemas"]["DomainCoordinatorConfig"];

type AgentInfo = components["schemas"]["AgentInfo"];

export type CreateProjectAgentSelection = {
	workerAgent: string;
	orchestratorAgent: string;
	coordinator?: CoordinatorConfig;
	scm?: SCMProjectConfig;
	trackerIntake?: TrackerIntakeConfig;
};

const EMPTY_INTAKE: IntakeForm = { enabled: false, provider: "github", repo: "", assignee: "", labels: "" };
const DEFAULT_SCM: SCMSelection = { provider: "github", connectionId: "github-default", repo: "" };

type CreateProjectAgentSheetProps = {
	error?: string | null;
	errorCode?: string;
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
	guidance?: string;
	detail?: string;
	tone: "warning" | "error";
};

function projectSheetError(error: string, code: string | undefined, t: TFunction): SheetError {
	switch (code) {
		case "PROJECT_PATH_NOT_REPO_ROOT":
			return {
				title: t("projects.agents.errors.repositoryRootTitle"),
				guidance: t("projects.agents.errors.repositoryRootGuidance"),
				detail: error,
				tone: "warning",
			};
		case "PROJECT_BARE_REPOSITORY":
			return {
				title: t("projects.agents.errors.bareTitle"),
				guidance: t("projects.agents.errors.bareGuidance"),
				detail: error,
				tone: "warning",
			};
		case "UNSUPPORTED_GIT_REPO":
			return {
				title: t("projects.agents.errors.invalidTitle"),
				guidance: t("projects.agents.errors.invalidGuidance"),
				detail: error,
				tone: "warning",
			};
		default:
			return {
				title: t("projects.agents.errors.createTitle"),
				guidance: error ? undefined : t("projects.agents.errors.tryAgain"),
				detail: error || undefined,
				tone: "error",
			};
	}
}

export function CreateProjectAgentSheet({
	error,
	errorCode,
	isCreating,
	isInitializing = false,
	kind,
	onOpenChange,
	onSubmit,
	open,
	path,
	repositorySetupNeeded = false,
}: CreateProjectAgentSheetProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const agentsQuery = useQuery({
		...agentsQueryOptions,
		enabled: open,
	});
	const refreshAgentsMutation = useMutation({
		mutationFn: refreshAgents,
		onSuccess: (next) => queryClient.setQueryData(agentsQueryKey, next),
	});
	const agents = agentsQuery.data;
	const installedAgents = agents?.installed ?? [];
	const agentOptions = agents?.authorized ?? [];
	const supportedAgents = agents?.supported ?? [];
	const isLoadingAgents = agents === undefined && agentsQuery.isFetching;
	const agentsError = agentsQuery.isError ? t("projects.agents.loadFailed") : null;
	const displayError = refreshAgentsMutation.isError
		? t("projects.agents.refreshFailed")
		: agentsError;
	const [workerAgent, setWorkerAgent] = useState("");
	const [orchestratorAgent, setOrchestratorAgent] = useState("");
	const [coordinatorAutoWake, setCoordinatorAutoWake] = useState(false);
	const isBusy = isCreating || isInitializing;
	const [intake, setIntake] = useState<IntakeForm>(EMPTY_INTAKE);
	const [scm, setSCM] = useState<SCMSelection>(DEFAULT_SCM);
	const [scmValidated, setSCMValidated] = useState(true);
	const intakeIncomplete = intakeNeedsRule(intake);
	const canSubmit =
		workerAgent !== "" &&
		orchestratorAgent !== "" &&
		!intakeIncomplete &&
		scmValidated &&
		!isBusy &&
		!isLoadingAgents;
	const sheetError = error ? projectSheetError(error, errorCode, t) : null;

	useEffect(() => {
		if (!open) {
			setWorkerAgent("");
			setOrchestratorAgent("");
			setCoordinatorAutoWake(false);
			setIntake(EMPTY_INTAKE);
			setSCM(DEFAULT_SCM);
			setSCMValidated(true);
		}
	}, [open, path]);

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !isBusy && onOpenChange(next)}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-overlay bg-scrim data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay max-h-[calc(100vh-2rem)] w-dialog-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
						<div className="min-w-0">
							<Dialog.Title className="text-subtitle font-semibold text-foreground">
								{kind === "workspace" ? t("projects.agents.workspaceTitle") : t("projects.agents.projectTitle")}
							</Dialog.Title>
							<Dialog.Description className="mt-1 break-all text-xs text-muted-foreground">
								{path ?? ""}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label={t("projects.agents.close")}
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
							const scmConfig = scmSelectionConfig(scm);
							void onSubmit({
								workerAgent,
								orchestratorAgent,
								...(coordinatorAutoWake ? { coordinator: { autoWake: true } } : {}),
								...(scmConfig ? { scm: scmConfig } : {}),
								trackerIntake: buildIntake(intake),
							});
						}}
					>
						<div className="grid gap-3 sm:grid-cols-2">
							<RequiredAgentField
								id="newProjectWorkerAgent"
								label={t("projects.agents.worker")}
								placeholder={t("projects.agents.workerPlaceholder")}
								value={workerAgent}
								authorized={agentOptions}
								installed={installedAgents}
								supported={supportedAgents}
								disabled={isLoadingAgents}
								onChange={setWorkerAgent}
							/>
							<RequiredAgentField
								id="newProjectOrchestratorAgent"
								label={t("projects.agents.orchestrator")}
								placeholder={t("projects.agents.orchestratorPlaceholder")}
								value={orchestratorAgent}
								authorized={agentOptions}
								installed={installedAgents}
								supported={supportedAgents}
								disabled={isLoadingAgents}
								onChange={setOrchestratorAgent}
							/>
						</div>

						<label className="flex items-center gap-2.5 text-control text-foreground">
							<input
								type="checkbox"
								className="size-icon-base accent-accent"
								checked={coordinatorAutoWake}
								onChange={(event) => setCoordinatorAutoWake(event.target.checked)}
							/>
							{t("projects.agents.autoWake")}
						</label>

						{isLoadingAgents && (
							<p className="text-xs leading-row text-muted-foreground">{t("projects.agents.loading")}</p>
						)}

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

						{displayError && (
							<div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-row text-destructive">
								<span>{displayError}</span>
								<button
									type="button"
									className="shrink-0 rounded text-foreground underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
									disabled={refreshAgentsMutation.isPending}
									onClick={() => refreshAgentsMutation.mutate()}
								>
									{t("projects.agents.retry")}
								</button>
							</div>
						)}

						<div className="border-t border-border pt-4">
							<p className="mb-3 text-xs font-medium text-muted-foreground">
								{t("projects.agents.sourceControl")}
							</p>
							<SCMConnectionFields
								compact
								value={scm}
								onValidationChange={setSCMValidated}
								onChange={(next) => {
									setSCM(next);
									setSCMValidated(next.provider === "github" && next.connectionId === "github-default");
									setIntake((current) => ({ ...current, provider: next.provider }));
								}}
							/>
						</div>

						<div className="border-t border-border pt-4">
							<IntakeFields form={intake} onChange={(patch) => setIntake((f) => ({ ...f, ...patch }))} compact />
						</div>

						{repositorySetupNeeded && (
							<div className="rounded-md border border-border bg-surface/80 px-3 py-2.5 text-xs leading-body-md text-muted-foreground">
								{t("projects.agents.setupNotice")}
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
									{sheetError.guidance && <p className="text-muted-foreground">{sheetError.guidance}</p>}
									{sheetError.detail && <p className="text-muted-foreground">{sheetError.detail}</p>}
								</div>
							</div>
						)}

						<div className="flex items-center justify-end gap-2 pt-1">
							<Button type="button" variant="ghost" disabled={isBusy} onClick={() => onOpenChange(false)}>
								{t("ui.cancel")}
							</Button>
							<Button type="submit" variant="primary" disabled={!canSubmit}>
								{isInitializing
									? t("projects.create.settingUp")
									: isCreating
										? t("projects.create.creating")
										: kind === "workspace"
											? t("projects.agents.createWorkspace")
											: t("projects.agents.createProject")}
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
	const { t } = useTranslation();
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
				reason: !installedAgent
					? t("projects.agents.needsInstall")
					: isAuthUnknown
						? t("projects.agents.authUnknown")
						: !isAuthorized
							? t("projects.agents.needsAuth")
							: "",
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
