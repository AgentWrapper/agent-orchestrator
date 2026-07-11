package store_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestProjectPauseIsIndependentOfConfig is the headline AC: pausing then
// resuming a project leaves its config byte-identical. Because pause lives in a
// dedicated column mutated by its own query — never through the config JSON blob
// — a pause/resume cycle must not rewrite config at all. We prove "untouched"
// two ways: the decoded config round-trips unchanged, AND no
// project_config_changed CDC event fires (the trigger is AFTER UPDATE OF config,
// so any write to the config column would emit one).
func TestProjectPauseIsIndependentOfConfig(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	cfg := domain.ProjectConfig{
		DefaultBranch: "develop",
		Env:           map[string]string{"GITHUB_TOKEN": "secret"},
		Symlinks:      []string{".env"},
		AgentConfig:   domain.AgentConfig{Model: "claude-opus-4-5"},
		TrackerIntake: domain.TrackerIntakeConfig{
			Enabled:       true,
			Provider:      domain.TrackerProviderGitHub,
			MaxConcurrent: 8,
		},
	}
	if err := s.UpsertProject(ctx, domain.ProjectRecord{
		ID: "mer", Path: "/tmp/mer", RegisteredAt: now, Config: cfg,
	}); err != nil {
		t.Fatalf("upsert with config: %v", err)
	}

	before, ok, err := s.GetProject(ctx, "mer")
	if err != nil || !ok {
		t.Fatalf("get before: ok=%v err=%v", ok, err)
	}
	if before.Paused {
		t.Fatal("freshly-registered project should default to not paused")
	}

	// The seq after the initial config write — pause/resume must add no
	// project_config_changed events beyond this point.
	base, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatalf("latest seq: %v", err)
	}

	// Pause.
	affected, err := s.SetProjectPaused(ctx, "mer", true)
	if err != nil || !affected {
		t.Fatalf("pause: affected=%v err=%v", affected, err)
	}
	paused, _, _ := s.GetProject(ctx, "mer")
	if !paused.Paused {
		t.Fatal("project not paused after SetProjectPaused(true)")
	}
	if !reflect.DeepEqual(paused.Config, before.Config) {
		t.Fatalf("pause changed config: got %#v, want %#v", paused.Config, before.Config)
	}

	// Resume.
	affected, err = s.SetProjectPaused(ctx, "mer", false)
	if err != nil || !affected {
		t.Fatalf("resume: affected=%v err=%v", affected, err)
	}
	resumed, _, _ := s.GetProject(ctx, "mer")
	if resumed.Paused {
		t.Fatal("project still paused after SetProjectPaused(false)")
	}
	if !reflect.DeepEqual(resumed.Config, before.Config) {
		t.Fatalf("resume changed config: got %#v, want %#v", resumed.Config, before.Config)
	}

	// The strongest proof the config column was never written: no
	// project_config_changed events after the pause/resume cycle.
	evs, err := s.EventsAfter(ctx, base, 100)
	if err != nil {
		t.Fatalf("events after: %v", err)
	}
	for _, e := range evs {
		if string(e.Type) == "project_config_changed" {
			t.Fatalf("pause/resume emitted a project_config_changed event (config column was written): %#v", e)
		}
	}
}

// TestSetProjectPausedMissingProject: a pause targeting an unknown project
// reports no row affected rather than erroring, mirroring ArchiveProject.
func TestSetProjectPausedMissingProject(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	affected, err := s.SetProjectPaused(ctx, "ghost", true)
	if err != nil {
		t.Fatalf("pause missing project errored: %v", err)
	}
	if affected {
		t.Fatal("pausing an unknown project reported a row affected")
	}
}

// TestUpsertProjectPreservesPaused: saving project config (an upsert) must not
// clear the independent paused bit. This guards the "pause is not config
// surgery" invariant against the config write path.
func TestUpsertProjectPreservesPaused(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	if err := s.UpsertProject(ctx, domain.ProjectRecord{
		ID: "mer", Path: "/tmp/mer", RegisteredAt: now,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := s.SetProjectPaused(ctx, "mer", true); err != nil {
		t.Fatalf("pause: %v", err)
	}

	// Re-save the project with a fresh config (the SetConfig path is an upsert).
	if err := s.UpsertProject(ctx, domain.ProjectRecord{
		ID: "mer", Path: "/tmp/mer", RegisteredAt: now,
		Config: domain.ProjectConfig{DefaultBranch: "develop"},
	}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	got, _, _ := s.GetProject(ctx, "mer")
	if !got.Paused {
		t.Fatal("upsert (config save) cleared the paused bit")
	}
	if got.Config.DefaultBranch != "develop" {
		t.Fatalf("config not saved: %#v", got.Config)
	}
}

// TestFleetPausedRoundTrips: the daemon-global fleet-paused flag persists
// independently and defaults to false on a fresh database.
func TestFleetPausedRoundTrips(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	paused, err := s.GetFleetPaused(ctx)
	if err != nil {
		t.Fatalf("get fleet paused: %v", err)
	}
	if paused {
		t.Fatal("fleet should default to not paused on a fresh database")
	}

	if err := s.SetFleetPaused(ctx, true); err != nil {
		t.Fatalf("set fleet paused true: %v", err)
	}
	if paused, _ := s.GetFleetPaused(ctx); !paused {
		t.Fatal("fleet not paused after SetFleetPaused(true)")
	}

	if err := s.SetFleetPaused(ctx, false); err != nil {
		t.Fatalf("set fleet paused false: %v", err)
	}
	if paused, _ := s.GetFleetPaused(ctx); paused {
		t.Fatal("fleet still paused after SetFleetPaused(false)")
	}
}
