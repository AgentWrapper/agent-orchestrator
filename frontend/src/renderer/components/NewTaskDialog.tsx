import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TaskComposer } from "./TaskComposer";

type NewTaskDialogProps = {
	open: boolean;
	projectId?: string;
	onCreated: (sessionId: string) => void;
	onOpenChange: (open: boolean) => void;
};

export function NewTaskDialog({ open, projectId, onCreated, onOpenChange }: NewTaskDialogProps) {
	const { t } = useTranslation();
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-xl -translate-x-1/2 -translate-y-1/2 rounded-(--radius-settings-dialog-lg) border border-[var(--color-border-settings-dialog)] bg-popover p-0 text-popover-foreground shadow-[var(--shadow-settings-dialog)] data-[state=open]:animate-modal-in">
					<div className="flex items-start justify-between gap-4 border-b border-[var(--color-border-settings-dialog-header)] p-(--size-modal-padding)">
						<div className="min-w-0">
							<Dialog.Title className="settings-dialog-title">{t("newTask.title")}</Dialog.Title>
							<Dialog.Description className="mt-1 text-xs text-settings-muted">
								{t("newTask.description")}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="settings-close-button"
								aria-label={t("newTask.close")}
							>
								<X className="size-icon-base" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>

					<TaskComposer
						projectId={projectId}
						autoFocusTitle
						onCreated={(sessionId) => {
							onCreated(sessionId);
							onOpenChange(false);
						}}
						onCancel={() => onOpenChange(false)}
					/>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
