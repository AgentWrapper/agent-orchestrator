import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Repeat2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	findActiveAgentSwitch,
	findRecoveryRequiredAgentSwitch,
	useAgentSwitches,
} from "../hooks/useAgentSwitches";
import { clearSwitchAgentState, useSwitchAgentState } from "../hooks/useSwitchAgent";
import { agentLabel } from "../lib/agent-options";
import { cn } from "../lib/utils";
import { sessionIsActive, type WorkspaceSession } from "../types/workspace";
import { canSwitchAgentHarness, SwitchAgentDialog } from "./SwitchAgentDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type TerminalSwitchAgentButtonProps = {
	session: WorkspaceSession;
};

export function TerminalSwitchAgentButton({ session }: TerminalSwitchAgentButtonProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const switches = useAgentSwitches(session.id).data ?? [];
	const activeSwitch = findActiveAgentSwitch(switches);
	const recoverySwitch = findRecoveryRequiredAgentSwitch(switches);
	const switchMutation = useSwitchAgentState(session.id);
	const targetHarness = activeSwitch?.targetHarness ?? switchMutation.input?.targetHarness;
	const switching = Boolean(!recoverySwitch && (activeSwitch || (switchMutation.isPending && targetHarness)));

	useEffect(() => {
		if (switchMutation.error) setOpen(true);
	}, [switchMutation.error]);

	if (
		session.kind !== "worker" ||
		session.isTerminated ||
		!canSwitchAgentHarness(session.provider) ||
		(!recoverySwitch && !switching && !sessionIsActive(session))
	) {
		return null;
	}

	const label = recoverySwitch
		? t("switchAgent.recovery.action")
		: switching && targetHarness
			? t("switchAgent.inProgress", { target: agentLabel(targetHarness) })
			: t("switchAgent.action");
	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen && switchMutation.error) {
			clearSwitchAgentState(queryClient, session.id);
		}
	};

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						aria-busy={switching ? true : undefined}
						aria-label={label}
						className={cn(
							"ml-1 grid size-6 shrink-0 place-items-center rounded-full border border-border/70 bg-background/45 text-muted-foreground transition-colors hover:border-border-strong hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50",
							recoverySwitch && "border-warning/50 text-warning hover:border-warning/70 hover:text-warning",
						)}
						onClick={() => setOpen(true)}
						type="button"
					>
						{recoverySwitch ? (
							<TriangleAlert aria-hidden="true" className="size-icon-sm" />
						) : switching ? (
							<LoaderCircle aria-hidden="true" className="size-icon-sm animate-spin" />
						) : (
							<Repeat2 aria-hidden="true" className="size-4 stroke-[1.8]" />
						)}
					</button>
				</TooltipTrigger>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
			{open ? (
				<SwitchAgentDialog onOpenChange={handleOpenChange} open session={session} />
			) : null}
		</>
	);
}
