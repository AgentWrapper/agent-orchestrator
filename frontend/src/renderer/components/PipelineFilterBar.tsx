import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { RUN_STATUSES, runStatusLabel } from "../lib/pipeline-display";
import type { RunStatus } from "../lib/pipeline-draft";
import type { PipelineRunRowModel, RunEvent } from "./PipelineRunRow";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// The four dimensions the runs list narrows on, mirroring GitHub's Workflow /
// Event / Status / Branch menus. An unset dimension means "any"; the pipeline
// dimension is shared with the left rail, so selecting a pipeline in either
// place moves the same value.
export type RunFilters = {
	pipeline?: string;
	event?: RunEvent;
	status?: RunStatus;
	branch?: string;
};

export const EMPTY_RUN_FILTERS: RunFilters = {};

// What each subject kind means as a trigger, in list-reading terms.
const EVENT_LABELS: Record<RunEvent, string> = {
	pr: "Pull request",
	session: "Session",
	project: "Manual",
};

export function runEventLabel(event: RunEvent): string {
	return EVENT_LABELS[event] ?? event;
}

export function filterRunRows(rows: PipelineRunRowModel[], filters: RunFilters): PipelineRunRowModel[] {
	return rows.filter(
		(row) =>
			(!filters.pipeline || row.run.pipelineName === filters.pipeline) &&
			(!filters.event || row.event === filters.event) &&
			(!filters.status || row.status === filters.status) &&
			(!filters.branch || row.branch === filters.branch),
	);
}

// The filter row that sits in the list header. Options come from the runs the
// list actually holds, so a menu never offers a value that would empty the list;
// the exception is Status, which lists all five lifecycle states in order so the
// set of things a run can be does not shift under the cursor.
export function PipelineFilterBar({
	rows,
	filters,
	onChange,
}: {
	rows: PipelineRunRowModel[];
	filters: RunFilters;
	onChange: (next: RunFilters) => void;
}) {
	const pipelines = uniqueSorted(rows.map((row) => row.run.pipelineName));
	const events = RUN_EVENTS.filter((event) => rows.some((row) => row.event === event));
	const branches = uniqueSorted(rows.flatMap((row) => (row.branch ? [row.branch] : [])));

	return (
		<div className="flex flex-wrap items-center gap-1">
			<FilterMenu
				label="Pipeline"
				options={pipelines.map((name) => ({ value: name, label: name }))}
				value={filters.pipeline}
				onSelect={(value) => onChange({ ...filters, pipeline: value })}
			/>
			<FilterMenu
				label="Event"
				options={events.map((event) => ({ value: event, label: runEventLabel(event) }))}
				value={filters.event}
				onSelect={(value) => onChange({ ...filters, event: value as RunEvent | undefined })}
			/>
			<FilterMenu
				label="Status"
				options={RUN_STATUSES.map((status) => ({ value: status, label: runStatusLabel(status) }))}
				value={filters.status}
				onSelect={(value) => onChange({ ...filters, status: value as RunStatus | undefined })}
			/>
			<FilterMenu
				label="Branch"
				options={branches.map((branch) => ({ value: branch, label: branch }))}
				value={filters.branch}
				onSelect={(value) => onChange({ ...filters, branch: value })}
			/>
		</div>
	);
}

const RUN_EVENTS: readonly RunEvent[] = ["pr", "session", "project"];

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort();
}

// One filter dimension. The trigger shows the active value in place of the
// dimension name, which is how a narrowed list says so without a second row of
// chips underneath it.
function FilterMenu({
	label,
	options,
	value,
	onSelect,
}: {
	label: string;
	options: { value: string; label: string }[];
	value?: string;
	onSelect: (next: string | undefined) => void;
}) {
	const active = options.find((option) => option.value === value);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					disabled={options.length === 0}
					className={cn("gap-1", active && "text-accent hover:text-accent")}
				>
					<span className="max-w-40 truncate">{active ? `${label}: ${active.label}` : label}</span>
					<ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
				<DropdownMenuItem onSelect={() => onSelect(undefined)}>
					<Check className={cn("size-3.5", value === undefined ? "opacity-100" : "opacity-0")} />
					Any {label.toLowerCase()}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				{options.map((option) => (
					<DropdownMenuItem
						key={option.value}
						onSelect={() => onSelect(option.value === value ? undefined : option.value)}
					>
						<Check className={cn("size-3.5", option.value === value ? "opacity-100" : "opacity-0")} />
						<span className="truncate">{option.label}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
