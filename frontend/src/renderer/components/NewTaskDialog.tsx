import * as Dialog from "@radix-ui/react-dialog";
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
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					{/* The composer is the dialog's complete visible surface. Keep the title
					    and description in the accessibility tree without spending visual rows. */}
					<Dialog.Title className="sr-only">{t("newTask.title")}</Dialog.Title>
					<Dialog.Description className="sr-only">{t("newTask.description")}</Dialog.Description>
					<TaskComposer
						projectId={projectId}
						autoFocusTitle
						onCreated={(sessionId) => {
							onCreated(sessionId);
							onOpenChange(false);
						}}
					/>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
