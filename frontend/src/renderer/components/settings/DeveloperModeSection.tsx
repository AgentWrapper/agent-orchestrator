import { Wrench } from "lucide-react";
import { useUiStore } from "../../stores/ui-store";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

// Single opt-in toggle that reveals developer-only surfaces (currently the
// Feature Releases update channel). Persisted via the ui-store, defaults off.
export function DeveloperModeSection() {
	const developerMode = useUiStore((state) => state.developerMode);
	const setDeveloperMode = useUiStore((state) => state.setDeveloperMode);

	return (
		<SettingsSection title="Developer Mode" sectionId="developer-mode">
			<SettingsRow icon={Wrench} label="Developer Mode">
				<Switch aria-label="Developer Mode" checked={developerMode} onCheckedChange={setDeveloperMode} />
			</SettingsRow>
		</SettingsSection>
	);
}
