package importer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeStore struct {
	projects map[string]domain.ProjectRecord
}

func newFakeStore() *fakeStore { return &fakeStore{projects: map[string]domain.ProjectRecord{}} }
func (f *fakeStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	r, ok := f.projects[id]
	return r, ok, nil
}
func (f *fakeStore) UpsertProject(_ context.Context, r domain.ProjectRecord) error {
	f.projects[r.ID] = r
	return nil
}

func writeLegacyRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".agent-orchestrator")
	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o750); err != nil {
		t.Fatal(err)
	}
	cfg := "projects:\n  alpha:\n    path: /repos/alpha\n    name: Alpha\n"
	if err := os.WriteFile(filepath.Join(root, "config.yaml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestStatus_NoLegacyData(t *testing.T) {
	svc := New(Deps{Store: newFakeStore(), Root: filepath.Join(t.TempDir(), "nope")})
	st, err := svc.Status(context.Background())
	if err != nil || st.Available {
		t.Fatalf("want unavailable; got %+v err=%v", st, err)
	}
}

func TestStatus_LegacyPresentStaysAvailableAfterImport(t *testing.T) {
	root := writeLegacyRoot(t)
	svc := New(Deps{Store: newFakeStore(), Root: root})
	st, err := svc.Status(context.Background())
	if err != nil || !st.Available || st.LegacyRoot != root {
		t.Fatalf("want available at %q; got %+v err=%v", root, st, err)
	}
	if _, err := svc.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	// Availability is physical (legacy data still on disk), so it stays true; the
	// app marker is what stops the prompt after a completed import.
	st, _ = svc.Status(context.Background())
	if !st.Available {
		t.Fatal("availability must remain true after import (marker governs prompting)")
	}
}

func TestRun_ImportsProjects(t *testing.T) {
	root := writeLegacyRoot(t)
	svc := New(Deps{Store: newFakeStore(), Root: root})
	rep, err := svc.Run(context.Background())
	if err != nil || rep.ProjectsImported != 1 {
		t.Fatalf("projectsImported=%d err=%v", rep.ProjectsImported, err)
	}
}

func TestNew_DefaultsRoot(t *testing.T) {
	if New(Deps{Store: newFakeStore()}).root == "" {
		t.Fatal("empty Root should fall back to the default legacy root")
	}
}
