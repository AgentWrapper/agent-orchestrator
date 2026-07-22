import { useEffect, useState } from "react";
import type { PredicateDraft } from "../lib/pipeline-draft";
import { PredicateBuilder, CompiledPredicateReadout } from "./PredicateBuilder";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

// PredicateBuilderModal hosts the builder + compiled readout behind a
// Cancel/Done header (mockup 1b), so V3 (routes.when) and V5 (exit predicates)
// can edit a predicate sub-tree in place. Edits stay local until Done; Cancel
// (or dismissing the dialog) discards them. onDone(undefined) means the caller
// should clear the predicate ("always").

export interface PredicateBuilderModalProps {
	open: boolean;
	title: string;
	value: PredicateDraft | undefined;
	stageNames: string[];
	onCancel: () => void;
	onDone: (value: PredicateDraft | undefined) => void;
}

export function PredicateBuilderModal({
	open,
	title,
	value,
	stageNames,
	onCancel,
	onDone,
}: PredicateBuilderModalProps) {
	const [draft, setDraft] = useState<PredicateDraft | undefined>(value);

	// Reseed the local draft each time the modal opens for a (possibly new)
	// predicate; edits while open stay local until Done.
	useEffect(() => {
		if (open) setDraft(value);
	}, [open, value]);

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
			<DialogContent showCloseButton={false} aria-describedby={undefined} className="max-w-2xl">
				<DialogHeader className="flex-row items-center justify-between">
					<DialogTitle>{title}</DialogTitle>
					<div className="flex items-center gap-2">
						<Button variant="outline" size="sm" onClick={onCancel}>
							Cancel
						</Button>
						<Button size="sm" onClick={() => onDone(draft)}>
							Done
						</Button>
					</div>
				</DialogHeader>
				<div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto">
					<PredicateBuilder value={draft} onChange={setDraft} stageNames={stageNames} />
					<CompiledPredicateReadout value={draft} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
