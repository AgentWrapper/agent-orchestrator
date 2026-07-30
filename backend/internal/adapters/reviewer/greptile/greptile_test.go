package greptile

import (
	"context"
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
