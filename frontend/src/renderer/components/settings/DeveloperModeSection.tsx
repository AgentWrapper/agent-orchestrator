import { Cloud, KeyRound, Link, Mail, Shield, Tag, Wrench } from "lucide-react";
import { useState } from "react";
import { prepareCloudDevSettings } from "../../lib/cloud-dev";
import { useUiStore } from "../../stores/ui-store";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

// Single opt-in toggle that reveals developer-only surfaces (currently the
// Feature Releases update channel). Persisted via the ui-store, defaults off.
export function DeveloperModeSection() {
	const developerMode = useUiStore((state) => state.developerMode);
	const setDeveloperMode = useUiStore((state) => state.setDeveloperMode);
	const cloudDev = useUiStore((state) => state.cloudDev);
	const setCloudDev = useUiStore((state) => state.setCloudDev);
	const [cloudStatus, setCloudStatus] = useState<string | null>(null);
	const [cloudError, setCloudError] = useState<string | null>(null);
	const [preparingCloud, setPreparingCloud] = useState(false);

	const prepareCloud = async () => {
		setPreparingCloud(true);
		setCloudStatus(null);
		setCloudError(null);
		try {
			const next = await prepareCloudDevSettings(cloudDev, {
				forceToken: Boolean(cloudDev.accessToken.trim() && cloudDev.orgId.trim()),
			});
			setCloudDev(next);
			setCloudStatus("Cloud project ready.");
		} catch (error) {
			setCloudError(error instanceof Error ? error.message : "Could not prepare AO Cloud.");
		} finally {
			setPreparingCloud(false);
		}
	};

	return (
		<SettingsSection title="Developer Mode" sectionId="developer-mode">
			<SettingsRow icon={Wrench} label="Developer Mode">
				<Switch aria-label="Developer Mode" checked={developerMode} onCheckedChange={setDeveloperMode} />
			</SettingsRow>
			{developerMode && (
				<>
					<SettingsRow icon={Cloud} label="AO Cloud tasks">
						<Switch
							aria-label="AO Cloud tasks"
							checked={cloudDev.enabled}
							onCheckedChange={(enabled) => setCloudDev({ enabled })}
						/>
					</SettingsRow>
					<CloudInputRow
						icon={Link}
						label="AO Cloud URL"
						value={cloudDev.apiBaseUrl}
						onChange={(apiBaseUrl) => setCloudDev({ apiBaseUrl })}
					/>
					<CloudInputRow
						icon={Mail}
						label="Dev auth email"
						value={cloudDev.devAuthEmail}
						onChange={(devAuthEmail) => setCloudDev({ devAuthEmail })}
					/>
					<CloudInputRow
						icon={KeyRound}
						label="Org ID"
						value={cloudDev.orgId}
						onChange={(orgId) => setCloudDev({ orgId })}
					/>
					<CloudInputRow
						icon={Tag}
						label="Project ID"
						value={cloudDev.projectId}
						onChange={(projectId) => setCloudDev({ projectId })}
					/>
					<CloudInputRow
						icon={Link}
						label="Repo URL"
						value={cloudDev.repoUrl}
						onChange={(repoUrl) => setCloudDev({ repoUrl })}
					/>
					<CloudInputRow
						icon={Shield}
						label="Permissions"
						value={cloudDev.permissions}
						onChange={(permissions) => setCloudDev({ permissions })}
					/>
					<SettingsRow icon={Cloud} label="Setup cloud">
						<button
							type="button"
							className="settings-option-trigger disabled:pointer-events-none disabled:opacity-50"
							disabled={preparingCloud}
							onClick={() => void prepareCloud()}
						>
							{preparingCloud ? "Preparing…" : "Connect & register"}
						</button>
					</SettingsRow>
					{cloudStatus && <p className="px-1 text-xs leading-row text-success">{cloudStatus}</p>}
					{cloudError && <p className="px-1 text-xs leading-row text-error">{cloudError}</p>}
				</>
			)}
		</SettingsSection>
	);
}

function CloudInputRow({
	icon,
	label,
	value,
	onChange,
}: {
	icon: typeof Cloud;
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<SettingsRow icon={icon} label={label}>
			<input
				aria-label={label}
				className="settings-inline-input"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		</SettingsRow>
	);
}
