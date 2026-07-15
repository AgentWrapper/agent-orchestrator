package review

import (
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReviewTextsIncludesMultiPRQueue(t *testing.T) {
	spec := launchSpec()
	spec.RunID = "run-2"
	spec.PRURL = "https://github.com/o/r/pull/2"
	spec.TargetSHA = "sha2"
	spec.ReviewIndex = 1
	spec.ReviewQueue = []ports.ReviewTask{
		{RunID: "run-1", PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha1"},
		{RunID: "run-2", PRURL: "https://github.com/o/r/pull/2", TargetSHA: "sha2"},
	}

	prompt, _ := reviewTexts(spec)
	for _, want := range []string{
		"AO created 2 review tasks",
		"Review every queued PR, then submit all results together",
		"Complete every review task in the queue autonomously",
		"Do not ask whether to continue",
		"* 1. https://github.com/o/r/pull/1 (head commit sha1, run run-1)",
		"* 2. https://github.com/o/r/pull/2 (head commit sha2, run run-2)",
		"After every PR has its own GitHub review",
		"printf '%s'",
		"do not use a heredoc",
		"ao review submit --session mer-1 --reviews -",
		`"reviews": [`,
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestReviewPromptTokenBudget(t *testing.T) {
	prompt, systemPrompt := reviewTexts(launchSpec())
	t.Logf("review task: %d chars (~%d tokens)", len(prompt), len(prompt)/4)
	t.Logf("review system: %d chars (~%d tokens)", len(systemPrompt), len(systemPrompt)/4)
	if len(prompt) > 1_500 || len(systemPrompt) > 400 {
		t.Fatalf("review prompt exceeded token budget: task=%d system=%d", len(prompt), len(systemPrompt))
	}
}
