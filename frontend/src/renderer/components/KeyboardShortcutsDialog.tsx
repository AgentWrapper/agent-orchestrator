import {
	APP_SHORTCUTS,
	effectiveShortcutBindings,
	SHORTCUT_CATEGORIES,
	shortcutBindingKeys,
} from "../../shared/shortcuts";
import { useCommandPaletteEnabled } from "../hooks/useCommandPaletteEnabled";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type KeyboardShortcutsDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCustomize?: () => void;
	isMac?: boolean;
};

function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	const platform =
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
	return platform.toLowerCase().includes("mac");
}

export function KeyboardShortcutsDialog({
	open,
	onOpenChange,
	onCustomize,
	isMac = isMacPlatform(),
}: KeyboardShortcutsDialogProps) {
	const isCommandPaletteEnabled = useCommandPaletteEnabled();
	const overrides = useKeybindingsStore((state) => state.overrides);
	const availableShortcuts = APP_SHORTCUTS.filter(
		(shortcut) => shortcut.id !== "command-palette" || isCommandPaletteEnabled,
	);

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
						const shortcuts = availableShortcuts.filter((shortcut) => shortcut.category === category);
						if (shortcuts.length === 0) return null;
						return (
							<section className="border-b border-border py-4 last:border-b-0" key={category}>
								<h2 className="mb-2 font-mono text-micro font-semibold uppercase tracking-wide-lg text-passive">
									{category}
								</h2>
								<div className="flex flex-col">
									{shortcuts.map((shortcut) => (
										<div className="flex min-h-11 items-center justify-between gap-5 py-1.5" key={shortcut.id}>
											<p className="min-w-0 text-control font-medium text-foreground">{shortcut.label}</p>
											<div className="flex shrink-0 flex-col items-end gap-1">
												{effectiveShortcutBindings(shortcut.id, isMac, overrides).map((binding, bindingIndex) => {
													const keys = shortcutBindingKeys(binding, isMac);
													return (
														<div
															className="flex items-center gap-1"
															aria-label={keys.join("+")}
															key={`${binding.key}-${bindingIndex}`}
														>
															{keys.map((key) => (
																<kbd
																	className="inline-flex min-w-7 items-center justify-center rounded-sm border border-border-strong bg-surface px-1.5 py-1 font-mono text-caption font-medium text-muted-foreground shadow-sm"
																	key={key}
																>
																	{key}
																</kbd>
															))}
														</div>
													);
												})}
											</div>
										</div>
									))}
								</div>
							</section>
						);
					})}
				</div>
				{onCustomize ? (
					<div className="flex justify-end border-t border-border px-5 py-3">
						<button
							type="button"
							className="rounded-md bg-accent px-3 py-2 text-control font-medium text-accent-foreground transition-opacity hover:opacity-90"
							onClick={onCustomize}
						>
							Customize
						</button>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
