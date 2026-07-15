// Client-side helpers for the Pipelines Definitions UI. Server-side validation
// is the source of truth (spec §4b); these only shape wire values for display.

export type PipelineValidationIssue = { path: string; message: string };

// Pull the full per-issue list out of the daemon's validation error. On a 422
// the pipelines controller sets code=PIPELINE_VALIDATION_FAILED and stashes the
// issues under details.issues (path + message per issue) so the editor can
// surface every problem at once. Returns null for any other error shape.
export function parsePipelineValidationIssues(error: unknown): PipelineValidationIssue[] | null {
	if (typeof error !== "object" || error === null) return null;
	const body = error as { code?: unknown; details?: unknown };
	if (body.code !== "PIPELINE_VALIDATION_FAILED") return null;
	const details = body.details;
	if (typeof details !== "object" || details === null) return null;
	const issues = (details as { issues?: unknown }).issues;
	if (!Array.isArray(issues)) return [];
	return issues.flatMap((raw) => {
		if (typeof raw !== "object" || raw === null) return [];
		const { path, message } = raw as { path?: unknown; message?: unknown };
		return [
			{
				path: typeof path === "string" ? path : "",
				message: typeof message === "string" ? message : String(message ?? ""),
			},
		];
	});
}

// Best-effort stage count for the definitions list. The definition summary the
// API returns carries only the raw YAML (no normalized config), so we count the
// block-style entries under the top-level `stages:` list, plus the inline
// `stages: []` / `stages: [a, b]` forms the schema editor can produce.
//
// ponytail: heuristic YAML scan, not a real parser. Handles the block + simple
// inline shapes the editor authors; returns null when it can't tell (caller
// renders "-"). Upgrade path: have the API expose a stageCount field on
// PipelineDefinitionSummary (informed to orchestrator) and drop this.
export function countStagesFromYaml(source: string): number | null {
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const match = /^(\s*)stages\s*:(.*)$/.exec(lines[i]);
		if (!match) continue;
		const keyIndent = match[1].length;
		const inline = match[2].trim();

		// Inline flow sequence: `stages: []` or `stages: [a, b]`.
		if (inline.startsWith("[")) {
			const inner = inline
				.replace(/^\[/, "")
				.replace(/\][^\]]*$/, "")
				.trim();
			return inner === "" ? 0 : inner.split(",").filter((part) => part.trim() !== "").length;
		}
		// Anything else on the line (a scalar, an anchor) is not a block list.
		if (inline !== "") return null;

		// Block sequence: count `- ` items at the child indent until we dedent
		// back to or past the `stages:` key.
		let itemIndent = -1;
		let count = 0;
		for (let j = i + 1; j < lines.length; j += 1) {
			const line = lines[j];
			if (line.trim() === "") continue;
			const indent = line.length - line.trimStart().length;
			if (indent <= keyIndent) break;
			const isItem = /^-(\s|$)/.test(line.trimStart());
			if (itemIndent === -1 && isItem) itemIndent = indent;
			if (isItem && indent === itemIndent) count += 1;
		}
		return count;
	}
	return null;
}

// Starter document offered when creating a new definition, so the editor is
// never empty and authors get a valid-shaped skeleton to edit.
export const DEFAULT_PIPELINE_YAML = `name: my-pipeline
stages:
  - name: review
    trigger:
      on: [manual]
    executor:
      kind: agent
      plugin: claude-code
      mode: review
`;
