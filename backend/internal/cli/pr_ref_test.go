package cli

import (
	"context"
	"testing"
)

func TestResolvePRRefPreservesProviderNeutralReference(t *testing.T) {
	ctx := &commandContext{}
	project := projectDetails{Repo: "https://gitlab.example.com/group/subgroup/repo.git"}
	for _, input := range []string{
		"42",
		"!42",
		"group/subgroup/repo!42",
		"https://gitlab.example.com/group/subgroup/repo/-/merge_requests/42",
		"https://github.com/aoagents/agent-orchestrator/pull/42",
	} {
		t.Run(input, func(t *testing.T) {
			got, err := ctx.resolvePRRef(context.Background(), input, project)
			if err != nil || got != input {
				t.Fatalf("resolvePRRef(%q) = %q, %v", input, got, err)
			}
		})
	}
}
