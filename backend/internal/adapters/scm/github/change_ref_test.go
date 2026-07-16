package github

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestProviderParseChangeRef(t *testing.T) {
	provider, err := NewProvider(ProviderOptions{SkipTokenPreflight: true})
	if err != nil {
		t.Fatal(err)
	}
	repo := ports.SCMRepo{
		Provider: "github", Host: "github.com", Owner: "aoagents", Name: "agent-orchestrator", Repo: "aoagents/agent-orchestrator",
	}
	for _, input := range []string{
		"42",
		"#42",
		"aoagents/agent-orchestrator#42",
		"https://github.com/aoagents/agent-orchestrator/pull/42",
	} {
		t.Run(input, func(t *testing.T) {
			got, ok := provider.ParseChangeRef(input, repo)
			if !ok || got.Number != 42 || got.Repo != repo || got.URL != "https://github.com/aoagents/agent-orchestrator/pull/42" {
				t.Fatalf("ParseChangeRef(%q) = %#v, %v", input, got, ok)
			}
		})
	}
	withoutContext, ok := provider.ParseChangeRef("https://github.com/aoagents/agent-orchestrator/pull/42", ports.SCMRepo{})
	if !ok || withoutContext.Repo.Repo != "aoagents/agent-orchestrator" || withoutContext.Number != 42 {
		t.Fatalf("ParseChangeRef without context = %#v, %v", withoutContext, ok)
	}
	for _, input := range []string{
		"aoagents/other#42",
		"https://github.com/aoagents/other/pull/42",
		"#0",
		"anything",
	} {
		if got, ok := provider.ParseChangeRef(input, repo); ok {
			t.Fatalf("ParseChangeRef(%q) = %#v, true", input, got)
		}
	}
}
