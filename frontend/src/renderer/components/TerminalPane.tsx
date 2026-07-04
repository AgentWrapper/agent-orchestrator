import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalTarget } from "../types/terminal";
import type { WorkspaceSession } from "../types/workspace";
import type { Theme } from "../stores/ui-store";
import { useTerminalSession, type AttachableTerminal, type TerminalSessionState } from "../hooks/useTerminalSession";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { XtermTerminal } from "./XtermTerminal";
import { RestoreUnavailableDialog } from "./RestoreUnavailableDialog";

type TerminalPaneProps = {
	session?: WorkspaceSession;
	theme: Theme;
	daemonReady: boolean;
	terminalTarget?: TerminalTarget;
	fontSize: number;
};

export function TerminalPane({ session, theme, daemonReady, terminalTarget, fontSize }: TerminalPaneProps) {
	const terminalKey =
		terminalTarget?.kind === "reviewer" ? terminalTarget.handleId : (session?.terminalHandleId ?? "empty");

	if (!window.ao) {
		const provider = terminalTarget?.kind === "reviewer" ? terminalTarget.harness : (session?.provider ?? "claude");
		return (
			<pre
				className="h-full overflow-auto bg-terminal p-4 font-mono leading-relaxed text-[var(--term-fg)]"
				style={{ fontSize }}
			>
				<span className="text-[var(--term-dim)]">~/{session?.workspaceName ?? "reverbcode"}</span>{" "}
				<span className="text-[var(--term-blue)]">{session?.branch || "main"}</span> $ {provider}
				{"\n"}
				<span className="text-[var(--term-green)]">✻ Welcome to the agent CLI</span>
				{"\n\n"}
				<span className="text-[var(--term-dim)]">
					Browser preview renders a static terminal surface. Electron attaches the live PTY.
				</span>
			</pre>
		);
	}

	return (
		<AttachedTerminal
			key={terminalKey}
			session={session}
			theme={theme}
			daemonReady={daemonReady}
			fontSize={fontSize}
			terminalTarget={terminalTarget}
		/>
	);
}

// Agents whose full-screen TUI keeps its own transcript and scrolls it only by
// keyboard, ignoring SGR wheel reports. The terminal routes the wheel to
// PageUp/PageDown for these (see XtermTerminal's paneScrollsByKeyboard).
const KEYBOARD_SCROLL_PROVIDERS = new Set(["opencode"]);

function bannerText(state: TerminalSessionState, error?: string): string | undefined {
	if (state === "reattaching") return "Terminal disconnected — reattaching…";
	if (state === "error") return `Terminal error: ${error ?? "connection failed"}`;
	return undefined;
}

function AttachedTerminal({ session, theme, daemonReady, terminalTarget, fontSize }: TerminalPaneProps) {
	const attachSession =
		session && terminalTarget?.kind === "reviewer"
			? { ...session, terminalHandleId: terminalTarget.handleId }
			: session;
	// One terminal instance per handle-scoped pane lifetime. TerminalPane keys this
	// component by terminal handle, so session switches get a fresh xterm + mux
	// hook state instead of reusing a potentially stale screen/input binding.
	const [terminal, setTerminal] = useState<AttachableTerminal | null>(null);
	const [initFailed, setInitFailed] = useState(false);
	const [isRestoring, setIsRestoring] = useState(false);
	const [restoreError, setRestoreError] = useState<string | undefined>();
	const [restoreUnavailable, setRestoreUnavailable] = useState(false);
	const queryClient = useQueryClient();
	const { attach, state, error } = useTerminalSession(attachSession, { daemonReady });
	const handleId = attachSession?.terminalHandleId;
	const provider = terminalTarget?.kind === "reviewer" ? terminalTarget.harness : session?.provider;
	const hadAttachmentRef = useRef(false);
	const canRestoreSession = terminalTarget?.kind !== "reviewer" && session?.status === "terminated";

	const handleReady = useCallback((handle: AttachableTerminal) => {
		setTerminal(handle);
	}, []);
	const handleInitError = useCallback((err: unknown) => {
		console.error("xterm failed to initialize", err);
		setInitFailed(true);
	}, []);
	const restoreSession = useCallback(async () => {
		if (!session?.id || !canRestoreSession || isRestoring) return;
		setIsRestoring(true);
		setRestoreError(undefined);
		try {
			const { error: restoreError } = await apiClient.POST("/api/v1/sessions/{sessionId}/restore", {
				params: { path: { sessionId: session.id } },
			});
			if (restoreError) {
				const code = (restoreError as { code?: string }).code;
				if (code === "SESSION_NOT_RESUMABLE") {
					setRestoreUnavailable(true);
					return;
				}
				throw new Error(apiErrorMessage(restoreError, "Unable to restore session"));
			}
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		} catch (err) {
			setRestoreError(err instanceof Error ? err.message : "Unable to restore session");
		} finally {
			setIsRestoring(false);
		}
	}, [canRestoreSession, isRestoring, queryClient, session?.id]);

	useEffect(() => {
		if (!terminal) return;
		// Reuse means the previous session's screen would linger; clear before
		// re-pointing. Screen-clear only, never reset(): every pane PTY is
		// `zellij attach` with identical modes, so the previous session's mouse
		// tracking stays valid while the new attach's handshake + repaint stream
		// in — a full RIS would leave wheel scroll dead for that window (yyork's
		// frozen-scroll regression, solved there the same way). Skipped on the
		// very first attachment: the buffer is empty and the first fit may not
		// have run yet.
		if (hadAttachmentRef.current) {
			terminal.clear();
		}
		hadAttachmentRef.current = true;
		return attach(terminal);
	}, [terminal, handleId, attach, attachSession?.id]);

	if (initFailed) {
		return (
			<div className="grid h-full place-items-center bg-terminal p-4 font-mono text-[12px] text-muted-foreground">
				Terminal failed to initialize on this GPU/driver. Restart the app to retry.
			</div>
		);
	}

	const banner = bannerText(state, error);
	const showEmptyState = !handleId;
	const showExitedState = state === "exited";

	return (
		<div className="flex h-full min-h-0 flex-col bg-terminal">
			{showExitedState && (
				<TerminalEndedStrip
					canRestore={canRestoreSession}
					error={restoreError}
					isRestoring={isRestoring}
					onRestore={restoreSession}
					variant={terminalTarget?.kind === "reviewer" ? "reviewer" : "session"}
				/>
			)}
			<div className="relative min-h-0 flex-1">
				<XtermTerminal
					ariaLabel="Session terminal"
					fontSize={fontSize}
					onError={handleInitError}
					onReady={handleReady}
					paneScrollsByKeyboard={provider ? KEYBOARD_SCROLL_PROVIDERS.has(provider) : false}
					theme={theme}
				/>
				{showEmptyState && (
					<div className="absolute inset-0 grid place-items-center bg-terminal font-mono text-[13px]">
						<div className="text-center">
							<div className="text-[var(--term-fg)]">Agent Orchestrator</div>
							<div className="mt-2 text-[var(--term-dim)]">
								No session selected. Pick a worker to attach its terminal.
							</div>
						</div>
					</div>
				)}
				{banner && (
					<div className="absolute inset-x-3 top-2 rounded-md border border-border bg-surface/95 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
						{banner}
					</div>
				)}
			</div>
			{session && (
				<RestoreUnavailableDialog
					open={restoreUnavailable}
					session={session}
					onOpenChange={setRestoreUnavailable}
					onRecreated={async () => {
						await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
					}}
				/>
			)}
		</div>
	);
}

type TerminalEndedStripProps = {
	canRestore: boolean;
	error?: string;
	isRestoring: boolean;
	onRestore: () => void;
	variant: "reviewer" | "session";
};

function TerminalEndedStrip({ canRestore, error, isRestoring, onRestore, variant }: TerminalEndedStripProps) {
	const message = canRestore
		? "Restore the session to attach a live terminal and continue writing."
		: variant === "reviewer"
			? "This reviewer terminal has ended. Re-run review from the summary panel, or switch back to the agent terminal."
			: "This terminal process ended, but the session is not marked terminated yet.";

	return (
		<div className="shrink-0 border-b border-border bg-surface/80 px-4 py-2">
			<div className="flex min-h-9 items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
						Terminal ended
					</div>
					<div className="mt-0.5 truncate text-[12px] text-muted-foreground">{message}</div>
				</div>
				{error && <div className="max-w-[320px] truncate text-[12px] text-destructive">{error}</div>}
				{canRestore && (
					<button
						type="button"
						className="h-8 shrink-0 rounded-md border border-border bg-raised px-3 text-[12px] font-medium text-foreground transition hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
						disabled={isRestoring}
						onClick={onRestore}
					>
						{isRestoring ? "Restoring..." : "Restore session"}
					</button>
				)}
			</div>
		</div>
	);
}
