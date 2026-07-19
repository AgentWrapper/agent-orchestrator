// Helpers tying /validate issues and the YAML buffer to the editor's
// validation surfaces (V6): which stage an issue points at (inline node badges
// + the Problems panel's Reveal) and which YAML line a stage's block starts on
// (split view scrolls there on node select).

import type { PipelineDraft } from "./pipeline-draft";
import { stageNodeId } from "./pipeline-graph";
import type { PipelineValidationIssue } from "./pipeline-yaml";

// Issue paths from the daemon address stages positionally: `stages[2].name`.
// Returns that stage's canvas node id (the index-based stage identity), or
// null when the path is not stage-scoped or points past the stage list.
// Unnamed stages resolve too: "name must not be empty" needs a Reveal target.
export function issueStageNodeId(draft: PipelineDraft, issue: PipelineValidationIssue): string | null {
	const match = /^stages\[(\d+)\]/.exec(issue.path);
	if (!match) return null;
	const index = Number(match[1]);
	return index < draft.stages.length ? stageNodeId(index) : null;
}

// Groups issue messages by the node id they resolve to, for the canvas badges.
export function stageIssueMessages(draft: PipelineDraft, issues: PipelineValidationIssue[]): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const issue of issues) {
		const id = issueStageNodeId(draft, issue);
		if (id === null) continue;
		(out[id] ??= []).push(issue.message);
	}
	return out;
}

// stageYamlLine finds the 1-based line of `name: <stage>` inside the stages
// block. Best-effort text scan (per spec); exotic quoting or a name split
// across lines just means the caller does not scroll.
export function stageYamlLine(source: string, stageName: string): number | null {
	if (!stageName) return null;
	const escaped = stageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const nameLine = new RegExp(`^\\s*-?\\s*name:\\s*["']?${escaped}["']?\\s*(#.*)?$`);
	const lines = source.split("\n");
	let inStages = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^stages\s*:/.test(line)) {
			inStages = true;
			continue;
		}
		// A new top-level key ends the stages block (so the pipeline-level
		// `name:` never matches a stage of the same name).
		if (inStages && /^\S/.test(line)) inStages = false;
		if (inStages && nameLine.test(line)) return i + 1;
	}
	return null;
}
