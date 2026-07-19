import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { ExitPredicatesDraft, PipelineDraft, PredicateDraft } from "../lib/pipeline-draft";
import { cn } from "../lib/utils";
import { CompiledPredicateReadout, PredicateBuilder } from "./PredicateBuilder";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

// PipelineSettingsModal edits the pipeline-level draft fields (mockup 1b top):
// Name, Max concurrent (stepper, min 1), Allow fork PRs, plus the three exit
// conditions (done / stalled / blocksMerge), each authored with V4's
// PredicateBuilder over its optional slot in draft.exitPredicates. An unset
// condition is valid ("no condition"). Edits stay local until Done, which hands
// the caller the updated draft to commit through usePipelineDraft's setDraft;
// Cancel (or dismissing) discards them.

export interface PipelineSettingsModalProps {
	open: boolean;
	value: PipelineDraft;
	onCancel: () => void;
	onDone: (value: PipelineDraft) => void;
}

type ExitKey = keyof ExitPredicatesDraft;

const EXIT_TABS: { key: ExitKey; dotClass: string; caption: string }[] = [
	{ key: "done", dotClass: "bg-success", caption: "Run is done when…" },
	{ key: "stalled", dotClass: "bg-error", caption: "Run is stalled when…" },
	{ key: "blocksMerge", dotClass: "bg-warning", caption: "Run blocks merge when…" },
];

export function PipelineSettingsModal({ open, value, onCancel, onDone }: PipelineSettingsModalProps) {
	const [draft, setDraft] = useState<PipelineDraft>(value);
	const [tab, setTab] = useState<ExitKey>("done");

	// Reseed the local draft each time the modal opens; edits while open stay
	// local until Done (same convention as PredicateBuilderModal).
	useEffect(() => {
		if (open) {
			setDraft(value);
			setTab("done");
		}
	}, [open, value]);

	const stageNames = draft.stages.map((s) => s.name).filter(Boolean);

	const setMaxConcurrent = (n: number | undefined) => {
		const next = { ...draft };
		if (n === undefined || !Number.isFinite(n)) delete next.maxConcurrentStages;
		else next.maxConcurrentStages = Math.max(1, Math.trunc(n));
		setDraft(next);
	};

	const setExit = (key: ExitKey, predicate: PredicateDraft | undefined) => {
		const exitPredicates: ExitPredicatesDraft = { ...draft.exitPredicates };
		if (predicate) exitPredicates[key] = predicate;
		else delete exitPredicates[key];
		const next = { ...draft };
		// All three unset means no exitPredicates at all, so the field round-trips
		// as absent instead of an empty mapping.
		if (Object.keys(exitPredicates).length > 0) next.exitPredicates = exitPredicates;
		else delete next.exitPredicates;
		setDraft(next);
	};

	const maxConcurrent = draft.maxConcurrentStages;

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
			<DialogContent showCloseButton={false} aria-describedby={undefined} className="max-w-3xl">
				<DialogHeader className="flex-row items-center justify-between">
					<div className="min-w-0">
						<DialogTitle>Pipeline settings</DialogTitle>
						<p className="mt-0.5 truncate text-caption text-passive">
							{draft.name || "untitled"} · exit conditions decide when the loop ends
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button variant="outline" size="sm" onClick={onCancel}>
							Cancel
						</Button>
						<Button size="sm" onClick={() => onDone(draft)}>
							Done
						</Button>
					</div>
				</DialogHeader>

				<div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						<label className="flex flex-col gap-1.5">
							<FieldLabel>Name</FieldLabel>
							<Input
								aria-label="Pipeline name"
								value={draft.name}
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							/>
						</label>

						<div className="flex flex-col gap-1.5">
							<FieldLabel>Max concurrent</FieldLabel>
							<div className="flex h-control-form items-center gap-1 rounded-md border border-border bg-surface px-1">
								<Input
									type="number"
									min={1}
									aria-label="Max concurrent"
									className="h-full flex-1 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
									value={maxConcurrent ?? ""}
									onChange={(e) => setMaxConcurrent(e.target.value === "" ? undefined : Number(e.target.value))}
								/>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Decrease max concurrent"
									disabled={(maxConcurrent ?? 1) <= 1}
									onClick={() => setMaxConcurrent((maxConcurrent ?? 2) - 1)}
								>
									<Minus className="size-icon-sm" aria-hidden="true" />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Increase max concurrent"
									onClick={() => setMaxConcurrent((maxConcurrent ?? 0) + 1)}
								>
									<Plus className="size-icon-sm" aria-hidden="true" />
								</Button>
							</div>
						</div>

						<div className="flex flex-col gap-1.5">
							<FieldLabel>Allow fork PRs</FieldLabel>
							<div className="flex h-control-form items-center gap-2 rounded-md border border-border bg-surface px-2.5">
								<Switch
									aria-label="Allow fork PRs"
									checked={draft.allowForkPRs ?? false}
									onCheckedChange={(checked) => setDraft({ ...draft, allowForkPRs: checked })}
								/>
								<span className="text-xs text-muted-foreground">{draft.allowForkPRs ? "On" : "Off"}</span>
							</div>
						</div>
					</div>

					<div className="flex flex-col gap-2">
						<FieldLabel>Exit conditions</FieldLabel>
						<Tabs value={tab} onValueChange={(next) => setTab(next as ExitKey)}>
							<div className="flex items-center justify-between gap-2">
								<TabsList>
									{EXIT_TABS.map(({ key, dotClass }) => (
										<TabsTrigger key={key} value={key} className="gap-1.5 font-mono">
											<span className={cn("size-1.5 rounded-full", dotClass)} aria-hidden="true" />
											{key}
										</TabsTrigger>
									))}
								</TabsList>
								<span className="text-caption text-passive">{EXIT_TABS.find((t) => t.key === tab)?.caption}</span>
							</div>
							{EXIT_TABS.map(({ key }) => (
								<TabsContent key={key} value={key} className="mt-2 flex flex-col gap-3">
									<PredicateBuilder
										value={draft.exitPredicates?.[key]}
										onChange={(predicate) => setExit(key, predicate)}
										stageNames={stageNames}
									/>
									<CompiledPredicateReadout value={draft.exitPredicates?.[key]} />
								</TabsContent>
							))}
						</Tabs>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function FieldLabel({ children }: { children: React.ReactNode }) {
	return <span className="font-mono text-micro font-medium uppercase tracking-wide text-passive">{children}</span>;
}
