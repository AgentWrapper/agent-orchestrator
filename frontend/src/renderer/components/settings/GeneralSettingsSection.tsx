import { Languages, Monitor, Moon, Palette, Smartphone, Sun } from "lucide-react";
import type { ThemePreference } from "../../lib/theme";
import type { AppLocale } from "../../i18n";
import { useLocaleStore, useT } from "../../stores/locale-store";
import { useUiStore } from "../../stores/ui-store";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { SettingsLinkRow, SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function GeneralSettingsSection({ onConnectMobile }: { onConnectMobile: () => void }) {
	const t = useT();
	const themePreference = useUiStore((state) => state.themePreference);
	const setThemePreference = useUiStore((state) => state.setThemePreference);
	const locale = useLocaleStore((state) => state.locale);
	const setLocale = useLocaleStore((state) => state.setLocale);

	const themeOptions = [
		{ value: "light", label: t("settings.theme.light"), icon: <Sun className="size-icon-lg" aria-hidden="true" /> },
		{ value: "dark", label: t("settings.theme.dark"), icon: <Moon className="size-icon-lg" aria-hidden="true" /> },
		{
			value: "system",
			label: t("settings.theme.system"),
			icon: <Monitor className="size-icon-lg" aria-hidden="true" />,
		},
	] satisfies SettingsOption<ThemePreference>[];

	const languageOptions = [
		{ value: "en", label: t("settings.language.en") },
		{ value: "zh-CN", label: t("settings.language.zhCN") },
	] satisfies SettingsOption<AppLocale>[];

	return (
		<SettingsSection title={t("settings.general")}>
			<SettingsRow icon={Palette} label={t("settings.theme")}>
				<SettingsOptionMenu
					aria-label={t("settings.theme")}
					value={themePreference}
					options={themeOptions}
					onChange={setThemePreference}
				/>
			</SettingsRow>
			<SettingsRow icon={Languages} label={t("settings.language")}>
				<SettingsOptionMenu
					aria-label={t("settings.language")}
					value={locale}
					options={languageOptions}
					onChange={(next) => {
						void setLocale(next);
					}}
				/>
			</SettingsRow>
			<SettingsLinkRow icon={Smartphone} label={t("settings.connectMobile")} onClick={onConnectMobile} />
		</SettingsSection>
	);
}
