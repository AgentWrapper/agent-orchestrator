package executors

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// buildStagePrompt composes the pipeline-specific prompt layer injected into a
// spawned agent session: which stage it is running, in what mode, and where to
// drop structured findings so the executor can harvest them. Ported from the
// old stage-prompt.ts; kept terse because agents read it once.
//
// The findings path is documented relative to the workspace root so the agent
// does not need the absolute path.
func buildStagePrompt(pipelineName string, stage pipeline.Stage, loopRound *int, prCtx pipeline.RunContext, upstream []pipeline.Artifact) string {
	var mode pipeline.TaskMode
	if stage.Executor.Kind == pipeline.ExecutorAgent {
		mode = stage.Executor.Mode
	}

	var lines []string
	lines = append(lines, "## Pipeline Stage", "Pipeline: "+pipelineName, "Stage: "+stage.Name)
	if mode != "" {
		lines = append(lines, "Mode: "+string(mode))
	}
	if loopRound != nil {
		lines = append(lines, "Loop round: "+strconv.Itoa(*loopRound))
	}
	if stage.Policy != nil && stage.Policy.BlocksMerge != nil && *stage.Policy.BlocksMerge {
		lines = append(lines, "This stage's findings will block merge until they are resolved.")
	}

	lines = append(lines, prBlock(prCtx)...)
	lines = append(lines, upstreamFindingsBlock(upstream)...)

	if stage.Task.Prompt != "" {
		lines = append(lines, "", "## Task", stage.Task.Prompt)
	}

	if len(stage.Task.Inputs) > 0 {
		lines = append(lines, "", "## Inputs", "```json", marshalInputs(stage.Task.Inputs), "```")
	}

	lines = append(lines, "", "## Reporting Findings", formatFindingsInstructions(mode))

	return strings.Join(lines, "\n")
}

// prBlock renders a "## Pull request" section describing the run's PR when the
// context carries one, so the agent knows it is working on a specific PR branch.
// It returns nil for runs with no PR (e.g. manual triggers), leaving the prompt
// unchanged. Only the fields that are set are rendered.
func prBlock(prCtx pipeline.RunContext) []string {
	if prCtx.PRNumber == 0 && prCtx.PRURL == "" {
		return nil
	}
	lines := []string{"", "## Pull request"}
	if prCtx.PRNumber > 0 {
		lines = append(lines, "Number: #"+strconv.Itoa(prCtx.PRNumber))
	}
	if prCtx.PRURL != "" {
		lines = append(lines, "URL: "+prCtx.PRURL)
	}
	if prCtx.SourceBranch != "" || prCtx.TargetBranch != "" {
		lines = append(lines, "Branch: "+prCtx.SourceBranch+" -> "+prCtx.TargetBranch)
	}
	if prCtx.HeadSHA != "" {
		lines = append(lines, "Head SHA: "+prCtx.HeadSHA)
	}
	return lines
}

// upstreamFindingsCap bounds how many upstream findings are rendered into the
// prompt so a run with thousands of open findings does not blow the context
// window. Beyond the cap the overflow count is noted.
const upstreamFindingsCap = 100

// upstreamFindingsBlock renders an "## Upstream findings" section: one line per
// finding carrying its fingerprint, severity, stage of origin, file:line, title,
// and current status, so a summarize/verify stage can reference them by
// fingerprint in {kind:"status"} records. Returns nil when there are none,
// leaving the prompt unchanged. The section is capped at upstreamFindingsCap with
// an overflow note.
func upstreamFindingsBlock(upstream []pipeline.Artifact) []string {
	if len(upstream) == 0 {
		return nil
	}
	lines := []string{"", "## Upstream findings",
		"Findings from earlier stages this stage depends on. Reference a fingerprint below in a status record to resolve or dismiss it (see Reporting Findings)."}
	shown := upstream
	overflow := 0
	if len(shown) > upstreamFindingsCap {
		overflow = len(shown) - upstreamFindingsCap
		shown = shown[:upstreamFindingsCap]
	}
	for _, a := range shown {
		status := a.Status
		if status == "" {
			status = pipeline.ArtifactStatusOpen
		}
		lines = append(lines, fmt.Sprintf("- [%s] fp=%s (%s) %s:%d-%d %s; status: %s",
			a.Severity, a.Fingerprint, a.StageName, a.FilePath, a.StartLine, a.EndLine, a.Title, status))
	}
	if overflow > 0 {
		lines = append(lines, fmt.Sprintf("... and %d more findings not shown (cap %d).", overflow, upstreamFindingsCap))
	}
	return lines
}

// formatFindingsInstructions mirrors the old JSONL write-then-rename contract:
// the executor polls for the final file and parses it on first sight, so the
// agent must write a temp file and rename it into place to avoid the executor
// ever seeing a torn write.
func formatFindingsInstructions(mode pipeline.TaskMode) string {
	path := ".ao/" + pipeline.FindingsFilename
	tmpPath := path + ".tmp"

	blocks := []string{
		"When this stage is complete, write your findings to `" + path + "` (one JSON object per line, JSONL).",
		"Write the JSONL to `" + tmpPath + "` first, then rename it to `" + path + "` so the orchestrator never observes a partial file (e.g. `mv " + tmpPath + " " + path + "`).",
		"The orchestrator harvests this file once you go idle; without it the stage cannot complete.",
	}

	switch mode {
	case pipeline.ModeReview:
		blocks = append(blocks, `Each line must be a "finding" record with: { kind: "finding", filePath, startLine, endLine, title, description, category, severity ("error" | "warning" | "info"), confidence (0-1) }.`)
	case pipeline.ModeAnswer:
		blocks = append(blocks, `Each line must be a "json" record: { kind: "json", data: { ... } } where `+"`data`"+` matches the task's outputSchema (if any).`)
	default:
		blocks = append(blocks, `Each line must be either a "finding" or a "json" record (see ArtifactInput in the orchestrator types).`)
	}

	blocks = append(blocks,
		`To update an existing upstream finding (listed above under Upstream findings), emit a status record: { kind: "status", fingerprint: "<fp>", status: "open" | "resolved" | "dismissed" }, using a fingerprint from that list. Use "resolved" for a finding you fixed, "dismissed" for a false positive, "open" to reopen one still broken.`,
		"If there are no findings, rename an empty file. The file's existence, not its contents, is the completion signal.")

	return strings.Join(blocks, " ")
}

func marshalInputs(inputs map[string]any) string {
	b, err := json.MarshalIndent(inputs, "", "  ")
	if err != nil {
		// Inputs are free-form config; an unmarshalable value is a config bug,
		// but the prompt should still spawn. Fall back to a compact best-effort
		// rendering rather than aborting the stage.
		return "{}"
	}
	return string(b)
}
