package engine

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// fakeCommander records spawn/kill/send calls for the adapter tests.
type fakeCommander struct {
	spawned  ports.SpawnConfig
	spawnOut domain.Session
	spawnErr error
	killErr  error
	killed   []domain.SessionID
	sent     map[domain.SessionID]string
}

func (f *fakeCommander) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.Session, error) {
	f.spawned = cfg
	return f.spawnOut, f.spawnErr
}

func (f *fakeCommander) Kill(_ context.Context, id domain.SessionID) (bool, error) {
	f.killed = append(f.killed, id)
	return f.killErr == nil, f.killErr
}

func (f *fakeCommander) Send(_ context.Context, id domain.SessionID, message string) error {
	if f.sent == nil {
		f.sent = map[domain.SessionID]string{}
	}
	f.sent[id] = message
	return nil
}

// fakeReader serves session/PR/artifact facts from in-memory maps.
type fakeReader struct {
	sessions map[domain.SessionID]domain.SessionRecord
	prs      map[domain.SessionID]domain.PRFacts
	runs     map[pipeline.RunID]pipeline.RunState
	arts     map[pipeline.ArtifactID]pipeline.Artifact
}

func (f *fakeReader) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	rec, ok := f.sessions[id]
	return rec, ok, nil
}

func (f *fakeReader) GetDisplayPRFactsForSession(_ context.Context, id domain.SessionID) (domain.PRFacts, bool, error) {
	pr, ok := f.prs[id]
	return pr, ok, nil
}

func (f *fakeReader) GetPipelineRun(_ context.Context, id pipeline.RunID) (pipeline.RunState, bool, error) {
	run, ok := f.runs[id]
	return run, ok, nil
}

func (f *fakeReader) GetPipelineArtifact(_ context.Context, id pipeline.ArtifactID) (pipeline.Artifact, bool, error) {
	a, ok := f.arts[id]
	return a, ok, nil
}

func TestSessionSpawnerAdapterSpawnMapsConfig(t *testing.T) {
	cmd := &fakeCommander{spawnOut: domain.Session{SessionRecord: domain.SessionRecord{
		ID: "mer-3", Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-3"},
	}}}
	a := &sessionSpawnerAdapter{cmd: cmd, reader: &fakeReader{}}

	got, err := a.Spawn(context.Background(), executors.SpawnRequest{
		ProjectID: "mer", IssueID: "issue-1", Prompt: "review this", Harness: "codex",
	})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if got.SessionID != "mer-3" || got.WorkspacePath != "/ws/mer-3" {
		t.Fatalf("spawned session = %+v", got)
	}
	if cmd.spawned.ProjectID != "mer" || cmd.spawned.IssueID != "issue-1" ||
		cmd.spawned.Prompt != "review this" || cmd.spawned.Harness != "codex" ||
		cmd.spawned.Kind != domain.KindWorker {
		t.Fatalf("spawn config mismapped: %+v", cmd.spawned)
	}
}

func TestSessionSpawnerAdapterGetAndKill(t *testing.T) {
	reader := &fakeReader{sessions: map[domain.SessionID]domain.SessionRecord{
		"live": {Activity: domain.Activity{State: domain.ActivityIdle}},
	}}
	cmd := &fakeCommander{killErr: errors.New("already gone")}
	a := &sessionSpawnerAdapter{cmd: cmd, reader: reader}

	snap, ok, err := a.Get(context.Background(), "live")
	if err != nil || !ok || snap.Activity != "idle" || snap.Terminated {
		t.Fatalf("get live = %+v ok=%v err=%v", snap, ok, err)
	}
	if _, ok, _ := a.Get(context.Background(), "missing"); ok {
		t.Fatal("missing session must report ok=false")
	}
	// Kill is best-effort: a kill error is swallowed so teardown stays clean.
	if err := a.Kill(context.Background(), "live"); err != nil {
		t.Fatalf("kill must swallow errors, got %v", err)
	}
	if len(cmd.killed) != 1 || cmd.killed[0] != "live" {
		t.Fatalf("kill not delegated: %v", cmd.killed)
	}
}

func TestCommandSessionsAdapterForkGate(t *testing.T) {
	reader := &fakeReader{
		sessions: map[domain.SessionID]domain.SessionRecord{
			"nopr": {Metadata: domain.SessionMetadata{WorkspacePath: "/ws/nopr"}},
			"pr":   {Metadata: domain.SessionMetadata{WorkspacePath: "/ws/pr"}},
		},
		prs: map[domain.SessionID]domain.PRFacts{
			"pr": {Number: 42},
		},
	}
	a := &commandSessionsAdapter{reader: reader}

	// No PR: safe to run (ForkNo), PRNumber 0.
	got, ok, err := a.Get(context.Background(), "nopr")
	if err != nil || !ok {
		t.Fatalf("get nopr: ok=%v err=%v", ok, err)
	}
	if got.Fork != executors.ForkNo || got.PRNumber != 0 || got.WorkspacePath != "/ws/nopr" {
		t.Fatalf("no-PR session = %+v, want ForkNo/0", got)
	}

	// PR present but fork provenance unknowable from the store: fail safe to
	// ForkUnknown so the command executor gates it behind allowForkPRs.
	got, ok, err = a.Get(context.Background(), "pr")
	if err != nil || !ok {
		t.Fatalf("get pr: ok=%v err=%v", ok, err)
	}
	if got.Fork != executors.ForkUnknown || got.PRNumber != 42 {
		t.Fatalf("PR session = %+v, want ForkUnknown/42", got)
	}

	if _, ok, _ := a.Get(context.Background(), "missing"); ok {
		t.Fatal("missing session must report ok=false")
	}
}

func TestSessionMessengerAdapterAlive(t *testing.T) {
	reader := &fakeReader{sessions: map[domain.SessionID]domain.SessionRecord{
		"live":   {Activity: domain.Activity{State: domain.ActivityActive}},
		"exited": {Activity: domain.Activity{State: domain.ActivityExited}},
		"dead":   {IsTerminated: true, Activity: domain.Activity{State: domain.ActivityIdle}},
	}}
	cmd := &fakeCommander{}
	a := &sessionMessengerAdapter{cmd: cmd, reader: reader}

	cases := map[string]bool{"live": true, "exited": false, "dead": false, "missing": false}
	for id, want := range cases {
		got, err := a.Alive(context.Background(), id)
		if err != nil {
			t.Fatalf("alive %s: %v", id, err)
		}
		if got != want {
			t.Fatalf("alive %s = %v, want %v", id, got, want)
		}
	}

	if err := a.Send(context.Background(), "live", "hello"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if cmd.sent["live"] != "hello" {
		t.Fatalf("send not delegated: %v", cmd.sent)
	}
}

func TestArtifactStoreAdapterGroupsUpstreamByStage(t *testing.T) {
	run := pipeline.RunState{
		RunID: "run-1",
		Stages: map[string]pipeline.StageState{
			"lint":   {StageRunID: "sr-lint", Artifacts: []pipeline.ArtifactID{"a1", "a2"}},
			"secrev": {StageRunID: "sr-sec", Artifacts: []pipeline.ArtifactID{"a3"}},
		},
	}
	reader := &fakeReader{
		runs: map[pipeline.RunID]pipeline.RunState{"run-1": run},
		arts: map[pipeline.ArtifactID]pipeline.Artifact{
			"a1": {ArtifactID: "a1", StageName: "lint", ArtifactInput: pipeline.ArtifactInput{Kind: pipeline.ArtifactKindFinding, Title: "f1"}},
			"a2": {ArtifactID: "a2", StageName: "lint", ArtifactInput: pipeline.ArtifactInput{Kind: pipeline.ArtifactKindJSON, Data: map[string]any{"k": "v"}}},
			"a3": {ArtifactID: "a3", StageName: "secrev", ArtifactInput: pipeline.ArtifactInput{Kind: pipeline.ArtifactKindFinding, Title: "f3"}},
		},
	}
	a := &artifactStoreAdapter{reader: reader}

	// Request an extra stage ("missing") that has no state; it is simply omitted.
	got, err := a.UpstreamArtifacts(context.Background(), "run-1", []string{"lint", "secrev", "missing"})
	if err != nil {
		t.Fatalf("upstream artifacts: %v", err)
	}
	if len(got["lint"]) != 2 || len(got["secrev"]) != 1 {
		t.Fatalf("grouping = %+v, want lint:2 secrev:1", got)
	}
	if _, present := got["missing"]; present {
		t.Fatalf("stage not in run must be omitted, got %+v", got["missing"])
	}
	// Both finding and JSON kinds are returned (builtins consume both).
	if got["lint"][0].Kind != pipeline.ArtifactKindFinding || got["lint"][1].Kind != pipeline.ArtifactKindJSON {
		t.Fatalf("lint artifacts lost kind fidelity: %+v", got["lint"])
	}

	// Unknown run yields an empty (non-nil) map, not an error.
	empty, err := a.UpstreamArtifacts(context.Background(), "nope", []string{"lint"})
	if err != nil || len(empty) != 0 {
		t.Fatalf("unknown run = %+v err=%v, want empty", empty, err)
	}
}

// Compile-time proof the adapters satisfy the executor DI seams.
var (
	_ executors.SessionSpawner   = (*sessionSpawnerAdapter)(nil)
	_ executors.CommandSessions  = (*commandSessionsAdapter)(nil)
	_ executors.SessionMessenger = (*sessionMessengerAdapter)(nil)
	_ executors.ArtifactStore    = (*artifactStoreAdapter)(nil)
)
