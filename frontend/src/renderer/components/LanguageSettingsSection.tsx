import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { localePreferences, type LocalePreference, type LocaleSnapshot } from "../../shared/locale";
import { applyLocaleSnapshot, resolveNavigatorLocaleSnapshot } from "../i18n";
import { aoBridge } from "../lib/bridge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const languageTitleId = "language-settings-title";

export function LanguageSettingsSection() {
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<LocaleSnapshot | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);

	useEffect(() => {
		let active = true;
		void aoBridge.locale
			.get()
			.catch(() => resolveNavigatorLocaleSnapshot())
			.then((loaded) => {
				if (active) setSnapshot(loaded);
			});
		return () => {
			active = false;
		};
	}, []);

	const selectLanguage = async (preference: LocalePreference) => {
		setSaving(true);
		setSaveFailed(false);
		try {
			const next = await aoBridge.locale.set(preference);
			await applyLocaleSnapshot(next);
			setSnapshot(next);
		} catch {
			setSaveFailed(true);
		} finally {
			setSaving(false);
		}
	};

	const languageName = (locale: LocaleSnapshot["effectiveLocale"]) =>
		locale === "zh-CN" ? t("settings.language.simplifiedChinese") : t("settings.language.english");

	return (
		<Card>
			<CardHeader>
				<CardTitle id={languageTitleId} className="text-control">
					{t("settings.language.title")}
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{snapshot ? (
					<Select
						value={snapshot.preference}
						onValueChange={(value) => void selectLanguage(value as LocalePreference)}
						disabled={saving}
					>
						<SelectTrigger aria-labelledby={languageTitleId} className="h-control-form w-full text-control">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{localePreferences.map((preference) => (
								<SelectItem key={preference} value={preference}>
									{preference === "system"
										? t("settings.language.system")
										: preference === "en"
											? t("settings.language.english")
											: t("settings.language.simplifiedChinese")}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : (
					<div className="flex h-control-form items-center">
						<Loader2 aria-hidden="true" className="size-icon-base animate-spin text-muted-foreground" />
					</div>
				)}

				{snapshot?.preference === "system" && (
					<p className="text-xs text-muted-foreground">
						{t("settings.language.effective", { language: languageName(snapshot.effectiveLocale) })}
					</p>
				)}
				{saveFailed && (
					<p role="alert" className="text-xs text-error">
						{t("settings.language.saveFailed")}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
