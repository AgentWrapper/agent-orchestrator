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
					{/* An eyebrow, not a heading with a subtitle: the placeholder already
					    explains the field, so a description line only adds a row to read. */}
					<div className="flex items-center justify-between gap-4 px-(--size-modal-padding) pt-4 pb-2">
						<Dialog.Title className="eyebrow-label">{t("newTask.title")}</Dialog.Title>
						<Dialog.Description className="sr-only">{t("newTask.description")}</Dialog.Description>
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
