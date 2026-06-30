package legacyimport

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// fakeStore is an in-memory Store with the importer's idempotency semantics.
type fakeStore struct {
	projects map[string]domain.ProjectRecord
}

func newFakeStore() *fakeStore {
	return &fakeStore{projects: map[string]domain.ProjectRecord{}}
}

func (f *fakeStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	r, ok := f.projects[id]
	return r, ok, nil
}
func (f *fakeStore) UpsertProject(_ context.Context, r domain.ProjectRecord) error {
	f.projects[r.ID] = r
	return nil
}

// writeLegacyRoot builds a minimal legacy store: two projects. Returns the
// legacy root.
func writeLegacyRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".agent-orchestrator")
	mustMkdir(t, filepath.Join(root, "projects", "alpha", "sessions"))
	mustMkdir(t, filepath.Join(root, "projects", "beta", "sessions"))

	mustWrite(t, filepath.Join(root, "config.yaml"), `projects:
  alpha:
    path: /repos/alpha
    name: Alpha
    defaultBranch: develop
  beta:
    path: /repos/beta
`)
	return root
}

func runOpts(root string) Options {
	return Options{
		Root:          root,
		Now:           time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC),
		RepoOriginURL: func(string) string { return "" },
	}
}

func TestRun_EndToEnd(t *testing.T) {
	root := writeLegacyRoot(t)
	store := newFakeStore()
	ctx := context.Background()

	rep, err := Run(ctx, store, runOpts(root))
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if rep.ProjectsImported != 2 {
		t.Fatalf("projectsImported = %d, want 2", rep.ProjectsImported)
	}
	// develop branch survives into the config blob.
	if store.projects["alpha"].Config.DefaultBranch != "develop" {
		t.Fatalf("alpha config = %+v", store.projects["alpha"].Config)
	}
}

func TestRun_Idempotent(t *testing.T) {
	root := writeLegacyRoot(t)
	store := newFakeStore()
	ctx := context.Background()
	if _, err := Run(ctx, store, runOpts(root)); err != nil {
		t.Fatalf("first run: %v", err)
	}
	rep, err := Run(ctx, store, runOpts(root))
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if rep.ProjectsImported != 0 || rep.ProjectsSkipped != 2 {
		t.Fatalf("re-run projects: imported=%d skipped=%d, want 0/2", rep.ProjectsImported, rep.ProjectsSkipped)
	}
}

func TestRun_DryRunWritesNothing(t *testing.T) {
	root := writeLegacyRoot(t)
	store := newFakeStore()
	opts := runOpts(root)
	opts.DryRun = true
	rep, err := Run(context.Background(), store, opts)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if rep.ProjectsImported != 2 {
		t.Fatalf("dry-run plan = %+v", rep)
	}
	if len(store.projects) != 0 {
		t.Fatal("dry run must not write to the store")
	}
}

func TestRun_NoLegacyData(t *testing.T) {
	root := filepath.Join(t.TempDir(), "empty")
	rep, err := Run(context.Background(), newFakeStore(), Options{Root: root})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if rep.ProjectsImported != 0 || len(rep.Notes) == 0 {
		t.Fatalf("expected empty import with a note, got %+v", rep)
	}
}

func TestHasLegacyData(t *testing.T) {
	root := writeLegacyRoot(t)
	has, err := HasLegacyData(root)
	if err != nil {
		t.Fatalf("HasLegacyData: %v", err)
	}
	if !has {
		t.Fatal("HasLegacyData = false, want true")
	}

	missing, err := HasLegacyData(filepath.Join(t.TempDir(), "nope"))
	if err != nil {
		t.Fatalf("HasLegacyData(missing) errored: %v", err)
	}
	if missing {
		t.Fatal("HasLegacyData = true for missing root")
	}
}

// TestHasLegacyData_ParseErrorSurfaced guards #2186 bug 2: a legacy store that
// exists but fails to parse must return the error, not a silent (false, nil)
// that the CLI would render as "No legacy AO projects found".
func TestHasLegacyData_ParseErrorSurfaced(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".agent-orchestrator")
	mustMkdir(t, root)
	// An unterminated quote is a YAML syntax error (not a tolerated TypeError).
	mustWrite(t, filepath.Join(root, "config.yaml"), `projects:
  alpha:
    path: "/repos/alpha
`)
	has, err := HasLegacyData(root)
	if err == nil {
		t.Fatal("HasLegacyData on a malformed config returned nil error; want the parse error surfaced")
	}
	if has {
		t.Fatal("HasLegacyData = true for an unparseable config")
	}
}

// TestRun_ObjectFormRepo guards #2186 bug 1: a legacy config.yaml whose `repo:`
// is a mapping (the shape `ao project add` writes) must still decode and import.
// When `repo` was typed as a string, yaml.Unmarshal failed and the whole store
// silently imported zero projects.
func TestRun_ObjectFormRepo(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".agent-orchestrator")
	mustMkdir(t, filepath.Join(root, "projects", "tg_content_factory", "sessions"))
	mustWrite(t, filepath.Join(root, "config.yaml"), `projects:
  tg_content_factory:
    projectId: tg_content_factory
    path: /repos/tg_content_factory
    repo:
      owner: axisrow
      name: tg_content_factory
      platform: github
      originUrl: https://github.com/axisrow/tg_content_factory
    defaultBranch: develop
    source: ao-project-add
`)
	store := newFakeStore()
	rep, err := Run(context.Background(), store, runOpts(root))
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if rep.ProjectsImported != 1 {
		t.Fatalf("projectsImported = %d, want 1 (object-form repo must decode)", rep.ProjectsImported)
	}
	// A non-default branch is carried into the rewrite config, proving sibling
	// fields decode correctly alongside the object-form repo mapping.
	if got := store.projects["tg_content_factory"].Config.DefaultBranch; got != "develop" {
		t.Fatalf("defaultBranch = %q, want develop", got)
	}
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o750); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, p, content string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
