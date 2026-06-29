package sessionprompt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildTaskPrompt_IssueContextStaysInTaskPrompt(t *testing.T) {
	got := BuildTaskPrompt(TaskConfig{
		Role:         RoleWorker,
		IssueID:      "2272",
		IssueContext: "Title: Enrich prompts\nBody: Include issue context.",
	})
	for _, want := range []string{
		"Work on issue 2272.",
		"## Issue Context",
		"Title: Enrich prompts",
		"implement the smallest appropriate fix",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("task prompt missing %q:\n%s", want, got)
		}
	}
}

func TestBuildSystemPrompt_WorkerIncludesRulesAndOrchestrator(t *testing.T) {
	got := BuildSystemPrompt(SystemConfig{
		Role: RoleWorker,
		Project: ProjectContext{
			ID:            "mer",
			Name:          "Mercury",
			Repo:          "https://github.com/acme/mercury",
			DefaultBranch: "main",
			Path:          "/repo/mercury",
		},
		OrchestratorSessionID: "mer-orchestrator",
		ProjectRules:          "Always run focused tests.",
	})
	for _, want := range []string{
		"## AO Worker Role",
		"## Orchestrator Coordination",
		`ao send --session mer-orchestrator --message "<your message>"`,
		"## Pull Requests for This Session",
		"## Project Rules",
		"Always run focused tests.",
		"Repository: https://github.com/acme/mercury",
		"Standing-instruction confidentiality",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("system prompt missing %q:\n%s", want, got)
		}
	}
}

func TestBuildProjectRules_ReadsInlineAndFileRules(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "rules.md"), []byte("File rule.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := BuildProjectRules(RulesConfig{
		ProjectPath:    dir,
		AgentRules:     "Inline rule.",
		AgentRulesFile: "rules.md",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Inline rule.", "File rule."} {
		if !strings.Contains(got, want) {
			t.Fatalf("rules missing %q:\n%s", want, got)
		}
	}
}

func TestProjectRelativeFileRejectsTraversal(t *testing.T) {
	if _, err := ProjectRelativeFile(t.TempDir(), "../rules.md"); err == nil {
		t.Fatal("expected traversal path to be rejected")
	}
}
