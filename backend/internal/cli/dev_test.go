package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/devimport"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestDevImportProjectsDryRunWritesNothing(t *testing.T) {
	cfg := setConfigEnv(t)
	sourceDir := filepath.Join(t.TempDir(), "source")
	writeDevImportProject(t, sourceDir, "alpha", "/repos/alpha")

	out, _, err := executeCLI(t, Deps{}, "dev", "import-projects", "--from-data-dir", sourceDir, "--dry-run")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Dry run -- no changes written.") || !strings.Contains(out, "Inserted: 1") {
		t.Fatalf("out = %q", out)
	}

	target, err := sqlite.Open(cfg.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = target.Close() }()
	projects, err := target.ListProjects(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 0 {
		t.Fatalf("target projects = %#v, want none", projects)
	}
}

func TestDevImportProjectsJSON(t *testing.T) {
	setConfigEnv(t)
	sourceDir := filepath.Join(t.TempDir(), "source")
	writeDevImportProject(t, sourceDir, "alpha", "/repos/alpha")

	out, _, err := executeCLI(t, Deps{}, "dev", "import-projects", "--from-data-dir", sourceDir, "--json")
	if err != nil {
		t.Fatal(err)
	}
	var rep devimport.Report
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("parse report %q: %v", out, err)
	}
	if rep.SourceDataDir != sourceDir || rep.Inserted != 1 || rep.Updated != 0 || rep.Skipped != 0 {
		t.Fatalf("report = %#v", rep)
	}
}

func TestDevImportProjectsRefusesLiveTargetDaemon(t *testing.T) {
	cfg := setConfigEnv(t)
	sourceDir := filepath.Join(t.TempDir(), "source")
	writeDevImportProject(t, sourceDir, "alpha", "/repos/alpha")
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: os.Getpid(), Port: 3002, StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	_, _, err := executeCLI(t, Deps{}, "dev", "import-projects", "--from-data-dir", sourceDir)
	if err == nil || !strings.Contains(err.Error(), "target AO daemon is running") {
		t.Fatalf("err = %v, want live target daemon refusal", err)
	}
}

func TestDevImportProjectsRefusesSameSourceAndTargetDataDir(t *testing.T) {
	cfg := setConfigEnv(t)

	_, _, err := executeCLI(t, Deps{}, "dev", "import-projects", "--from-data-dir", cfg.dataDir)
	if err == nil || !strings.Contains(err.Error(), "source and target data dirs are the same") {
		t.Fatalf("err = %v, want same-dir refusal", err)
	}
}

func writeDevImportProject(t *testing.T, dataDir string, id string, path string) {
	t.Helper()
	store, err := sqlite.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	project := domain.ProjectRecord{
		ID:            id,
		Path:          path,
		RepoOriginURL: "https://example.com/" + id + ".git",
		DisplayName:   id,
		RegisteredAt:  time.Unix(100, 0).UTC(),
		Kind:          domain.ProjectKindSingleRepo,
		Config:        domain.ProjectConfig{DefaultBranch: "main"},
	}
	if err := store.UpsertWorkspaceProject(context.Background(), project, nil); err != nil {
		t.Fatal(err)
	}
}
