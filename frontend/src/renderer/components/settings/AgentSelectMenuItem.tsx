import { Check, TriangleAlert } from "lucide-react";
import type { AgentStatusTone } from "../../lib/agent-select-options";
import { cn } from "../../lib/utils";
import { AgentAvatar } from "../AgentAvatar";

const STATUS_TONE_CLASS: Record<AgentStatusTone, string> = {
	success: "text-success",
	warning: "text-warning",
	muted: "text-settings-muted",
};

export function AgentSelectMenuItem({
	agentId,
	label,
	selected,
	status,
	statusTone,
	warning = false,
	disabled = false,
}: {
	agentId?: string;
	label: string;
	selected: boolean;
	status?: string;
	statusTone?: AgentStatusTone;
	warning?: boolean;
	disabled?: boolean;
}) {
	return (
		<span className={cn("flex min-w-0 w-full items-center gap-2", disabled && "opacity-45")}>
			{agentId ? (
				<AgentAvatar provider={agentId} className="size-icon-lg" decorative />
			) : (
				<span className="size-icon-lg shrink-0" aria-hidden="true" />
			)}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{status ? (
				<span
					className={cn(
						"inline-flex shrink-0 items-center gap-1 text-caption",
						STATUS_TONE_CLASS[statusTone ?? "muted"],
					)}
				>
					{warning && <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />}
					{status}
				</span>
			) : null}
			{selected ? <Check className="size-3 shrink-0 text-settings-label" aria-hidden="true" /> : null}
		</span>
	);
}
