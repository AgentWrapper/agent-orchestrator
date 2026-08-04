import { Beaker, Dice5, PaintBucket } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../stores/ui-store";
import { IS_DEV } from "../../lib/is-dev";
import { Input } from "../ui/input";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

/** Dev-only settings for controlling board fixtures and UI test data. */
export function DevSettingsSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const devSettings = useUiStore((state) => state.devSettings);
	const setDevSettings = useUiStore((state) => state.setDevSettings);

	if (!IS_DEV) return null;

	return (
		<SettingsSection title={t("settings.dev.title")} sectionId="dev-settings" titleHidden={titleHidden}>
			<SettingsRow icon={Dice5} label={t("settings.dev.fixtureSessionsLabel")}>
				<Input
					type="number"
					min={0}
					max={20}
					value={devSettings.fixtureCount}
					onChange={(e) =>
						setDevSettings({
							...devSettings,
							fixtureCount: Math.max(0, Math.min(20, Number(e.target.value) || 0)),
						})
					}
					aria-label={t("settings.dev.fixtureCountAria")}
					className="w-20 text-right tabular-nums"
				/>
			</SettingsRow>
			<SettingsRow icon={PaintBucket} label={t("settings.dev.activitySpreadLabel")}>
				<Input
					type="number"
					min={5}
					max={480}
					step={5}
					value={devSettings.randomSpreadMinutes}
					onChange={(e) =>
						setDevSettings({
							...devSettings,
							randomSpreadMinutes: Math.max(5, Math.min(480, Number(e.target.value) || 5)),
						})
					}
					aria-label={t("settings.dev.activitySpreadAria")}
					className="w-20 text-right tabular-nums"
				/>
			</SettingsRow>
			<SettingsRow icon={Beaker} label={t("settings.dev.resetDefaultsLabel")}>
				<button
					type="button"
					className="rounded-md border border-input bg-transparent px-3 py-1 text-xs font-medium text-foreground hover:bg-interactive-hover transition-colors"
					onClick={() => {
						setDevSettings({ fixtureCount: 8, randomSpreadMinutes: 120 });
						window.location.reload();
					}}
				>
					{t("settings.dev.resetReload")}
				</button>
			</SettingsRow>
		</SettingsSection>
	);
}
