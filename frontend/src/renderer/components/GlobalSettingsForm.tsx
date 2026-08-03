import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Keyboard, Mail } from "lucide-react";
import { ConnectMobileModal } from "./ConnectMobileModal";
import { DeveloperModeSection } from "./settings/DeveloperModeSection";
import { GeneralSettingsSection } from "./settings/GeneralSettingsSection";
import { ReportProblemDialog } from "./settings/ReportProblemDialog";
import { SettingsLinkRow } from "./settings/SettingsRow";
import { SettingsPageShell } from "./settings/SettingsPageShell";
import { SettingsPanel } from "./settings/SettingsPanel";
import { SettingsSection } from "./settings/SettingsSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import { KeyboardShortcutsSettingsDialog } from "./settings/KeyboardShortcutsSettingsDialog";

export function GlobalSettingsForm() {
	const navigate = useNavigate();
	const { t } = useTranslation();
	const [mobileOpen, setMobileOpen] = useState(false);
	const [reportProblemOpen, setReportProblemOpen] = useState(false);
	const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);

	return (
		<>
			<SettingsPageShell>
				<SettingsPanel onClose={() => navigate({ to: "/" })}>
					<GeneralSettingsSection onConnectMobile={() => setMobileOpen(true)} />
					<SettingsSection title={t("settings.preferences")}>
						<SettingsLinkRow
							icon={Keyboard}
							label={t("settings.keyboardShortcuts")}
							onClick={() => setKeyboardShortcutsOpen(true)}
						/>
					</SettingsSection>
					<UpdatesSection />
					<DeveloperModeSection />
					<SettingsSection title={t("settings.getHelp")}>
						<SettingsLinkRow
							icon={Mail}
							label={t("settings.reportProblem")}
							onClick={() => setReportProblemOpen(true)}
						/>
					</SettingsSection>
				</SettingsPanel>
			</SettingsPageShell>
			<ConnectMobileModal open={mobileOpen} onOpenChange={setMobileOpen} />
			<ReportProblemDialog open={reportProblemOpen} onOpenChange={setReportProblemOpen} />
			<KeyboardShortcutsSettingsDialog
				open={keyboardShortcutsOpen}
				onOpenChange={setKeyboardShortcutsOpen}
			/>
		</>
	);
}
