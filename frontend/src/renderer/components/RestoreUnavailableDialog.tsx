import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { isOrchestratorSession } from "../types/workspace";
import type { WorkspaceSession } from "../types/workspace";

type RestoreUnavailableDialogProps = {
	open: boolean;
	session: WorkspaceSession;
	onOpenChange: (open: boolean) => void;
	onRecreated: (newOrchestratorId: string) => void;
};

export function RestoreUnavailableDialog({ open, session, onOpenChange, onRecreated }: RestoreUnavailableDialogProps) {
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const orchestrator = isOrchestratorSession(session);

	const recreate = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const id = await spawnOrchestrator(session.workspaceId, "restore_dialog", true);
			onOpenChange(false);
			onRecreated(id);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("projects.restore.createFailed"));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-overlay bg-scrim" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					<Dialog.Title className="text-sm font-medium text-foreground">
						{t("projects.restore.title")}
					</Dialog.Title>
					<Dialog.Description className="mt-2 text-control text-muted-foreground">
						{orchestrator
							? t("projects.restore.orchestratorDescription")
							: t("projects.restore.workerDescription")}
					</Dialog.Description>
					{error && <div className="mt-3 text-xs text-destructive">{error}</div>}
					<div className="mt-4 flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
							{orchestrator ? t("ui.cancel") : t("ui.close")}
						</Button>
						{orchestrator && (
							<Button onClick={recreate} disabled={busy}>
								{busy && <Loader2 className="mr-2 size-icon-base animate-spin" />}
								{t("projects.restore.create")}
							</Button>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
