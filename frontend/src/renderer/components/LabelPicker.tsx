import { Check, ChevronDown, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useTrackerIntakeLabels, type TrackerLabel } from "../hooks/useTrackerIntakeLabels";

export function LabelPicker({
	projectId,
	value,
	onChange,
}: {
	projectId: string;
	value: string[];
	onChange: (labels: string[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const labelsQuery = useTrackerIntakeLabels(projectId, open);
	const options = useMemo(
		() => (labelsQuery.data ? mergeMissingLabels(labelsQuery.data.labels, value) : []),
		[labelsQuery.data?.labels, value],
	);
	const needle = search.trim().toLocaleLowerCase();
	const filtered = options.filter((label) => {
		if (needle === "") return true;
		return (
			label.name.toLocaleLowerCase().includes(needle) || (label.description ?? "").toLocaleLowerCase().includes(needle)
		);
	});
	const summary = value.length === 0 ? "All labels" : value.length === 1 ? value[0] : `${value.length} labels selected`;

	function toggle(name: string) {
		if (value.some((label) => label.toLocaleLowerCase() === name.toLocaleLowerCase())) {
			onChange(value.filter((label) => label.toLocaleLowerCase() !== name.toLocaleLowerCase()));
			return;
		}
		onChange([...value, name]);
	}

	return (
		<PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
			<PopoverPrimitive.Trigger asChild>
				<button
					type="button"
					aria-label="Labels"
					className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-interactive-hover focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
				>
					<span className="min-w-0 truncate">{summary}</span>
					<ChevronDown className="size-3.5 shrink-0 text-passive" aria-hidden="true" />
				</button>
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					align="start"
					sideOffset={6}
					className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[300px] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[var(--shadow)] data-[state=open]:animate-overlay-in"
				>
					<div className="flex gap-1.5 border-b border-border p-2">
						<label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-background px-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-weak">
							<Search className="size-3.5 shrink-0 text-passive" aria-hidden="true" />
							<input
								autoFocus
								value={search}
								onChange={(event) => setSearch(event.target.value)}
								placeholder="Search labels…"
								className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-passive"
							/>
						</label>
						<button
							type="button"
							aria-label="Refresh labels"
							disabled={labelsQuery.refresh.isPending}
							onClick={() => labelsQuery.refresh.mutate()}
							className="grid size-8 shrink-0 place-items-center rounded-md bg-raised text-muted-foreground transition hover:text-foreground disabled:opacity-50"
						>
							<RefreshCw
								className={`size-3.5 ${labelsQuery.refresh.isPending ? "animate-spin" : ""}`}
								aria-hidden="true"
							/>
						</button>
					</div>
					<div role="listbox" aria-multiselectable="true" className="max-h-64 overflow-y-auto p-1">
						{labelsQuery.isLoading ? <PickerNote>Loading labels…</PickerNote> : null}
						{labelsQuery.isError || labelsQuery.refresh.isError ? (
							<PickerNote>Could not load repository labels.</PickerNote>
						) : null}
						{!labelsQuery.isLoading && !labelsQuery.isError && filtered.length === 0 ? (
							<PickerNote>No labels found.</PickerNote>
						) : null}
						{filtered.map((label) => {
							const selected = value.some((item) => item.toLocaleLowerCase() === label.name.toLocaleLowerCase());
							return (
								<button
									key={label.name}
									type="button"
									role="option"
									aria-selected={selected}
									onClick={() => toggle(label.name)}
									className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:outline-none"
								>
									<span
										className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-[3px] border ${selected ? "border-accent bg-accent text-accent-foreground" : "border-border-strong"}`}
									>
										{selected ? <Check className="size-3" aria-hidden="true" /> : null}
									</span>
									<span
										className="mt-[5px] size-2.5 shrink-0 rounded-full"
										style={{ backgroundColor: labelColor(label.color) }}
									/>
									<span className="min-w-0">
										<span className="block truncate text-[13px] text-foreground">{label.name}</span>
										{label.description ? (
											<span className="block truncate text-[12px] text-muted-foreground">{label.description}</span>
										) : null}
									</span>
								</button>
							);
						})}
					</div>
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}

function mergeMissingLabels(labels: TrackerLabel[], selected: string[]): TrackerLabel[] {
	const names = new Set(labels.map((label) => label.name.toLocaleLowerCase()));
	const missing = selected
		.filter((name) => !names.has(name.toLocaleLowerCase()))
		.map((name) => ({ name, color: "9a9a9a", description: "No longer available in this repository" }));
	return [...missing, ...labels];
}

function labelColor(color: string): string {
	return /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "#9a9a9a";
}

function PickerNote({ children }: { children: React.ReactNode }) {
	return <div className="px-2 py-5 text-center text-[12px] text-muted-foreground">{children}</div>;
}
