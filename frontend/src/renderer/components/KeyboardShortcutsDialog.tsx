import { APP_SHORTCUTS, SHORTCUT_CATEGORIES, shortcutKeys } from "../../shared/shortcuts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type KeyboardShortcutsDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	isMac?: boolean;
};

function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	const platform =
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
	return platform.toLowerCase().includes("mac");
}

export function KeyboardShortcutsDialog({ open, onOpenChange, isMac = isMacPlatform() }: KeyboardShortcutsDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[min(680px,calc(100svh-32px))] max-w-xl gap-0 overflow-hidden border-border bg-popover p-0 text-popover-foreground">
				<DialogHeader className="border-b border-border px-5 py-4">
					<DialogTitle className="text-[15px]">Keyboard shortcuts</DialogTitle>
					<DialogDescription className="text-xs">
						Move around Agent Orchestrator without leaving the keyboard.
					</DialogDescription>
				</DialogHeader>

				<div className="overflow-y-auto px-5 py-2">
					{SHORTCUT_CATEGORIES.map((category) => {
						const shortcuts = APP_SHORTCUTS.filter((shortcut) => shortcut.category === category);
						if (shortcuts.length === 0) return null;
						return (
							<section className="border-b border-border py-4 last:border-b-0" key={category}>
								<h2 className="mb-2 font-mono text-micro font-semibold uppercase tracking-wide-lg text-passive">
									{category}
								</h2>
								<div className="flex flex-col">
									{shortcuts.map((shortcut) => (
										<div className="flex min-h-11 items-center justify-between gap-5 py-1.5" key={shortcut.id}>
											<div className="min-w-0">
												<p className="text-control font-medium text-foreground">{shortcut.label}</p>
												{shortcut.context ? (
													<p className="mt-0.5 text-caption text-passive">{shortcut.context}</p>
												) : null}
											</div>
											<div
												className="flex shrink-0 items-center gap-1"
												aria-label={shortcutKeys(shortcut, isMac).join("+")}
											>
												{shortcutKeys(shortcut, isMac).map((key) => (
													<kbd
														className="inline-flex min-w-7 items-center justify-center rounded-sm border border-border-strong bg-surface px-1.5 py-1 font-mono text-caption font-medium text-muted-foreground shadow-sm"
														key={key}
													>
														{key}
													</kbd>
												))}
											</div>
										</div>
									))}
								</div>
							</section>
						);
					})}
				</div>
			</DialogContent>
		</Dialog>
	);
}
