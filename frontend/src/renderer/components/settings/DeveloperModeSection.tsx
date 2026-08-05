import { Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../stores/ui-store";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

// Single opt-in toggle that reveals developer-only surfaces (currently the
// Feature Releases update channel). Persisted via the ui-store, defaults off.
export function DeveloperModeSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const developerMode = useUiStore((state) => state.developerMode);
	const setDeveloperMode = useUiStore((state) => state.setDeveloperMode);

	return (
		<SettingsSection title={t("settings.developerMode")} sectionId="developer-mode" titleHidden={titleHidden}>
			<SettingsRow icon={Wrench} label={t("settings.developerMode")}>
				<Switch aria-label={t("settings.developerMode")} checked={developerMode} onCheckedChange={setDeveloperMode} />
			</SettingsRow>
		</SettingsSection>
	);
}
