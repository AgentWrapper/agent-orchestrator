import { ArrowRightLeft, Loader2, MessageSquare, Monitor, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import type {
	SessionInterfaceMode,
	SessionInterfaceTransition,
	SessionInterfaceTransitionPolicy,
} from "../hooks/useSessionInterfaceTransition";
import { interfaceTransitionIsCancellable } from "../hooks/useSessionInterfaceTransition";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";

function targetLabel(target: SessionInterfaceMode): string {
	return target === "chat" ? "Chat" : "Terminal UI";
}

function TargetIcon({ target, className }: { target: SessionInterfaceMode; className?: string }) {
	const Icon = target === "chat" ? MessageSquare : Monitor;
	return <Icon aria-hidden="true" className={className} />;
}

export function SessionInterfaceSwitchButton({
	target,
	supported,
	disabledReason,
	pending,
	onClick,
	className,
}: {
	target: SessionInterfaceMode;
	supported: boolean;
	disabledReason?: string;
	pending?: boolean;
	onClick: () => void;
	className?: string;
}) {
	const label = `Open ${targetLabel(target)}`;
	return (
		<Button
			type="button"
			size="sm"
			variant="ghost"
			className={cn("h-7 gap-1.5 px-2 text-xs text-muted-foreground", className)}
			disabled={!supported || pending}
			onClick={onClick}
			title={supported ? `${label} using this agent's native conversation` : disabledReason}
		>
			{pending ? (
				<Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
			) : (
				<TargetIcon target={target} className="size-3.5" />
			)}
			<span>{pending ? "Switching…" : label}</span>
		</Button>
	);
}

export function SessionInterfaceSwitchDialog({
	open,
	target,
	waitingForInput,
	busy,
	error,
	onOpenChange,
	onChoose,
}: {
	open: boolean;
	target: SessionInterfaceMode;
	waitingForInput?: boolean;
	busy?: boolean;
	error?: string;
	onOpenChange: (open: boolean) => void;
	onChoose: (policy: SessionInterfaceTransitionPolicy) => void;
}) {
	const targetName = targetLabel(target);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md gap-0 overflow-hidden rounded-xl border-border bg-popover p-0">
				<DialogHeader className="border-b border-border px-5 py-4">
					<DialogTitle className="flex items-center gap-2 text-sm">
						<ArrowRightLeft aria-hidden="true" className="size-4 text-muted-foreground" />
						Switch to {targetName}?
					</DialogTitle>
					<DialogDescription className="pt-1 text-xs leading-5">
						The same AO session, worktree, and agent-native conversation continue in the other interface.
						Completed messages and tool work stay in the agent's context.
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-2 px-5 py-4">
					<button
						type="button"
						className="rounded-lg border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-border-strong hover:bg-muted disabled:opacity-50"
						disabled={busy}
						onClick={() => onChoose("drain")}
					>
						<strong className="block text-sm font-medium text-foreground">Finish work, then switch</strong>
						<span className="mt-1 block text-xs leading-5 text-muted-foreground">
							Wait for the running turn and anything already queued to finish. New AO messages wait safely
							for {targetName}.
						</span>
					</button>
					<button
						type="button"
						className="rounded-lg border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-warning/60 hover:bg-muted disabled:opacity-50"
						disabled={busy}
						onClick={() => onChoose("interrupt")}
					>
						<strong className="block text-sm font-medium text-foreground">Stop now and switch</strong>
						<span className="mt-1 block text-xs leading-5 text-muted-foreground">
							Cancel the running turn before switching. Files already changed remain in the worktree, but
							unfinished output and queued Chat turns are cancelled.
						</span>
					</button>
					{waitingForInput ? (
						<p className="text-[11px] leading-4 text-warning">
							This turn is waiting for your input. “Finish work” will wait until you answer it; use “Stop
							now” to switch immediately.
						</p>
					) : null}
					{error ? (
						<p role="alert" className="text-xs leading-5 text-destructive">
							{error}
						</p>
					) : null}
				</div>

				<DialogFooter className="border-t border-border px-5 py-3">
					<Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
						Keep current interface
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

const phaseCopy: Record<SessionInterfaceTransition["phase"], string> = {
	requested: "Preparing the switch…",
	preflighting: "Checking the other interface…",
	draining: "Waiting for the current work to finish…",
	source_stopping: "Stopping the current controller…",
	source_stopped: "Current controller stopped…",
	target_starting: "Resuming the agent in the other interface…",
	activating: "Activating the new interface…",
	completed: "Interface switched",
	failed: "Interface switch failed",
	cancelled: "Interface switch cancelled",
	recovery_required: "Interface switch needs recovery",
};

export function SessionInterfaceTransitionOverlay({
	transition,
	cancelling,
	cancelError,
	onCancel,
}: {
	transition?: SessionInterfaceTransition;
	cancelling?: boolean;
	cancelError?: string;
	onCancel: () => void;
}) {
	if (!transition || ![
		"requested",
		"preflighting",
		"draining",
		"source_stopping",
		"source_stopped",
		"target_starting",
		"activating",
	].includes(transition.phase)) {
		return null;
	}
	const cancellable = interfaceTransitionIsCancellable(transition);
	return (
		<div className="absolute inset-0 z-30 grid place-items-center bg-background/80 px-5 backdrop-blur-[2px]">
			<div
				role="status"
				aria-live="polite"
				className="flex w-full max-w-sm flex-col items-center rounded-xl border border-border bg-popover px-5 py-6 text-center shadow-lg"
			>
				<div className="mb-3 grid size-9 place-items-center rounded-full bg-muted">
					<Loader2 aria-hidden="true" className="size-4 animate-spin text-foreground" />
				</div>
				<strong className="text-sm font-medium text-foreground">{phaseCopy[transition.phase]}</strong>
				<p className="mt-1.5 text-xs leading-5 text-muted-foreground">
					Switching to {targetLabel(transition.targetMode)} with the same native conversation. AO will
					never run both controllers at once.
				</p>
				{cancellable ? (
					<Button className="mt-4" size="sm" variant="outline" disabled={cancelling} onClick={onCancel}>
						{cancelling ? "Cancelling…" : "Cancel switch"}
					</Button>
				) : null}
				{cancelError ? (
					<p role="alert" className="mt-3 text-xs text-destructive">
						{cancelError}
					</p>
				) : null}
			</div>
		</div>
	);
}

export function SessionInterfaceTransitionNotice({
	transition,
	onDismiss,
}: {
	transition?: SessionInterfaceTransition;
	onDismiss: () => void;
}) {
	if (!transition || (transition.phase !== "failed" && transition.phase !== "recovery_required")) {
		return null;
	}
	return (
		<div className="absolute left-1/2 top-3 z-20 flex w-[min(34rem,calc(100%-1.5rem))] -translate-x-1/2 items-start gap-2 rounded-lg border border-warning/30 bg-popover px-3 py-2.5 shadow-md">
		<TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
		<div className="min-w-0 flex-1">
			<strong className="block text-xs font-medium text-foreground">{phaseCopy[transition.phase]}</strong>
			<p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
				{transition.errorDetail || "The original interface remains available. You can retry the switch."}
			</p>
		</div>
		<button
			type="button"
			className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
			onClick={onDismiss}
			aria-label="Dismiss interface switch message"
		>
			<X aria-hidden="true" className="size-3.5" />
		</button>
	</div>
	);
}

export function SessionInterfaceActionGroup({ children }: { children: ReactNode }) {
	return <div className="flex items-center gap-1">{children}</div>;
}
