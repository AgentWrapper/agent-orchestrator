package trackerintake

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestRepository(t *testing.T) {
	project := domain.ProjectRecord{RepoOriginURL: "git@github.com:acme/demo.git"}
	repo, ok := Repository(project, domain.TrackerIntakeConfig{Enabled: true})
	if !ok || repo.Native != "acme/demo" {
		t.Fatalf("Repository = %#v, %v", repo, ok)
	}
	repo, ok = Repository(project, domain.TrackerIntakeConfig{Enabled: true, Repo: "other/repo"})
	if !ok || repo.Native != "other/repo" {
		t.Fatalf("configured Repository = %#v, %v", repo, ok)
	}
}

func TestRepositoryAcceptsGitHubSCPStyleOrigin(t *testing.T) {
	for _, remote := range []string{
		"https://github.com/acme/demo.git",
		"git@github.com:acme/demo.git",
		"alice@github.com:acme/demo.git",
		"github.com:acme/demo.git",
	} {
		t.Run(remote, func(t *testing.T) {
			project := domain.ProjectRecord{RepoOriginURL: remote}
			repo, ok := Repository(project, domain.TrackerIntakeConfig{Enabled: true})
			if !ok || repo.Native != "acme/demo" {
				t.Fatalf("Repository = %#v, %v; want acme/demo, true", repo, ok)
			}
		})
	}
}

func TestRepositoryRejectsNonGitHubOrigin(t *testing.T) {
	for _, remote := range []string{
		"https://gitlab.com/acme/demo.git",
		"git@gitlab.com:acme/demo.git",
		"alice@gitlab.com:acme/demo.git",
		"gitlab.com:acme/demo.git",
		"acme/demo",
	} {
		t.Run(remote, func(t *testing.T) {
			project := domain.ProjectRecord{RepoOriginURL: remote}
			if repo, ok := Repository(project, domain.TrackerIntakeConfig{Enabled: true}); ok {
				t.Fatalf("Repository = %#v, true; want false", repo)
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
