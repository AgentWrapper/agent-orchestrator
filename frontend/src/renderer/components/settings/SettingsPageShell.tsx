import type { ReactNode } from "react";
import { CenterPanelShell } from "../CenterPanelShell";

/** Outer settings frame — chrome matches sidebar; inset panel is #101013. */
export function SettingsPageShell({ children }: { children: ReactNode }) {
	return <CenterPanelShell variant="settings">{children}</CenterPanelShell>;
}
