import * as Dialog from "@radix-ui/react-dialog";
import { GitBranch, Info, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AGENT_OPTIONS } from "../lib/agent-options";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export type CreateProjectAgentSelection = {
	workerAgent: string;
	orchestratorAgent: string;
};

type RecoveryCode = "NOT_A_GIT_REPO" | "PROJECT_UNBORN";

type CreateProjectAgentSheetProps = {
	error?: string | null;
	isCreating: boolean;
	isInitializing?: boolean;
	onInitialize?: (selection: CreateProjectAgentSelection) => Promise<void>;
	onOpenChange: (open: boolean) => void;
	onSubmit: (selection: CreateProjectAgentSelection) => Promise<void>;
	open: boolean;
	path: string | null;
	recoveryCode?: RecoveryCode | null;
};

const RECOVERY_COPY = {
	NOT_A_GIT_REPO: {
		title: "Set up Git to continue",
		description: "AO will initialize Git in this folder, create an empty initial commit, then continue automatically.",
		action: "Initialize Git and create commit",
		pending: "Setting up repository...",
		steps: ["Run git init", "Create an empty initial commit", "Start the project"],
	},
	PROJECT_UNBORN: {
		title: "Create the first commit to continue",
		description:
			"This folder is already a Git repository, but it does not have a commit yet. AO will create an empty initial commit, then continue automatically.",
		action: "Create initial commit",
		pending: "Creating commit...",
		steps: ["Create an empty initial commit", "Verify the repository", "Start the project"],
	},
} satisfies Record<
	RecoveryCode,
	{ title: string; description: string; action: string; pending: string; steps: string[] }
>;

const RECOVERY_MESSAGE = "AO needs a Git repository with an initial commit before it can create agent workspaces.";

export function CreateProjectAgentSheet({
	error,
	isCreating,
	isInitializing = false,
	onInitialize,
	onOpenChange,
	onSubmit,
	open,
	path,
	recoveryCode,
}: CreateProjectAgentSheetProps) {
	const [workerAgent, setWorkerAgent] = useState("");
	const [orchestratorAgent, setOrchestratorAgent] = useState("");
	const isBusy = isCreating || isInitializing;
	const hasRecovery = Boolean(error && recoveryCode);
	const canSubmit = workerAgent !== "" && orchestratorAgent !== "" && !isBusy;
	const canInitialize = Boolean(canSubmit && recoveryCode && onInitialize);
	const recovery = recoveryCode ? RECOVERY_COPY[recoveryCode] : null;
	const showRecoveryFailure = Boolean(error && recoveryCode && error !== RECOVERY_MESSAGE);

	useEffect(() => {
		if (!open) {
			setWorkerAgent("");
			setOrchestratorAgent("");
		}
	}, [open, path]);

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !isBusy && onOpenChange(next)}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
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
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
								aria-label="Close project agents dialog"
								disabled={isBusy}
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>
					<form
						className="space-y-4 px-5 py-4"
						aria-busy={isBusy || undefined}
						onSubmit={(event) => {
							event.preventDefault();
							if (hasRecovery) {
								if (canInitialize) void onInitialize?.({ workerAgent, orchestratorAgent });
								return;
							}
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
								onChange={setWorkerAgent}
							/>
							<RequiredAgentField
								id="newProjectOrchestratorAgent"
								label="Orchestrator agent"
								placeholder="Select orchestrator agent"
								value={orchestratorAgent}
								onChange={setOrchestratorAgent}
							/>
						</div>

						{error && recoveryCode && recovery ? (
							<div className="rounded-md border border-border bg-surface/80 p-3 text-[12px] leading-5">
								<div className="flex gap-3">
									<div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground">
										<GitBranch className="size-4" aria-hidden="true" />
									</div>
									<div className="min-w-0 flex-1 space-y-3">
										<div className="flex items-start justify-between gap-3">
											<div className="space-y-1">
												<p className="font-medium text-foreground">{recovery.title}</p>
												<p className="text-muted-foreground">{recovery.description}</p>
											</div>
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														aria-label="Manual Git setup"
														className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-interactive-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
														type="button"
													>
														<Info className="size-4" aria-hidden="true" />
													</button>
												</TooltipTrigger>
												<TooltipContent className="max-w-[300px] text-[11px] leading-5">
													<div className="space-y-1.5">
														<p>Prefer to do it yourself?</p>
														{recoveryCode === "NOT_A_GIT_REPO" ? <code className="block">git init</code> : null}
														<code className="block">git commit --allow-empty -m "initial commit"</code>
														<p>Then try adding the project again.</p>
													</div>
												</TooltipContent>
											</Tooltip>
										</div>

										<div className="grid gap-1.5 text-[11px] text-muted-foreground">
											{recovery.steps.map((step, index) => (
												<div key={step} className="flex items-center gap-2">
													<span className="grid size-4 shrink-0 place-items-center rounded-full bg-background text-[10px] text-passive">
														{index + 1}
													</span>
													<span>{step}</span>
												</div>
											))}
										</div>

										{showRecoveryFailure ? (
											<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-destructive">
												Setup failed: {error}
											</div>
										) : null}

										<Button
											type="button"
											variant="primary"
											className="w-full transition-[transform,opacity] active:scale-[0.98]"
											disabled={!canInitialize}
											onClick={() => void onInitialize?.({ workerAgent, orchestratorAgent })}
										>
											{isInitializing ? recovery.pending : recovery.action}
										</Button>
									</div>
								</div>
							</div>
						) : error ? (
							<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
								{error}
							</div>
						) : null}

						<div className="flex items-center justify-end gap-2 pt-1">
							<Button type="button" variant="ghost" disabled={isBusy} onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							{!hasRecovery ? (
								<Button type="submit" variant="primary" disabled={!canSubmit}>
									{isCreating ? "Creating..." : "Create and start"}
								</Button>
							) : null}
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export function RequiredAgentField({
	id,
	invalid = false,
	label,
	onChange,
	placeholder,
	value,
}: {
	id: string;
	invalid?: boolean;
	label: string;
	onChange: (value: string) => void;
	placeholder: string;
	value: string;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id} className="text-[12px] font-medium text-muted-foreground">
				{label}
			</Label>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger id={id} className="h-8 w-full text-[13px]" aria-invalid={invalid || undefined}>
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent>
					{AGENT_OPTIONS.map((agent) => (
						<SelectItem key={agent} value={agent}>
							{agent}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
