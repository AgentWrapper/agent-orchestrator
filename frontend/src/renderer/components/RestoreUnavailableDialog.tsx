import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { hasConfiguredOrchestratorAgent, isOrchestratorSession } from "../types/workspace";
import type { WorkspaceSession } from "../types/workspace";

type RestoreUnavailableDialogProps = {
	open: boolean;
	session: WorkspaceSession;
	onOpenChange: (open: boolean) => void;
	onRecreated: (newOrchestratorId: string) => void;
};

export function RestoreUnavailableDialog({ open, session, onOpenChange, onRecreated }: RestoreUnavailableDialogProps) {
	const navigate = useNavigate();
	const workspaceQuery = useWorkspaceQuery();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const orchestrator = isOrchestratorSession(session);
	const workspace = workspaceQuery.data?.find((candidate) => candidate.id === session.workspaceId);
	const hasOrchestratorAgent = hasConfiguredOrchestratorAgent(workspace);
	const checkingProject = workspaceQuery.isLoading && workspaceQuery.data === undefined;

	const recreate = async () => {
		if (checkingProject) return;
		if (!hasOrchestratorAgent) {
			onOpenChange(false);
			void navigate({
				to: "/projects/$projectId/settings",
				params: { projectId: session.workspaceId },
			});
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const id = await spawnOrchestrator(session.workspaceId, "restore_dialog", true);
			onOpenChange(false);
			onRecreated(id);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create orchestrator");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					<Dialog.Title className="text-sm font-medium text-foreground">Session can no longer be restored</Dialog.Title>
					<Dialog.Description className="mt-2 text-control text-muted-foreground">
						{orchestrator
							? "This orchestrator has no saved agent session to resume. You can create a new orchestrator while AO preserves any workspace data it cannot safely clean."
							: "This session has no saved agent session or prompt to resume from."}
					</Dialog.Description>
					{error && <div className="mt-3 text-xs text-destructive">{error}</div>}
					<div className="mt-4 flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
							{orchestrator ? "Cancel" : "Close"}
						</Button>
						{orchestrator && (
							<Button onClick={recreate} disabled={busy || checkingProject}>
								{busy && <Loader2 className="mr-2 size-icon-base animate-spin" />}
								{checkingProject
									? "Checking project…"
									: hasOrchestratorAgent
										? "Create new orchestrator"
										: "Configure orchestrator agent"}
							</Button>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
