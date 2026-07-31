package pipelinesvc_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	pipelinesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

const runFilesYAML = `name: review
stages:
  - id: review
    executor: agent
    agent: claude
    prompt: review the diff
    produces: review.md
    on_success: publish
  - id: publish
    executor: command
    run: make publish
`

// newRunFilesService stands up a real store and a real run folder on disk, so
// the traversal and symlink checks run against a filesystem rather than a mock.
func newRunFilesService(t *testing.T) (*pipelinesvc.Service, pipeline.RunFolder) {
	t.Helper()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "proj", Path: t.TempDir(), RegisteredAt: now}); err != nil {
		t.Fatalf("seed project: %v", err)
	}

	folder, err := pipeline.CreateRunFolder(t.TempDir(), "proj", "run-1", []byte(runFilesYAML))
	if err != nil {
		t.Fatalf("create run folder: %v", err)
	}
	def, err := pipeline.ParseDefinition([]byte(runFilesYAML))
	if err != nil {
		t.Fatalf("parse definition: %v", err)
	}

	run := pipeline.RunState{
		RunID:        "run-1",
		ProjectID:    "proj",
		PipelineID:   "pl-1",
		PipelineName: "review",
		Subject:      pipeline.Subject{Kind: pipeline.SubjectProject, ProjectID: "proj"},
		Status:       pipeline.RunRunning,
		RunDir:       folder.Dir,
		Def:          *def,
		Stages: map[string]*pipeline.StageState{
			"review":  {ID: "review", Outcome: pipeline.OutcomeRunning, Attempt: 1, EnteredVia: pipeline.EntryTrigger, StartedAt: now},
			"publish": {ID: "publish", Outcome: pipeline.OutcomePending},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := store.SavePipelineRun(ctx, &run); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	return pipelinesvc.New(store), folder
}

// ---------------------------------------------------------------------------
// Outputs: the endpoint is a file server pointed at a user-influenced path
// ---------------------------------------------------------------------------

func TestRunOutput_ServesADeclaredArtifact(t *testing.T) {
	svc, folder := newRunFilesService(t)
	writeOutput(t, folder, "review.md", "# findings\n")

	got, err := svc.RunOutput(context.Background(), "run-1", "review.md")
	if err != nil {
		t.Fatalf("RunOutput: %v", err)
	}
	if got.Filename != "review.md" || string(got.Content) != "# findings\n" {
		t.Fatalf("output = %+v", got)
	}
}

// Every one of these is a filename a caller could put in the URL. None of them
// may resolve, and the reason must not depend on whether the target exists.
func TestRunOutput_RejectsTraversalAbsoluteAndUndeclaredNames(t *testing.T) {
	svc, folder := newRunFilesService(t)
	writeOutput(t, folder, "review.md", "# findings\n")
	// Real files just outside the allowlist, so a leak would be observable.
	if err := os.WriteFile(filepath.Join(folder.Dir, "secret.txt"), []byte("shh"), 0o600); err != nil {
		t.Fatalf("seed secret: %v", err)
	}

	for _, name := range []string{
		"",
		".",
		"..",
		"../secret.txt",
		"../../../etc/passwd",
		"/etc/passwd",
		`..\..\secret.txt`,
		"agent-outputs/review.md",
		"review.md/../../run.json",
		"./review.md",
		"definition.yaml",
		"run.json",
		"secret.txt",
		"review.md\x00.png",
		"Review.md",
	} {
		_, err := svc.RunOutput(context.Background(), "run-1", name)
		if !errors.Is(err, pipeline.ErrOutputNotDeclared) {
			t.Errorf("RunOutput(%q) err = %v, want ErrOutputNotDeclared", name, err)
		}
	}
}

// A symlink planted in agent-outputs under the declared name is the one way a
// declared filename could still point outside the run folder.
func TestRunOutput_RejectsASymlinkEscape(t *testing.T) {
	svc, folder := newRunFilesService(t)
	outside := filepath.Join(t.TempDir(), "id_rsa")
	if err := os.WriteFile(outside, []byte("PRIVATE KEY"), 0o600); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(folder.Dir, "agent-outputs", "review.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	_, err := svc.RunOutput(context.Background(), "run-1", "review.md")
	if !errors.Is(err, pipeline.ErrOutputNotDeclared) {
		t.Fatalf("err = %v, want ErrOutputNotDeclared", err)
	}
}

// A directory named like the artifact is the same class of trick.
func TestRunOutput_RejectsADirectory(t *testing.T) {
	svc, folder := newRunFilesService(t)
	if err := os.Mkdir(filepath.Join(folder.Dir, "agent-outputs", "review.md"), 0o750); err != nil {
		t.Fatalf("seed dir: %v", err)
	}

	if _, err := svc.RunOutput(context.Background(), "run-1", "review.md"); !errors.Is(err, pipeline.ErrOutputNotDeclared) {
		t.Fatalf("err = %v, want ErrOutputNotDeclared", err)
	}
}

func TestRunOutput_DeclaredButNotWrittenYet(t *testing.T) {
	svc, _ := newRunFilesService(t)
	if _, err := svc.RunOutput(context.Background(), "run-1", "review.md"); !errors.Is(err, pipelinesvc.ErrOutputMissing) {
		t.Fatalf("err = %v, want ErrOutputMissing", err)
	}
}

func TestRunOutput_UnknownRun(t *testing.T) {
	svc, _ := newRunFilesService(t)
	if _, err := svc.RunOutput(context.Background(), "run-nope", "review.md"); err == nil {
		t.Fatal("an unknown run resolved an output")
	}
}

// ---------------------------------------------------------------------------
// Stage logs
// ---------------------------------------------------------------------------

func TestStageLog_TailsAndReportsTruncation(t *testing.T) {
	svc, folder := newRunFilesService(t)
	if err := os.WriteFile(folder.LogPath("review"), []byte("one\ntwo\nthree\n"), 0o600); err != nil {
		t.Fatalf("seed log: %v", err)
	}
	ctx := context.Background()

	whole, err := svc.StageLog(ctx, "run-1", "review", 0)
	if err != nil {
		t.Fatalf("StageLog: %v", err)
	}
	if whole.Content != "one\ntwo\nthree\n" || whole.Truncated {
		t.Fatalf("whole log = %+v", whole)
	}

	tail, err := svc.StageLog(ctx, "run-1", "review", 2)
	if err != nil {
		t.Fatalf("StageLog tail: %v", err)
	}
	if tail.Content != "two\nthree\n" || !tail.Truncated {
		t.Fatalf("tail = %+v", tail)
	}
}

func TestStageLog_Rejections(t *testing.T) {
	svc, _ := newRunFilesService(t)
	ctx := context.Background()

	if _, err := svc.StageLog(ctx, "run-1", "nope", 0); !errors.Is(err, pipelinesvc.ErrStageNotFound) {
		t.Errorf("unknown stage err = %v, want ErrStageNotFound", err)
	}
	if _, err := svc.StageLog(ctx, "run-1", "review", 0); !errors.Is(err, pipelinesvc.ErrStageLogMissing) {
		t.Errorf("unwritten log err = %v, want ErrStageLogMissing", err)
	}
	if _, err := svc.StageLog(ctx, "run-nope", "review", 0); err == nil {
		t.Error("an unknown run returned a log")
	}
}

func writeOutput(t *testing.T, folder pipeline.RunFolder, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(folder.Dir, "agent-outputs", name), []byte(body), 0o600); err != nil {
		t.Fatalf("write output %s: %v", name, err)
	}
}
