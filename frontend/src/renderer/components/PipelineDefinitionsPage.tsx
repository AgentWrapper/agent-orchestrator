import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { apiErrorMessage } from "../lib/api-client";
import { formatTimeCompact } from "../lib/format-time";
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
import { ConfirmDialog } from "./ConfirmDialog";
import { PipelineCanvas } from "./PipelineCanvas";
import { YamlEditor } from "./YamlEditor";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "../lib/utils";

// The definition editor's view modes (mockups 1a/1c): the node-graph canvas, a
// side-by-side canvas+YAML split, and the raw YAML editor. V1 fills in YAML mode
// end to end; Canvas/Split mount placeholders that V2/V6 flesh out.
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
	const { yamlSource, setYamlSource, draft, validation } = usePipelineDraft(
		def ? def.yamlSource : DEFAULT_PIPELINE_YAML,
	);
	const [view, setView] = useState<ViewMode>("yaml");
	const [issues, setIssues] = useState<PipelineValidationIssue[] | null>(null);
	const [genericError, setGenericError] = useState<string | null>(null);

	const mutation = def ? update : create;
	const isSaving = mutation.isPending;

	// Save serializes the draft to config and reuses the existing create/update
	// endpoints. In YAML mode the buffer IS that config verbatim (so raw
	// formatting survives); a canvas-only edit path (V2+) would setYamlSource via
	// the draft first.
	const save = () => {
		setIssues(null);
		setGenericError(null);
		const onError = (error: unknown) => {
			const parsed = parsePipelineValidationIssues(error);
			if (parsed) setIssues(parsed);
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
					<ValidityIndicator validation={validation} />
					<Button size="sm" variant="ghost" onClick={onClose} disabled={isSaving}>
						Cancel
					</Button>
					<Button size="sm" variant="primary" onClick={save} disabled={isSaving}>
						{isSaving && <Loader2 className="size-icon-sm animate-spin" aria-hidden="true" />}
						{isSaving ? "Saving…" : "Save"}
					</Button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden bg-surface/40">
				{view === "canvas" ? (
					<PipelineCanvas draft={draft} />
				) : view === "split" ? (
					<div className="flex h-full min-h-0">
						<div className="min-w-0 flex-1 border-r border-border">
							<PipelineCanvas draft={draft} />
						</div>
						<div className="min-h-0 flex-1 overflow-hidden">
							<YamlEditor
								value={yamlSource}
								onChange={setYamlSource}
								aria-label="Pipeline YAML"
								className="px-1 py-2"
							/>
						</div>
					</div>
				) : (
					<YamlEditor value={yamlSource} onChange={setYamlSource} aria-label="Pipeline YAML" className="px-1 py-2" />
				)}
			</div>

			{genericError && (
				<div className="flex items-start gap-2 border-t border-destructive/40 bg-destructive/10 px-4.5 py-2.5 text-caption text-destructive">
					<AlertCircle className="mt-0.5 size-icon-sm shrink-0" aria-hidden="true" />
					<span>{genericError}</span>
				</div>
			)}

			{issues && (
				<div className="max-h-48 shrink-0 overflow-y-auto border-t border-warning/40 bg-warning/10 px-4.5 py-3">
					<p className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold text-warning">
						<AlertCircle className="size-icon-sm" aria-hidden="true" />
						{issues.length === 0
							? "Validation failed"
							: `${issues.length} validation ${issues.length === 1 ? "issue" : "issues"}`}
					</p>
					<ul className="space-y-1">
						{issues.map((issue, i) => (
							<li key={`${issue.path}-${i}`} className="text-caption text-foreground">
								{issue.path && <span className="font-mono text-warning">{issue.path}</span>}
								{issue.path && ": "}
								<span className="text-muted-foreground">{issue.message}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
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

// ValidityIndicator is the placeholder Valid / N-problems status wired to the
// draft hook's live validation. V6 expands this into the full Problems panel.
function ValidityIndicator({ validation }: { validation: PipelineDraftValidation }) {
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
		const n = validation.issues.length;
		return (
			<span className="flex items-center gap-1 text-caption text-warning" aria-live="polite">
				<AlertCircle className="size-icon-sm" aria-hidden="true" />
				{n === 0 ? "Invalid" : `${n} ${n === 1 ? "problem" : "problems"}`}
			</span>
		);
	}
	return null;
}
