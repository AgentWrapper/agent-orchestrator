import type { ReactNode } from "react";

/** Outer settings frame — Figma "Rectangle 1": #121213, 1px #757575, 17px radius, inset on top/right/bottom only. */
export function SettingsPageShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex h-full min-h-0 w-full bg-background pt-(--size-settings-page-inset) pr-(--size-settings-page-inset) pb-(--size-settings-page-inset) pl-0">
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-settings-panel border border-[var(--color-border-settings)] bg-settings-panel">
				{children}
			</div>
		</div>
	);
}
