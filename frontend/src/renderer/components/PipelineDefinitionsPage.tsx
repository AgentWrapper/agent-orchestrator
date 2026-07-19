import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { apiErrorMessage } from "../lib/api-client";
import { formatTimeCompact } from "../lib/format-time";
import type { StageDraft } from "../lib/pipeline-draft";
import { issueStageName, stageIssueMessages, stageYamlLine } from "../lib/pipeline-problems";
import {
	countStagesFromYaml,
	DEFAULT_PIPELINE_YAML,
	parsePipelineValidationIssues,
	type PipelineValidationIssue,
} from "../lib/pipeline-yaml";
import {
	type PipelineDefinitionSummary,
	usePipelineDefinitionMutations,
	usePipelineDefinitionsQuery,
} from "../hooks/usePipelineDefinitions";
import { usePipelineDraft, type PipelineDraftValidation } from "../hooks/usePipelineDraft";
import { useStageSelection } from "../hooks/useStageSelection";
import { ConfirmDialog } from "./ConfirmDialog";
import { PipelineCanvas } from "./PipelineCanvas";
import { PipelineProblemsPanel, type PipelineProblem } from "./PipelineProblemsPanel";
import { PipelineSettingsModal } from "./PipelineSettingsModal";
import { PredicateBuilderModal } from "./PredicateBuilderModal";
import { StageInspector } from "./StageInspector";
import { YamlEditor } from "./YamlEditor";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "../lib/utils";

// The definition editor's view modes (mockups 1a/1c): the node-graph canvas
// (with the stage inspector on selection), a side-by-side canvas+YAML split
// with two-way sync, and the raw YAML editor.
type ViewMode = "canvas" | "split" | "yaml";

// One of: browsing the list, editing an existing definition, or drafting a new
// one. The editor buffer lives in EditorView while a draft is open, so switching
// modes here is what mounts/unmounts the CodeMirror instance.
type Mode = { kind: "list" } | { kind: "edit"; def: PipelineDefinitionSummary } | { kind: "create" };

// The Definitions tab: a list of the project's stored pipelines plus a CodeMirror
// YAML editor for create/update. Server-side validation is authoritative; on
// save we surface the daemon's per-issue error list inline and keep the buffer.
export function PipelineDefinitionsPage({ projectId }: { projectId?: string }) {
	const definitionsQuery = usePipelineDefinitionsQuery(projectId);
	const [mode, setMode] = useState<Mode>({ kind: "list" });

	if (mode.kind !== "list" && projectId) {
		return (
			<DefinitionEditor
				projectId={projectId}
				def={mode.kind === "edit" ? mode.def : null}
				onClose={() => setMode({ kind: "list" })}
			/>
		);
	}

	const definitions = definitionsQuery.data ?? [];

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between px-4.5 pt-4">
				<p className="text-md-sm text-passive">
					Pipeline definitions authored as YAML. A run snapshots its definition at trigger time.
				</p>
				<Button size="sm" variant="primary" disabled={!projectId} onClick={() => setMode({ kind: "create" })}>
					<Plus className="size-icon-md" aria-hidden="true" />
					New pipeline
				</Button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4.5">
				{!projectId ? (
					<p className="py-10 text-center text-xs text-passive">Select a project to view its pipelines.</p>
				) : definitionsQuery.isLoading ? (
					<p className="py-10 text-center text-xs text-passive">Loading pipelines…</p>
				) : definitionsQuery.isError ? (
					<p className="py-10 text-center text-xs text-error">
						Could not load pipelines. {apiErrorMessage(definitionsQuery.error)}
					</p>
				) : definitions.length === 0 ? (
					<p className="py-10 text-center text-xs text-passive">
						No pipelines yet. Click <span className="text-foreground">New pipeline</span> to author one.
					</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="w-24 text-right">Stages</TableHead>
								<TableHead className="w-32">Updated</TableHead>
								<TableHead className="w-24 text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{definitions.map((def) => (
								<DefinitionRow
									key={def.id}
									def={def}
									projectId={projectId}
									onEdit={() => setMode({ kind: "edit", def })}
								/>
							))}
						</TableBody>
					</Table>
				)}
			</div>
		</div>
	);
}

function DefinitionRow({
	def,
	projectId,
	onEdit,
}: {
	def: PipelineDefinitionSummary;
	projectId: string;
	onEdit: () => void;
}) {
	const { remove } = usePipelineDefinitionMutations(projectId);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const stageCount = countStagesFromYaml(def.yamlSource);

	return (
		<TableRow className="cursor-pointer" onClick={onEdit}>
			<TableCell className="max-w-0">
				<div className="truncate text-control text-foreground">{def.name || "(unnamed)"}</div>
				<div className="truncate font-mono text-micro text-passive">{def.id}</div>
			</TableCell>
			<TableCell className="text-right font-mono text-xs text-muted-foreground">{stageCount ?? "-"}</TableCell>
			<TableCell className="text-caption text-passive">{formatTimeCompact(def.updatedAt)}</TableCell>
			<TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
				<div className="flex items-center justify-end gap-1">
					<Button size="sm" variant="ghost" className="h-6 px-2 text-caption" onClick={onEdit}>
						<Pencil className="size-icon-sm" aria-hidden="true" />
						Edit
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-caption text-destructive hover:text-destructive"
						onClick={() => setConfirmOpen(true)}
						aria-label={`Delete ${def.name || def.id}`}
					>
						<Trash2 className="size-icon-sm" aria-hidden="true" />
					</Button>
				</div>
				<ConfirmDialog
					open={confirmOpen}
					onOpenChange={(open) => {
						if (!remove.isPending) setConfirmOpen(open);
					}}
					title="Delete pipeline"
					description={
						<p className="text-sm text-muted-foreground">
							Delete <strong className="text-foreground">{def.name || def.id}</strong>? Runs already triggered keep
							their snapshot; this only removes the definition.
						</p>
					}
					confirmLabel={remove.isPending ? "Deleting…" : "Delete"}
					destructive
					busy={remove.isPending}
					error={remove.isError ? apiErrorMessage(remove.error) : null}
					size="sm"
					onConfirm={() =>
						remove.mutate(def.id, {
							onSuccess: () => setConfirmOpen(false),
						})
					}
				/>
			</TableCell>
		</TableRow>
	);
}

function DefinitionEditor({
	projectId,
	def,
	onClose,
}: {
	projectId: string;
	def: PipelineDefinitionSummary | null;
	onClose: () => void;
}) {
	const { create, update } = usePipelineDefinitionMutations(projectId);
	const { yamlSource, setYamlSource, draft, parseError, setDraft, validation } = usePipelineDraft(
		def ? def.yamlSource : DEFAULT_PIPELINE_YAML,
	);
	// One selection instance for the editor area: the canvas writes on node
	// click, the stage inspector (V3) binds to the same stage name.
	const selection = useStageSelection();
	const [view, setView] = useState<ViewMode>("yaml");
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Issues a rejected save reported; live validation covers the same ground,
	// so these only matter in the race where a save beat the debounce. Cleared
	// on the next buffer change (they describe a buffer that no longer exists).
	const [saveIssues, setSaveIssues] = useState<PipelineValidationIssue[] | null>(null);
	const [genericError, setGenericError] = useState<string | null>(null);
	const [conditionOpen, setConditionOpen] = useState(false);

	useEffect(() => setSaveIssues(null), [yamlSource]);

	const mutation = def ? update : create;
	const isSaving = mutation.isPending;

	const selectedIndex = selection.selectedStage
		? draft.stages.findIndex((s) => s.name === selection.selectedStage)
		: -1;
	const selectedStageDraft = selectedIndex >= 0 ? draft.stages[selectedIndex] : null;
	const stageNames = draft.stages.map((s) => s.name).filter(Boolean);

	// Inspector edits replace the selected stage in place; a rename moves the
	// selection with the stage (names are the selection identity).
	const updateSelectedStage = (next: StageDraft) => {
		if (selectedIndex < 0) return;
		setDraft({ ...draft, stages: draft.stages.map((s, i) => (i === selectedIndex ? next : s)) });
		if (next.name !== selection.selectedStage) selection.selectStage(next.name || null);
	};

	// The blocking problem list (mockup 1d): the YAML parse error, the live
	// /validate issues, and any leftover save-rejection issues, each resolved to
	// the stage it points at so Reveal and the node badges can target it.
	const liveIssues = validation.valid === false ? validation.issues : EMPTY_ISSUES;
	const problems: PipelineProblem[] = [
		...(parseError ? [{ path: "", message: `YAML syntax error: ${parseError}`, stage: null }] : []),
		...dedupeIssues([...liveIssues, ...(saveIssues ?? [])]).map((issue) => ({
			path: issue.path,
			message: issue.message,
			stage: issueStageName(draft, issue),
		})),
	];
	const stageIssues = useMemo(
		() => stageIssueMessages(draft, [...liveIssues, ...(saveIssues ?? [])]),
		[draft, liveIssues, saveIssues],
	);
	// Save is gated on blocking problems (mockup 1d: "must resolve before
	// saving"); "still checking" alone does not block.
	const blocked = problems.length > 0;

	// Reveal + node select scroll the YAML pane to the stage's block. The buffer
	// is read through a ref so scrolling happens on selection changes only, not
	// on every keystroke.
	const yamlRef = useRef(yamlSource);
	yamlRef.current = yamlSource;
	const revealLine = useMemo(
		() => (selection.selectedStage ? stageYamlLine(yamlRef.current, selection.selectedStage) : null),
		[selection.selectedStage],
	);

	// Save serializes the draft to config and reuses the existing create/update
	// endpoints. In YAML mode the buffer IS that config verbatim (so raw
	// formatting survives); canvas/inspector edits reserialize through setDraft.
	const save = () => {
		setSaveIssues(null);
		setGenericError(null);
		const onError = (error: unknown) => {
			const parsed = parsePipelineValidationIssues(error);
			if (parsed) setSaveIssues(parsed);
			else setGenericError(apiErrorMessage(error));
		};
		if (def) update.mutate({ id: def.id, yamlSource }, { onSuccess: onClose, onError });
		else create.mutate(yamlSource, { onSuccess: onClose, onError });
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between gap-3 border-b border-border px-4.5 py-3">
				<div className="min-w-0">
					<h2 className="truncate text-control font-semibold text-foreground">
						{def ? `Edit ${def.name || def.id}` : "New pipeline"}
					</h2>
					<p className="text-caption text-passive">YAML validated live by the daemon.</p>
				</div>
				<div className="flex shrink-0 items-center gap-3">
					<ViewToggle value={view} onChange={setView} />
					<Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
						<Settings2 className="size-icon-sm" aria-hidden="true" />
						Settings
					</Button>
					<ValidityIndicator validation={validation} problemCount={problems.length} />
					<Button size="sm" variant="ghost" onClick={onClose} disabled={isSaving}>
						Cancel
					</Button>
					<Button size="sm" variant="primary" onClick={save} disabled={isSaving || blocked}>
						{isSaving && <Loader2 className="size-icon-sm animate-spin" aria-hidden="true" />}
						{isSaving ? "Saving…" : "Save"}
					</Button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden bg-surface/40">
				{view === "canvas" ? (
					<div className="flex h-full min-h-0">
						<div className="min-w-0 flex-1">
							<PipelineCanvas draft={draft} onDraftChange={setDraft} selection={selection} stageIssues={stageIssues} />
						</div>
						{selectedStageDraft && (
							<div className="w-80 shrink-0">
								<StageInspector
									stage={selectedStageDraft}
									stageNames={stageNames}
									onChange={updateSelectedStage}
									onEditCondition={() => setConditionOpen(true)}
									onClose={() => selection.selectStage(null)}
								/>
							</div>
						)}
					</div>
				) : view === "split" ? (
					<div className="flex h-full min-h-0">
						<div className="min-w-0 flex-1 border-r border-border">
							<PipelineCanvas draft={draft} onDraftChange={setDraft} selection={selection} stageIssues={stageIssues} />
						</div>
						<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
							<div
								data-testid="yaml-parse-status"
								className="flex shrink-0 items-center justify-end border-b border-border px-3 py-1"
							>
								{parseError ? (
									<span className="truncate font-mono text-micro text-error">YAML error: {parseError}</span>
								) : (
									<span className="font-mono text-micro text-success">✓ parsed</span>
								)}
							</div>
							<div className="min-h-0 flex-1 overflow-hidden">
								<YamlEditor
									value={yamlSource}
									onChange={setYamlSource}
									revealLine={revealLine}
									aria-label="Pipeline YAML"
									className="px-1 py-2"
								/>
							</div>
						</div>
					</div>
				) : (
					<YamlEditor
						value={yamlSource}
						onChange={setYamlSource}
						revealLine={revealLine}
						aria-label="Pipeline YAML"
						className="px-1 py-2"
					/>
				)}
			</div>

			<PipelineSettingsModal
				open={settingsOpen}
				value={draft}
				onCancel={() => setSettingsOpen(false)}
				onDone={(next) => {
					setDraft(next);
					setSettingsOpen(false);
				}}
			/>

			{genericError && (
				<div className="flex items-start gap-2 border-t border-destructive/40 bg-destructive/10 px-4.5 py-2.5 text-caption text-destructive">
					<AlertCircle className="mt-0.5 size-icon-sm shrink-0" aria-hidden="true" />
					<span>{genericError}</span>
				</div>
			)}

			<PipelineProblemsPanel problems={problems} onReveal={(stage) => selection.selectStage(stage)} />

			{selectedStageDraft && (
				<PredicateBuilderModal
					open={conditionOpen}
					title={`Run condition · ${selectedStageDraft.name || "(unnamed)"}`}
					value={selectedStageDraft.routes?.when}
					stageNames={stageNames}
					onCancel={() => setConditionOpen(false)}
					onDone={(value) => {
						setConditionOpen(false);
						const { routes: _routes, ...rest } = selectedStageDraft;
						updateSelectedStage(value ? { ...selectedStageDraft, routes: { when: value } } : rest);
					}}
				/>
			)}
		</div>
	);
}

// A save rejection and the live validation of the same buffer report the same
// issues; keep one row each.
const EMPTY_ISSUES: PipelineValidationIssue[] = [];
function dedupeIssues(issues: PipelineValidationIssue[]): PipelineValidationIssue[] {
	const seen = new Set<string>();
	return issues.filter((issue) => {
		const key = `${issue.path} ${issue.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// ViewToggle is the top-bar Canvas / Split / YAML segmented control (mockups
// 1a/1c). A plain radiogroup of buttons keyed to the app tokens.
const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
	{ value: "canvas", label: "Canvas" },
	{ value: "split", label: "Split" },
	{ value: "yaml", label: "YAML" },
];

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (next: ViewMode) => void }) {
	return (
		<div role="radiogroup" aria-label="Editor view" className="flex items-center rounded-md border border-border p-0.5">
			{VIEW_OPTIONS.map((opt) => (
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

// ValidityIndicator is the top-bar Valid / N-problems status (mockups 1a/1d),
// counting every blocking problem the panel shows (validate issues + YAML
// parse errors), not just the last validate response.
function ValidityIndicator({
	validation,
	problemCount,
}: {
	validation: PipelineDraftValidation;
	problemCount: number;
}) {
	if (problemCount > 0) {
		return (
			<span
				className="flex items-center gap-1 rounded-full border border-error/40 bg-error/10 px-2 py-0.5 text-caption text-error"
				aria-live="polite"
			>
				<AlertCircle className="size-icon-sm" aria-hidden="true" />
				{`${problemCount} ${problemCount === 1 ? "problem" : "problems"}`}
			</span>
		);
	}
	if (validation.isValidating) {
		return (
			<span className="flex items-center gap-1 text-caption text-passive" aria-live="polite">
				<Loader2 className="size-icon-sm animate-spin" aria-hidden="true" />
				Checking…
			</span>
		);
	}
	if (validation.valid === true) {
		return (
			<span className="flex items-center gap-1 text-caption text-success" aria-live="polite">
				<CheckCircle2 className="size-icon-sm" aria-hidden="true" />
				Valid
			</span>
		);
	}
	if (validation.valid === false) {
		return (
			<span className="flex items-center gap-1 text-caption text-warning" aria-live="polite">
				<AlertCircle className="size-icon-sm" aria-hidden="true" />
				Invalid
			</span>
		);
	}
	return null;
}
