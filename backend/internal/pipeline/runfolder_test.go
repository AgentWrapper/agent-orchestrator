package pipeline

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const sampleDefYAML = `name: review
on:
  pr: [created]
stages:
  - id: review
    executor: agent
    agent: claude
    prompt: review the diff
    produces: review.md
`

func TestCreateRunFolderLayout(t *testing.T) {
	base := t.TempDir()

	f, err := CreateRunFolder(base, "proj-1", RunID("run-1"), []byte(sampleDefYAML))
	if err != nil {
		t.Fatalf("CreateRunFolder: %v", err)
	}

	want := filepath.Join(base, "proj-1", "run-1")
	if f.Dir != want {
		t.Fatalf("Dir = %q, want %q", f.Dir, want)
	}

	for _, sub := range []string{"agent-outputs", "stage-logs"} {
		info, statErr := os.Stat(filepath.Join(f.Dir, sub))
		if statErr != nil {
			t.Fatalf("stat %s: %v", sub, statErr)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a directory", sub)
		}
	}

	got, err := os.ReadFile(filepath.Join(f.Dir, "definition.yaml"))
	if err != nil {
		t.Fatalf("read definition.yaml: %v", err)
	}
	if string(got) != sampleDefYAML {
		t.Fatalf("definition.yaml not byte-identical:\ngot:  %q\nwant: %q", got, sampleDefYAML)
	}
}

func TestCreateRunFolderIsIdempotent(t *testing.T) {
	base := t.TempDir()

	if _, err := CreateRunFolder(base, "proj-1", RunID("run-1"), []byte(sampleDefYAML)); err != nil {
		t.Fatalf("first CreateRunFolder: %v", err)
	}
	if _, err := CreateRunFolder(base, "proj-1", RunID("run-1"), []byte(sampleDefYAML)); err != nil {
		t.Fatalf("second CreateRunFolder: %v", err)
	}
}

func TestCreateRunFolderRejectsBadPathComponents(t *testing.T) {
	base := t.TempDir()

	cases := []struct {
		name      string
		projectID string
		runID     RunID
	}{
		{"empty project", "", "run-1"},
		{"empty run", "proj-1", ""},
		{"traversal project", "..", "run-1"},
		{"traversal run", "proj-1", ".."},
		{"separator project", "a/b", "run-1"},
		{"separator run", "proj-1", "a/b"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := CreateRunFolder(base, tc.projectID, tc.runID, []byte(sampleDefYAML)); err == nil {
				t.Fatalf("CreateRunFolder(%q, %q) = nil error, want rejection", tc.projectID, tc.runID)
			}
		})
	}
}

func TestPaths(t *testing.T) {
	f := RunFolder{Dir: "/base/proj/run"}

	if got, want := f.OutputPath(&Stage{ID: "review", Produces: "review.md"}), "/base/proj/run/agent-outputs/review.md"; got != want {
		t.Fatalf("OutputPath = %q, want %q", got, want)
	}
	if got := f.OutputPath(&Stage{ID: "build"}); got != "" {
		t.Fatalf("OutputPath with no produces = %q, want empty", got)
	}
	if got := f.OutputPath(nil); got != "" {
		t.Fatalf("OutputPath(nil) = %q, want empty", got)
	}
	if got, want := f.LogPath("build"), "/base/proj/run/stage-logs/build.log"; got != want {
		t.Fatalf("LogPath = %q, want %q", got, want)
	}
	if got, want := f.ContextPath(), "/base/proj/run/Context.md"; got != want {
		t.Fatalf("ContextPath = %q, want %q", got, want)
	}
	if got, want := RunWorkspaceDir(f), "/base/proj/run/workspace"; got != want {
		t.Fatalf("RunWorkspaceDir = %q, want %q", got, want)
	}
	if got, want := StageWorkspaceDir(f, "build"), "/base/proj/run/workspaces/build"; got != want {
		t.Fatalf("StageWorkspaceDir = %q, want %q", got, want)
	}
}

func TestVerifyArtifact(t *testing.T) {
	base := t.TempDir()
	f, err := CreateRunFolder(base, "proj-1", RunID("run-1"), []byte(sampleDefYAML))
	if err != nil {
		t.Fatalf("CreateRunFolder: %v", err)
	}

	// No produces: nothing is contracted, so the stage verifies.
	if !f.VerifyArtifact(&Stage{ID: "build"}) {
		t.Fatal("VerifyArtifact with no produces = false, want true")
	}
	if !f.VerifyArtifact(nil) {
		t.Fatal("VerifyArtifact(nil) = false, want true")
	}

	stage := &Stage{ID: "review", Produces: "review.md"}

	if f.VerifyArtifact(stage) {
		t.Fatal("VerifyArtifact on missing file = true, want false")
	}

	if err := os.WriteFile(f.OutputPath(stage), nil, 0o600); err != nil {
		t.Fatalf("write empty artifact: %v", err)
	}
	if f.VerifyArtifact(stage) {
		t.Fatal("VerifyArtifact on empty file = true, want false")
	}

	if err := os.WriteFile(f.OutputPath(stage), []byte("looks good\n"), 0o600); err != nil {
		t.Fatalf("write artifact: %v", err)
	}
	if !f.VerifyArtifact(stage) {
		t.Fatal("VerifyArtifact on non-empty file = false, want true")
	}

	// A directory at the artifact path is not an artifact.
	dirStage := &Stage{ID: "dir", Produces: "dir.md"}
	if err := os.Mkdir(f.OutputPath(dirStage), 0o750); err != nil {
		t.Fatalf("mkdir artifact dir: %v", err)
	}
	if f.VerifyArtifact(dirStage) {
		t.Fatal("VerifyArtifact on a directory = true, want false")
	}
}

func TestAppendContextAccumulates(t *testing.T) {
	base := t.TempDir()
	f, err := CreateRunFolder(base, "proj-1", RunID("run-1"), []byte(sampleDefYAML))
	if err != nil {
		t.Fatalf("CreateRunFolder: %v", err)
	}

	if _, err := os.Stat(f.ContextPath()); !os.IsNotExist(err) {
		t.Fatalf("Context.md exists before any append: %v", err)
	}

	lines := []string{
		"stage `review` finished, its output is at agent-outputs/review.md",
		"stage `fix` finished, its output is at agent-outputs/fix.md",
	}
	for _, line := range lines {
		if err := f.AppendContext(line); err != nil {
			t.Fatalf("AppendContext: %v", err)
		}
	}
	// A line that already ends in a newline must not gain a second one.
	if err := f.AppendContext("stage `ship` finished\n"); err != nil {
		t.Fatalf("AppendContext: %v", err)
	}

	got, err := os.ReadFile(f.ContextPath())
	if err != nil {
		t.Fatalf("read Context.md: %v", err)
	}
	want := lines[0] + "\n" + lines[1] + "\n" + "stage `ship` finished\n"
	if string(got) != want {
		t.Fatalf("Context.md =\n%q\nwant\n%q", got, want)
	}
}

func TestWriteRunJSONRoundTrips(t *testing.T) {
	base := t.TempDir()
	f, err := CreateRunFolder(base, "proj-1", RunID("run-1"), []byte(sampleDefYAML))
	if err != nil {
		t.Fatalf("CreateRunFolder: %v", err)
	}

	created := time.Date(2026, 7, 26, 10, 0, 0, 0, time.UTC)
	run := RunState{
		RunID:        RunID("run-1"),
		ProjectID:    "proj-1",
		PipelineID:   ID("pl-1"),
		PipelineName: "review",
		Subject: Subject{
			Kind:      SubjectPR,
			ProjectID: "proj-1",
			PR:        &PRRef{Number: 412, Repo: "acme/widget"},
		},
		Status: RunRunning,
		RunDir: f.Dir,
		Def: Pipeline{
			Name:   "review",
			Stages: []Stage{{ID: "review", Executor: ExecutorAgent, Agent: "claude", Prompt: "review the diff", Produces: "review.md"}},
		},
		Stages: map[string]*StageState{
			"review": {ID: "review", Outcome: OutcomeRunning, Attempt: 1, EnteredVia: EntryTrigger, StartedAt: created},
		},
		Nudged:    map[string]bool{"review": true},
		CreatedAt: created,
		UpdatedAt: created.Add(time.Minute),
	}

	if err := f.WriteRunJSON(run); err != nil {
		t.Fatalf("WriteRunJSON: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(f.Dir, "run.json"))
	if err != nil {
		t.Fatalf("read run.json: %v", err)
	}
	if !json.Valid(raw) {
		t.Fatal("run.json is not valid JSON")
	}
	// Pretty printed, per decision D2: this file is for humans.
	if !hasIndentedLine(raw) {
		t.Fatalf("run.json is not pretty printed:\n%s", raw)
	}

	var got RunState
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal run.json: %v", err)
	}
	if got.RunID != run.RunID || got.ProjectID != run.ProjectID || got.Status != run.Status {
		t.Fatalf("round trip lost identity: %+v", got)
	}
	if got.Subject.PR == nil || got.Subject.PR.Number != 412 {
		t.Fatalf("round trip lost the subject: %+v", got.Subject)
	}
	if len(got.Def.Stages) != 1 || got.Def.Stages[0].Produces != "review.md" {
		t.Fatalf("round trip lost the frozen definition: %+v", got.Def)
	}
	stage, ok := got.Stages["review"]
	if !ok || stage.Outcome != OutcomeRunning || stage.Attempt != 1 {
		t.Fatalf("round trip lost the stage state: %+v", got.Stages)
	}
	if !got.CreatedAt.Equal(run.CreatedAt) {
		t.Fatalf("CreatedAt = %v, want %v", got.CreatedAt, run.CreatedAt)
	}
}

func TestWriteRunJSONOverwrites(t *testing.T) {
	base := t.TempDir()
	f, err := CreateRunFolder(base, "proj-1", RunID("run-1"), []byte(sampleDefYAML))
	if err != nil {
		t.Fatalf("CreateRunFolder: %v", err)
	}

	if err := f.WriteRunJSON(RunState{RunID: "run-1", Status: RunRunning}); err != nil {
		t.Fatalf("first WriteRunJSON: %v", err)
	}
	if err := f.WriteRunJSON(RunState{RunID: "run-1", Status: RunSucceeded}); err != nil {
		t.Fatalf("second WriteRunJSON: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(f.Dir, "run.json"))
	if err != nil {
		t.Fatalf("read run.json: %v", err)
	}
	var got RunState
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal run.json: %v", err)
	}
	if got.Status != RunSucceeded {
		t.Fatalf("Status = %q, want %q", got.Status, RunSucceeded)
	}
}

func hasIndentedLine(raw []byte) bool {
	for i := 0; i < len(raw)-1; i++ {
		if raw[i] == '\n' && raw[i+1] == ' ' {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Declared outputs: the outputs endpoint's whole authorization rule
// ---------------------------------------------------------------------------

func TestDeclaredOutputResolvesADeclaredFilename(t *testing.T) {
	f := RunFolder{Dir: t.TempDir()}
	p, err := ParseDefinition([]byte(sampleDefYAML))
	if err != nil {
		t.Fatalf("ParseDefinition: %v", err)
	}

	got, err := f.DeclaredOutput(p, "review.md")
	if err != nil {
		t.Fatalf("DeclaredOutput: %v", err)
	}
	if want := filepath.Join(f.Dir, "agent-outputs", "review.md"); got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}

func TestDeclaredOutputRejectsEverythingElse(t *testing.T) {
	f := RunFolder{Dir: t.TempDir()}
	p, err := ParseDefinition([]byte(sampleDefYAML))
	if err != nil {
		t.Fatalf("ParseDefinition: %v", err)
	}

	// Traversal, absolute paths, separators, near-misses and the run folder's
	// own files are all the same answer: not declared, so not servable.
	for _, name := range []string{
		"", ".", "..", "../definition.yaml", "../../../etc/passwd",
		"/etc/passwd", `..\..\secrets`, "agent-outputs/review.md",
		"review.md/../../run.json", "run.json", "definition.yaml",
		"Review.md", "review.md ", "review",
	} {
		if _, err := f.DeclaredOutput(p, name); err == nil {
			t.Errorf("DeclaredOutput(%q) resolved, want rejection", name)
		}
	}
}

func TestDeclaredOutputRejectsATraversingProduces(t *testing.T) {
	// A frozen definition from an older build could carry a `produces` the
	// current validator rejects. Matching it must still not yield a path.
	f := RunFolder{Dir: t.TempDir()}
	p := &Pipeline{Stages: []Stage{{ID: "s", Produces: "../../run.json"}}}

	if _, err := f.DeclaredOutput(p, "../../run.json"); err == nil {
		t.Fatal("a traversing produces resolved, want rejection")
	}
}

func TestDeclaredOutputOnANilPipeline(t *testing.T) {
	if _, err := (RunFolder{Dir: t.TempDir()}).DeclaredOutput(nil, "review.md"); err == nil {
		t.Fatal("nil pipeline resolved, want rejection")
	}
}

// ---------------------------------------------------------------------------
// Log tail
// ---------------------------------------------------------------------------

func TestReadLogTail(t *testing.T) {
	f, err := CreateRunFolder(t.TempDir(), "proj-1", RunID("run-1"), []byte(sampleDefYAML))
	if err != nil {
		t.Fatalf("CreateRunFolder: %v", err)
	}
	if err := os.WriteFile(f.LogPath("review"), []byte("one\ntwo\nthree\n"), 0o600); err != nil {
		t.Fatalf("write log: %v", err)
	}

	tests := []struct {
		n             int
		want          string
		wantTruncated bool
	}{
		{0, "one\ntwo\nthree\n", false},
		{-1, "one\ntwo\nthree\n", false},
		{2, "two\nthree\n", true},
		{99, "one\ntwo\nthree\n", false},
		{1, "three\n", true},
	}
	for _, tc := range tests {
		got, exists, truncated, tailErr := f.ReadLogTail("review", tc.n)
		if tailErr != nil {
			t.Fatalf("ReadLogTail(%d): %v", tc.n, tailErr)
		}
		if !exists {
			t.Fatalf("ReadLogTail(%d): exists = false", tc.n)
		}
		if got != tc.want {
			t.Errorf("ReadLogTail(%d) = %q, want %q", tc.n, got, tc.want)
		}
		if truncated != tc.wantTruncated {
			t.Errorf("ReadLogTail(%d) truncated = %v, want %v", tc.n, truncated, tc.wantTruncated)
		}
	}
}

func TestReadLogTailMissingLogIsNotAnError(t *testing.T) {
	f, err := CreateRunFolder(t.TempDir(), "proj-1", RunID("run-1"), []byte(sampleDefYAML))
	if err != nil {
		t.Fatalf("CreateRunFolder: %v", err)
	}
	content, exists, _, err := f.ReadLogTail("never-started", 10)
	if err != nil {
		t.Fatalf("ReadLogTail: %v", err)
	}
	if exists || content != "" {
		t.Fatalf("exists = %v, content = %q, want false and empty", exists, content)
	}
}
