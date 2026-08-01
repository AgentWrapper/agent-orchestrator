import { MessageSquare, Monitor, Moon, Palette, Smartphone, SquareTerminal, Sun } from "lucide-react";
import type { ThemePreference } from "../../lib/theme";
import { useUiStore } from "../../stores/ui-store";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { SettingsLinkRow, SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { cn } from "../../lib/utils";
import { useSettings, useUpdateSessionInterface } from "../../hooks/useSettings";
import type { SessionMode } from "../../types/workspace";

const THEME_OPTIONS = [
	{ value: "light", label: "Light", icon: <Sun className="size-icon-lg" aria-hidden="true" /> },
	{ value: "dark", label: "Dark", icon: <Moon className="size-icon-lg" aria-hidden="true" /> },
	{ value: "system", label: "System", icon: <Monitor className="size-icon-lg" aria-hidden="true" /> },
] satisfies SettingsOption<ThemePreference>[];

const INTERFACE_OPTIONS = [
	{
		value: "tui",
		label: "Terminal",
		icon: <SquareTerminal className="size-icon-lg" aria-hidden="true" />,
	},
	{
		value: "chat",
		label: "Chat",
		icon: <MessageSquare className="size-icon-lg" aria-hidden="true" />,
	},
] satisfies SettingsOption<SessionMode>[];

/**
 * The default interface for new sessions.
 *
 * Daemon-owned, so `ao spawn` and mobile resolve the same value. Two things this
 * control must be honest about: it only affects sessions created afterwards —
 * a session's interface is fixed when it is born — and chat is limited to the
 * agents that have a structured driver today.
 */
function SessionInterfaceRow() {
	const { settings, isLoading, error } = useSettings();
	const { update, saving, error: saveError } = useUpdateSessionInterface();

	const chatAvailable = (settings?.chatHarnesses.length ?? 0) > 0;
	const help = !chatAvailable
		? "Applies to new sessions. No installed agent supports chat yet."
		: `Applies to new sessions. Chat currently supports ${settings?.chatHarnesses.join(", ")}.`;

	const note = saveError ?? error ?? help;

	return (
		<div className="flex flex-col">
			<SettingsRow icon={MessageSquare} label="Default session interface">
				<SettingsOptionMenu
					aria-label="Default session interface"
					value={settings?.defaultSessionMode ?? "tui"}
					options={INTERFACE_OPTIONS}
					onChange={(mode) => update(mode)}
					disabled={isLoading || saving || !chatAvailable}
				/>
			</SettingsRow>
			{/* Stated rather than implied: this changes what NEW sessions get. An
			    existing session's interface is fixed when it is created, so nothing
			    here can move a session that already exists. */}
			<p
				className={cn(
					"px-2 pb-2 text-xs leading-relaxed",
					saveError || error ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{note}
			</p>
		</div>
	);
}

export function GeneralSettingsSection({ onConnectMobile }: { onConnectMobile: () => void }) {
	const themePreference = useUiStore((state) => state.themePreference);
	const setThemePreference = useUiStore((state) => state.setThemePreference);

	return (
		<SettingsSection title="General">
			<SettingsRow icon={Palette} label="Theme">
				<SettingsOptionMenu
					aria-label="Theme"
					value={themePreference}
					options={THEME_OPTIONS}
					onChange={setThemePreference}
				/>
			</SettingsRow>
			<SessionInterfaceRow />
			<SettingsLinkRow icon={Smartphone} label="Connect Mobile" onClick={onConnectMobile} />
		</SettingsSection>
	);
}
