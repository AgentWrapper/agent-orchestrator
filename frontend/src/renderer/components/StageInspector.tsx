import { useId, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Trash2, X } from "lucide-react";
import { cn } from "../lib/utils";
import { AGENT_OPTIONS } from "../lib/agent-options";
import {
	ALL_EXECUTOR_KINDS,
	ALL_WORKSPACE_KINDS,
	DEFAULT_STAGE_DEADLINE,
	SETTLED_OUTCOMES,
	type ExecutorKind,
	type StageDraft,
	type StageOutcome,
	type WorkspaceKind,
} from "../lib/pipeline-draft";
import {
	applyEnvCompletion,
	envCompletionAt,
	isAvailable,
	matchEnvVars,
	type EnvCompletion,
	type StageEnvVar,
} from "../lib/pipeline-env";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

// The stage inspector (mockup 1a, right panel): a form two-way bound to the
// selected StageDraft. Every edit calls onChange with the next stage; the
// editor area owns the draft (usePipelineDraft) and the selection
// (useStageSelection), so this component stays a pure controlled form.
//
// `needs` is not editable here: the graph lib maintains it from the inbound
// success edges (spec §9.2), so it renders read-only.
//
// The form is split per executor kind, and `credentials` renders only under
// `command`. Credentials on an agent stage is therefore impossible to express
// rather than merely rejected: the tier separation (spec §6.2) is enforced by
// the shape of the UI, not by a validation message after the fact.
//
// Two states the daemon cannot settle at edit time are warned about here:
// `produces` with a path separator (spec §13), and `workspace: session` under a
// `pr.*` trigger, which is legal but fails at plan time when the PR has no
// local session (spec §5.3).
//
// The prompt and the run script complete `$AO...` from the stage's own ambient
// set, and the Environment section lists that set in full (lib/pipeline-env.ts
// derives both). Both are resolved by the parent, which owns the draft the
// availability rules read.

export interface StageInspectorProps {
	stage: StageDraft;
	// Every stage id in the draft; candidates for onSuccess and onFailure.
	stageIds: string[];
	onChange: (next: StageDraft) => void;
	onClose?: () => void;
	// Removes the inspected stage from the draft (the parent scrubs the routing
	// keys and clears the selection). The delete button renders only when wired.
	onDelete?: () => void;
	// The pipeline declares an `on.pr` trigger, which is what makes
	// `workspace: session` a warning rather than a certainty (spec §5.3).
	prTriggered?: boolean;
	// `defaults.deadline`, shown as the deadline placeholder so the effective
	// bound is visible even when this stage does not override it (spec §13.1).
	defaultDeadline?: string;
	// The ambient `$AO_*` set for this stage (stageEnvVars), which drives both
	// the completion menu and the Environment reference. Unwired means neither
	// renders rather than a catalog guessed from partial context.
	envVars?: StageEnvVar[];
}

// A `produces` value names a file inside the stage's output directory, so a
// path separator is rejected (spec §13). Checked live here; the daemon's
// /validate stays authoritative.
export function producesError(produces: string | undefined): string | null {
	if (!produces) return null;
	if (produces.includes("/") || produces.includes("\\")) return "Must be a bare filename, no path separators.";
	return null;
}

const WORKSPACE_OPTIONS: { value: WorkspaceKind | "default"; label: string }[] = [
	{ value: "default", label: "Default" },
	...ALL_WORKSPACE_KINDS.map((kind) => ({ value: kind, label: kind })),
];

const EXECUTOR_SUBTITLE: Record<ExecutorKind, string> = {
	agent: "Agent executor",
	command: "Command executor",
};

// The engine kills the session on these outcomes when `session` is absent.
const DEFAULT_KILL_ON: StageOutcome[] = ["succeeded", "failed"];

export function StageInspector({
	stage,
	stageIds,
	onChange,
	onClose,
	onDelete,
	prTriggered,
	defaultDeadline,
	envVars = [],
}: StageInspectorProps) {
	const update = (patch: Partial<StageDraft>) => onChange({ ...stage, ...patch });

	// Swapping executor kind drops the other kind's fields so nothing the daemon
	// rejects survives in the serialized config.
	const setExecutorKind = (executor: ExecutorKind) => {
		if (executor === stage.executor) return;
		const next: StageDraft = { ...stage, executor };
		if (executor === "agent") {
			delete next.run;
			delete next.credentials;
		} else {
			delete next.agent;
			delete next.prompt;
			delete next.produces;
			delete next.session;
		}
		onChange(next);
	};

	const onSuccess = stage.onSuccess ?? [];
	const successCandidates = stageIds.filter((id) => id !== stage.id && !onSuccess.includes(id));
	const killOn = stage.session?.killOn;
	const sessionUnderPr = stage.workspace === "session" && !!prTriggered;

	return (
		<div
			data-testid="stage-inspector"
			className="flex h-full min-h-0 w-full flex-col overflow-y-auto border-l border-border bg-background"
		>
			<div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
				<div className="min-w-0">
					<h2 className="truncate text-control font-semibold text-foreground">Stage: {stage.id || "(unnamed)"}</h2>
					<p className="text-caption text-passive">{EXECUTOR_SUBTITLE[stage.executor]}</p>
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
				<Section label="Id">
					<Input
						aria-label="Stage id"
						value={stage.id}
						onChange={(e) => update({ id: e.target.value })}
						placeholder="stage-id"
					/>
				</Section>

				<Section label="Executor">
					<Segmented
						ariaLabel="Executor kind"
						options={ALL_EXECUTOR_KINDS.map((kind) => ({ value: kind, label: kind }))}
						value={stage.executor}
						onChange={setExecutorKind}
					/>
					<div className="mt-2.5">
						{stage.executor === "agent" ? (
							<AgentFields stage={stage} update={update} envVars={envVars} />
						) : (
							// `credentials` lives here and nowhere else, so an agent stage
							// cannot express it at all (spec §6.2).
							<CommandFields stage={stage} update={update} envVars={envVars} />
						)}
					</div>
				</Section>

				{envVars.length > 0 && <EnvReference vars={envVars} executor={stage.executor} />}

				{stage.executor === "agent" && (
					<Section label="Session · kill-on">
						<div className="flex items-center justify-between gap-2">
							<span className="text-caption text-muted-foreground">Override the default</span>
							<Switch
								aria-label="Override kill-on"
								checked={killOn !== undefined}
								onCheckedChange={(on) => update({ session: on ? { killOn: DEFAULT_KILL_ON } : undefined })}
							/>
						</div>
						{killOn === undefined ? (
							<p className="mt-1.5 text-caption text-passive">
								Kills the session on {DEFAULT_KILL_ON.join(" and ")}; every other outcome keeps it for inspection.
							</p>
						) : (
							<>
								<div className="mt-2 flex flex-wrap gap-1.5">
									{SETTLED_OUTCOMES.map((outcome) => {
										const active = killOn.includes(outcome);
										return (
											<button
												key={outcome}
												type="button"
												aria-pressed={active}
												onClick={() =>
													update({
														session: {
															killOn: active ? killOn.filter((o) => o !== outcome) : [...killOn, outcome],
														},
													})
												}
												className={cn(
													"rounded-md border px-2 py-0.5 font-mono text-caption transition-colors",
													active
														? "border-accent-dim bg-accent-weak text-accent"
														: "border-border bg-raised text-muted-foreground hover:text-foreground",
												)}
											>
												{outcome}
											</button>
										);
									})}
								</div>
								{killOn.length === 0 && <p className="mt-1.5 text-caption text-passive">Never kills the session.</p>}
							</>
						)}
					</Section>
				)}

				<Section label="On success">
					<div className="flex flex-wrap gap-1.5">
						{onSuccess.map((id) => (
							<Chip
								key={id}
								label={id}
								removeLabel={`Remove successor ${id}`}
								onRemove={() => {
									const next = onSuccess.filter((s) => s !== id);
									update({ onSuccess: next.length ? next : undefined });
								}}
							/>
						))}
						{successCandidates.map((id) => (
							<button
								key={id}
								type="button"
								aria-label={`Add successor ${id}`}
								onClick={() => update({ onSuccess: [...onSuccess, id] })}
								className="rounded-md border border-dashed border-border px-2 py-0.5 font-mono text-caption text-passive transition-colors hover:text-foreground"
							>
								+ {id}
							</button>
						))}
						{onSuccess.length === 0 && successCandidates.length === 0 && (
							<span className="text-caption text-passive">No other stages to route to.</span>
						)}
					</div>
				</Section>

				<Section label="On failure">
					<Select
						value={stage.onFailure ?? "__default"}
						onValueChange={(id) => update({ onFailure: id === "__default" ? undefined : id })}
					>
						<SelectTrigger size="sm" aria-label="On failure" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="__default">Pipeline default</SelectItem>
							{stageIds
								.filter((id) => id && id !== stage.id)
								.map((id) => (
									<SelectItem key={id} value={id}>
										{id}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
				</Section>

				<Section label="Needs">
					<div className="flex flex-wrap gap-1.5" data-testid="stage-needs">
						{(stage.needs ?? []).map((id) => (
							<span
								key={id}
								className="rounded-md border border-border bg-raised px-2 py-0.5 font-mono text-caption text-muted-foreground"
							>
								{id}
							</span>
						))}
						{(stage.needs ?? []).length === 0 && (
							<span className="text-caption text-passive">Set automatically from the inbound success edges.</span>
						)}
					</div>
				</Section>

				<Section label="Workspace">
					<Select
						value={stage.workspace ?? "default"}
						onValueChange={(value) => update({ workspace: value === "default" ? undefined : (value as WorkspaceKind) })}
					>
						<SelectTrigger size="sm" aria-label="Workspace" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{WORKSPACE_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{sessionUnderPr && (
						<Warning>
							This pipeline triggers on pull requests. A PR with no local session fails the run at plan time, before any
							stage starts.
						</Warning>
					)}
				</Section>

				<Section label="Deadline">
					<Input
						aria-label="Deadline"
						value={stage.deadline ?? ""}
						onChange={(e) => update({ deadline: e.target.value || undefined })}
						// Every stage has a bound; the placeholder is the one it
						// inherits, so the effective deadline is always on screen.
						placeholder={defaultDeadline || DEFAULT_STAGE_DEADLINE}
					/>
				</Section>
			</div>
		</div>
	);
}

// --- executor sub-forms ------------------------------------------------------

type FieldsProps = { stage: StageDraft; update: (patch: Partial<StageDraft>) => void; envVars: StageEnvVar[] };

function AgentFields({ stage, update, envVars }: FieldsProps) {
	const producesIssue = producesError(stage.produces);
	return (
		<div className="flex flex-col gap-2.5">
			<LabeledControl label="Agent">
				<Select value={stage.agent ?? ""} onValueChange={(agent) => update({ agent })}>
					<SelectTrigger size="sm" aria-label="Agent" className="w-full">
						<SelectValue placeholder="Select agent" />
					</SelectTrigger>
					<SelectContent>
						{AGENT_OPTIONS.map((agent) => (
							<SelectItem key={agent} value={agent}>
								{agent}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</LabeledControl>
			<LabeledControl label="Prompt">
				<EnvTextarea
					ariaLabel="Prompt"
					rows={4}
					value={stage.prompt ?? ""}
					onValueChange={(prompt) => update({ prompt: prompt || undefined })}
					placeholder="What this stage should do."
					envVars={envVars}
				/>
			</LabeledControl>
			<LabeledControl label="Produces">
				<Input
					aria-label="Produces"
					value={stage.produces ?? ""}
					onChange={(e) => update({ produces: e.target.value || undefined })}
					placeholder="review.md"
					aria-invalid={producesIssue !== null}
					className={cn(producesIssue && "border-destructive focus-visible:border-destructive")}
				/>
				{producesIssue ? (
					<span className="text-caption text-destructive">{producesIssue}</span>
				) : (
					<span className="text-caption text-passive">Written to $AO_OUTPUT and verified when the stage signals.</span>
				)}
			</LabeledControl>
		</div>
	);
}

function CommandFields({ stage, update, envVars }: FieldsProps) {
	const credentials = stage.credentials ?? [];
	// The pending chip text. The inspector is remounted per selected node, so
	// this never leaks between stages.
	const [pending, setPending] = useState("");

	// ponytail: free text, because there is no credentials catalog endpoint yet.
	// Swap the input for a picker once one exists; the daemon rejects unknown
	// names either way (spec §13).
	const commit = () => {
		const name = pending.trim();
		setPending("");
		if (!name || credentials.includes(name)) return;
		update({ credentials: [...credentials, name] });
	};

	return (
		<div className="flex flex-col gap-2.5">
			<LabeledControl label="Run">
				<EnvTextarea
					ariaLabel="Run"
					rows={4}
					value={stage.run ?? ""}
					onValueChange={(run) => update({ run: run || undefined })}
					placeholder="npm test"
					envVars={envVars}
				/>
			</LabeledControl>
			<LabeledControl label="Credentials">
				{credentials.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{credentials.map((name) => (
							<Chip
								key={name}
								label={name}
								removeLabel={`Remove credential ${name}`}
								onRemove={() => {
									const kept = credentials.filter((c) => c !== name);
									update({ credentials: kept.length ? kept : undefined });
								}}
							/>
						))}
					</div>
				)}
				<Input
					aria-label="Add credential"
					value={pending}
					onChange={(e) => setPending(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== "Enter" && e.key !== ",") return;
						e.preventDefault();
						commit();
					}}
					onBlur={commit}
					placeholder="github-release"
				/>
				<span className="text-caption text-passive">
					Injected into this stage's environment only. Agent stages cannot declare credentials.
				</span>
			</LabeledControl>
		</div>
	);
}

// --- $AO completion ----------------------------------------------------------

// EnvTextarea is the prompt / run field with the `$AO` completion menu on it.
// Typing `$AO` opens a list of this stage's ambient variables; arrow keys move,
// Enter or Tab inserts, Escape dismisses.
//
// Entries the stage will not have are listed too, greyed and with the reason,
// because the menu is where the availability model is learned. They stay
// insertable: someone completing `$AO_OUTPUT` before typing `produces:` is
// writing the stage they mean to have, and the reason is on screen either way.
function EnvTextarea({
	ariaLabel,
	value,
	onValueChange,
	envVars,
	rows,
	placeholder,
}: {
	ariaLabel: string;
	value: string;
	onValueChange: (next: string) => void;
	envVars: StageEnvVar[];
	rows: number;
	placeholder: string;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const [completion, setCompletion] = useState<EnvCompletion | null>(null);
	const [active, setActive] = useState(0);
	// The `caret:value` signature the menu must stay shut at: set by Escape and
	// by an insertion, so neither the caret move nor the resulting change event
	// reopens the menu on the token that was just completed. Cleared as soon as
	// the caret or the text moves off it.
	const closedAt = useRef<string | null>(null);
	const listId = useId();

	const matches = completion ? matchEnvVars(envVars, completion.query) : [];
	const open = matches.length > 0;
	const activeIndex = Math.min(active, matches.length - 1);

	const sync = (el: HTMLTextAreaElement) => {
		const signature = `${el.selectionStart}:${el.value}`;
		if (closedAt.current === signature) {
			setCompletion(null);
			return;
		}
		closedAt.current = null;
		const next = envCompletionAt(el.value, el.selectionStart);
		// Same token means same menu; keeping the object stable avoids a render
		// on every caret move through unrelated text.
		setCompletion((prev) => (prev?.start === next?.start && prev?.query === next?.query ? prev : next));
		setActive(0);
	};

	const insert = (chosen: StageEnvVar) => {
		const el = ref.current;
		if (!el || !completion) return;
		const next = applyEnvCompletion(el.value, completion, chosen.name);
		closedAt.current = `${next.caret}:${next.value}`;
		setCompletion(null);
		el.focus();
		el.setSelectionRange(completion.start, completion.start + 1 + completion.query.length);
		// A native insertText keeps the textarea's own undo stack: ⌘Z takes back
		// the completion and leaves the typed `$AO...` rather than clearing the
		// whole field. React sees the resulting input event like any keystroke.
		if (typeof document.execCommand === "function" && document.execCommand("insertText", false, `$${chosen.name}`)) {
			return;
		}
		// No execCommand (jsdom, and any engine that drops it): write the value
		// through, then place the caret. The DOM node is set first so React's
		// re-render finds it already correct and leaves the selection alone.
		el.value = next.value;
		el.setSelectionRange(next.caret, next.caret);
		onValueChange(next.value);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (!open) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((activeIndex + 1) % matches.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((activeIndex - 1 + matches.length) % matches.length);
		} else if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			insert(matches[activeIndex]);
		} else if (e.key === "Escape") {
			e.preventDefault();
			// The editor also listens for Escape; a dismissal is not a close.
			e.stopPropagation();
			closedAt.current = `${e.currentTarget.selectionStart}:${e.currentTarget.value}`;
			setCompletion(null);
		}
	};

	return (
		<div className="relative">
			<textarea
				ref={ref}
				aria-label={ariaLabel}
				className={textareaClass}
				rows={rows}
				value={value}
				onChange={(e) => {
					onValueChange(e.target.value);
					sync(e.target);
				}}
				// Fires on caret moves and selection changes, which is what closes
				// the menu when the caret leaves the token.
				onSelect={(e) => sync(e.currentTarget)}
				onKeyDown={onKeyDown}
				onBlur={() => setCompletion(null)}
				placeholder={placeholder}
				aria-autocomplete="list"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
			/>
			{open && (
				<ul
					id={listId}
					role="listbox"
					aria-label="Ambient variables"
					className="absolute inset-x-0 top-full z-overlay mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
				>
					{matches.map((v, i) => (
						<li
							key={v.name}
							id={`${listId}-${i}`}
							role="option"
							aria-selected={i === activeIndex}
							aria-disabled={!isAvailable(v)}
							// mousedown, not click: the textarea must keep focus so the
							// insertion lands where the caret already is.
							onMouseDown={(e) => {
								e.preventDefault();
								insert(v);
							}}
							onMouseMove={() => setActive(i)}
							className={cn(
								// bg-surface is the same token as bg-popover, so the
								// highlight is the accent wash the kill-on chips use.
								"cursor-default rounded-md px-2 py-1.5 transition-colors",
								i === activeIndex && "bg-accent-weak",
								!isAvailable(v) && "opacity-60",
							)}
						>
							<div className="flex items-baseline justify-between gap-2">
								<span className="shrink-0 font-mono text-caption text-foreground">${v.name}</span>
								{v.note && <span className="text-right text-micro text-passive">{v.note}</span>}
							</div>
							<p className="text-micro text-passive">{v.description}</p>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

// EnvReference is the same catalog without the typing: collapsed by default so
// the panel stays a form, expanded when someone wants to know what a stage
// actually gets. Collapsed by hand rather than with a primitive, because
// components/ui has no collapsible and this is one boolean.
function EnvReference({ vars, executor }: { vars: StageEnvVar[]; executor: ExecutorKind }) {
	const [open, setOpen] = useState(false);
	const reach = vars.filter(isAvailable).length;

	return (
		<Section label="Environment">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-1.5 text-caption text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRight
					className={cn("size-icon-xs shrink-0 transition-transform", open && "rotate-90")}
					aria-hidden="true"
				/>
				<span>
					{reach} of {vars.length} $AO variables reach this stage
				</span>
			</button>
			{open && (
				<>
					<ul className="mt-2 flex flex-col gap-2.5" data-testid="stage-env-reference">
						{vars.map((v) => (
							<li key={v.name} className={cn(!isAvailable(v) && "opacity-60")}>
								<div className="flex items-baseline justify-between gap-2">
									<span className="shrink-0 font-mono text-caption text-foreground">${v.name}</span>
									{v.note && <span className="text-right text-micro text-passive">{v.note}</span>}
								</div>
								<p className="text-micro text-passive">{v.description}</p>
								<p className="truncate font-mono text-micro text-passive/80" title={v.example}>
									{v.example}
								</p>
							</li>
						))}
					</ul>
					<p className="mt-3 text-caption text-passive">
						{executor === "command"
							? "The run script is shell interpolated, so $AO_OUTPUT expands before the command sees it."
							: "The prompt is handed to the agent verbatim; the agent reads these from its own environment."}{" "}
						Type $AO in the {executor === "command" ? "run script" : "prompt"} to insert one. A manual run names its own
						subject, so it can be about a session or a PR the triggers never mention.
					</p>
				</>
			)}
		</Section>
	);
}

// --- small building blocks ---------------------------------------------------

const textareaClass =
	"w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 font-mono text-caption leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak";

// Chip is a removable mono pill, the shape every stage-id-ish list in this
// panel uses (successors, credentials).
function Chip({ label, removeLabel, onRemove }: { label: string; removeLabel: string; onRemove: () => void }) {
	return (
		<span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-raised px-2 py-0.5 font-mono text-caption text-foreground">
			<span className="truncate">{label}</span>
			<button
				type="button"
				aria-label={removeLabel}
				onClick={onRemove}
				className="shrink-0 text-passive transition-colors hover:text-foreground"
			>
				<X className="size-icon-xs" aria-hidden="true" />
			</button>
		</span>
	);
}

// Warning is the edit-time caution for states the daemon accepts but a run may
// not survive; it never blocks saving.
function Warning({ children }: { children: React.ReactNode }) {
	return (
		<p className="mt-1.5 flex items-start gap-1.5 text-caption text-warning">
			<AlertTriangle className="mt-0.5 size-icon-xs shrink-0" aria-hidden="true" />
			<span>{children}</span>
		</p>
	);
}

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
