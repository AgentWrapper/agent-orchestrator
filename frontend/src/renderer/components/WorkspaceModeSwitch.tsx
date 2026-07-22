import { Cloud, HardDrive } from "lucide-react";
import { cn } from "../lib/utils";

export type WorkspaceMode = "local" | "cloud";

export function WorkspaceModeSwitch({
	mode,
	onChange,
}: {
	mode: WorkspaceMode;
	onChange: (mode: WorkspaceMode) => void;
}) {
	return (
		<div
			aria-label="Workspace mode"
			className="mx-1 mb-3 grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 group-data-[collapsible=icon]:mx-0 group-data-[collapsible=icon]:grid-cols-1"
			role="tablist"
		>
			<ModeButton active={mode === "local"} icon={HardDrive} label="Local" onClick={() => onChange("local")} />
			<ModeButton active={mode === "cloud"} icon={Cloud} label="Cloud" onClick={() => onChange("cloud")} />
		</div>
	);
}

function ModeButton({
	active,
	icon: Icon,
	label,
	onClick,
}: {
	active: boolean;
	icon: typeof HardDrive;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-selected={active}
			className={cn(
				"flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:px-0",
				active ? "bg-background text-foreground shadow-sm" : "text-passive hover:text-foreground",
			)}
			onClick={onClick}
			role="tab"
			type="button"
		>
			<Icon aria-hidden="true" className="size-3.5" />
			<span className="group-data-[collapsible=icon]:sr-only">{label}</span>
		</button>
	);
}
