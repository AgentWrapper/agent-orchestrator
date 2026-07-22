import { Plus, X } from "lucide-react";
import { useEffect } from "react";
import { useCloseShellTerminal, useShellTerminals } from "../hooks/useShellTerminals";
import { useShell } from "../lib/shell-context";
import { cn } from "../lib/utils";
import { useResolvedTheme, useUiStore } from "../stores/ui-store";
import { TerminalPane } from "./TerminalPane";

// The standalone terminals screen: shells with no agent session behind them,
// reachable from anywhere via the topbar button or Ctrl+`.
//
// This exists because the session view cannot be the only home for shells — it
// is unreachable in a project with no sessions, which is exactly when a user
// most wants a plain terminal. Inside a session, shells still appear as tabs
// beside that session's pane; this screen is where they live otherwise.
export function ShellTerminalsView() {
	const { daemonStatus } = useShell();
	const theme = useResolvedTheme();
	const shellTerminals = useShellTerminals().data ?? [];
	const closeShellTerminal = useCloseShellTerminal();
	const requestNewShellTerminal = useUiStore((state) => state.requestNewShellTerminal);
	const activeHandleId = useUiStore((state) => state.activeShellTerminalHandleId);
	const setActiveShellTerminal = useUiStore((state) => state.setActiveShellTerminal);

	// Keep the selection pointed at a shell that still exists: closing the active
	// tab (or a daemon-side exit pruning it) would otherwise leave the pane bound
	// to a dead handle.
	const active = shellTerminals.find((s) => s.handleId === activeHandleId);
	useEffect(() => {
		if (shellTerminals.length === 0) {
			if (activeHandleId !== null) setActiveShellTerminal(null);
			return;
		}
		if (!active) setActiveShellTerminal(shellTerminals[0].handleId);
	}, [shellTerminals, active, activeHandleId, setActiveShellTerminal]);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<div className="flex h-inspector-tabs shrink-0 items-center gap-3 border-b border-border bg-background px-5">
				<span className="shrink-0 font-mono text-caption font-semibold uppercase tracking-wide-lg text-muted-foreground">
					TERMINALS
				</span>
				{shellTerminals.map((shell) => {
					const isActive = shell.handleId === active?.handleId;
					return (
						<span
							key={shell.handleId}
							className={cn(
								"inline-flex min-w-0 shrink-0 items-center gap-1 rounded-sm pl-1.5 transition-colors",
								isActive ? "bg-interactive-hover" : "hover:bg-interactive-hover/60",
							)}
						>
							<button
								aria-current={isActive}
								className={cn(
									"min-w-0 max-w-shell-tab-max truncate font-mono text-control font-semibold transition-colors",
									isActive ? "text-foreground" : "text-passive hover:text-foreground",
								)}
								onClick={() => setActiveShellTerminal(shell.handleId)}
								title={shell.workingDir}
								type="button"
							>
								{shell.title}
							</button>
							<button
								aria-label={`Close terminal ${shell.title}`}
								className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-passive transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
								onClick={() => closeShellTerminal.mutate(shell.handleId)}
								title="Close terminal"
								type="button"
							>
								<X aria-hidden="true" className="size-icon-sm" />
							</button>
						</span>
					);
				})}
				<button
					aria-label="New terminal"
					className="ml-auto inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
					onClick={requestNewShellTerminal}
					title="New terminal (Ctrl+`)"
					type="button"
				>
					<Plus aria-hidden="true" className="size-icon-md" />
				</button>
			</div>
			<div className="min-h-0 flex-1">
				{active ? (
					<TerminalPane
						daemonReady={daemonStatus.state === "ready"}
						fontSize={12}
						terminalTarget={{ kind: "shell", handleId: active.handleId, title: active.title }}
						theme={theme}
					/>
				) : (
					<div className="grid h-full place-items-center bg-terminal font-mono text-control">
						<div className="text-center">
							<div className="text-terminal">No terminals open</div>
							<div className="mt-2 text-terminal-dim">
								Press <span className="text-terminal">Ctrl+`</span> or use the terminal button to open one.
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
