import * as Dialog from "@radix-ui/react-dialog";
import { Cloud, Laptop } from "lucide-react";

type OrchestratorLaunchDialogProps = {
	open: boolean;
	busy?: boolean;
	error?: string | null;
	onChoose: (cloud: boolean) => void;
	onOpenChange: (open: boolean) => void;
};

// A tiny two-option launcher shown when starting a project's orchestrator and a
// cloud target is available: run it locally, or in a per-session cloud sandbox.
export function OrchestratorLaunchDialog({ open, busy, error, onChoose, onOpenChange }: OrchestratorLaunchDialogProps) {
	const optionClass =
		"flex flex-col items-center gap-1.5 rounded-md border border-border bg-interactive-hover px-3 py-4 text-control text-foreground transition-colors hover:border-accent hover:bg-interactive-active disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-icon-lg [&_svg]:text-muted-foreground";

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-[26rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex flex-col gap-1 border-b border-border px-4 py-3">
						<Dialog.Title className="text-subtitle font-semibold text-foreground">Start orchestrator</Dialog.Title>
						<Dialog.Description className="text-xs text-muted-foreground">
							Run it on your machine, or in a per-session cloud sandbox (survives shutdown, shareable).
						</Dialog.Description>
					</div>
					<div className="grid grid-cols-2 gap-3 p-4">
						<button type="button" className={optionClass} disabled={busy} onClick={() => onChoose(false)}>
							<Laptop aria-hidden="true" />
							<span className="font-medium">Local</span>
							<span className="text-xs text-muted-foreground">On this machine</span>
						</button>
						<button type="button" className={optionClass} disabled={busy} onClick={() => onChoose(true)}>
							<Cloud aria-hidden="true" />
							<span className="font-medium">Cloud</span>
							<span className="text-xs text-muted-foreground">Per-session sandbox</span>
						</button>
					</div>
					{busy && <p className="px-4 pb-4 text-xs text-muted-foreground">Starting…</p>}
					{error && !busy && <p className="px-4 pb-4 text-xs leading-row text-error">{error}</p>}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
