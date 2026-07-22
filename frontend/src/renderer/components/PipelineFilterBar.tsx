import { cn } from "../lib/utils";

// Board filter bar: a pipeline-name multi-select (chip toggles). Empty selection
// means "show all". The old design also carried a "show dismissed" toggle here,
// but that only governs findings, which live in the run detail — so it moved
// there rather than sitting inert on the board.
export function PipelineFilterBar({
	availablePipelines,
	selected,
	onChange,
}: {
	availablePipelines: string[];
	selected: string[];
	onChange: (next: string[]) => void;
}) {
	const toggle = (name: string) => {
		const set = new Set(selected);
		if (set.has(name)) set.delete(name);
		else set.add(name);
		onChange([...set]);
	};
	const showingAll = selected.length === 0;

	return (
		<div className="flex flex-wrap items-center gap-2 border-b border-border px-4.5 py-2.5">
			<span className="text-micro uppercase tracking-wide text-passive">Pipelines</span>
			{availablePipelines.length === 0 && <span className="text-caption text-passive">(none yet)</span>}
			{availablePipelines.map((name) => {
				const active = selected.includes(name);
				return (
					<button
						key={name}
						type="button"
						onClick={() => toggle(name)}
						aria-pressed={active}
						className={cn(
							"rounded-full border px-2.5 py-0.5 font-mono text-caption transition-colors",
							active
								? "border-accent-dim bg-accent-weak text-accent"
								: "border-border bg-raised text-muted-foreground hover:text-foreground",
						)}
					>
						{name}
					</button>
				);
			})}
			{!showingAll && (
				<button
					type="button"
					onClick={() => onChange([])}
					className="ml-1 text-micro text-passive underline-offset-2 hover:underline"
				>
					clear
				</button>
			)}
		</div>
	);
}
