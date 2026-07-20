package store_test

import (
	"context"
	"testing"
	"time"

	shelltermsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
)

func shellTerminalRecord(handleID, appRunID string) shelltermsvc.ShellTerminalRecord {
	return shelltermsvc.ShellTerminalRecord{
		HandleID:   handleID,
		WorkingDir: "/repos/portfolio",
		Title:      "portfolio",
		AppRunID:   appRunID,
		CreatedAt:  time.Now().UTC().Truncate(time.Second),
	}
}

func TestInsertAndSelectShellTerminalsByAppRunID(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	if err := s.InsertShellTerminal(ctx, shellTerminalRecord("shellterm-a", "run-1")); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := s.InsertShellTerminal(ctx, shellTerminalRecord("shellterm-b", "run-2")); err != nil {
		t.Fatalf("insert: %v", err)
	}

	got, err := s.SelectShellTerminalsByAppRunID(ctx, "run-1")
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(got) != 1 || got[0].HandleID != "shellterm-a" {
		t.Fatalf("terminals = %+v, want only run-1's shell", got)
	}
	if got[0].ProjectID != "" {
		t.Errorf("project id = %q, want empty for a project-less shell", got[0].ProjectID)
	}
}

// A shell opened with no project stores NULL, not "" — an empty string would
// violate the projects foreign key.
func TestInsertShellTerminalWithoutProjectStoresNullProjectID(t *testing.T) {
	s := newTestStore(t)
	if err := s.InsertShellTerminal(context.Background(), shellTerminalRecord("shellterm-noproject", "run-1")); err != nil {
		t.Fatalf("insert without project: %v", err)
	}
}

func TestInsertShellTerminalWithProjectRoundTrips(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "portfolio")

	rec := shellTerminalRecord("shellterm-withproject", "run-1")
	rec.ProjectID = "portfolio"
	if err := s.InsertShellTerminal(ctx, rec); err != nil {
		t.Fatalf("insert: %v", err)
	}

	got, err := s.SelectShellTerminalsByAppRunID(ctx, "run-1")
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(got) != 1 || got[0].ProjectID != "portfolio" {
		t.Fatalf("terminals = %+v, want project portfolio", got)
	}
}

func TestDeleteShellTerminalByHandleIDReportsWhetherRowExisted(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	if err := s.InsertShellTerminal(ctx, shellTerminalRecord("shellterm-a", "run-1")); err != nil {
		t.Fatalf("insert: %v", err)
	}

	deleted, err := s.DeleteShellTerminalByHandleID(ctx, "shellterm-a")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if !deleted {
		t.Error("deleted = false, want true for an existing row")
	}

	deleted, err = s.DeleteShellTerminalByHandleID(ctx, "shellterm-a")
	if err != nil {
		t.Fatalf("delete again: %v", err)
	}
	if deleted {
		t.Error("deleted = true on the second call, want false")
	}
}

func TestSelectAndDeleteShellTerminalsFromPreviousAppRuns(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	for _, rec := range []shelltermsvc.ShellTerminalRecord{
		shellTerminalRecord("shellterm-orphan1", "run-crashed"),
		shellTerminalRecord("shellterm-orphan2", "run-crashed"),
		shellTerminalRecord("shellterm-current", "run-current"),
	} {
		if err := s.InsertShellTerminal(ctx, rec); err != nil {
			t.Fatalf("insert %s: %v", rec.HandleID, err)
		}
	}

	orphans, err := s.SelectShellTerminalsFromPreviousAppRuns(ctx, "run-current")
	if err != nil {
		t.Fatalf("select orphans: %v", err)
	}
	if len(orphans) != 2 {
		t.Fatalf("orphans = %+v, want 2", orphans)
	}

	cleared, err := s.DeleteShellTerminalsFromPreviousAppRuns(ctx, "run-current")
	if err != nil {
		t.Fatalf("delete orphans: %v", err)
	}
	if cleared != 2 {
		t.Errorf("cleared = %d, want 2", cleared)
	}

	remaining, err := s.SelectShellTerminalsByAppRunID(ctx, "run-current")
	if err != nil {
		t.Fatalf("select current: %v", err)
	}
	if len(remaining) != 1 {
		t.Errorf("remaining = %+v, want the current run's shell untouched", remaining)
	}
}
