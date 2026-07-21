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
export function CenterPanelShell({
	variant,
	className,
	children,
}: {
	variant: CenterPanelVariant;
	/** Extra classes on the outer frame (e.g. the macOS top inset). */
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={className ? `center-panel-shell ${className}` : "center-panel-shell"}>
			<div className={variantClass[variant]}>{children}</div>
		</div>
	);
}
