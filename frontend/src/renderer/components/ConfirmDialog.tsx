import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	settingsDialogBodyClass,
	settingsDialogContentClass,
	settingsDialogFooterClass,
	settingsDialogHeaderClass,
} from "./ui/dialog";

type ConfirmDialogProps = {
	open: boolean;
	title: string;
	description: React.ReactNode;
	confirmLabel: string;
	destructive?: boolean;
	busy?: boolean;
	error?: string | null;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	size?: "default" | "sm";
};

// Shared confirmation modal styled exactly like the settings dialogs
// (ReportProblemDialog) — same frame, header typography, and footer buttons
// via the shared settingsDialog* class constants. Destructive confirms fill
// with the deep danger-strong token instead of the settings accent.
export function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel,
	destructive,
	busy,
	error,
	onConfirm,
	onOpenChange,
	size: _size,
}: ConfirmDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false} className={settingsDialogContentClass}>
				<DialogClose asChild>
					<button
						type="button"
						disabled={busy}
						className="settings-dialog-close-button settings-close-button"
						aria-label="Close dialog"
						title="Close (Esc)"
					>
						<X className="size-5" aria-hidden="true" />
					</button>
				</DialogClose>

				<div className={settingsDialogHeaderClass}>
					<DialogTitle className="settings-dialog-title">{title}</DialogTitle>
					<DialogDescription asChild>
						<div className="text-control leading-4 text-settings-muted">{description}</div>
					</DialogDescription>
				</div>

				{error ? (
					<div className={settingsDialogBodyClass}>
						<p role="alert" className="text-caption leading-4 text-error">
							{error}
						</p>
					</div>
				) : null}

				<div className={settingsDialogFooterClass}>
					<DialogClose asChild>
						<button type="button" className="settings-footer-button" disabled={busy}>
							Cancel
						</button>
					</DialogClose>
					<button
						type="button"
						className={cn(
							"settings-footer-button border-transparent text-white disabled:cursor-not-allowed disabled:opacity-50",
							destructive ? "bg-danger-strong" : "bg-settings-accent",
						)}
						disabled={busy}
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
