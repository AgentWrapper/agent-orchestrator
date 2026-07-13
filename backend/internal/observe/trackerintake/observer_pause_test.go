package trackerintake

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func intakeEnabled(assignee string) domain.ProjectConfig {
	return domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: assignee, MaxConcurrent: 32}}
}

// TestPollSkipsPausedProject: a paused project dispatches nothing on the next
// tick, while an unpaused peer with the same config still dispatches. Pausing is
// the intake gate — config is untouched, so the paused project resumes cleanly.
func TestPollSkipsPausedProject(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{
		{ID: "live", RepoOriginURL: "https://github.com/acme/live.git", Config: intakeEnabled("alice")},
		{ID: "paused", RepoOriginURL: "https://github.com/acme/paused.git", Paused: true, Config: intakeEnabled("alice")},
	}}
	tracker := &fakeTracker{issuesByRepo: map[string][]domain.Issue{
		"acme/live": {
			{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/live#1"}, Title: "live", State: domain.IssueOpen, Assignees: []string{"alice"}},
		},
		"acme/paused": {
			{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/paused#1"}, Title: "paused", State: domain.IssueOpen, Assignees: []string{"alice"}},
		},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want 1 (paused project must not dispatch)", len(spawner.calls))
	}
	if spawner.calls[0].ProjectID != "live" {
		t.Fatalf("spawned for %q, want the unpaused project 'live'", spawner.calls[0].ProjectID)
	}
}

// TestPollSkipsWholeTickWhenFleetPaused: a fleet-wide pause short-circuits the
// entire intake tick — no project dispatches, including ones whose own paused
// bit is clear. This is why the global flag is distinct: a project registered
// while the fleet is paused is gated without needing its own bit set.
func TestPollSkipsWholeTickWhenFleetPaused(t *testing.T) {
	store := &fakeStore{
		fleetPaused: true,
		projects: []domain.ProjectRecord{
			{ID: "a", RepoOriginURL: "https://github.com/acme/a.git", Config: intakeEnabled("alice")},
			{ID: "b", RepoOriginURL: "https://github.com/acme/b.git", Config: intakeEnabled("alice")},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/a#1"}, Title: "x", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %d, want 0 while the fleet is paused", len(spawner.calls))
	}
}
