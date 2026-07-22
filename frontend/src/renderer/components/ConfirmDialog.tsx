import * as Dialog from "@radix-ui/react-dialog";
import { XCircle } from "lucide-react";
import { Button } from "./ui/button";

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
	size = "default",
}: ConfirmDialogProps) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-125 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-4 shadow-lg">
					<div className="flex gap-2">
						<div className="min-w-0 flex-1">
							<Dialog.Title className="text-sm font-semibold text-foreground">{title}</Dialog.Title>
							<Dialog.Description asChild>
								<div className="mt-2">{description}</div>
							</Dialog.Description>
						</div>
					</div>
					{error && (
						<div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
							<XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							<span>{error}</span>
						</div>
					)}
					<div className="mt-4 flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy} size={size}>
							Cancel
						</Button>
						<Button
							className={
								destructive
									? "border-destructive bg-destructive text-destructive-foreground font-medium hover:opacity-90"
									: ""
							}
							onClick={onConfirm}
							disabled={busy}
							size={size}
						>
							{confirmLabel}
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
