package trackerintake

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestScopeGitHubOrigin(t *testing.T) {
	project := domain.ProjectRecord{RepoOriginURL: "git@github.com:acme/demo.git"}
	repo, ok := Scope(project, domain.TrackerIntakeConfig{Enabled: true})
	if !ok || repo.Native != "acme/demo" {
		t.Fatalf("Scope = %#v, %v", repo, ok)
	}
	repo, ok = Scope(project, domain.TrackerIntakeConfig{Enabled: true, Repo: "other/repo"})
	if !ok || repo.Native != "other/repo" {
		t.Fatalf("configured Scope = %#v, %v", repo, ok)
	}
}

func TestScopeUsesLinearTeam(t *testing.T) {
	repo, ok := Scope(domain.ProjectRecord{}, domain.TrackerIntakeConfig{
		Enabled:  true,
		Provider: domain.TrackerProviderLinear,
		TeamID:   "team-1",
	})
	if !ok || repo.Provider != domain.TrackerProviderLinear || repo.Native != "team-1" {
		t.Fatalf("Scope = %#v, %v", repo, ok)
	}
}

func TestScopeRejectsNonGitHubOrigin(t *testing.T) {
	for _, remote := range []string{
		"https://gitlab.com/acme/demo.git",
		"git@gitlab.com:acme/demo.git",
	} {
		t.Run(remote, func(t *testing.T) {
			project := domain.ProjectRecord{RepoOriginURL: remote}
			if repo, ok := Scope(project, domain.TrackerIntakeConfig{Enabled: true}); ok {
				t.Fatalf("Scope = %#v, true; want false", repo)
			}
		})
	}
}

func TestMatchesAnyLabel(t *testing.T) {
	if !MatchesAnyLabel([]string{"Bug"}, []string{"bug", "READY"}) {
		t.Fatal("expected case-insensitive OR match")
	}
	if MatchesAnyLabel([]string{"needs-design"}, []string{"bug", "ready"}) {
		t.Fatal("expected no selected labels to match")
	}
	if !MatchesAnyLabel(nil, nil) {
		t.Fatal("empty selection should match")
	}
}

func TestMatchesAssignee(t *testing.T) {
	if !MatchesAssignee([]string{"OctoCat"}, "octocat") {
		t.Fatal("expected case-insensitive assignee match")
	}
	if MatchesAssignee([]string{"someone-else"}, "octocat") {
		t.Fatal("unexpected assignee match")
	}
}
