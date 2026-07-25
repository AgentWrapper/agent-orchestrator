import type { ReactNode } from "react";
import { CenterPanelShell } from "../CenterPanelShell";

/** Outer settings frame — sidebar chrome with the settings inset panel. */
export function SettingsPageShell({ children }: { children: ReactNode }) {
	// Settings keeps its own large centered layout; do not pull the heading into
	// the macOS titlebar band or flush fullscreen margins.
	return <CenterPanelShell titlebarAlign={false}>{children}</CenterPanelShell>;
}
