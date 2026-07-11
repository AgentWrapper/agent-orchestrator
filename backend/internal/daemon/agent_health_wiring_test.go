package daemon

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
)

type fakeProjectLister struct {
	summaries []projectsvc.Summary
	configs   map[domain.ProjectID]*domain.ProjectConfig
	listErr   error
}

func (f fakeProjectLister) List(context.Context) ([]projectsvc.Summary, error) {
	return f.summaries, f.listErr
}

func (f fakeProjectLister) Get(_ context.Context, id domain.ProjectID) (projectsvc.GetResult, error) {
	cfg, ok := f.configs[id]
	if !ok {
		return projectsvc.GetResult{}, errors.New("not found")
	}
	return projectsvc.GetResult{Project: &projectsvc.Project{ID: id, Config: cfg}}, nil
}

func contains(hs []string, want string) bool {
	for _, h := range hs {
		if h == want {
			return true
		}
	}
	return false
}

func TestConfiguredHarnessesUnionsCoreDefaultAndProjects(t *testing.T) {
	lister := fakeProjectLister{
		summaries: []projectsvc.Summary{{ID: "proj-a"}, {ID: "proj-b"}},
		configs: map[domain.ProjectID]*domain.ProjectConfig{
			"proj-a": {
				Worker:       domain.RoleOverride{Harness: domain.HarnessCodex},
				Orchestrator: domain.RoleOverride{Harness: domain.HarnessOpenCode},
				Prime:        domain.RoleOverride{Harness: domain.HarnessAider},
				WorkerMix: domain.WorkerMix{
					{Harness: domain.HarnessGrok},
					{Harness: domain.HarnessDroid},
				},
				Reviewers: []domain.ReviewerConfig{{Harness: domain.ReviewerHarness("codex")}},
			},
			"proj-b": {
				Worker: domain.RoleOverride{Harness: domain.HarnessAmp},
			},
		},
	}
	got := configuredHarnesses(context.Background(), lister, "claude-code", nil)

	// Core three always present.
	for _, core := range []string{"claude-code", "codex", "codex-fugu"} {
		if !contains(got, core) {
			t.Errorf("core harness %q missing from %v", core, got)
		}
	}
	// Project-referenced harnesses present.
	for _, want := range []string{"opencode", "aider", "grok", "droid", "amp"} {
		if !contains(got, want) {
			t.Errorf("configured harness %q missing from %v", want, got)
		}
	}
	// Deduped + sorted.
	for i := 1; i < len(got); i++ {
		if got[i-1] >= got[i] {
			t.Fatalf("harness set not sorted/deduped: %v", got)
		}
	}
}

func TestConfiguredHarnessesDegradesOnListError(t *testing.T) {
	lister := fakeProjectLister{listErr: errors.New("db down")}
	got := configuredHarnesses(context.Background(), lister, "codex", nil)
	// Default agent + core set still returned.
	for _, want := range []string{"codex", "claude-code", "codex-fugu"} {
		if !contains(got, want) {
			t.Errorf("harness %q missing from degraded set %v", want, got)
		}
	}
}

func TestStartAgentHealthDisabledReturnsClosedChannel(t *testing.T) {
	monitor, done := startAgentHealth(context.Background(), agentHealthConfig{Interval: 0, DefaultAgent: "claude-code"}, nil, nil, nil)
	select {
	case <-done:
	default:
		t.Fatal("disabled loop should return an already-closed done channel")
	}
	if monitor == nil {
		t.Fatal("monitor must be non-nil even when disabled so the endpoint works")
	}
	if len(monitor.Snapshot().Harnesses) != 0 {
		t.Fatal("disabled monitor snapshot should be empty")
	}
}
