import type { WorkspaceSession } from "../types/workspace";
import { ConfirmDialog } from "./ConfirmDialog";

export function SessionTerminationDialog({
	busy,
	error,
	onConfirm,
	onOpenChange,
	open,
	session,
}: {
	busy: boolean;
	error?: string | null;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	session?: WorkspaceSession;
}) {
	return (
		<ConfirmDialog
			busy={busy}
			confirmLabel={busy ? "Terminating..." : "Terminate session"}
			description={
				<p className="text-xs leading-5 text-muted-foreground">
					This stops the agent and moves the session to Archive. Uncommitted changes are preserved.
				</p>
			}
			destructive
			error={error}
			onConfirm={onConfirm}
			onOpenChange={onOpenChange}
			open={open}
			size="sm"
			title={`Terminate ${session?.title ?? "session"}?`}
		/>
	);
}
