import type { ReactNode } from "react";

/** Visual variants for inset center panels (app routes, welcome board, settings, …). */
export type CenterPanelVariant = "app" | "welcome" | "settings";

const variantClass: Record<CenterPanelVariant, string> = {
	app: "center-panel-app",
	welcome: "center-panel-welcome",
	settings: "center-panel-settings",
};

/**
 * Shared inset center panel: sidebar-colored outer frame with a bordered inner
 * surface. Used by the shell's app routes (kanban board, session views), the
 * welcome board, and the settings page. Chrome lives in `styles.css`
 * (`center-panel-*` utilities).
 */
export function CenterPanelShell({ variant, children }: { variant: CenterPanelVariant; children: ReactNode }) {
	return (
		<div className="center-panel-shell">
			<div className={variantClass[variant]}>{children}</div>
		</div>
	);
}
