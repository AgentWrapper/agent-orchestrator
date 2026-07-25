import type { ReactNode } from "react";
import { CenterPanelShell } from "../CenterPanelShell";

/** Outer settings frame — same center-panel insets as board/session. */
export function SettingsPageShell({ children }: { children: ReactNode }) {
	return <CenterPanelShell>{children}</CenterPanelShell>;
}
