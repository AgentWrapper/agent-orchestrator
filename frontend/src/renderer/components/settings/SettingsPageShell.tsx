import type { ReactNode } from "react";

/** Outer settings frame — chrome matches sidebar (#1E1F22); inset panel is #101013. */
export function SettingsPageShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex h-full min-h-0 w-full bg-sidebar pt-(--size-settings-page-inset) pr-(--size-settings-page-inset) pb-(--size-settings-page-inset) pl-0">
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-settings-panel border border-[var(--color-border-settings)] bg-settings-panel">
				{children}
			</div>
		</div>
	);
}
