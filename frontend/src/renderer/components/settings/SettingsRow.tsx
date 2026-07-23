import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

function SettingsRowLabel({ icon: Icon, label }: { icon?: LucideIcon; label: string }) {
	return (
		<div className="flex shrink-0 items-center gap-(--size-settings-row-icon-gap)">
			{Icon ? <Icon className="size-icon-lg shrink-0 text-settings-muted" aria-hidden="true" /> : null}
			<span className="whitespace-nowrap text-sm leading-5 text-settings-label">{label}</span>
		</div>
	);
}

/** Settings row bar: tokenized height, radius, padding, and icon gap. */
export function SettingsRow({
	icon,
	label,
	children,
	className,
}: {
	icon?: LucideIcon;
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("settings-row-bar", className)}>
			<SettingsRowLabel icon={icon} label={label} />
			<div className="flex min-w-0 flex-1 items-center justify-end">{children}</div>
		</div>
	);
}

export function SettingsLinkRow({ icon, label, onClick }: { icon?: LucideIcon; label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="settings-row-bar w-full text-left transition-colors hover:bg-settings-menu-selected"
		>
			<SettingsRowLabel icon={icon} label={label} />
			<ChevronRight className="size-icon-base shrink-0 text-settings-muted" aria-hidden="true" />
		</button>
	);
}
