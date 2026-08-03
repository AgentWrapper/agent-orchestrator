import { Bot, CircleHelp, GitBranch, Inbox, MonitorCog, RefreshCw, Settings2, Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";
import { GlobalSettingsForm, type GlobalSettingsSection } from "./GlobalSettingsForm";
import { ProjectSettingsForm, type ProjectSettingsSection } from "./ProjectSettingsForm";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	settingsDialogBodyClass,
	settingsDialogContentClass,
	settingsDialogHeaderClass,
} from "./ui/dialog";
import { type SettingsModal, useUiStore } from "../stores/ui-store";
import { cn } from "../lib/utils";

const globalSections: Array<{ id: Exclude<GlobalSettingsSection, "all">; label: string; icon: typeof Settings2 }> = [
	{ id: "general", label: "General", icon: Settings2 },
	{ id: "updates", label: "Updates", icon: RefreshCw },
	{ id: "developer", label: "Developer", icon: Wrench },
	{ id: "help", label: "Help", icon: CircleHelp },
];

const projectSections: Array<{ id: ProjectSettingsSection; label: string; icon: typeof Settings2 }> = [
	{ id: "general", label: "General", icon: MonitorCog },
	{ id: "agents", label: "Agents", icon: Bot },
	{ id: "workflow", label: "Workflow", icon: GitBranch },
	{ id: "intake", label: "Intake", icon: Inbox },
];

export function SettingsDialog() {
	const settingsModal = useUiStore((state) => state.settingsModal);
	const closeSettings = useUiStore((state) => state.closeSettings);
	const [displaySettings, setDisplaySettings] = useState<SettingsModal | null>(settingsModal);
	const isProjectSettings = displaySettings?.scope === "project";
	const [activeSection, setActiveSection] = useState<Exclude<GlobalSettingsSection, "all">>("general");
	const [activeProjectSection, setActiveProjectSection] = useState<ProjectSettingsSection>("general");
	const activeLabel = isProjectSettings
		? (projectSections.find((s) => s.id === activeProjectSection)?.label ?? "General")
		: (globalSections.find((section) => section.id === activeSection)?.label ?? "General");

	useEffect(() => {
		if (settingsModal) setDisplaySettings(settingsModal);
		if (settingsModal?.scope === "global") setActiveSection("general");
		if (settingsModal?.scope === "project") setActiveProjectSection("general");
	}, [settingsModal]);

	return (
		<Dialog open={settingsModal !== null} onOpenChange={(open) => !open && closeSettings()}>
			{displaySettings ? (
				<DialogContent
					className={cn(
						settingsDialogContentClass,
						"h-(--size-settings-dialog-height) w-(--size-settings-dialog-wide) max-h-none origin-center overflow-hidden p-0",
					)}
					showCloseButton={false}
				>
					<div className="flex h-full min-h-0">
						{/* Sidebar — same bg as the app sidebar */}
						<aside className="flex w-48 shrink-0 flex-col border-r border-(--color-border-settings-dialog-header) bg-sidebar">
							<p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Settings</p>
							<nav aria-label="Settings sections" className="flex flex-col gap-0.5 p-2 pt-0">
						{isProjectSettings ? (
								projectSections.map(({ id, label, icon }) => (
									<SettingsNavItem
										active={activeProjectSection === id}
										icon={icon}
										key={id}
										label={label}
										onClick={() => setActiveProjectSection(id)}
									/>
								))
							) : (
								globalSections.map(({ id, label, icon }) => (
									<SettingsNavItem
										active={activeSection === id}
										icon={icon}
										key={id}
										label={label}
										onClick={() => setActiveSection(id)}
									/>
								))
							)}
							</nav>
						</aside>

						{/* Main area — same bg as the app page */}
						<div className="flex min-w-0 flex-1 flex-col bg-background">
							<DialogHeader className={cn(settingsDialogHeaderClass, "flex h-14 shrink-0 flex-row items-center justify-between border-b border-(--color-border-settings-dialog-header) px-6")}>
								<DialogTitle className="text-sm font-semibold text-foreground">{activeLabel}</DialogTitle>
								<DialogDescription className="sr-only">
									{isProjectSettings ? "Manage this project's settings." : `Manage ${activeLabel.toLowerCase()} settings.`}
								</DialogDescription>
								<DialogClose
									aria-label="Close settings"
									className="grid size-8 place-items-center rounded-md text-muted-foreground transition-[background-color,color] hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<X aria-hidden="true" className="size-4" />
								</DialogClose>
							</DialogHeader>
							<div className={cn(settingsDialogBodyClass, "flex-1 overflow-y-auto px-6 pt-5")}>
							{displaySettings.scope === "project" ? (
								<ProjectSettingsForm projectId={displaySettings.projectId} section={activeProjectSection} />
							) : (
								<GlobalSettingsForm section={activeSection} />
							)}
							</div>
						</div>
					</div>
				</DialogContent>
			) : null}
		</Dialog>
	);
}

function SettingsNavItem({
	active,
	icon: Icon,
	label,
	onClick,
}: {
	active: boolean;
	icon: typeof Settings2;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium transition-[background-color,color,transform] duration-[100ms] ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				active
					? "bg-interactive-active text-foreground"
					: "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
			)}
			onClick={onClick}
			type="button"
		>
			<Icon aria-hidden="true" className="size-4 shrink-0" />
			{label}
		</button>
	);
}
