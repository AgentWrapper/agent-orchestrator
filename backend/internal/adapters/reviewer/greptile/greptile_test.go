package greptile

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReviewCommandUsesJSONAndPRBaseBranch(t *testing.T) {
	command, err := New().ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewQueue: []ports.ReviewTask{{TargetBranch: "develop"}},
		ReviewIndex: 0,
	})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	got := strings.Join(command.Argv, " ")
	if got != "greptile review --json --branch develop" {
		t.Fatalf("command = %q", got)
	}
}

func TestParseReviewResultWithFindings(t *testing.T) {
	result, err := New().ParseReviewResult([]byte(`{
		"summary":"Adds the reviewer integration.",
		"confidence":3,
		"confidenceReasoning":"One issue should be fixed.",
		"securitySummary":"No broad security concerns.",
		"comments":[{
			"path":"backend/reviewer.go",
			"startLine":41,
			"endLine":43,
			"severity":"P1",
			"securityIssue":true,
			"body":"Cancellation can race completion.",
			"suggestion":"Guard the active job id."
		}]
	}`))
	if err != nil {
		t.Fatalf("ParseReviewResult: %v", err)
	}
	if result.Verdict != domain.VerdictChangesRequested {
		t.Fatalf("verdict = %q", result.Verdict)
	}
	for _, want := range []string{
		"## Greptile review",
		"**Confidence:** 3/5",
		"P1 · Security · `backend/reviewer.go:41-43`",
		"Cancellation can race completion.",
		"> Guard the active job id.",
	} {
		if !strings.Contains(result.Body, want) {
			t.Errorf("body missing %q:\n%s", want, result.Body)
		}
	}
}

func TestParseReviewResultWithoutFindingsApproves(t *testing.T) {
	result, err := New().ParseReviewResult([]byte(`{"summary":"Looks good.","comments":[]}`))
	if err != nil {
		t.Fatalf("ParseReviewResult: %v", err)
	}
	if result.Verdict != domain.VerdictApproved {
		t.Fatalf("verdict = %q", result.Verdict)
	}
	if !strings.Contains(result.Body, "No actionable findings.") {
		t.Fatalf("body = %q", result.Body)
	}
}

func TestParseReviewResultRejectsNonJSONOutput(t *testing.T) {
	if _, err := New().ParseReviewResult([]byte("review failed")); err == nil {
		t.Fatal("expected malformed output error")
	}
}

func TestPrepareTerminalRequestWritesDisplayOnlyCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.json")
	command, err := New().PrepareTerminalRequest(path, []ports.ReviewTask{{
		RunID: "run-1", PRURL: "https://github.com/acme/repo/pull/4", TargetSHA: "sha-1", TargetBranch: "main", WorkspacePath: t.TempDir(),
	}})
	if err != nil {
		t.Fatalf("PrepareTerminalRequest: %v", err)
	}
	aoExecutable, err := resolveAOExecutable()
	if err != nil {
		t.Fatalf("resolveAOExecutable: %v", err)
	}
	if strings.Join(command.Argv, " ") != aoExecutable+" review-terminal "+path {
		t.Fatalf("command = %#v", command.Argv)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read request: %v", err)
	}
	var request struct {
		ResultPath string `json:"resultPath"`
		Tasks      []struct {
			TargetBranch string `json:"targetBranch"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if request.ResultPath != TerminalResultPath(path) || len(request.Tasks) != 1 || request.Tasks[0].TargetBranch != "main" {
		t.Fatalf("request = %+v", request)
	}
}

func TestParseTerminalResultPreservesInlineComments(t *testing.T) {
	result, err := New().ParseTerminalResult([]byte(`{"complete":true,"results":[{"runId":"run-1","prUrl":"https://github.com/acme/repo/pull/4","targetSha":"sha-1","verdict":"changes_requested","body":"fix it","comments":[{"path":"main.go","startLine":4,"endLine":5,"side":"RIGHT","body":"bug"}]}]}`))
	if err != nil {
		t.Fatalf("ParseTerminalResult: %v", err)
	}
	if !result.Complete || len(result.Results) != 1 || len(result.Results[0].Comments) != 1 {
		t.Fatalf("result = %+v", result)
	}
	comment := result.Results[0].Comments[0]
	if comment.Path != "main.go" || comment.StartLine != 4 || comment.EndLine != 5 || comment.Side != "RIGHT" {
		t.Fatalf("comment = %+v", comment)
	}
}
