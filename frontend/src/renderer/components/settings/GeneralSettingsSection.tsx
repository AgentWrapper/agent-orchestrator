import { Languages, Monitor, Moon, Palette, Smartphone, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ThemePreference, ThemeStyle } from "../../lib/theme";
import type { AppLocale } from "../../i18n";
import { useLocaleStore } from "../../stores/locale-store";
import { useUiStore } from "../../stores/ui-store";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { SettingsLinkRow, SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

const COLOR_THEME_OPTIONS = [
	{ value: "orchestrate", label: "Orchestrate" },
	{ value: "github", label: "GitHub" },
	{ value: "catppuccin", label: "Catppuccin" },
	{ value: "dracula", label: "Dracula" },
	{ value: "tokyo-night", label: "Tokyo Night" },
	{ value: "rose-pine", label: "Rosé Pine" },
	{ value: "nord", label: "Nord" },
	{ value: "gruvbox", label: "Gruvbox" },
	{ value: "solarized", label: "Solarized" },
] satisfies SettingsOption<ThemeStyle>[];

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
	const themeStyle = useUiStore((state) => state.themeStyle);
	const setThemeStyle = useUiStore((state) => state.setThemeStyle);
	const locale = useLocaleStore((state) => state.locale);
	const setLocale = useLocaleStore((state) => state.setLocale);
	const localeSaving = useLocaleStore((state) => state.saving);
	const localeSaveError = useLocaleStore((state) => state.saveError);

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
		{ value: "ja", label: t("settings.language.ja") },
		{ value: "ko", label: t("settings.language.ko") },
		{ value: "es", label: t("settings.language.es") },
		{ value: "fr", label: t("settings.language.fr") },
		{ value: "de", label: t("settings.language.de") },
		{ value: "pt-BR", label: t("settings.language.ptBR") },
	] satisfies SettingsOption<AppLocale>[];

	return (
		<SettingsSection title={t("settings.general")} titleHidden={titleHidden}>
			<SettingsRow icon={Palette} label={t("settings.colorTheme")}>
				<SettingsOptionMenu
					aria-label={t("settings.colorTheme")}
					value={themeStyle}
					options={COLOR_THEME_OPTIONS}
					onChange={setThemeStyle}
				/>
			</SettingsRow>
			<SettingsRow icon={Moon} label={t("settings.theme")}>
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
					disabled={localeSaving}
					value={locale}
					options={languageOptions}
					onChange={(next) => {
						void setLocale(next);
					}}
				/>
			</SettingsRow>
			{localeSaveError ? (
				<p role="alert" className="px-3 text-caption leading-4 text-error">
					{t("settings.language.saveFailed")}
				</p>
			) : null}
			<SettingsLinkRow icon={Smartphone} label={t("settings.connectMobile")} onClick={onConnectMobile} />
		</SettingsSection>
	);
}
