import { DashboardSubhead } from "./DashboardSubhead";
import { MigrationSection } from "./MigrationSection";
import { UpdatesSection } from "./UpdatesSection";

// App-wide settings, shown from the sidebar when no project is selected. Each
// section is a self-contained card: Updates (auto-update channel, #2207) and
// Migration (re-run the legacy-AO import, #2205).
export function GlobalSettingsForm() {
	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead title="Global settings" subtitle="Settings that apply across all projects" />
			<div className="min-h-0 flex-1 overflow-y-auto p-[18px]">
				<div className="mx-auto flex max-w-2xl flex-col gap-4">
					<UpdatesSection />
					<MigrationSection />
				</div>
			</div>
		</div>
	);
}
