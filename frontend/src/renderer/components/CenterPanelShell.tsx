import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** Visual variants for inset center panels (welcome board, settings, …). */
export type CenterPanelVariant = "welcome" | "settings";

const VARIANTS: Record<
	CenterPanelVariant,
	{
		outer: string;
		inner: string;
	}
> = {
	welcome: {
		outer: "pt-(--size-welcome-panel-inset) pr-(--size-welcome-panel-inset) pb-(--size-welcome-panel-inset) pl-0",
		inner: "rounded-welcome-panel border border-[var(--color-border-welcome-panel)] bg-welcome-panel",
	},
	settings: {
		outer: "pt-(--size-settings-page-inset) pr-(--size-settings-page-inset) pb-(--size-settings-page-inset) pl-0",
		inner: "rounded-settings-panel border border-[var(--color-border-settings)] bg-settings-panel",
	},
};

/**
 * Shared inset center panel: sidebar-colored outer frame with a bordered inner
 * surface. Used by the welcome board, settings page, and future full-width
 * center routes.
 */
export function CenterPanelShell({ variant, children }: { variant: CenterPanelVariant; children: ReactNode }) {
	const styles = VARIANTS[variant];
	return (
		<div className={cn("flex h-full min-h-0 w-full bg-sidebar", styles.outer)}>
			<div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", styles.inner)}>{children}</div>
		</div>
	);
}
