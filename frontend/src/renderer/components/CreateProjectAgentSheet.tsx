import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { AGENT_OPTIONS } from "../lib/agent-options";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type AgentInfo = components["schemas"]["AgentInfo"];

export type CreateProjectAgentSelection = {
	workerAgent: string;
	orchestratorAgent: string;
};

type CreateProjectAgentSheetProps = {
	error?: string | null;
	isCreating: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (selection: CreateProjectAgentSelection) => Promise<void>;
	open: boolean;
	path: string | null;
};

export function CreateProjectAgentSheet({
	error,
	isCreating,
	onOpenChange,
	onSubmit,
	open,
	path,
}: CreateProjectAgentSheetProps) {
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
	const agentsError = agentsQuery.isError
		? agentsQuery.error instanceof Error
			? agentsQuery.error.message
			: "Could not load agent catalog."
		: null;
	const [workerAgent, setWorkerAgent] = useState("");
	const [orchestratorAgent, setOrchestratorAgent] = useState("");
	const canSubmit = workerAgent !== "" && orchestratorAgent !== "" && !isCreating && !isLoadingAgents;

	useEffect(() => {
		if (!open) {
			setWorkerAgent("");
			setOrchestratorAgent("");
		}
	}, [open, path]);

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !isCreating && onOpenChange(next)}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
						<div className="min-w-0">
							<Dialog.Title className="text-[15px] font-semibold text-foreground">Project agents</Dialog.Title>
							<Dialog.Description className="mt-1 break-all text-[12px] text-muted-foreground">
								{path ?? ""}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label="Close project agents dialog"
								disabled={isCreating}
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>
					<form
						className="space-y-4 px-5 py-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!canSubmit) return;
							void onSubmit({ workerAgent, orchestratorAgent });
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

						{isLoadingAgents && <p className="text-[12px] leading-5 text-muted-foreground">Loading agents...</p>}

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

						{agentsError && (
							<div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
								<span>{agentsError}</span>
								<button
									type="button"
									className="shrink-0 rounded text-foreground underline-offset-2 hover:underline"
									onClick={() => refreshAgentsMutation.mutate()}
								>
									Retry
								</button>
							</div>
						)}

						{refreshAgentsMutation.isError && (
							<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
								{refreshAgentsMutation.error instanceof Error
									? refreshAgentsMutation.error.message
									: "Could not refresh agent catalog."}
							</div>
						)}

						{error && (
							<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
								{error}
							</div>
						)}

						<div className="flex items-center justify-end gap-2 pt-1">
							<Button type="button" variant="ghost" disabled={isCreating} onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" disabled={!canSubmit}>
								{isCreating ? "Creating..." : "Create and start"}
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
	const fallbackAgents = AGENT_OPTIONS.map((agent) => ({ id: agent, label: agent }));
	const supportedAgents = supported ?? fallbackAgents;
	const installedAgents = installed ?? supportedAgents;
	const authorizedAgents = authorized ?? supportedAgents;
	const authorizedIds = new Set(authorizedAgents.map((agent) => agent.id));
	const installedById = new Map(installedAgents.map((agent) => [agent.id, agent]));
	const options = supportedAgents
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

	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id} className="text-[12px] font-medium text-muted-foreground">
				{label}
			</Label>
			<Select value={value} onValueChange={onChange} disabled={disabled}>
				<SelectTrigger id={id} className="h-8 w-full text-[13px]" aria-invalid={invalid || undefined}>
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent position="popper" align="start" sideOffset={4} className="!max-h-80">
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
		</div>
	);
});
