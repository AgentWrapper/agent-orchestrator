package executors

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// mockSpawner is a scriptable SessionSpawner for agent-executor tests. No real
// session is ever created.
type mockSpawner struct {
	workspace  string
	spawnErr   error
	spawnCalls int
	killCalls  int
	lastReq    SpawnRequest

	// snapshot state, mutated by tests between polls.
	activity   string
	terminated bool
	exists     bool
}

func (m *mockSpawner) Spawn(_ context.Context, req SpawnRequest) (SpawnedSession, error) {
	m.spawnCalls++
	m.lastReq = req
	if m.spawnErr != nil {
		return SpawnedSession{}, m.spawnErr
	}
	m.exists = true
	return SpawnedSession{SessionID: "sess-1", WorkspacePath: m.workspace}, nil
}

func (m *mockSpawner) Get(_ context.Context, _ string) (SessionSnapshot, bool, error) {
	if !m.exists {
		return SessionSnapshot{}, false, nil
	}
	return SessionSnapshot{Activity: m.activity, Terminated: m.terminated}, true, nil
}

func (m *mockSpawner) Kill(_ context.Context, _ string) error {
	m.killCalls++
	m.exists = false
	return nil
}

func agentStartInput(ws string) StartInput {
	return StartInput{
		PipelineName: "ci",
		ProjectID:    "proj",
		RunID:        "run-1",
		StageRunID:   "sr-1",
		Stage:        agentStage(pipeline.ModeReview),
	}
}

func startAgent(t *testing.T, m *mockSpawner) (*AgentExecutor, Handle) {
	t.Helper()
	exec := NewAgentExecutor(m)
	h, err := exec.Start(context.Background(), agentStartInput(m.workspace))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	return exec, h
}

func TestAgent_RunningUntilIdleAndFile(t *testing.T) {
	m := &mockSpawner{workspace: t.TempDir(), activity: "active"}
	exec, h := startAgent(t, m)

	// Active, no file -> running.
	out, _ := exec.Poll(context.Background(), h)
	if out.Status != OutcomeRunning {
		t.Fatalf("want running while active, got %s", out.Status)
	}

	// Idle but file still missing -> running.
	m.activity = "idle"
	out, _ = exec.Poll(context.Background(), h)
	if out.Status != OutcomeRunning {
		t.Fatalf("want running with no findings file, got %s", out.Status)
	}
}

func TestAgent_CompletesAndKills(t *testing.T) {
	ws := t.TempDir()
	m := &mockSpawner{workspace: ws, activity: "idle"}
	exec, h := startAgent(t, m)
	writeFindingsAt(t, ws, findingLine(t, 0.9, "error"))

	out, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != OutcomeCompleted {
		t.Fatalf("want completed, got %s (%s)", out.Status, out.ErrorMessage)
	}
	if len(out.Artifacts) != 1 {
		t.Fatalf("want 1 artifact, got %d", len(out.Artifacts))
	}
	if m.killCalls != 1 {
		t.Errorf("want session killed once on completion, got %d", m.killCalls)
	}
}

func TestAgent_EmptyFileCompletesZeroArtifacts(t *testing.T) {
	ws := t.TempDir()
	m := &mockSpawner{workspace: ws, activity: "idle"}
	exec, h := startAgent(t, m)
	writeFindingsAt(t, ws) // empty file

	out, _ := exec.Poll(context.Background(), h)
	if out.Status != OutcomeCompleted || len(out.Artifacts) != 0 {
		t.Fatalf("empty file should complete with zero artifacts, got %s / %d", out.Status, len(out.Artifacts))
	}
	if m.killCalls != 1 {
		t.Errorf("want kill on completion, got %d", m.killCalls)
	}
}

func TestAgent_BadFindingsFailsWithoutKill(t *testing.T) {
	ws := t.TempDir()
	m := &mockSpawner{workspace: ws, activity: "idle"}
	exec, h := startAgent(t, m)
	writeFindingsAt(t, ws, "not-json {{{")

	out, _ := exec.Poll(context.Background(), h)
	if out.Status != OutcomeFailed {
		t.Fatalf("want failed, got %s", out.Status)
	}
	if m.killCalls != 0 {
		t.Errorf("bad findings file must leave session up, got kills=%d", m.killCalls)
	}
}

func TestAgent_VanishedSessionFails(t *testing.T) {
	m := &mockSpawner{workspace: t.TempDir(), activity: "idle"}
	exec, h := startAgent(t, m)
	m.exists = false // vanished

	out, _ := exec.Poll(context.Background(), h)
	if out.Status != OutcomeFailed {
		t.Fatalf("want failed, got %s", out.Status)
	}
	if !strings.Contains(out.ErrorMessage, "no longer exists") {
		t.Errorf("unexpected message: %s", out.ErrorMessage)
	}
}

func TestAgent_TerminatedWithoutFindingsFails(t *testing.T) {
	m := &mockSpawner{workspace: t.TempDir(), activity: "exited"}
	exec, h := startAgent(t, m)

	out, _ := exec.Poll(context.Background(), h)
	if out.Status != OutcomeFailed {
		t.Fatalf("want failed, got %s", out.Status)
	}
	if !strings.Contains(out.ErrorMessage, "terminated without findings") {
		t.Errorf("unexpected message: %s", out.ErrorMessage)
	}
}

func TestAgent_TruncationEmitsObservation(t *testing.T) {
	ws := t.TempDir()
	m := &mockSpawner{workspace: ws, activity: "idle"}
	exec, h := startAgent(t, m)

	// Write past the cap.
	path := filepath.Join(ws, ".ao", pipeline.FindingsFilename)
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	f, _ := os.Create(path)
	line := findingLine(t, 0.5, "info") + "\n"
	for w := 0; w <= findingsFileSizeCapBytes; w += len(line) {
		f.WriteString(line)
	}
	f.Close()

	out, _ := exec.Poll(context.Background(), h)
	if out.Status != OutcomeCompleted {
		t.Fatalf("want completed, got %s", out.Status)
	}
	if len(out.Observations) != 1 || out.Observations[0].Name != "pipeline.findings.truncated" {
		t.Fatalf("expected a truncation observation, got %+v", out.Observations)
	}
}

func TestAgent_StartRejectsNonAgentStage(t *testing.T) {
	m := &mockSpawner{workspace: t.TempDir()}
	exec := NewAgentExecutor(m)
	in := agentStartInput(m.workspace)
	in.Stage.Executor.Kind = pipeline.ExecutorCommand
	if _, err := exec.Start(context.Background(), in); err == nil {
		t.Fatal("expected error starting a command stage on the agent executor")
	}
	if m.spawnCalls != 0 {
		t.Error("must not spawn for a non-agent stage")
	}
}

func TestAgent_SpawnErrorPropagates(t *testing.T) {
	m := &mockSpawner{workspace: t.TempDir(), spawnErr: errors.New("boom")}
	exec := NewAgentExecutor(m)
	if _, err := exec.Start(context.Background(), agentStartInput(m.workspace)); err == nil {
		t.Fatal("expected spawn error to propagate")
	}
}

func TestAgent_NoWorkspaceKillsAndFails(t *testing.T) {
	m := &mockSpawner{workspace: ""} // spawn returns empty workspace
	exec := NewAgentExecutor(m)
	if _, err := exec.Start(context.Background(), agentStartInput("")); err == nil {
		t.Fatal("expected error when spawned session has no workspace")
	}
	if m.killCalls != 1 {
		t.Errorf("want the workspace-less orphan killed, got %d", m.killCalls)
	}
}

func TestAgent_SpawnSetsBranchFromPRContext(t *testing.T) {
	m := &mockSpawner{workspace: t.TempDir(), activity: "active"}
	exec := NewAgentExecutor(m)
	in := agentStartInput(m.workspace)
	sameRepo := false
	in.Context = pipeline.RunContext{SourceBranch: "feature", PRNumber: 3, IsFromFork: &sameRepo}
	if _, err := exec.Start(context.Background(), in); err != nil {
		t.Fatalf("start: %v", err)
	}
	if m.lastReq.Branch != "feature" {
		t.Fatalf("spawn branch = %q, want %q", m.lastReq.Branch, "feature")
	}
}

func TestAgent_SpawnNoBranchWithoutPRContext(t *testing.T) {
	m := &mockSpawner{workspace: t.TempDir(), activity: "active"}
	exec := NewAgentExecutor(m)
	if _, err := exec.Start(context.Background(), agentStartInput(m.workspace)); err != nil {
		t.Fatalf("start: %v", err)
	}
	if m.lastReq.Branch != "" {
		t.Fatalf("spawn branch = %q, want empty for a run with no PR", m.lastReq.Branch)
	}
}

func TestAgent_CancelKills(t *testing.T) {
	m := &mockSpawner{workspace: t.TempDir(), activity: "active"}
	exec, h := startAgent(t, m)
	if err := exec.Cancel(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	if m.killCalls != 1 {
		t.Errorf("cancel should kill once, got %d", m.killCalls)
	}
}

// writeFindingsAt writes a findings file under {ws}/.ao/.
func writeFindingsAt(t *testing.T, ws string, lines ...string) {
	t.Helper()
	dir := filepath.Join(ws, ".ao")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := ""
	for _, l := range lines {
		content += l + "\n"
	}
	if err := os.WriteFile(filepath.Join(dir, pipeline.FindingsFilename), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
