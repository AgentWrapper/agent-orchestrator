import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Mail } from "lucide-react";
import { ConnectMobileModal } from "./ConnectMobileModal";
import { GeneralSettingsSection } from "./settings/GeneralSettingsSection";
import { ReportProblemDialog } from "./settings/ReportProblemDialog";
import { SettingsLinkRow } from "./settings/SettingsRow";
import { SettingsPageShell } from "./settings/SettingsPageShell";
import { SettingsPanel } from "./settings/SettingsPanel";
import { SettingsSection } from "./settings/SettingsSection";
import { UpdatesSection } from "./settings/UpdatesSection";

export function GlobalSettingsForm() {
	const navigate = useNavigate();
	const [mobileOpen, setMobileOpen] = useState(false);
	const [reportProblemOpen, setReportProblemOpen] = useState(false);

	return (
		<>
			<SettingsPageShell>
				<SettingsPanel onClose={() => navigate({ to: "/" })}>
					<GeneralSettingsSection onConnectMobile={() => setMobileOpen(true)} />
					<UpdatesSection />
					<SettingsSection title="Get help">
						<SettingsLinkRow icon={Mail} label="Report a problem" onClick={() => setReportProblemOpen(true)} />
					</SettingsSection>
				</SettingsPanel>
			</SettingsPageShell>
			<ConnectMobileModal open={mobileOpen} onOpenChange={setMobileOpen} />
			<ReportProblemDialog open={reportProblemOpen} onOpenChange={setReportProblemOpen} />
		</>
	);
}
