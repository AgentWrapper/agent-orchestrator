import type { WorkspaceSession } from "../types/workspace";
import { ConfirmDialog } from "./ConfirmDialog";

export function SessionTerminationDialog({
	onConfirm,
	onOpenChange,
	open,
	session,
}: {
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	session?: WorkspaceSession;
}) {
	return (
		<ConfirmDialog
			confirmLabel="Terminate session"
			description={
				<p className="text-xs leading-5 text-muted-foreground">
					This stops the agent and moves the session to Archive. Uncommitted changes are preserved.
				</p>
			}
			destructive
			onConfirm={onConfirm}
			onOpenChange={onOpenChange}
			open={open}
			title={`Terminate ${session?.title ?? "session"}?`}
		/>
	);
}
