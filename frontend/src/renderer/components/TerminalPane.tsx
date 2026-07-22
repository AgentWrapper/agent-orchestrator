import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalTarget } from "../types/terminal";
import type { WorkspaceSession } from "../types/workspace";
import type { Theme } from "../stores/ui-store";
import { useTerminalSession, type AttachableTerminal, type TerminalSessionState } from "../hooks/useTerminalSession";
import { apiClient } from "../lib/api-client";
import { isLoopbackHostname } from "../lib/loopback";
import { cn } from "../lib/utils";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { useRestoreSession } from "../hooks/useRestoreSession";
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
		terminalTarget?.kind === "reviewer" || terminalTarget?.kind === "shell"
			? terminalTarget.handleId
			: (session?.terminalHandleId ?? "empty");

	if (!window.ao) {
		// A standalone shell has no agent and no branch, so it previews as a plain
		// prompt rather than borrowing the session's agent transcript.
		if (terminalTarget?.kind === "shell") {
			return (
				<pre
					className="h-full overflow-auto bg-terminal p-4 font-mono leading-relaxed text-terminal"
					style={{ fontSize }}
				>
					<span className="text-terminal-dim">{terminalTarget.title}</span> $ {"\n"}
					<span className="text-terminal-dim">
						{"(standalone shell — a live PTY here in the desktop app)"}
						{"\n"}
					</span>
				</pre>
			);
		}
		const provider = terminalTarget?.kind === "reviewer" ? terminalTarget.harness : (session?.provider ?? "claude");
		const lines =
			terminalTarget?.kind === "reviewer" ? reviewerPreviewLines(session) : workerPreviewLines(session, provider);
		return (
			<pre
				className="h-full overflow-auto bg-terminal p-4 font-mono leading-relaxed text-terminal-foreground"
				data-testid="session-terminal"
				style={{ fontSize }}
			>
				<span className="text-terminal-dim">~/{session?.workspaceName ?? "reverbcode"}</span>{" "}
				<span className="text-accent">{session?.branch || "main"}</span> $ {provider}
				{"\n"}
				{lines.map((line, index) => (
					<span
						key={`${line}:${index}`}
						className={
							line.startsWith("PASS") || line.startsWith("DONE")
								? "text-success"
								: line.startsWith("WARN") || line.startsWith("TODO")
									? "text-warning"
									: line.startsWith("$") || line.startsWith("▲")
										? "text-accent"
										: "text-terminal-foreground"
						}
					>
						{line}
						{"\n"}
					</span>
				))}
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

function workerPreviewLines(session: WorkspaceSession | undefined, provider: string): string[] {
	if (session?.id === "ao-demo-orchestrator") {
		return [
			"> Go through my Linear backlog and let's plan which tasks to spawn off",
			"",
			"Ran 3 shell commands",
			"",
			"Here's the backlog triage. Half of it is already in flight — don't spawn those.",
			"",
			"Already covered — don't spawn (session → PR):",
			"— terminal polish → PR #318, changes requested",
			"— browser preview stack → PRs #319/#320, in review",
			"— README screenshot assets → PR #323, approved and mergeable",
			"",
			"Plan: 3 sessions worth spawning",
			"",
			"┌───┬────────────────────┬──────────────────────────────────────────┬──────────────────────────────────┐",
			"│ # │ Session            │ Scope                                    │ Why now                          │",
			"├───┼────────────────────┼──────────────────────────────────────────┼──────────────────────────────────┤",
			"│ 1 │ new-task-flake     │ NewTaskDialog smoke test flakes on Enter │ Failing PR #324's e2e; small fix │",
			"│ 2 │ checkout-retries   │ e2e retries leak state between runs      │ Flakes 1-in-5 on CI; well scoped │",
			"│ 3 │ session-pr-surface │ PR checks missing on board cards         │ Additive; touches board only     │",
			"└───┴────────────────────┴──────────────────────────────────────────┴──────────────────────────────────┘",
			"",
			"Want me to spawn all three? I'd put #1–2 on codex and #3 on claude-code.",
			"",
			"> yes, spawn all three",
			"",
			"Running 3 shell commands…",
			'└ $ ao spawn --project ao-demo --name "new-task-flake" --agent codex --prompt',
			'  "Fix the flaky NewTaskDialog smoke test: submit is debounced 300ms while the',
			'  e2e check asserts synchronously. Reproduce, fix, and push to update PR #324."',
			"PASS 3 sessions spawned — board updated",
		];
	}
	if (session?.id === "demo-review-stack") {
		return [
			'$ rg "previewUrl|Browser" frontend/src/renderer',
			"frontend/src/renderer/components/SessionInspector.tsx: Browser tab selected after ao preview",
			"frontend/src/renderer/hooks/useBrowserView.ts: preview revision re-navigates the view",
			"$ ao preview http://localhost:5173",
			"DONE preview target set for demo-review-stack",
			"$ npm --prefix frontend run typecheck",
			"PASS TypeScript project references are clean",
			"TODO wait for reviewer on PR #320 before merging the stack",
		];
	}
	if (session?.id === "demo-working") {
		return [
			`$ ${provider} --continue`,
			"Reading renderer board and inspector components...",
			"Updated demo workspace data for README screenshots",
			"$ npm --prefix frontend test -- SessionsBoard SessionInspector",
			"PASS 18 tests passed",
			"DONE board has Working, Needs you, In review, and Ready to merge populated",
		];
	}
	if (session?.id === "demo-needs-input") {
		return [
			"$ git diff --stat",
			"frontend/src/renderer/components/TerminalPane.tsx | 41 +++++++++++++++++",
			"frontend/src/renderer/styles.css                 | 27 +++++++++++",
			"WARN reviewer requested a tighter terminal activity sample",
			"TODO confirm whether to keep the toolbar density change",
		];
	}
	if (session?.id === "demo-ci-failed") {
		return [
			"╭────────────────────────────────────────────╮",
			"│ >_ OpenAI Codex (v0.133.0)                 │",
			"│ model:        gpt-5.5 high  /model to change",
			"│ directory:    ~/ao-demo/demo-new-task-flake",
			"│ permissions:  YOLO mode                    │",
			"╰────────────────────────────────────────────╯",
			"",
			"• I'll start from the failing check output, reproduce the Enter-submit",
			"  path locally, then patch and push.",
			"",
			"• Ran npm test -- NewTaskDialog",
			"└ PASS 12 tests passed",
			"",
			"▲ ao send · CI failed on PR #324. The failing checks are e2e (NewTaskDialog",
			"  submits with Enter). Investigate and push a fix.",
			"",
			'• Ran rg -n "onKeyDown|Enter" src/components/NewTaskDialog.tsx',
			'└ src/components/NewTaskDialog.tsx:88:  onKeyDown={(e) => e.key === "Enter" && scheduleSubmit()}',
			"  src/components/NewTaskDialog.tsx:141: const scheduleSubmit = debounce(submit, 300)",
			"  … +42 lines (ctrl + t to view transcript)",
			"",
			"Found it: submit is debounced 300ms, the check asserts immediately.",
			"Patching the handler and re-running e2e…",
		];
	}
	return [
		`$ ${provider} --status`,
		"Reading task context and local diff...",
		"Running focused validation for the current session",
		"PASS demo terminal is populated for screenshots",
	];
}

function reviewerPreviewLines(session: WorkspaceSession | undefined): string[] {
	return [
		"$ ao review submit --session " + (session?.id ?? "demo-session"),
		"Reviewing PR #319: browser preview rail renders inside AO",
		"PASS implementation matches the requested README screenshot flow",
		"Reviewing PR #320: stacked PR review rows",
		"WARN keep multiple review rows visible before taking the screenshot",
		"DONE submitted batched review results",
	];
}

// Agents whose full-screen TUI keeps its own transcript and scrolls it only by
// keyboard, ignoring SGR wheel reports. The terminal routes the wheel to
// PageUp/PageDown for these (see XtermTerminal's paneScrollsByKeyboard).
// kilocode is a fork of opencode and shares its TUI surface, so it scrolls the
// same way.
const KEYBOARD_SCROLL_PROVIDERS = new Set(["opencode", "kilocode"]);

// Whether the given provider's TUI is one of the keyboard-scroll agents above.
export function providerScrollsByKeyboard(provider?: string): boolean {
	return provider ? KEYBOARD_SCROLL_PROVIDERS.has(provider) : false;
}

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
	const restoreSessionById = useRestoreSession();
	// A shell pane has no session, so it hands the hook its handle directly
	// instead of reading one off `attachSession`.
	const shellTerminalHandleId = terminalTarget?.kind === "shell" ? terminalTarget.handleId : undefined;
	const { attach, state, error } = useTerminalSession(attachSession, { daemonReady, shellTerminalHandleId });
	const handleId = shellTerminalHandleId ?? attachSession?.terminalHandleId;
	const provider = terminalTarget?.kind === "reviewer" ? terminalTarget.harness : session?.provider;
	const hadAttachmentRef = useRef(false);
	// A standalone shell is never restorable: there is no session row to restore.
	const canRestoreSession =
		terminalTarget?.kind !== "reviewer" && terminalTarget?.kind !== "shell" && session?.status === "terminated";

	const handleReady = useCallback((handle: AttachableTerminal) => {
		setTerminal(handle);
	}, []);
	const handleInitError = useCallback((err: unknown) => {
		console.error("xterm failed to initialize", err);
		setInitFailed(true);
	}, []);
	const handleLinkOpen = useCallback(
		(uri: string) => {
			if (!session?.id || session.kind !== "worker" || session.status === "terminated") return;
			try {
				const url = new URL(uri);
				if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHostname(url.hostname)) return;
			} catch {
				return;
			}
			void (async () => {
				try {
					const { error: previewError } = await apiClient.POST("/api/v1/sessions/{sessionId}/preview", {
						params: { path: { sessionId: session.id } },
						body: { url: uri },
					});
					if (previewError) {
						console.warn("Unable to open terminal link in Browser preview", previewError);
						return;
					}
					await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				} catch (error) {
					console.warn("Unable to open terminal link in Browser preview", error);
				}
			})();
		},
		[queryClient, session?.id, session?.kind, session?.status],
	);
	const restoreSession = useCallback(async () => {
		if (!session?.id || !canRestoreSession || isRestoring) return;
		setIsRestoring(true);
		setRestoreError(undefined);
		try {
			const result = await restoreSessionById(session.id);
			if (result.status === "not_resumable") {
				setRestoreUnavailable(true);
				return;
			}
			if (result.status === "error") {
				setRestoreError(result.message);
			}
		} catch (err) {
			setRestoreError(err instanceof Error ? err.message : "Unable to restore session");
		} finally {
			setIsRestoring(false);
		}
	}, [canRestoreSession, isRestoring, restoreSessionById, session?.id]);

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
			<div className="grid h-full place-items-center bg-terminal p-4 font-mono text-xs text-muted-foreground">
				Terminal failed to initialize on this GPU/driver. Restart the app to retry.
			</div>
		);
	}

	const banner = bannerText(state, error);
	const showEmptyState = !handleId;
	const showEndedState = state === "exited" || canRestoreSession;
	const emptyStateTitle = session ? "Starting session" : "Agent Orchestrator";
	const emptyStateMessage = session
		? session.kind === "orchestrator"
			? "Preparing the orchestrator terminal. This can take a moment while AO creates the worktree and starts the agent."
			: "Preparing the worker terminal. This can take a moment while AO creates the worktree and starts the agent."
		: "No session selected. Pick a worker to attach its terminal.";

	return (
		<div className="flex h-full min-h-0 flex-col bg-terminal" data-testid="session-terminal">
			{showEndedState && (
				<TerminalEndedStrip
					canRestore={canRestoreSession}
					error={restoreError}
					isRestoring={isRestoring}
					onRestore={restoreSession}
					variant={
						terminalTarget?.kind === "reviewer" ? "reviewer" : terminalTarget?.kind === "shell" ? "shell" : "session"
					}
				/>
			)}
			<div className="relative min-h-0 flex-1">
				<XtermTerminal
					ariaLabel={terminalTarget?.kind === "shell" ? "Shell terminal" : "Session terminal"}
					fontSize={fontSize}
					onError={handleInitError}
					onLinkOpen={handleLinkOpen}
					onReady={handleReady}
					paneScrollsByKeyboard={providerScrollsByKeyboard(provider)}
					theme={theme}
				/>
				{showEmptyState && (
					<div className="absolute inset-0 grid place-items-center bg-terminal font-mono text-control">
						<div className="text-center">
							<div className="text-terminal">{emptyStateTitle}</div>
							<div className="mt-2 text-terminal-dim">{emptyStateMessage}</div>
						</div>
					</div>
				)}
				{banner && (
					<div className="absolute inset-x-3 top-2 rounded-md border border-border bg-surface/95 px-3 py-1.5 font-mono text-caption text-muted-foreground">
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
	variant: "reviewer" | "session" | "shell";
};

function TerminalEndedStrip({ canRestore, error, isRestoring, onRestore, variant }: TerminalEndedStripProps) {
	const message = canRestore
		? "Restore the session to attach a live terminal and continue writing."
		: variant === "reviewer"
			? "This reviewer terminal has ended. Re-run review from the summary panel, or switch back to the agent terminal."
			: variant === "shell"
				? "This shell exited. Close the tab, or open a new terminal."
				: "This terminal process ended, but the session is not marked terminated yet.";

	return (
		<div className="shrink-0 border-b border-border bg-surface/80 px-4 py-2">
			<div className="flex min-h-control-board items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="font-mono text-caption font-medium uppercase tracking-wide-md text-muted-foreground">
						Terminal ended
					</div>
					<div className="mt-0.5 truncate text-xs text-muted-foreground">{message}</div>
				</div>
				{error && <div className="max-w-content-max truncate text-xs text-destructive">{error}</div>}
				{canRestore && (
					<button
						type="button"
						aria-label="Restore session"
						title="Restore session"
						className="inline-flex size-control-form shrink-0 items-center justify-center rounded-md border border-border bg-raised text-foreground transition hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
						disabled={isRestoring}
						onClick={onRestore}
					>
						<RotateCcw className={cn("size-icon-base", isRestoring && "animate-spin")} aria-hidden="true" />
					</button>
				)}
			</div>
		</div>
	);
}
