/**
 * The composer's suggestion list.
 *
 * Presentation only: it renders ranked rows and reports clicks. Which rows exist,
 * which is highlighted, and what a selection inserts are all decided by the
 * composer, so the keyboard and the mouse cannot disagree about what is selected.
 *
 * Not a Popover or a Command: both want focus. The textarea must keep it — the user
 * is still typing, and every keystroke has to reach the field and re-filter the
 * list. So this is a plain positioned panel wired to the textarea's own key
 * handling, following the listbox pattern (`aria-activedescendant` on the input
 * rather than a focus move).
 */

import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import type { Suggestion, TriggerKind } from "./composerSuggest";

export function ComposerSuggestMenu({
	id,
	kind,
	items,
	highlighted,
	onPick,
	onHighlight,
	truncated,
}: {
	/** Shared with the textarea's `aria-controls`, so the pairing is announced. */
	id: string;
	kind: TriggerKind;
	items: Suggestion[];
	highlighted: number;
	onPick: (value: string) => void;
	onHighlight: (index: number) => void;
	/** The candidate list was capped by the daemon, so it is not exhaustive. */
	truncated?: boolean;
}) {
	const list = useRef<HTMLUListElement>(null);

	// Keep the highlighted row visible when it moves by keyboard past the edge of
	// the scroll area.
	useEffect(() => {
		const row = list.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [highlighted]);

	if (items.length === 0) return null;

	return (
		<div
			className="absolute bottom-full left-0 z-50 mb-1.5 w-full max-w-md overflow-hidden rounded-md border border-border-strong bg-surface shadow-lg"
			// The composer owns the keyboard; a pointerdown here must not pull focus
			// out of the textarea on its way to the click.
			onMouseDown={(event) => event.preventDefault()}
		>
			<div className="flex items-baseline justify-between gap-2 border-b border-border px-2.5 py-1.5">
				<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					{kind === "skill" ? "Skills" : "Files in this worktree"}
				</span>
				<span className="text-[10px] text-muted-foreground">↑↓ · ⏎ select · esc</span>
			</div>

			<ul ref={list} id={id} role="listbox" className="max-h-64 overflow-y-auto py-1">
				{items.map((item, index) => (
					<li key={item.value} data-index={index}>
						<button
							type="button"
							role="option"
							id={`${id}-option-${index}`}
							aria-selected={index === highlighted}
							onClick={() => onPick(item.value)}
							onMouseEnter={() => onHighlight(index)}
							className={cn(
								"flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left",
								index === highlighted ? "bg-accent-weak" : "bg-transparent",
							)}
						>
							<span className="min-w-0 flex-1">
								<span
									className={cn(
										"block truncate text-xs",
										index === highlighted ? "text-foreground" : "text-muted-foreground",
									)}
								>
									{kind === "skill" ? `/${item.label}` : item.label}
								</span>
								{item.detail ? (
									<span className="block truncate text-[11px] leading-snug text-muted-foreground">
										{item.detail}
									</span>
								) : null}
							</span>
							{item.badge ? (
								<span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
									{item.badge}
								</span>
							) : null}
						</button>
					</li>
				))}
			</ul>

			{truncated ? (
				// Said out loud rather than letting a capped list read as the whole
				// worktree: a file that is missing because of the cap looks identical to
				// one that does not exist.
				<p className="border-t border-border px-2.5 py-1 text-[10px] text-muted-foreground">
					Showing part of a large worktree — type more to narrow it.
				</p>
			) : null}
		</div>
	);
}
