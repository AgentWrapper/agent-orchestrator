import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GeneralSettingsSection } from "./settings/GeneralSettingsSection";
import { ReportProblemDialog } from "./settings/ReportProblemDialog";
import { SettingsLinkRow } from "./settings/SettingsRow";
import { SettingsSection } from "./settings/SettingsSection";
import { UpdatesSection } from "./settings/UpdatesSection";

export type GlobalSettingsSection = "general" | "updates" | "help" | "all";

export function GlobalSettingsForm({
	section = "all",
	onOpenKeyboardShortcuts,
	onOpenConnectMobile,
}: {
	section?: GlobalSettingsSection;
	onOpenKeyboardShortcuts?: () => void;
	onOpenConnectMobile?: () => void;
}) {
	const { t } = useTranslation();
	const [reportProblemOpen, setReportProblemOpen] = useState(false);
	// The dialog header names the active page, so never repeat that title as the
	// first group heading.
	const leadingTitleHidden = true;

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
							onConnectMobile={() => onOpenConnectMobile?.()}
							titleHidden={leadingTitleHidden}
						/>
						<SettingsSection title={t("settings.preferences")} grouped>
							<SettingsLinkRow
								label={t("settings.keyboardShortcuts")}
								onClick={() => onOpenKeyboardShortcuts?.()}
							/>
						</SettingsSection>
					</>
				)}
				{(section === "all" || section === "updates") && <UpdatesSection titleHidden={leadingTitleHidden} />}
				{(section === "all" || section === "help") && (
					<SettingsSection title={t("settings.getHelp")} titleHidden={leadingTitleHidden} grouped>
						<SettingsLinkRow label={t("settings.reportProblem")} onClick={() => setReportProblemOpen(true)} />
					</SettingsSection>
				)}
			</div>
			<ReportProblemDialog open={reportProblemOpen} onOpenChange={setReportProblemOpen} />
		</>
	);
}
