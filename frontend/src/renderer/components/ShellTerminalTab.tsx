import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTruncatedText } from "../hooks/useTruncatedText";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import { cn } from "../lib/utils";

type ShellTerminalTabProps = {
	shell: ShellTerminal;
	isActive: boolean;
	onSelect: () => void;
	onClose: () => void;
	/** Commit a new tab title. Omitted where rename is not wired. */
	onRename?: (title: string) => void;
};

// One standalone-shell tab, shared by the session pane's tab strip (CenterPane)
// and the standalone /terminals screen (ShellTerminalsView) so the two never
// drift. The open tab gets the rounded background highlight used by the
// inspector rail tabs; the full title only becomes the hover tooltip when the
// strip truncates it; the close control appears on hover/focus.
//
// Double-clicking the label renames the tab inline: Enter or blur commits,
// Escape cancels, and an empty or unchanged name is discarded. The close
// control is a sibling button, not nested inside the tab button - nesting
// interactive elements is invalid HTML and breaks keyboard traversal.
export function ShellTerminalTab({ shell, isActive, onSelect, onClose, onRename }: ShellTerminalTabProps) {
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(shell.title);
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState(shell.title);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (isEditing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [isEditing]);

	const beginEdit = () => {
		if (!onRename) return;
		setDraft(shell.title);
		setIsEditing(true);
	};

	const commit = () => {
		if (!isEditing) return;
		setIsEditing(false);
		const next = draft.trim();
		if (next && next !== shell.title) onRename?.(next);
	};

	const cancel = () => {
		setIsEditing(false);
		setDraft(shell.title);
	};

	return (
		<span
			className={cn(
				"group inline-flex min-w-shell-tab-min items-center gap-1 rounded-md px-2 py-1 transition-colors",
				isActive ? "bg-interactive-active" : "hover:bg-interactive-hover/60",
			)}
		>
			{isEditing ? (
				<input
					aria-label={`Rename terminal ${shell.title}`}
					className="min-w-flex-min max-w-shell-tab-max rounded-sm border border-accent bg-background px-1 font-mono text-control font-semibold text-foreground shadow-sm outline-none ring-1 ring-accent"
					onBlur={commit}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commit();
						} else if (event.key === "Escape") {
							event.preventDefault();
							cancel();
						}
					}}
					ref={inputRef}
					value={draft}
				/>
			) : (
				<button
					ref={ref}
					aria-current={isActive}
					className={cn(
						"min-w-flex-min max-w-shell-tab-max select-none truncate font-mono text-control font-semibold transition-colors",
						isActive ? "text-foreground" : "text-passive hover:text-foreground",
					)}
					onClick={onSelect}
					onDoubleClick={beginEdit}
					title={isTruncated ? shell.title : shell.workingDir}
					type="button"
				>
					{shell.title}
				</button>
			)}
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
