import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { useUiStore } from "../stores/ui-store";
import { findProjectOrchestrator, type WorkspaceSummary } from "../types/workspace";

type OrchestratorReplacementDialogProps = {
	workspaces: WorkspaceSummary[];
};

export function OrchestratorReplacementDialog({ workspaces }: OrchestratorReplacementDialogProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const error = useUiStore((state) => state.orchestratorReplacementError);
	const clearError = useUiStore((state) => state.clearOrchestratorReplacementError);
	const startRestart = useUiStore((state) => state.startOrchestratorRestart);
	const finishRestart = useUiStore((state) => state.finishOrchestratorRestart);
	const setError = useUiStore((state) => state.setOrchestratorReplacementError);
	const [isRetrying, setIsRetrying] = useState(false);

	const project = error ? workspaces.find((workspace) => workspace.id === error.projectId) : undefined;
	const orchestrator = error ? findProjectOrchestrator(workspaces, error.projectId) : undefined;
	const title = error?.projectName ? `Could not update ${error.projectName} orchestrator` : "Could not update orchestrator";

	const retry = async () => {
		if (!error) return;
		setIsRetrying(true);
		startRestart(error.projectId);
		try {
			const sessionId = await spawnOrchestrator(error.projectId, true);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			clearError();
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: error.projectId, sessionId },
			});
		} catch (err) {
			setError({
				projectId: error.projectId,
				projectName: project?.name ?? error.projectName,
				message: err instanceof Error ? err.message : "Could not restart orchestrator",
			});
		} finally {
			finishRestart(error.projectId);
			setIsRetrying(false);
		}
	};

	const openCurrent = () => {
		if (!error || !orchestrator) return;
		clearError();
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: error.projectId, sessionId: orchestrator.id },
		});
	};

	return (
		<Dialog.Root open={Boolean(error)} onOpenChange={(open) => !open && clearError()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					<Dialog.Title className="text-sm font-medium text-foreground">{title}</Dialog.Title>
					<Dialog.Description className="mt-2 text-[13px] leading-5 text-muted-foreground">
						The current orchestrator was not replaced. Existing work was not force-deleted.
					</Dialog.Description>
					{error && (
						<p className="mt-3 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-[12px] leading-5 text-error">
							{error.message}
						</p>
					)}
					<div className="mt-5 flex justify-end gap-2">
						<button className="settings-form__secondary" onClick={clearError} type="button">
							Close
						</button>
						{orchestrator && (
							<button className="settings-form__secondary" onClick={openCurrent} type="button">
								Open current
							</button>
						)}
						<button className="settings-form__primary" disabled={isRetrying} onClick={() => void retry()} type="button">
							{isRetrying ? "Retrying..." : "Retry restart"}
						</button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
