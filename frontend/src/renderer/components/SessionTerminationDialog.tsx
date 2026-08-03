import { useTranslation } from "react-i18next";
import type { WorkspaceSession } from "../types/workspace";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

export function SessionTerminationDialog({
	busy,
	error,
	onConfirm,
	onOpenChange,
	open,
	session,
}: {
	busy?: boolean;
	error?: string | null;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	session?: WorkspaceSession;
}) {
	const { t } = useTranslation();
	const title = session?.title;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm p-5">
				<DialogHeader>
					<DialogTitle>{t("termination.dialog")}</DialogTitle>
				</DialogHeader>
				<p className="text-caption leading-4 text-muted-foreground">
					{title ? t("termination.bodyNamed", { title }) : t("termination.body")}
				</p>
				{error ? <p className="text-caption text-destructive">{error}</p> : null}
				<div className="mt-3 flex justify-end gap-1.5">
					<button
						className="h-control-md rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
						onClick={() => onOpenChange(false)}
						type="button"
						disabled={busy}
					>
						{t("common.no")}
					</button>
					<button
						aria-label={t("termination.confirmAria")}
						className="h-control-md rounded-md bg-danger-strong px-2.5 text-xs font-semibold text-white transition-[filter] hover:brightness-110 disabled:opacity-60"
						onClick={onConfirm}
						type="button"
						disabled={busy}
					>
						{t("common.yes")}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
