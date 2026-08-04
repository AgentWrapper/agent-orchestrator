import { Monitor, Moon, Smartphone, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ThemePreference } from "../../lib/theme";
import { useUiStore } from "../../stores/ui-store";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { SettingsLinkRow, SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function GeneralSettingsSection({
	onConnectMobile,
	titleHidden,
}: {
	onConnectMobile: () => void;
	titleHidden?: boolean;
}) {
	const { t } = useTranslation();
	const themePreference = useUiStore((state) => state.themePreference);
	const setThemePreference = useUiStore((state) => state.setThemePreference);

	const modeOptions = [
		{ value: "light", label: t("settings.theme.light"), icon: <Sun className="size-icon-lg" aria-hidden="true" /> },
		{ value: "dark", label: t("settings.theme.dark"), icon: <Moon className="size-icon-lg" aria-hidden="true" /> },
		{ value: "system", label: t("settings.theme.system"), icon: <Monitor className="size-icon-lg" aria-hidden="true" /> },
	] satisfies SettingsOption<ThemePreference>[];

	return (
		<SettingsSection title={t("settings.general")} titleHidden={titleHidden}>
			<SettingsRow icon={Moon} label={t("settings.theme")}>
				<SettingsOptionMenu
					aria-label={t("settings.theme")}
					value={themePreference}
					options={modeOptions}
					onChange={setThemePreference}
				/>
			</SettingsRow>
			<SettingsLinkRow icon={Smartphone} label={t("settings.connectMobile")} onClick={onConnectMobile} />
		</SettingsSection>
	);
}
