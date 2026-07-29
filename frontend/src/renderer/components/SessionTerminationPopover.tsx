import type { ReactElement } from "react";
import type { WorkspaceSession } from "../types/workspace";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function SessionTerminationPopover({
	onConfirm,
	onOpenChange,
	open,
	session,
	trigger,
}: {
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	session?: WorkspaceSession;
	trigger: ReactElement;
}) {
	return (
		<Popover onOpenChange={onOpenChange} open={open}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				align="end"
				aria-label={`Terminate ${session?.title ?? "session"}?`}
				className="w-64 max-w-[calc(100vw-1rem)] p-3 shadow-lg"
				collisionPadding={8}
				onClick={(event) => event.stopPropagation()}
				role="dialog"
				side="bottom"
				sideOffset={6}
			>
				<p className="text-control font-semibold text-foreground">Terminate session?</p>
				<p className="mt-1 text-caption leading-4 text-muted-foreground">
					Moves {session?.title ?? "this session"} to Archive. Changes are preserved.
				</p>
				<div className="mt-3 flex justify-end gap-1.5">
					<button
						className="h-control-md rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
						onClick={() => onOpenChange(false)}
						type="button"
					>
						No
					</button>
					<button
						aria-label="Yes, terminate session"
						className="h-control-md rounded-md bg-danger-strong px-2.5 text-xs font-semibold text-white transition-[filter] hover:brightness-110"
						onClick={onConfirm}
						type="button"
					>
						Yes
					</button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
