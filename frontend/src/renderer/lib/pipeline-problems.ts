// Helpers tying /validate issues and the YAML buffer to the editor's
// validation surfaces (V6): which stage an issue points at (inline node badges
// + the Problems panel's Reveal) and which YAML line a stage's block starts on
// (split view scrolls there on node select).

import type { PipelineDraft } from "./pipeline-draft";
import { stageNodeId } from "./pipeline-graph";
import type { PipelineValidationIssue } from "./pipeline-yaml";

// Issue paths from the daemon address stages positionally, then name the key:
// `stages[2].id`, `stages[2].onSuccess`, `stages[2].needs`. Only the index is
// load-bearing here, so the match stays anchored on the prefix and every v2 key
// resolves without a per-key list. Returns that stage's canvas node id (the
// index-based stage identity), or null when the path is not stage-scoped or
// points past the stage list. Stages with an empty id resolve too: "id must not
// be empty" needs a Reveal target.
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

// stageYamlLine finds the 1-based line of `id: <stage>` inside the stages
// block. Best-effort text scan (per spec); exotic quoting or an id split across
// lines just means the caller does not scroll.
export function stageYamlLine(source: string, stageId: string): number | null {
	if (!stageId) return null;
	const escaped = stageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const idLine = new RegExp(`^\\s*-?\\s*id:\\s*["']?${escaped}["']?\\s*(#.*)?$`);
	const lines = source.split("\n");
	let inStages = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^stages\s*:/.test(line)) {
			inStages = true;
			continue;
		}
		// A new top-level key ends the stages block, so a stray `id:` outside it
		// never matches.
		if (inStages && /^\S/.test(line)) inStages = false;
		if (inStages && idLine.test(line)) return i + 1;
	}
	return null;
}
