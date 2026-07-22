package executors

import (
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

func agentStage(mode pipeline.TaskMode) pipeline.Stage {
	return pipeline.Stage{
		Name:     "review",
		Executor: pipeline.StageExecutor{Kind: pipeline.ExecutorAgent, Plugin: "claude", Mode: mode},
		Task:     pipeline.TaskSpec{Prompt: "Look for bugs."},
	}
}

func upstreamFinding(stage, fp, sev, file, title string, status pipeline.ArtifactStatus) pipeline.Artifact {
	return pipeline.Artifact{
		ArtifactInput: pipeline.ArtifactInput{
			Kind: pipeline.ArtifactKindFinding, FilePath: file, StartLine: 10, EndLine: 12,
			Title: title, Severity: pipeline.Severity(sev),
		},
		StageName: stage, Fingerprint: fp, Status: status,
	}
}

func TestBuildStagePrompt_UpstreamFindingsSection(t *testing.T) {
	upstream := []pipeline.Artifact{
		upstreamFinding("scan", "fp-open", "error", "src/a.go", "leak", pipeline.ArtifactStatusOpen),
		upstreamFinding("scan", "fp-dismissed", "warning", "src/b.go", "nit", pipeline.ArtifactStatusDismissed),
	}
	got := buildStagePrompt("ci", agentStage(pipeline.ModeReview), nil, pipeline.RunContext{}, upstream)

	for _, want := range []string{
		"## Upstream findings",
		"fp=fp-open",
		"(scan)",
		"src/a.go:10-12",
		"leak",
		"status: open",
		"fp=fp-dismissed",
		"status: dismissed",
		// the reporting contract must teach the status-record vocabulary
		`{ kind: "status", fingerprint:`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing %q\n---\n%s", want, got)
		}
	}
}

func TestBuildStagePrompt_NoUpstreamNoSection(t *testing.T) {
	got := buildStagePrompt("ci", agentStage(pipeline.ModeReview), nil, pipeline.RunContext{}, nil)
	if strings.Contains(got, "## Upstream findings") {
		t.Errorf("no dependsOn artifacts must not render an Upstream findings section\n%s", got)
	}
}

func TestBuildStagePrompt_UpstreamFindingsCap(t *testing.T) {
	var upstream []pipeline.Artifact
	for i := 0; i < upstreamFindingsCap+25; i++ {
		upstream = append(upstream, upstreamFinding("scan", "fp", "info", "src/x.go", "t", pipeline.ArtifactStatusOpen))
	}
	got := buildStagePrompt("ci", agentStage(pipeline.ModeReview), nil, pipeline.RunContext{}, upstream)
	if !strings.Contains(got, "and 25 more findings not shown") {
		t.Errorf("expected overflow note for cap %d\n%s", upstreamFindingsCap, got)
	}
	if n := strings.Count(got, "- [info] fp=fp"); n != upstreamFindingsCap {
		t.Errorf("want %d rendered finding lines, got %d", upstreamFindingsCap, n)
	}
}

func TestBuildStagePrompt_CoreShape(t *testing.T) {
	round := 3
	got := buildStagePrompt("ci", agentStage(pipeline.ModeReview), &round, pipeline.RunContext{}, nil)

	for _, want := range []string{
		"## Pipeline Stage",
		"Pipeline: ci",
		"Stage: review",
		"Mode: review",
		"Loop round: 3",
		"## Task",
		"Look for bugs.",
		"## Reporting Findings",
		".ao/" + pipeline.FindingsFilename,
		".ao/" + pipeline.FindingsFilename + ".tmp",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing %q\n---\n%s", want, got)
		}
	}
}

func TestBuildStagePrompt_ReviewModeFindingSchema(t *testing.T) {
	got := buildStagePrompt("ci", agentStage(pipeline.ModeReview), nil, pipeline.RunContext{}, nil)
	if !strings.Contains(got, `"finding"`) || !strings.Contains(got, "severity") {
		t.Errorf("review mode must document the finding record schema\n%s", got)
	}
	if strings.Contains(got, "Loop round:") {
		t.Error("nil loopRound must not render a Loop round line")
	}
}

func TestBuildStagePrompt_AnswerModeJSONSchema(t *testing.T) {
	got := buildStagePrompt("ci", agentStage(pipeline.ModeAnswer), nil, pipeline.RunContext{}, nil)
	if !strings.Contains(got, `"json"`) || !strings.Contains(got, "outputSchema") {
		t.Errorf("answer mode must document the json record schema\n%s", got)
	}
}

func TestBuildStagePrompt_BlocksMergeNotice(t *testing.T) {
	stage := agentStage(pipeline.ModeReview)
	blocks := true
	stage.Policy = &pipeline.StagePolicy{BlocksMerge: &blocks}
	got := buildStagePrompt("ci", stage, nil, pipeline.RunContext{}, nil)
	if !strings.Contains(got, "block merge") {
		t.Errorf("blocksMerge stage must warn about blocking merge\n%s", got)
	}
}

func TestBuildStagePrompt_InputsRendered(t *testing.T) {
	stage := agentStage(pipeline.ModeReview)
	stage.Task.Inputs = map[string]any{"threshold": 5}
	got := buildStagePrompt("ci", stage, nil, pipeline.RunContext{}, nil)
	if !strings.Contains(got, "## Inputs") || !strings.Contains(got, "threshold") {
		t.Errorf("inputs must be rendered as a JSON block\n%s", got)
	}
}

func TestBuildStagePrompt_PRBlockRendered(t *testing.T) {
	prCtx := pipeline.RunContext{
		PRNumber:     42,
		PRURL:        "https://github.com/o/r/pull/42",
		SourceBranch: "feature",
		TargetBranch: "main",
		HeadSHA:      "abc123",
	}
	got := buildStagePrompt("ci", agentStage(pipeline.ModeReview), nil, prCtx, nil)
	for _, want := range []string{
		"## Pull request",
		"Number: #42",
		"URL: https://github.com/o/r/pull/42",
		"Branch: feature -> main",
		"Head SHA: abc123",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("PR block missing %q\n---\n%s", want, got)
		}
	}
}

func TestBuildStagePrompt_NoPRContextOmitsBlock(t *testing.T) {
	got := buildStagePrompt("ci", agentStage(pipeline.ModeReview), nil, pipeline.RunContext{}, nil)
	if strings.Contains(got, "## Pull request") {
		t.Errorf("empty PR context must not render a PR block\n%s", got)
	}
}

func TestBuildStagePrompt_NonAgentStageOmitsMode(t *testing.T) {
	stage := pipeline.Stage{
		Name:     "typecheck",
		Executor: pipeline.StageExecutor{Kind: pipeline.ExecutorCommand, Command: "tsc"},
	}
	got := buildStagePrompt("ci", stage, nil, pipeline.RunContext{}, nil)
	if strings.Contains(got, "Mode:") {
		t.Errorf("command stage has no agent mode line\n%s", got)
	}
}
