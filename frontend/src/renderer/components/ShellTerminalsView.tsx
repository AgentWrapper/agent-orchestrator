import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { useEffect } from "react";
import { useOverflowScroll } from "../hooks/useOverflowScroll";
import { useTruncatedText } from "../hooks/useTruncatedText";
import { useCloseShellTerminal, useShellTerminals, type ShellTerminal } from "../hooks/useShellTerminals";
import { useShell } from "../lib/shell-context";
import { cn } from "../lib/utils";
import { useResolvedTheme, useUiStore } from "../stores/ui-store";
import { TerminalPane } from "./TerminalPane";

// The standalone terminals screen: shells with no agent session behind them,
// reachable from anywhere via the + at the end of a tab strip or Ctrl+Shift+`.
//
// This exists because the session view cannot be the only home for shells - it
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
	const tabsOverflow = useOverflowScroll<HTMLDivElement>(shellTerminals.map((t) => t.handleId).join("|"));
	useEffect(() => {
		if (shellTerminals.length === 0) {
			if (activeHandleId !== null) setActiveShellTerminal(null);
			return;
		}
		if (!active) setActiveShellTerminal(shellTerminals[0].handleId);
	}, [shellTerminals, active, activeHandleId, setActiveShellTerminal]);

	return (
		<div className="flex h-full min-h-0 flex-col text-foreground">
			<div className="flex h-inspector-tabs shrink-0 items-center gap-3 border-b border-border px-5">
				<span className="shrink-0 font-mono text-caption font-semibold uppercase tracking-wide-lg text-muted-foreground">
					TERMINALS
				</span>
				<button
					aria-label="Scroll tabs left"
					className={cn(
						"inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:pointer-events-none disabled:opacity-0",
						!tabsOverflow.canScrollLeft && "invisible",
					)}
					disabled={!tabsOverflow.canScrollLeft}
					onClick={() => tabsOverflow.scrollByDirection(-1)}
					title="Scroll tabs left"
					type="button"
				>
					<ChevronLeft aria-hidden="true" className="size-icon-md" />
				</button>
				{/* Tabs shrink and truncate down to a minimum width; beyond that the
				    strip scrolls and edge chevrons reveal the overflow. */}
				<div
					ref={tabsOverflow.ref}
					className="scrollbar-none flex min-w-flex-min flex-1 items-center gap-3 overflow-x-auto"
				>
					{shellTerminals.map((shell) => {
						const isActive = shell.handleId === active?.handleId;
						return (
							<ShellTab
								key={shell.handleId}
								isActive={isActive}
								onClose={() => closeShellTerminal.mutate(shell.handleId)}
								onSelect={() => setActiveShellTerminal(shell.handleId)}
								shell={shell}
							/>
						);
					})}
				</div>
				<button
					aria-label="Scroll tabs right"
					className={cn(
						"inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:pointer-events-none disabled:opacity-0",
						!tabsOverflow.canScrollRight && "invisible",
					)}
					disabled={!tabsOverflow.canScrollRight}
					onClick={() => tabsOverflow.scrollByDirection(1)}
					title="Scroll tabs right"
					type="button"
				>
					<ChevronRight aria-hidden="true" className="size-icon-md" />
				</button>
				<button
					aria-label="New terminal"
					className="ml-auto inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
					onClick={requestNewShellTerminal}
					title="New terminal (Ctrl+Shift+`)"
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
								Press <span className="text-terminal">Ctrl+Shift+`</span> or use the + button to open one.
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

// Same tab chrome as the session view's strip: the open tab gets the rounded
// background highlight used by the inspector rail tabs, the full title only
// becomes the hover tooltip when the strip truncates it, and the close
// control appears on hover/focus (kept a sibling button - nesting interactive
// elements is invalid HTML).
function ShellTab({
	shell,
	isActive,
	onSelect,
	onClose,
}: {
	shell: ShellTerminal;
	isActive: boolean;
	onSelect: () => void;
	onClose: () => void;
}) {
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(shell.title);
	return (
		<span
			className={cn(
				"group inline-flex min-w-shell-tab-min items-center gap-1 rounded-md px-2 py-1 transition-colors",
				isActive ? "bg-interactive-active" : "hover:bg-interactive-hover/60",
			)}
		>
			<button
				ref={ref}
				aria-current={isActive}
				className={cn(
					"min-w-flex-min max-w-shell-tab-max truncate font-mono text-control font-semibold transition-colors",
					isActive ? "text-foreground" : "text-passive hover:text-foreground",
				)}
				onClick={onSelect}
				title={isTruncated ? shell.title : shell.workingDir}
				type="button"
			>
				{shell.title}
			</button>
			<button
				aria-label={`Close terminal ${shell.title}`}
				className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-passive opacity-0 transition-[background,color,opacity] group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
				onClick={onClose}
				title="Close terminal"
				type="button"
			>
				<X aria-hidden="true" className="size-icon-sm" />
			</button>
		</span>
	);
}
