import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, RotateCw, X } from "lucide-react";
import { findProjectOrchestrator, type WorkspaceSummary } from "../types/workspace";
import { TopbarButton } from "./TopbarButton";

type OrchestratorReplacementDialogProps = {
	projectId: string | null;
	error?: string;
	workspaces: WorkspaceSummary[];
	onOpenChange: (open: boolean) => void;
	onRetry: (projectId: string) => void;
};

export function OrchestratorReplacementDialog({
	projectId,
	error,
	workspaces,
	onOpenChange,
	onRetry,
}: OrchestratorReplacementDialogProps) {
	const navigate = useNavigate();
	const open = Boolean(projectId && error);
	const orchestrator = projectId ? findProjectOrchestrator(workspaces, projectId) : undefined;

	const openCurrent = () => {
		if (!projectId || !orchestrator) return;
		onOpenChange(false);
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId, sessionId: orchestrator.id },
		});
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-orchestrator -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					<div className="flex items-start gap-3">
						<div className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted text-warning">
							<AlertTriangle className="size-icon-base" aria-hidden="true" />
						</div>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="text-sm font-medium text-foreground">
								Orchestrator replacement failed
							</Dialog.Title>
							<Dialog.Description className="mt-2 text-[13px] leading-5 text-muted-foreground">
								{error ?? "The project orchestrator could not be replaced."}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								className="rounded-md p-1 text-passive hover:bg-interactive-hover hover:text-foreground"
								type="button"
							>
								<X className="size-icon-base" aria-hidden="true" />
								<span className="sr-only">Close</span>
							</button>
						</Dialog.Close>
					</div>
					<div className="mt-5 flex justify-end gap-2">
						{orchestrator ? (
							<TopbarButton onClick={openCurrent} variant="primary">
								Open current orchestrator
							</TopbarButton>
						) : null}
						<TopbarButton onClick={() => projectId && onRetry(projectId)} variant="accent">
							<RotateCw className="size-3.5" aria-hidden="true" />
							Retry
						</TopbarButton>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
