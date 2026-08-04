import { useState } from "react";
import { Keyboard, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConnectMobileModal } from "./ConnectMobileModal";
import { DeveloperModeSection } from "./settings/DeveloperModeSection";
import { GeneralSettingsSection } from "./settings/GeneralSettingsSection";
import { ReportProblemDialog } from "./settings/ReportProblemDialog";
import { SettingsLinkRow } from "./settings/SettingsRow";
import { SettingsSection } from "./settings/SettingsSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import { DevSettingsSection } from "./settings/DevSettingsSection";
import { KeyboardShortcutsSettingsDialog } from "./settings/KeyboardShortcutsSettingsDialog";

export type GlobalSettingsSection = "general" | "updates" | "developer" | "help" | "all";

export function GlobalSettingsForm({ section = "all" }: { section?: GlobalSettingsSection }) {
	const { t } = useTranslation();
	const [mobileOpen, setMobileOpen] = useState(false);
	const [reportProblemOpen, setReportProblemOpen] = useState(false);
	const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
	// One section per page means the dialog header already names it, so the
	// page's leading heading would just repeat that title.
	const leadingTitleHidden = section !== "all";

	return (
		<>
			<div
				aria-label={t("settings.title")}
				className="flex w-full flex-col gap-(--size-settings-section-gap)"
				data-testid="settings-page"
			>
				{(section === "all" || section === "general") && (
					<>
						<GeneralSettingsSection
							onConnectMobile={() => setMobileOpen(true)}
							titleHidden={leadingTitleHidden}
						/>
						<SettingsSection title={t("settings.preferences")}>
							<SettingsLinkRow
								icon={Keyboard}
								label={t("settings.keyboardShortcuts")}
								onClick={() => setKeyboardShortcutsOpen(true)}
							/>
						</SettingsSection>
					</>
				)}
				{(section === "all" || section === "updates") && <UpdatesSection titleHidden={leadingTitleHidden} />}
				{(section === "all" || section === "developer") && (
					<>
						<DeveloperModeSection titleHidden={leadingTitleHidden} />
						<DevSettingsSection titleHidden={leadingTitleHidden} />
					</>
				)}
				{(section === "all" || section === "help") && (
					<SettingsSection title={t("settings.getHelp")} titleHidden={leadingTitleHidden}>
						<SettingsLinkRow icon={Mail} label={t("settings.reportProblem")} onClick={() => setReportProblemOpen(true)} />
					</SettingsSection>
				)}
			</div>
			<ConnectMobileModal open={mobileOpen} onOpenChange={setMobileOpen} />
			<ReportProblemDialog open={reportProblemOpen} onOpenChange={setReportProblemOpen} />
			<KeyboardShortcutsSettingsDialog
				open={keyboardShortcutsOpen}
				onOpenChange={setKeyboardShortcutsOpen}
			/>
		</>
	);
}
