import { AlertCircle } from "lucide-react";
import { Button } from "./ui/button";

// The Problems panel (mockup 1d): docked under the editor surface, one row per
// blocking problem with the config path, the message, and a Reveal action that
// selects the offending stage (the canvas highlights it, the split view scrolls
// the YAML to its block, the inspector opens on it in canvas view).

export interface PipelineProblem {
	// Dotted config path; "" for document-level problems (YAML parse errors).
	path: string;
	message: string;
	// Stage the problem resolves to, when it does; enables the Reveal action.
	stage: string | null;
}

export function PipelineProblemsPanel({
	problems,
	onReveal,
}: {
	problems: PipelineProblem[];
	onReveal: (stage: string) => void;
}) {
	if (problems.length === 0) return null;
	return (
		<div
			data-testid="problems-panel"
			className="max-h-48 shrink-0 overflow-y-auto border-t border-border bg-surface/60"
		>
			<div className="flex items-center justify-between px-4.5 pt-2.5 pb-1.5">
				<p className="flex items-center gap-1.5 text-caption font-semibold text-foreground">
					Problems
					<span className="rounded-full bg-error/15 px-1.5 font-mono text-2xs text-error">{problems.length}</span>
				</p>
				<p className="text-caption text-passive">Must resolve before saving</p>
			</div>
			<ul>
				{problems.map((problem, i) => (
					<li
						key={`${problem.path}-${i}`}
						className="flex items-start gap-2 border-t border-border/50 px-4.5 py-2 text-caption"
					>
						<AlertCircle className="mt-0.5 size-icon-sm shrink-0 text-error" aria-hidden="true" />
						<span className="min-w-0 flex-1">
							{problem.path && <span className="font-mono text-muted-foreground">{problem.path}</span>}
							{problem.path && ": "}
							<span className="text-foreground">{problem.message}</span>
						</span>
						{problem.stage && (
							<Button
								size="sm"
								variant="ghost"
								className="h-5 shrink-0 px-2 text-caption text-accent hover:text-accent"
								onClick={() => onReveal(problem.stage!)}
							>
								Reveal
							</Button>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
