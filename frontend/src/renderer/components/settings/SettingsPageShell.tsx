import type { ReactNode } from "react";
import { CenterPanelShell } from "../CenterPanelShell";

/** Outer settings frame — sidebar chrome with the settings inset panel. */
export function SettingsPageShell({ children }: { children: ReactNode }) {
	return <CenterPanelShell variant="settings">{children}</CenterPanelShell>;
}
