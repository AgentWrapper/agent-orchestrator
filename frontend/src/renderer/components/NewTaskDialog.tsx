import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TaskComposer } from "./TaskComposer";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	settingsDialogContentClass,
	settingsDialogHeaderClass,
} from "./ui/dialog";
import { cn } from "../lib/utils";

type NewTaskDialogProps = {
	open: boolean;
	projectId?: string;
	onCreated: (sessionId: string) => void;
	onOpenChange: (open: boolean) => void;
};

export function NewTaskDialog({ open, projectId, onCreated, onOpenChange }: NewTaskDialogProps) {
	const { t } = useTranslation();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false} className={cn(settingsDialogContentClass, "w-dialog-xl")}>
				{/* An eyebrow, not a heading with a subtitle: the placeholder already
				    explains the field, so a description line only adds a row to read. */}
				<div className={cn(settingsDialogHeaderClass, "flex-row items-center justify-between gap-4")}>
					<DialogTitle className="eyebrow-label">{t("newTask.title")}</DialogTitle>
					<DialogDescription className="sr-only">{t("newTask.description")}</DialogDescription>
					<DialogClose asChild>
						<button
							type="button"
							className="settings-close-button border border-transparent transition-colors hover:border-(--color-border-settings-input) hover:bg-[var(--color-bg-settings-input)]"
							aria-label={t("newTask.close")}
						>
							<X className="size-icon-base" aria-hidden="true" />
						</button>
					</DialogClose>
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
			</DialogContent>
		</Dialog>
	);
}
