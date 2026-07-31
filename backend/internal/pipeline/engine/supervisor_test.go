package engine

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/triggers"
)

// fakeProjectLister is the supervisor's view of the projects table.
type fakeProjectLister struct{ ids []string }

func (l fakeProjectLister) ListProjects(context.Context) ([]domain.ProjectRecord, error) {
	out := make([]domain.ProjectRecord, 0, len(l.ids))
	for _, id := range l.ids {
		out = append(out, domain.ProjectRecord{ID: id})
	}
	return out, nil
}

func newTestSupervisor(t *testing.T, projects ...string) (*Supervisor, *fakeExecutor) {
	t.Helper()
	base := t.TempDir()
	execs := newFakeExecutor()
	sup := NewSupervisor(SupervisorConfig{
		Store:        newFakeStore(),
		Executors:    execs,
		Workspaces:   newFakeProvisioner(filepath.Join(base, "trees")),
		Sessions:     &fakeSessions{},
		Messenger:    &fakeMessenger{},
		Projects:     fakeProjectLister{ids: projects},
		BaseDir:      filepath.Join(base, "pipelines"),
		TickInterval: time.Hour,
	})
	if err := sup.Start(context.Background()); err != nil {
		t.Fatalf("start supervisor: %v", err)
	}
	t.Cleanup(func() { _ = sup.Stop(context.Background()) })
	return sup, execs
}

// TestSupervisorStartsAnEnginePerProject: known projects get an engine up
// front, and the same project always resolves to the same one.
func TestSupervisorStartsAnEnginePerProject(t *testing.T) {
	sup, _ := newTestSupervisor(t, "proj-1", "proj-2")

	first, err := sup.For(context.Background(), "proj-1")
	if err != nil {
		t.Fatalf("for: %v", err)
	}
	again, err := sup.For(context.Background(), "proj-1")
	if err != nil {
		t.Fatalf("for: %v", err)
	}
	if first != again {
		t.Fatal("a project resolved to two different engines")
	}
	if _, err := sup.For(context.Background(), "proj-2"); err != nil {
		t.Fatalf("for proj-2: %v", err)
	}
}

// TestSupervisorLazilyStartsUnknownProject: a project registered after boot
// still gets an engine, so its triggers are not silently dropped.
func TestSupervisorLazilyStartsUnknownProject(t *testing.T) {
	sup, _ := newTestSupervisor(t)
	eng, err := sup.For(context.Background(), "proj-late")
	if err != nil {
		t.Fatalf("for: %v", err)
	}
	if eng == nil {
		t.Fatal("no engine for a project registered after Start")
	}
}

// TestSupervisorStoppedRefusesLookups keeps a stopped daemon from quietly
// starting fresh engines.
func TestSupervisorStoppedRefusesLookups(t *testing.T) {
	sup, _ := newTestSupervisor(t, "proj-1")
	if err := sup.Stop(context.Background()); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if _, err := sup.For(context.Background(), "proj-1"); err == nil {
		t.Fatal("a stopped supervisor handed out an engine")
	}
}

// The supervisor owns the reaper: its ticker sweeps past-TTL kept sessions, so
// the 24h bound holds without anything else having to run.
func TestSupervisorSweepsOrphansOnItsTicker(t *testing.T) {
	base := t.TempDir()
	rows := newFakeOrphanSessions("proj-1", "stale")
	orphans := NewOrphanRegistry(rows, rows, nil)
	orphans.Keep(context.Background(), orphanKey("proj-1", "pr-review"),
		orphanInfo("run-a", "review", "no_signal", orphanBase), "stale")

	now := orphanBase.Add(OrphanTTL + time.Hour)
	sup := NewSupervisor(SupervisorConfig{
		Store:         newFakeStore(),
		Executors:     newFakeExecutor(),
		Workspaces:    newFakeProvisioner(filepath.Join(base, "trees")),
		Sessions:      rows,
		Messenger:     &fakeMessenger{},
		Orphans:       orphans,
		Projects:      fakeProjectLister{ids: []string{"proj-1"}},
		BaseDir:       filepath.Join(base, "pipelines"),
		Clock:         func() time.Time { return now },
		TickInterval:  time.Hour,
		SweepInterval: time.Millisecond,
	})
	if err := sup.Start(context.Background()); err != nil {
		t.Fatalf("start supervisor: %v", err)
	}
	t.Cleanup(func() { _ = sup.Stop(context.Background()) })

	deadline := time.Now().Add(2 * time.Second)
	for {
		if killed := rows.killedIDs(); len(killed) == 1 && killed[0] == "stale" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("killed %v, want the past-TTL session swept by the supervisor ticker", rows.killedIDs())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// TestSupervisorProviderDrivesRuns is the bridges' path end to end: resolve the
// project's engine through the EngineProvider port and start a run on it.
func TestSupervisorProviderDrivesRuns(t *testing.T) {
	sup, execs := newTestSupervisor(t, "proj-1")

	cfg, err := pipeline.ParseDefinition([]byte(twoStageYAML))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	eng, err := sup.Engines().For(context.Background(), "proj-1")
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	runID, err := eng.TriggerRun(triggers.TriggerRequest{
		Definition: pipeline.Definition{ID: "pl-1", ProjectID: "proj-1", Name: cfg.Name, YAMLSource: twoStageYAML, Config: *cfg},
		Event:      string(pipeline.PREventUpdated),
		Subject:    pipeline.Subject{Kind: pipeline.SubjectSession, ProjectID: "proj-1", SessionID: "sess-user"},
	})
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if runID == "" {
		t.Fatal("trigger returned no run id")
	}
	if ids := execs.startedIDs(); len(ids) != 1 || ids[0] != "review" {
		t.Fatalf("started %v, want the entry stage", ids)
	}
}
