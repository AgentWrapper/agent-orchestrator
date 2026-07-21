import type { ReactNode } from "react";

/** Visual variants for inset center panels (welcome board, settings, …). */
export type CenterPanelVariant = "welcome" | "settings";

/**
 * Shared inset center panel: sidebar-colored outer frame with a bordered inner
 * surface. Used by the welcome board, settings page, and future full-width
 * center routes. Chrome lives in `styles.css` (`center-panel-*` utilities).
 */
export function CenterPanelShell({ variant, children }: { variant: CenterPanelVariant; children: ReactNode }) {
	return (
		<div className="center-panel-shell">
			<div className={variant === "welcome" ? "center-panel-welcome" : "center-panel-settings"}>{children}</div>
		</div>
	);
}
