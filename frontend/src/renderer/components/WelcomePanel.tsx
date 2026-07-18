import type { ReactNode } from "react";

/** Inset frame for the first-launch welcome board (import chooser). */
export function WelcomePanel({ children }: { children: ReactNode }) {
	return (
		<div className="flex h-full min-h-0 w-full bg-background pt-(--size-welcome-panel-inset) pr-(--size-welcome-panel-inset) pb-(--size-welcome-panel-inset) pl-0">
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-welcome-panel border border-[var(--color-border-welcome-panel)] bg-welcome-panel">
				{children}
			</div>
		</div>
	);
}
