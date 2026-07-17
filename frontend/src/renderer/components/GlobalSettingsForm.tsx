import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { DashboardSubhead } from "./DashboardSubhead";
import { MigrationSection } from "./MigrationSection";
import { UpdatesSection } from "./UpdatesSection";
import { Button } from "./ui/button";

// App-wide settings, shown from the sidebar when no project is selected. Each
// section is a self-contained card: Updates (auto-update channel, #2207) and
// Migration (re-run the legacy-AO import, #2205). Connect Mobile lives in the
// sidebar Settings menu, not here.
export function GlobalSettingsForm() {
	const navigate = useNavigate();

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead
				title="Global settings"
				subtitle="Settings that apply across all projects"
				actions={
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => navigate({ to: "/" })}
						title="Close settings"
						aria-label="Close settings"
					>
						<X className="size-icon-base" />
					</Button>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto p-4.5">
				<div className="mx-auto flex max-w-2xl flex-col gap-4">
					<UpdatesSection />
					<MigrationSection />
				</div>
			</div>
		</div>
	);
}
