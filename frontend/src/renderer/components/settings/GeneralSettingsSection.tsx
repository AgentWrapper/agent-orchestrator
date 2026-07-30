import { Monitor, Moon, Palette, Smartphone, Sun } from "lucide-react";
import type { ThemePreference, ThemeStyle } from "../../lib/theme";
import { useUiStore } from "../../stores/ui-store";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { SettingsLinkRow, SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

const MODE_OPTIONS = [
	{ value: "light", label: "Light", icon: <Sun className="size-icon-lg" aria-hidden="true" /> },
	{ value: "dark", label: "Dark", icon: <Moon className="size-icon-lg" aria-hidden="true" /> },
	{ value: "system", label: "System", icon: <Monitor className="size-icon-lg" aria-hidden="true" /> },
] satisfies SettingsOption<ThemePreference>[];

const THEME_OPTIONS = [
	{ value: "orchestrate", label: "Orchestrate (Default)" },
	{ value: "github", label: "GitHub" },
	{ value: "catppuccin", label: "Catppuccin" },
	{ value: "dracula", label: "Dracula" },
	{ value: "tokyo-night", label: "Tokyo Night" },
	{ value: "rose-pine", label: "Rosé Pine" },
] satisfies SettingsOption<ThemeStyle>[];

export function GeneralSettingsSection({
	onConnectMobile,
	titleHidden,
}: {
	onConnectMobile: () => void;
	titleHidden?: boolean;
}) {
	const themePreference = useUiStore((state) => state.themePreference);
	const setThemePreference = useUiStore((state) => state.setThemePreference);
	const themeStyle = useUiStore((state) => state.themeStyle);
	const setThemeStyle = useUiStore((state) => state.setThemeStyle);

	return (
		<SettingsSection title="General" titleHidden={titleHidden}>
			<SettingsRow icon={Palette} label="Theme">
				<SettingsOptionMenu
					aria-label="Theme"
					value={themeStyle}
					options={THEME_OPTIONS}
					onChange={setThemeStyle}
				/>
			</SettingsRow>
			<SettingsRow icon={Moon} label="Mode">
				<SettingsOptionMenu
					aria-label="Mode"
					value={themePreference}
					options={MODE_OPTIONS}
					onChange={setThemePreference}
				/>
			</SettingsRow>
			<SettingsLinkRow icon={Smartphone} label="Connect Mobile" onClick={onConnectMobile} />
		</SettingsSection>
	);
}
