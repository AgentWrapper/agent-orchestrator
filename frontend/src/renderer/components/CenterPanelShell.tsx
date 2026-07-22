import type { ReactNode } from "react";

/**
 * Shared inset center panel: sidebar-colored outer frame with a bordered inner
 * surface. Used by the shell's app routes (kanban / session), the welcome board,
 * and settings. Chrome lives in `styles.css` (`center-panel-shell` +
 * `center-panel-surface`).
 */
export function CenterPanelShell({
	className,
	children,
}: {
	/** Extra classes on the outer frame. */
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={className ? `center-panel-shell ${className}` : "center-panel-shell"}>
			<div className="center-panel-surface">{children}</div>
		</div>
	);
}
