package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// TestReopenPreservesProjects models desktop reinstall: the install directory
// may change or be wiped, but the durable data dir under ~/.ao is reopened as-is.
// Opening the same dataDir again must not erase project registry rows.
func TestReopenPreservesProjects(t *testing.T) {
	dataDir := t.TempDir()
	ctx := context.Background()

	first, err := sqlite.Open(dataDir)
	if err != nil {
		t.Fatalf("open first: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := first.UpsertProject(ctx, domain.ProjectRecord{
		ID:           "proj-keep",
		Path:         filepath.Join(t.TempDir(), "keep-me-repo"),
		DisplayName:  "Keep Me",
		RegisteredAt: now,
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close first: %v", err)
	}

	// Simulate a fresh desktop binary launch after reinstall: new process,
	// same AO_DATA_DIR / default ~/.ao/data.
	second, err := sqlite.Open(dataDir)
	if err != nil {
		t.Fatalf("open second: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })

	list, err := second.ListProjects(ctx)
	if err != nil {
		t.Fatalf("list after reopen: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("projects after reopen = %d, want 1 (reinstall must not wipe registry)", len(list))
	}
	if list[0].ID != "proj-keep" || list[0].DisplayName != "Keep Me" {
		t.Fatalf("project after reopen = %#v, want proj-keep / Keep Me", list[0])
	}
}
