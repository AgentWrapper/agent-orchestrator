import { ArrowLeftRight, LoaderCircle, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	createSwitchAgentIdempotencyKey,
	type SwitchAgentHarness,
	useSwitchAgent,
} from "../hooks/useSwitchAgent";
import {
	findActiveAgentSwitch,
	isTerminalAgentSwitch,
	type AgentSwitch,
	useAgentSwitches,
} from "../hooks/useAgentSwitches";
import type { WorkspaceSession } from "../types/workspace";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	settingsDialogBodyClass,
	settingsDialogContentClass,
	settingsDialogFooterClass,
	settingsDialogHeaderClass,
} from "./ui/dialog";

export const SWITCH_AGENT_OPTIONS = [
	{ value: "claude-code", label: "Claude Code" },
	{ value: "codex", label: "Codex" },
] as const satisfies ReadonlyArray<{ value: SwitchAgentHarness; label: string }>;

export function canSwitchAgentHarness(value: string): value is SwitchAgentHarness {
	return SWITCH_AGENT_OPTIONS.some((option) => option.value === value);
}

export function agentLabel(harness: string): string {
	return SWITCH_AGENT_OPTIONS.find((option) => option.value === harness)?.label ?? harness;
}

const AGENT_SWITCH_STATE_KEYS = {
	preparing_handoff: "switchAgent.state.preparingHandoff",
	stopping_source: "switchAgent.state.stoppingSource",
	source_stopped: "switchAgent.state.sourceStopped",
	starting_target: "switchAgent.state.startingTarget",
	target_ready: "switchAgent.state.targetReady",
	delivering_context: "switchAgent.state.deliveringContext",
	completed: "switchAgent.state.completed",
	failed: "switchAgent.state.failed",
} as const;

type SwitchAgentDialogProps = {
	open: boolean;
	session: WorkspaceSession;
	onOpenChange: (open: boolean) => void;
};

export function SwitchAgentDialog({
	open,
	session,
	onOpenChange,
}: SwitchAgentDialogProps) {
	const { t } = useTranslation();
	const noteId = useId();
	const historyId = useId();
	const targetHarness: SwitchAgentHarness = session.provider === "claude-code" ? "codex" : "claude-code";
	const [note, setNote] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState(createSwitchAgentIdempotencyKey);
	const submittedRef = useRef(false);
	const switchAgent = useSwitchAgent();
	const switchesQuery = useAgentSwitches(session.id);
	const switches = switchesQuery.data ?? [];
	const activeSwitch = findActiveAgentSwitch(switches);
	const terminalHistory = switches.filter(isTerminalAgentSwitch);
	const checkingStatus = switchesQuery.isPending;

	const resetAttemptAfterEdit = () => {
		if (!submittedRef.current) return;
		submittedRef.current = false;
		setIdempotencyKey(createSwitchAgentIdempotencyKey());
		switchAgent.reset();
	};

	const submit = () => {
		if (switchAgent.isPending || checkingStatus || activeSwitch) return;
		submittedRef.current = true;
		switchAgent.mutate(
			{ session, targetHarness, note, idempotencyKey },
			{
				onSuccess: () => onOpenChange(false),
			},
		);
	};

	const error = switchAgent.error instanceof Error ? switchAgent.error.message : null;
	const historyError = switchesQuery.error instanceof Error ? switchesQuery.error.message : null;
	const stateLabel = (agentSwitch: AgentSwitch) => {
		if (agentSwitch.state === "failed" && agentSwitch.errorCode === "delivery_unconfirmed") {
			return t("switchAgent.state.deliveryUnconfirmed");
		}
		const translationKey =
			agentSwitch.state in AGENT_SWITCH_STATE_KEYS
				? AGENT_SWITCH_STATE_KEYS[agentSwitch.state as keyof typeof AGENT_SWITCH_STATE_KEYS]
				: undefined;
		return translationKey ? t(translationKey) : agentSwitch.state;
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && switchAgent.isPending) return;
				onOpenChange(nextOpen);
			}}
		>
			<DialogContent showCloseButton={false} className={settingsDialogContentClass}>
				<DialogClose asChild>
					<button
						type="button"
						disabled={switchAgent.isPending}
						className="settings-dialog-close-button settings-close-button"
						aria-label={t("switchAgent.close")}
					>
						<X className="size-5" aria-hidden="true" />
					</button>
				</DialogClose>

				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<div className={settingsDialogHeaderClass}>
						<DialogTitle className="settings-dialog-title">{t("switchAgent.title")}</DialogTitle>
						<DialogDescription className="text-control leading-4 text-settings-muted">
							{t("switchAgent.description", { current: agentLabel(session.provider) })}
						</DialogDescription>
					</div>

					<div className={settingsDialogBodyClass}>
						{checkingStatus ? (
							<div className="inline-flex items-center gap-2 text-control text-settings-muted" role="status">
								<LoaderCircle className="size-icon-sm animate-spin" aria-hidden="true" />
								{t("switchAgent.checkingStatus")}
							</div>
						) : activeSwitch ? (
							<div
								aria-live="polite"
								className="rounded-lg border border-border bg-surface px-3 py-2.5"
								role="status"
							>
								<div className="flex items-center gap-2 text-control font-medium text-foreground">
									<LoaderCircle className="size-icon-sm animate-spin" aria-hidden="true" />
									{t("switchAgent.progressTitle", {
										source: agentLabel(activeSwitch.fromHarness),
										target: agentLabel(activeSwitch.targetHarness),
									})}
								</div>
								<p className="mt-1 text-caption text-settings-muted">{stateLabel(activeSwitch)}</p>
							</div>
						) : (
							<div className="flex flex-col gap-1.5">
								<label className="settings-field-label" htmlFor={noteId}>
									{t("switchAgent.noteLabel")}
								</label>
								<textarea
									id={noteId}
									className="settings-field-control min-h-(--size-textarea-min) resize-y py-2.5"
									disabled={switchAgent.isPending}
									maxLength={4096}
									onChange={(event) => {
										resetAttemptAfterEdit();
										setNote(event.target.value);
									}}
									placeholder={t("switchAgent.notePlaceholder")}
									value={note}
								/>
							</div>
						)}

						{terminalHistory.length > 0 ? (
							<section aria-labelledby={historyId} className="flex flex-col gap-1.5">
								<h3 className="settings-field-label" id={historyId}>
									{t("switchAgent.historyTitle")}
								</h3>
								<ul className="max-h-40 space-y-1.5 overflow-y-auto" data-testid="agent-switch-history">
									{terminalHistory.map((entry) => (
										<li className="rounded-md border border-border px-2.5 py-2" key={entry.id}>
											<div className="flex items-center justify-between gap-3 text-caption">
												<span className="truncate text-foreground">
													{t("switchAgent.historyEntry", {
														source: agentLabel(entry.fromHarness),
														target: agentLabel(entry.targetHarness),
													})}
												</span>
												<span className="shrink-0 text-settings-muted">{stateLabel(entry)}</span>
											</div>
											{entry.errorCode ? (
												<p className="mt-0.5 truncate font-mono text-micro text-settings-muted">{entry.errorCode}</p>
											) : null}
										</li>
									))}
								</ul>
							</section>
						) : null}

						{error ? (
							<p className="text-caption leading-4 text-error" role="alert">
								{error}
							</p>
						) : null}
						{historyError ? (
							<p className="text-caption leading-4 text-error" role="alert">
								{historyError}
							</p>
						) : null}
					</div>

					<div className={settingsDialogFooterClass}>
						<DialogClose asChild>
							<button className="settings-footer-button" disabled={switchAgent.isPending} type="button">
								{activeSwitch || checkingStatus ? t("switchAgent.closeButton") : t("confirm.cancel")}
							</button>
						</DialogClose>
						{!activeSwitch && !checkingStatus ? (
							<button
								className="settings-footer-button settings-footer-button-primary"
								disabled={switchAgent.isPending}
								type="submit"
							>
								{switchAgent.isPending ? (
									<LoaderCircle className="size-icon-sm animate-spin" aria-hidden="true" />
								) : (
									<ArrowLeftRight className="size-icon-sm" aria-hidden="true" />
								)}
								{switchAgent.isPending ? t("switchAgent.switching") : t("switchAgent.confirm")}
							</button>
						) : null}
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
