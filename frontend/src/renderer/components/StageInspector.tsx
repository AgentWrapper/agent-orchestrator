import { useId, useState } from "react";
import { Pencil, Trash2, X } from "lucide-react";
import { cn } from "../lib/utils";
import { AGENT_OPTIONS } from "../lib/agent-options";
import {
	ALL_EXECUTOR_KINDS,
	ALL_TRIGGER_EVENTS,
	type BuiltinName,
	type ExecutorKind,
	type StageDraft,
	type StagePolicyDraft,
	type StageTriggerEvent,
	type TaskDraft,
	type TaskMode,
	type WorkspaceMode,
} from "../lib/pipeline-draft";
import { summarizePredicate } from "../lib/predicate-summary";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

// The stage inspector (mockup 1a, right panel): a form two-way bound to the
// selected StageDraft. Every edit calls onChange with the next stage; the
// editor area owns the draft (usePipelineDraft) and the selection
// (useStageSelection), so this component stays a pure controlled form. The
// routes.when block is a read-only summary; the predicate builder is V4 and is
// wired in through onEditCondition by Batch C (undefined until then).

export interface StageInspectorProps {
	stage: StageDraft;
	// All stage names in the draft; candidates for dependsOn.
	stageNames: string[];
	onChange: (next: StageDraft) => void;
	// Opens the V4 predicate builder for routes.when. Left unwired until Batch
	// C; while undefined the Edit-condition button is a disabled coming-soon stub.
	onEditCondition?: () => void;
	onClose?: () => void;
	// Removes the inspected stage from the draft (the parent scrubs dependsOn
	// and clears the selection). The delete button renders only when wired.
	onDelete?: () => void;
}

const TASK_MODES: TaskMode[] = ["review", "code", "answer"];
const BUILTIN_NAMES: BuiltinName[] = ["router", "compose"];
const WORKSPACE_OPTIONS: { value: WorkspaceMode | "default"; label: string }[] = [
	{ value: "default", label: "Default" },
	{ value: "shared-ro", label: "shared-ro" },
	{ value: "isolated-rw", label: "isolated-rw" },
];

const EXECUTOR_SUBTITLE: Record<ExecutorKind, string> = {
	agent: "Agent executor",
	command: "Command executor",
	builtin: "Builtin executor",
};

export function StageInspector({
	stage,
	stageNames,
	onChange,
	onEditCondition,
	onClose,
	onDelete,
}: StageInspectorProps) {
	const update = (patch: Partial<StageDraft>) => onChange({ ...stage, ...patch });

	// Merges a task patch and drops the task object entirely once every field is
	// empty, so an untouched stage serializes without a dangling `task:`.
	const updateTask = (patch: Partial<TaskDraft>) => {
		const task: TaskDraft = { ...stage.task, ...patch };
		const empty = !task.prompt && task.outputSchema === undefined && task.inputs === undefined;
		update({ task: empty ? undefined : task });
	};

	const updateBudget = (patch: { maxUsd?: number; maxDurationMs?: number }) => {
		const budget = { ...stage.budget, ...patch };
		const empty = budget.maxUsd === undefined && budget.maxDurationMs === undefined;
		update({ budget: empty ? undefined : budget });
	};

	const updatePolicy = (patch: Partial<StagePolicyDraft>) => {
		const policy = { ...stage.policy, ...patch };
		const empty = !policy.blocksMerge && policy.stallWindow === undefined;
		update({ policy: empty ? undefined : policy });
	};

	// Swapping executor kind rewrites the sub-object from scratch so no other
	// kind's fields leak into the serialized config (the daemon rejects them).
	const setExecutorKind = (kind: ExecutorKind) => {
		if (kind !== stage.executor.kind) update({ executor: { kind } });
	};

	const toggleTrigger = (event: StageTriggerEvent) => {
		const on = stage.trigger.on.includes(event)
			? stage.trigger.on.filter((e) => e !== event)
			: [...stage.trigger.on, event];
		update({ trigger: { on } });
	};

	const dependsOn = stage.dependsOn ?? [];
	const dependsOnCandidates = stageNames.filter((name) => name !== stage.name && !dependsOn.includes(name));

	return (
		<div
			data-testid="stage-inspector"
			className="flex h-full min-h-0 w-full flex-col overflow-y-auto border-l border-border bg-background"
		>
			<div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
				<div className="min-w-0">
					<h2 className="truncate text-control font-semibold text-foreground">Stage: {stage.name || "(unnamed)"}</h2>
					<p className="text-caption text-passive">{EXECUTOR_SUBTITLE[stage.executor.kind]}</p>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{onDelete && (
						<Button
							size="icon-sm"
							variant="ghost"
							className="text-destructive hover:text-destructive"
							onClick={onDelete}
							aria-label="Delete stage"
						>
							<Trash2 className="size-icon-sm" aria-hidden="true" />
						</Button>
					)}
					{onClose && (
						<Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close inspector">
							<X className="size-icon-sm" aria-hidden="true" />
						</Button>
					)}
				</div>
			</div>

			<div className="flex flex-col gap-5 px-4 py-4">
				<Section label="Name">
					<Input
						aria-label="Stage name"
						value={stage.name}
						onChange={(e) => update({ name: e.target.value })}
						placeholder="stage-name"
					/>
				</Section>

				<Section label="Trigger · on">
					<div className="flex flex-wrap gap-1.5">
						{ALL_TRIGGER_EVENTS.map((event) => {
							const active = stage.trigger.on.includes(event);
							return (
								<button
									key={event}
									type="button"
									aria-pressed={active}
									onClick={() => toggleTrigger(event)}
									className={cn(
										"rounded-md border px-2 py-0.5 font-mono text-caption transition-colors",
										active
											? "border-accent-dim bg-accent-weak text-accent"
											: "border-border bg-raised text-muted-foreground hover:text-foreground",
									)}
								>
									{event}
								</button>
							);
						})}
					</div>
				</Section>

				<Section label="Executor">
					<Segmented
						ariaLabel="Executor kind"
						options={ALL_EXECUTOR_KINDS.map((kind) => ({ value: kind, label: kind }))}
						value={stage.executor.kind}
						onChange={setExecutorKind}
					/>
					<div className="mt-2.5">
						{stage.executor.kind === "agent" && <AgentFields stage={stage} update={update} />}
						{stage.executor.kind === "command" && <CommandFields stage={stage} update={update} />}
						{stage.executor.kind === "builtin" && <BuiltinFields stage={stage} update={update} />}
					</div>
				</Section>

				<Section label="Task · prompt">
					<textarea
						aria-label="Task prompt"
						className={textareaClass}
						rows={4}
						value={stage.task?.prompt ?? ""}
						onChange={(e) => updateTask({ prompt: e.target.value || undefined })}
						placeholder="What this stage should do."
					/>
					<div className="mt-2 flex flex-col gap-2">
						<JsonField
							key={`schema-${stage.name}`}
							label="Output schema"
							value={stage.task?.outputSchema}
							onCommit={(outputSchema) => updateTask({ outputSchema })}
						/>
						<JsonField
							key={`inputs-${stage.name}`}
							label="Inputs"
							value={stage.task?.inputs}
							onCommit={(inputs) => updateTask({ inputs })}
						/>
					</div>
				</Section>

				<Section label="Depends on">
					<div className="flex flex-wrap gap-1.5">
						{dependsOn.map((name) => (
							<span
								key={name}
								className="inline-flex items-center gap-1 rounded-md border border-border bg-raised px-2 py-0.5 font-mono text-caption text-foreground"
							>
								{name}
								<button
									type="button"
									aria-label={`Remove dependency ${name}`}
									onClick={() => {
										const next = dependsOn.filter((d) => d !== name);
										update({ dependsOn: next.length ? next : undefined });
									}}
									className="text-passive transition-colors hover:text-foreground"
								>
									<X className="size-icon-xs" aria-hidden="true" />
								</button>
							</span>
						))}
						{dependsOnCandidates.map((name) => (
							<button
								key={name}
								type="button"
								aria-label={`Add dependency ${name}`}
								onClick={() => update({ dependsOn: [...dependsOn, name] })}
								className="rounded-md border border-dashed border-border px-2 py-0.5 font-mono text-caption text-passive transition-colors hover:text-foreground"
							>
								+ {name}
							</button>
						))}
						{dependsOn.length === 0 && dependsOnCandidates.length === 0 && (
							<span className="text-caption text-passive">No other stages to depend on.</span>
						)}
					</div>
				</Section>

				<Section label="Routes · when">
					<div className="rounded-md border border-border bg-surface/60 px-3 py-2.5">
						<p className="text-caption text-muted-foreground">Run this stage only when</p>
						<p className="mt-1 font-mono text-caption text-warning" data-testid="routes-when-summary">
							{summarizePredicate(stage.routes?.when)}
						</p>
						<Button
							size="sm"
							variant="ghost"
							className="mt-1.5 -ml-2 h-6 px-2 text-caption text-accent hover:text-accent"
							disabled={!onEditCondition}
							title={onEditCondition ? undefined : "Predicate builder coming soon"}
							onClick={onEditCondition}
						>
							<Pencil className="size-icon-xs" aria-hidden="true" />
							Edit condition{onEditCondition ? "" : " · coming soon"}
						</Button>
					</div>
				</Section>

				<Section label="Workspace">
					<Segmented
						ariaLabel="Workspace mode"
						options={WORKSPACE_OPTIONS}
						value={stage.workspace ?? "default"}
						onChange={(value) => update({ workspace: value === "default" ? undefined : value })}
					/>
				</Section>

				<Section label="Policy">
					<div className="flex flex-col gap-2.5">
						<div className="flex items-center justify-between gap-2">
							<span className="text-caption text-muted-foreground">Blocks merge</span>
							<Switch
								aria-label="Blocks merge"
								checked={!!stage.policy?.blocksMerge}
								onCheckedChange={(blocksMerge) => updatePolicy({ blocksMerge })}
							/>
						</div>
						<NumberField
							label="Stall window (rounds)"
							value={stage.policy?.stallWindow}
							onCommit={(stallWindow) => updatePolicy({ stallWindow })}
						/>
						<p className="text-caption text-passive">
							Number of consecutive loop rounds with the same finding fingerprint set before the run is treated as
							converged (stalled).
						</p>
					</div>
				</Section>

				<Section label="Advanced knobs">
					<div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
						<NumberField label="Retries" value={stage.retries} onCommit={(retries) => update({ retries })} />
						<NumberField label="Timeout (ms)" value={stage.timeoutMs} onCommit={(timeoutMs) => update({ timeoutMs })} />
						<NumberField
							label="Max rounds"
							value={stage.maxLoopRounds}
							onCommit={(maxLoopRounds) => update({ maxLoopRounds })}
						/>
						<NumberField
							label="Budget · max USD"
							value={stage.budget?.maxUsd}
							onCommit={(maxUsd) => updateBudget({ maxUsd })}
						/>
						<NumberField
							label="Budget · max duration (ms)"
							value={stage.budget?.maxDurationMs}
							onCommit={(maxDurationMs) => updateBudget({ maxDurationMs })}
						/>
					</div>
				</Section>
			</div>
		</div>
	);
}

// --- executor sub-forms ------------------------------------------------------

type FieldsProps = { stage: StageDraft; update: (patch: Partial<StageDraft>) => void };

function AgentFields({ stage, update }: FieldsProps) {
	const executor = stage.executor;
	return (
		<div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
			<LabeledControl label="Plugin">
				<Select value={executor.plugin ?? ""} onValueChange={(plugin) => update({ executor: { ...executor, plugin } })}>
					<SelectTrigger size="sm" aria-label="Plugin" className="w-full">
						<SelectValue placeholder="Select plugin" />
					</SelectTrigger>
					<SelectContent>
						{AGENT_OPTIONS.map((plugin) => (
							<SelectItem key={plugin} value={plugin}>
								{plugin}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</LabeledControl>
			<LabeledControl label="Mode">
				<Select
					value={executor.mode ?? ""}
					onValueChange={(mode) => update({ executor: { ...executor, mode: mode as TaskMode } })}
				>
					<SelectTrigger size="sm" aria-label="Mode" className="w-full">
						<SelectValue placeholder="Select mode" />
					</SelectTrigger>
					<SelectContent>
						{TASK_MODES.map((mode) => (
							<SelectItem key={mode} value={mode}>
								{mode}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</LabeledControl>
		</div>
	);
}

function CommandFields({ stage, update }: FieldsProps) {
	const executor = stage.executor;
	return (
		<div className="flex flex-col gap-2.5">
			<LabeledControl label="Command">
				<Input
					aria-label="Command"
					value={executor.command ?? ""}
					onChange={(e) => update({ executor: { ...executor, command: e.target.value || undefined } })}
					placeholder="npm"
				/>
			</LabeledControl>
			<LabeledControl label="Args (one per line)">
				<textarea
					key={`args-${stage.name}`}
					aria-label="Args"
					className={textareaClass}
					rows={2}
					defaultValue={(executor.args ?? []).join("\n")}
					onChange={(e) => {
						const args = e.target.value
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean);
						update({ executor: { ...executor, args: args.length ? args : undefined } });
					}}
					placeholder={"test\n--ci"}
				/>
			</LabeledControl>
			<LabeledControl label="Env (KEY=VALUE per line)">
				<textarea
					key={`env-${stage.name}`}
					aria-label="Env"
					className={textareaClass}
					rows={2}
					defaultValue={Object.entries(executor.env ?? {})
						.map(([k, v]) => `${k}=${v}`)
						.join("\n")}
					onChange={(e) => update({ executor: { ...executor, env: parseEnvLines(e.target.value) } })}
					placeholder="CI=1"
				/>
			</LabeledControl>
			<LabeledControl label="Working directory">
				<Input
					aria-label="Working directory"
					value={executor.cwd ?? ""}
					onChange={(e) => update({ executor: { ...executor, cwd: e.target.value || undefined } })}
					placeholder="(repo root)"
				/>
			</LabeledControl>
		</div>
	);
}

function BuiltinFields({ stage, update }: FieldsProps) {
	const executor = stage.executor;
	return (
		<LabeledControl label="Builtin">
			<Select
				value={executor.name ?? ""}
				onValueChange={(name) => update({ executor: { ...executor, name: name as BuiltinName } })}
			>
				<SelectTrigger size="sm" aria-label="Builtin name" className="w-full">
					<SelectValue placeholder="Select builtin" />
				</SelectTrigger>
				<SelectContent>
					{BUILTIN_NAMES.map((name) => (
						<SelectItem key={name} value={name}>
							{name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</LabeledControl>
	);
}

// --- small building blocks ---------------------------------------------------

const textareaClass =
	"w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 font-mono text-caption leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section>
			<h3 className="mb-1.5 font-mono text-micro font-medium uppercase tracking-wide text-passive">{label}</h3>
			{children}
		</section>
	);
}

function LabeledControl({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span className="text-caption text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}

function Segmented<T extends string>({
	ariaLabel,
	options,
	value,
	onChange,
}: {
	ariaLabel: string;
	options: { value: T; label: string }[];
	value: T;
	onChange: (next: T) => void;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={ariaLabel}
			className="flex w-fit items-center rounded-md border border-border p-0.5"
		>
			{options.map((opt) => (
				<button
					key={opt.value}
					type="button"
					role="radio"
					aria-checked={value === opt.value}
					onClick={() => onChange(opt.value)}
					className={cn(
						"rounded px-2.5 py-1 text-caption font-medium transition-colors",
						value === opt.value ? "bg-accent/15 text-foreground" : "text-muted-foreground hover:text-foreground",
					)}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}

function NumberField({
	label,
	value,
	onCommit,
}: {
	label: string;
	value: number | undefined;
	onCommit: (next: number | undefined) => void;
}) {
	const id = useId();
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<label htmlFor={id} className="text-caption text-muted-foreground">
				{label}
			</label>
			<Input
				id={id}
				type="number"
				value={value ?? ""}
				onChange={(e) => {
					if (e.target.value === "") return onCommit(undefined);
					const n = Number(e.target.value);
					if (Number.isFinite(n)) onCommit(n);
				}}
			/>
		</div>
	);
}

// JsonField edits an optional Record<string, unknown> as JSON text. The buffer
// is local so partial JSON can be typed freely; only a parseable object (or an
// emptied field) commits to the draft, anything else just shows the invalid
// hint until it parses again.
function JsonField({
	label,
	value,
	onCommit,
}: {
	label: string;
	value: Record<string, unknown> | undefined;
	onCommit: (next: Record<string, unknown> | undefined) => void;
}) {
	const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value, null, 2));
	const [invalid, setInvalid] = useState(false);
	const id = useId();

	const handleChange = (next: string) => {
		setText(next);
		if (next.trim() === "") {
			setInvalid(false);
			onCommit(undefined);
			return;
		}
		try {
			const parsed: unknown = JSON.parse(next);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				setInvalid(false);
				onCommit(parsed as Record<string, unknown>);
			} else {
				setInvalid(true);
			}
		} catch {
			setInvalid(true);
		}
	};

	return (
		<div className="flex min-w-0 flex-col gap-1">
			<label htmlFor={id} className="text-caption text-muted-foreground">
				{label} <span className="text-passive">(JSON, optional)</span>
				{invalid && <span className="ml-1 text-warning">invalid JSON</span>}
			</label>
			<textarea
				id={id}
				className={cn(textareaClass, invalid && "border-warning/60")}
				rows={2}
				value={text}
				onChange={(e) => handleChange(e.target.value)}
				placeholder="{ }"
			/>
		</div>
	);
}

function parseEnvLines(text: string): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		// ponytail: lines without KEY= are ignored while typing; /validate is the
		// authoritative check, this field never blocks input.
		if (eq <= 0) continue;
		out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
	}
	return Object.keys(out).length ? out : undefined;
}
