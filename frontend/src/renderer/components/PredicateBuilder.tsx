import { XIcon } from "lucide-react";
import type { PredicateDraft, PredicateKind, Severity, Verdict } from "../lib/pipeline-draft";
import { compilePredicateToText } from "../lib/predicate-text";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// PredicateBuilder is the recursive rule-builder over the predicate DSL
// (mockup 1b): and/or groups render as "Match ALL/ANY of the following" boxes
// with +Condition / +Group / not(…) wrap / remove, leaves render one row per
// predicate kind with that kind's inputs (predicate.go is the authoritative
// field set). It is a pure controlled component; V3 (routes.when) and V5 (exit
// predicates) reuse it through PredicateBuilderModal. An undefined value is the
// valid "always" start state.

export interface PredicateBuilderProps {
	value: PredicateDraft | undefined;
	onChange: (value: PredicateDraft | undefined) => void;
	stageNames: string[];
}

type LeafKind = Exclude<PredicateKind, "and" | "or" | "not">;

const LEAF_KINDS: { kind: LeafKind; label: string }[] = [
	{ kind: "no_open_findings", label: "no open findings" },
	{ kind: "stage_verdict", label: "stage verdict" },
	{ kind: "all_pass", label: "all pass" },
	{ kind: "any_pass", label: "any pass" },
	{ kind: "majority_pass", label: "majority pass" },
	{ kind: "finding_count_below", label: "finding count below" },
	{ kind: "loop_rounds_at_least", label: "loop rounds at least" },
	{ kind: "stage_retried_at_least", label: "stage retried at least" },
];

const SEVERITIES: Severity[] = ["error", "warning", "info"];
const VERDICTS: Verdict[] = ["pass", "fail", "neutral"];

// Sentinel for "field unset" in single-selects; radix Select forbids the empty
// string as an item value.
const ANY = "__any__";

// defaultLeaf seeds a freshly added or kind-switched row with that kind's
// required fields so the row is valid (or one pick away from valid) at birth.
function defaultLeaf(kind: LeafKind, stageNames: string[]): PredicateDraft {
	switch (kind) {
		case "all_pass":
		case "any_pass":
		case "majority_pass":
			return { kind, stages: [] };
		case "no_open_findings":
			return { kind };
		case "finding_count_below":
			return { kind, max: 1 };
		case "loop_rounds_at_least":
			return { kind, n: 1 };
		case "stage_retried_at_least":
			return stageNames[0] ? { kind, stage: stageNames[0], n: 1 } : { kind, n: 1 };
		case "stage_verdict":
			return stageNames[0] ? { kind, stage: stageNames[0], verdict: "pass" } : { kind, verdict: "pass" };
	}
}

function newCondition(stageNames: string[]): PredicateDraft {
	return defaultLeaf("no_open_findings", stageNames);
}

// New groups start with one condition: an and/or with zero predicates is
// invalid config, so never create one.
function newGroup(stageNames: string[]): PredicateDraft {
	return { kind: "and", predicates: [newCondition(stageNames)] };
}

export function PredicateBuilder({ value, onChange, stageNames }: PredicateBuilderProps) {
	if (!value) {
		return (
			<div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border p-3">
				<p className="text-xs text-muted-foreground">No condition · always matches.</p>
				<div className="flex items-center gap-1">
					<Button variant="ghost" size="sm" className="text-accent" onClick={() => onChange(newCondition(stageNames))}>
						+ Condition
					</Button>
					<Button variant="ghost" size="sm" onClick={() => onChange(newGroup(stageNames))}>
						+ Group
					</Button>
				</div>
			</div>
		);
	}
	return (
		<PredicateNode value={value} onChange={onChange} onRemove={() => onChange(undefined)} stageNames={stageNames} />
	);
}

interface NodeProps {
	value: PredicateDraft;
	onChange: (value: PredicateDraft) => void;
	onRemove: () => void;
	stageNames: string[];
}

function PredicateNode(props: NodeProps) {
	if (props.value.kind === "and" || props.value.kind === "or") return <GroupNode {...props} />;
	if (props.value.kind === "not") return <NotNode {...props} />;
	return <LeafRow {...props} />;
}

function GroupNode({ value, onChange, onRemove, stageNames }: NodeProps) {
	const children = value.predicates ?? [];
	const setChildren = (predicates: PredicateDraft[]) => onChange({ ...value, predicates });

	return (
		<div
			className={cn(
				"flex flex-col gap-2 rounded-md border border-border border-l-2 bg-surface/50 p-3",
				value.kind === "and" ? "border-l-accent" : "border-l-warning",
			)}
		>
			<div className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground">Match</span>
				<Select value={value.kind} onValueChange={(kind) => onChange({ ...value, kind: kind as "and" | "or" })}>
					<SelectTrigger
						size="sm"
						aria-label="Group type"
						className={cn("font-mono text-xs font-medium", value.kind === "and" ? "text-accent" : "text-warning")}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="and">ALL</SelectItem>
						<SelectItem value="or">ANY</SelectItem>
					</SelectContent>
				</Select>
				<span className="text-xs text-muted-foreground">of the following</span>
				<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Remove group" onClick={onRemove}>
					<XIcon className="size-icon-base" />
				</Button>
			</div>

			{children.map((child, i) => (
				<PredicateNode
					// ponytail: index keys; rows are only appended/removed, never reordered.
					key={i}
					value={child}
					stageNames={stageNames}
					onChange={(next) => setChildren(children.map((c, j) => (j === i ? next : c)))}
					onRemove={() => setChildren(children.filter((_, j) => j !== i))}
				/>
			))}

			<div className="flex items-center gap-1">
				<Button
					variant="ghost"
					size="sm"
					className="text-accent"
					onClick={() => setChildren([...children, newCondition(stageNames)])}
				>
					+ Condition
				</Button>
				<Button variant="ghost" size="sm" onClick={() => setChildren([...children, newGroup(stageNames)])}>
					+ Group
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="ml-auto font-mono text-xs"
					aria-label="Wrap group in not"
					onClick={() => onChange({ kind: "not", predicate: value })}
				>
					not(…) wrap
				</Button>
			</div>
		</div>
	);
}

function NotNode({ value, onChange, onRemove, stageNames }: NodeProps) {
	return (
		<div className="flex flex-col gap-2 rounded-md border border-border border-l-2 border-l-error bg-surface/50 p-3">
			<div className="flex items-center gap-2">
				<span className="font-mono text-xs font-medium text-error">not(…)</span>
				{value.predicate && (
					<Button variant="ghost" size="sm" aria-label="Unwrap not" onClick={() => onChange(value.predicate!)}>
						Unwrap
					</Button>
				)}
				<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Remove not" onClick={onRemove}>
					<XIcon className="size-icon-base" />
				</Button>
			</div>
			{value.predicate ? (
				<PredicateNode
					value={value.predicate}
					stageNames={stageNames}
					onChange={(next) => onChange({ kind: "not", predicate: next })}
					// A not without its inner predicate is invalid, so removing the child
					// removes the whole wrapper.
					onRemove={onRemove}
				/>
			) : (
				<Button
					variant="ghost"
					size="sm"
					className="self-start text-accent"
					onClick={() => onChange({ kind: "not", predicate: newCondition(stageNames) })}
				>
					+ Condition
				</Button>
			)}
		</div>
	);
}

function LeafRow({ value, onChange, onRemove, stageNames }: NodeProps) {
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-2">
			<Select value={value.kind} onValueChange={(kind) => onChange(defaultLeaf(kind as LeafKind, stageNames))}>
				<SelectTrigger size="sm" aria-label="Condition kind" className="font-mono text-xs">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{LEAF_KINDS.map(({ kind, label }) => (
						<SelectItem key={kind} value={kind}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<LeafFields value={value} onChange={onChange} stageNames={stageNames} />

			<span className="ml-auto flex items-center">
				<Button
					variant="ghost"
					size="sm"
					className="font-mono text-xs"
					aria-label="Wrap condition in not"
					onClick={() => onChange({ kind: "not", predicate: value })}
				>
					not(…)
				</Button>
				<Button variant="ghost" size="icon-sm" aria-label="Remove condition" onClick={onRemove}>
					<XIcon className="size-icon-base" />
				</Button>
			</span>
		</div>
	);
}

function LeafFields({ value, onChange, stageNames }: Omit<NodeProps, "onRemove">) {
	switch (value.kind) {
		case "all_pass":
		case "any_pass":
		case "majority_pass":
			return (
				<StageMultiSelect
					stages={value.stages ?? []}
					stageNames={stageNames}
					onChange={(stages) => onChange({ ...value, stages })}
				/>
			);
		case "no_open_findings":
			return (
				<>
					<span className="text-xs text-passive">scope</span>
					<OptionalStageSelect value={value} onChange={onChange} stageNames={stageNames} />
				</>
			);
		case "finding_count_below":
			return (
				<>
					<span className="text-xs text-passive">fewer than</span>
					<NumberField field="max" min={0} label="Max findings" value={value} onChange={onChange} />
					<SeveritySelect value={value} onChange={onChange} />
					<span className="text-xs text-passive">in</span>
					<OptionalStageSelect value={value} onChange={onChange} stageNames={stageNames} />
				</>
			);
		case "loop_rounds_at_least":
			return <NumberField field="n" min={1} label="Rounds" value={value} onChange={onChange} />;
		case "stage_retried_at_least":
			return (
				<>
					<RequiredStageSelect value={value} onChange={onChange} stageNames={stageNames} />
					<span className="text-xs text-passive">at least</span>
					<NumberField field="n" min={1} label="Retries" value={value} onChange={onChange} />
				</>
			);
		case "stage_verdict":
			return (
				<>
					<RequiredStageSelect value={value} onChange={onChange} stageNames={stageNames} />
					<span className="text-xs text-passive">is</span>
					<VerdictSelect value={value} onChange={onChange} />
				</>
			);
		default:
			return null;
	}
}

function StageMultiSelect({
	stages,
	stageNames,
	onChange,
}: {
	stages: string[];
	stageNames: string[];
	onChange: (stages: string[]) => void;
}) {
	const remaining = stageNames.filter((s) => !stages.includes(s));
	return (
		<>
			{stages.map((stage) => (
				<span
					key={stage}
					className="inline-flex items-center gap-1 rounded-md border border-border bg-raised px-2 py-0.5 font-mono text-xs text-foreground"
				>
					{stage}
					<button
						type="button"
						aria-label={`Remove stage ${stage}`}
						className="text-muted-foreground hover:text-foreground"
						onClick={() => onChange(stages.filter((s) => s !== stage))}
					>
						<XIcon className="size-3" />
					</button>
				</span>
			))}
			{/* Controlled to "" so the trigger snaps back to the placeholder after each add. */}
			<Select value="" onValueChange={(stage) => onChange([...stages, stage])}>
				<SelectTrigger size="sm" aria-label="Add stage" className="text-xs" disabled={remaining.length === 0}>
					<SelectValue placeholder="add stage…" />
				</SelectTrigger>
				<SelectContent>
					{remaining.map((stage) => (
						<SelectItem key={stage} value={stage}>
							{stage}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</>
	);
}

function OptionalStageSelect({ value, onChange, stageNames }: Omit<NodeProps, "onRemove">) {
	return (
		<Select
			value={value.stage ?? ANY}
			onValueChange={(v) => {
				const next = { ...value };
				if (v === ANY) delete next.stage;
				else next.stage = v;
				onChange(next);
			}}
		>
			<SelectTrigger size="sm" aria-label="Stage scope" className="text-xs">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ANY}>any stage</SelectItem>
				{stageNames.map((stage) => (
					<SelectItem key={stage} value={stage}>
						{stage}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function RequiredStageSelect({ value, onChange, stageNames }: Omit<NodeProps, "onRemove">) {
	return (
		<Select value={value.stage ?? ""} onValueChange={(stage) => onChange({ ...value, stage })}>
			<SelectTrigger size="sm" aria-label="Stage" className="text-xs">
				<SelectValue placeholder="stage…" />
			</SelectTrigger>
			<SelectContent>
				{stageNames.map((stage) => (
					<SelectItem key={stage} value={stage}>
						{stage}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function SeveritySelect({ value, onChange }: { value: PredicateDraft; onChange: (v: PredicateDraft) => void }) {
	return (
		<Select
			value={value.severity ?? ANY}
			onValueChange={(v) => {
				const next = { ...value };
				if (v === ANY) delete next.severity;
				else next.severity = v as Severity;
				onChange(next);
			}}
		>
			<SelectTrigger size="sm" aria-label="Severity" className="text-xs">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ANY}>any severity</SelectItem>
				{SEVERITIES.map((severity) => (
					<SelectItem key={severity} value={severity}>
						{severity}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function VerdictSelect({ value, onChange }: { value: PredicateDraft; onChange: (v: PredicateDraft) => void }) {
	return (
		<Select
			value={value.verdict ?? ""}
			onValueChange={(verdict) => onChange({ ...value, verdict: verdict as Verdict })}
		>
			<SelectTrigger size="sm" aria-label="Verdict" className="text-xs">
				<SelectValue placeholder="verdict…" />
			</SelectTrigger>
			<SelectContent>
				{VERDICTS.map((verdict) => (
					<SelectItem key={verdict} value={verdict}>
						{verdict}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function NumberField({
	field,
	min,
	label,
	value,
	onChange,
}: {
	field: "max" | "n";
	min: number;
	label: string;
	value: PredicateDraft;
	onChange: (v: PredicateDraft) => void;
}) {
	return (
		<Input
			type="number"
			min={min}
			aria-label={label}
			className="h-control-md w-16 px-2 text-xs"
			value={value[field] ?? ""}
			onChange={(e) => {
				const parsed = e.target.value === "" ? NaN : Number(e.target.value);
				const next = { ...value };
				// An emptied required number stays unset; the readout shows "?" and
				// the daemon's /validate flags it.
				if (Number.isFinite(parsed)) next[field] = Math.max(min, Math.trunc(parsed));
				else delete next[field];
				onChange(next);
			}}
		/>
	);
}

// CompiledPredicateReadout is the live "Compiled predicate · matches the DSL"
// panel under the builder (mockup 1b). Display only.
export function CompiledPredicateReadout({ value }: { value: PredicateDraft | undefined }) {
	return (
		<div className="rounded-md border border-border bg-surface p-3">
			<p className="font-mono text-micro font-medium uppercase tracking-wide text-passive">
				Compiled predicate · matches the DSL
			</p>
			<pre
				data-testid="compiled-predicate"
				className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-foreground"
			>
				{compilePredicateToText(value, { pretty: true })}
			</pre>
		</div>
	);
}
