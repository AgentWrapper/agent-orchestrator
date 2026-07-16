package session

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type recordingProjectProviderResolver struct {
	projects []domain.ProjectRecord
	bundle   ProjectProviderBundle
	err      error
}

func (r *recordingProjectProviderResolver) ResolveProjectProvider(_ context.Context, project domain.ProjectRecord) (ProjectProviderBundle, error) {
	r.projects = append(r.projects, project)
	return r.bundle, r.err
}

type gitLabProjectSCM struct {
	refs []ports.SCMPRRef
}

func (p *gitLabProjectSCM) ParseRepository(remote string) (ports.SCMRepo, bool) {
	if remote != "group/subgroup/repo" && remote != "https://gitlab.example.com/group/subgroup/repo.git" {
		return ports.SCMRepo{}, false
	}
	return ports.SCMRepo{
		Provider: "gitlab", Host: "gitlab.example.com", Owner: "group/subgroup", Name: "repo", Repo: "group/subgroup/repo",
	}, true
}

func (p *gitLabProjectSCM) ParseChangeRef(raw string, repo ports.SCMRepo) (ports.SCMPRRef, bool) {
	if raw != "!7" {
		return ports.SCMPRRef{}, false
	}
	return ports.SCMPRRef{
		Repo: repo, Number: 7, URL: "https://gitlab.example.com/group/subgroup/repo/-/merge_requests/7",
	}, true
}

func (p *gitLabProjectSCM) FetchPullRequests(_ context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	p.refs = append(p.refs, refs...)
	return []ports.SCMObservation{{
		Fetched: true, Provider: "gitlab", Host: "gitlab.example.com", Repo: "group/subgroup/repo",
		PR: ports.SCMPRObservation{
			URL: "https://gitlab.example.com/group/subgroup/repo/-/merge_requests/7", Number: 7,
		},
	}}, nil
}

func (*gitLabProjectSCM) FetchReviewThreads(context.Context, ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	return ports.SCMReviewObservation{}, nil
}

func TestClaimPRResolvesGitLabProviderFromProject(t *testing.T) {
	store := newFakeStore()
	store.sessions["demo-1"] = domain.SessionRecord{
		ID: "demo-1", ProjectID: "demo", Kind: domain.KindWorker,
		Metadata: domain.SessionMetadata{WorkspacePath: "/workspace"},
	}
	project := domain.ProjectRecord{
		ID: "demo", RepoOriginURL: "https://gitlab.example.com/group/subgroup/repo.git",
		Config: domain.ProjectConfig{SCM: domain.SCMProjectConfig{
			Provider: domain.SCMProviderGitLab, ConnectionID: "gitlab-work", Repo: "group/subgroup/repo",
		}},
	}
	store.projects[project.ID] = project
	scm := &gitLabProjectSCM{}
	resolver := &recordingProjectProviderResolver{bundle: ProjectProviderBundle{SCM: scm}}
	svc := NewWithDeps(Deps{Store: store, PRClaimer: fakePRClaimer{}, Providers: resolver})

	if _, err := svc.ClaimPR(context.Background(), "demo-1", "!7", ClaimPROptions{}); err != nil {
		t.Fatalf("ClaimPR: %v", err)
	}
	if len(resolver.projects) != 1 || resolver.projects[0].ID != "demo" {
		t.Fatalf("resolved projects = %#v", resolver.projects)
	}
	if len(scm.refs) != 1 || scm.refs[0].Number != 7 || scm.refs[0].Repo.Repo != "group/subgroup/repo" {
		t.Fatalf("fetched refs = %#v", scm.refs)
	}
}

func TestClaimPRFullURLWorksWhenLegacyProjectRepoIsMissing(t *testing.T) {
	store := newFakeStore()
	store.sessions["demo-1"] = domain.SessionRecord{
		ID: "demo-1", ProjectID: "demo", Kind: domain.KindWorker,
		Metadata: domain.SessionMetadata{WorkspacePath: "/workspace"},
	}
	store.projects["demo"] = domain.ProjectRecord{ID: "demo"}
	svc := NewWithDeps(Deps{
		Store: store, PRClaimer: fakePRClaimer{},
		SCM: fakeSCM{obs: ports.SCMObservation{
			Fetched: true, Provider: "github", Host: "github.com", Repo: "aoagents/agent-orchestrator",
			PR: ports.SCMPRObservation{URL: "https://github.com/aoagents/agent-orchestrator/pull/42", Number: 42},
		}},
	})

	if _, err := svc.ClaimPR(context.Background(), "demo-1", "https://github.com/aoagents/agent-orchestrator/pull/42", ClaimPROptions{}); err != nil {
		t.Fatalf("ClaimPR: %v", err)
	}
}

func TestSpawnResolvesGitLabTrackerFromProject(t *testing.T) {
	store := newFakeStore()
	project := domain.ProjectRecord{
		ID: "demo", RepoOriginURL: "https://gitlab.example.com/group/subgroup/repo.git",
		Config: domain.ProjectConfig{SCM: domain.SCMProjectConfig{
			Provider: domain.SCMProviderGitLab, ConnectionID: "gitlab-work", Repo: "group/subgroup/repo",
		}},
	}
	store.projects[project.ID] = project
	commander := &fakeCommander{}
	tracker := &fakeTracker{issue: domain.Issue{
		ID: domain.TrackerID{
			Provider: domain.TrackerProviderGitLab,
			Native:   "gitlab.example.com/group/subgroup/repo#!42",
		},
		Title: "Fix GitLab intake",
	}}
	resolver := &recordingProjectProviderResolver{bundle: ProjectProviderBundle{
		SCM: &gitLabProjectSCM{}, Tracker: tracker,
	}}
	svc := NewWithDeps(Deps{Manager: commander, Store: store, Providers: resolver})

	if _, err := svc.Spawn(context.Background(), ports.SpawnConfig{
		ProjectID: "demo", Kind: domain.KindWorker, IssueID: "42",
	}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if len(tracker.ids) != 1 || tracker.ids[0].Provider != domain.TrackerProviderGitLab || tracker.ids[0].Native != "gitlab.example.com/group/subgroup/repo#!42" {
		t.Fatalf("tracker ids = %#v", tracker.ids)
	}
	if commander.spawnedCfg.IssueContext == "" {
		t.Fatal("GitLab issue context was not added")
	}
}
