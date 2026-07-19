package engine

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline/executors"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// fakeCommander records spawn/kill/send calls for the adapter tests. When
// spawnErrOnce is set it is returned by the first Spawn and then cleared, so the
// fallback-retry path can be exercised (the second Spawn succeeds).
type fakeCommander struct {
	spawned      ports.SpawnConfig
	spawnConfigs []ports.SpawnConfig
	spawnOut     domain.Session
	spawnErr     error
	spawnErrOnce error
	killErr      error
	killed       []domain.SessionID
	sent         map[domain.SessionID]string
}

func (f *fakeCommander) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.Session, error) {
	f.spawned = cfg
	f.spawnConfigs = append(f.spawnConfigs, cfg)
	if f.spawnErrOnce != nil {
		err := f.spawnErrOnce
		f.spawnErrOnce = nil
		return domain.Session{}, err
	}
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

// checkedOutElsewhereAPIErr mirrors what session.Service returns in production:
// the workspace sentinel mapped by toAPIError into a typed 409 whose Unwrap chain
// no longer carries the sentinel, only the stable code.
func checkedOutElsewhereAPIErr() error {
	return apierr.Conflict("BRANCH_CHECKED_OUT_ELSEWHERE", "workspace: branch is already checked out in another worktree", nil)
}

func TestSessionSpawnerAdapterFallbackOnBranchConflict(t *testing.T) {
	cmd := &fakeCommander{
		spawnErrOnce: checkedOutElsewhereAPIErr(),
		spawnOut: domain.Session{SessionRecord: domain.SessionRecord{
			ID: "mer-9", Metadata: domain.SessionMetadata{WorkspacePath: "/ws/mer-9"},
		}},
	}
	a := &sessionSpawnerAdapter{cmd: cmd, reader: &fakeReader{}, log: slog.Default()}

	got, err := a.Spawn(context.Background(), executors.SpawnRequest{
		ProjectID: "mer", Prompt: "review this", Harness: "codex",
		Branch: "feature/x", StageRunID: "sr-abc#2",
	})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if got.SessionID != "mer-9" {
		t.Fatalf("fallback spawn session = %+v", got)
	}
	if len(cmd.spawnConfigs) != 2 {
		t.Fatalf("want 2 spawn attempts, got %d", len(cmd.spawnConfigs))
	}
	// First attempt: the real PR source branch, no base override.
	if cmd.spawnConfigs[0].Branch != "feature/x" || cmd.spawnConfigs[0].BaseBranch != "" {
		t.Fatalf("first attempt = %+v, want Branch=feature/x BaseBranch=empty", cmd.spawnConfigs[0])
	}
	// Retry: a derived pipeline/ branch based at the PR source branch head.
	retry := cmd.spawnConfigs[1]
	if retry.Branch != "pipeline/sr-abc-2" {
		t.Fatalf("fallback branch = %q, want pipeline/sr-abc-2", retry.Branch)
	}
	if retry.BaseBranch != "feature/x" {
		t.Fatalf("fallback base = %q, want feature/x", retry.BaseBranch)
	}
	if !strings.Contains(retry.Prompt, "review this") || !strings.Contains(retry.Prompt, "git push origin HEAD:feature/x") {
		t.Fatalf("fallback prompt missing note or original: %q", retry.Prompt)
	}
}

func TestSessionSpawnerAdapterNoRetryOnOtherError(t *testing.T) {
	cmd := &fakeCommander{spawnErr: errors.New("boom")}
	a := &sessionSpawnerAdapter{cmd: cmd, reader: &fakeReader{}, log: slog.Default()}

	if _, err := a.Spawn(context.Background(), executors.SpawnRequest{
		ProjectID: "mer", Branch: "feature/x", StageRunID: "sr-1",
	}); err == nil {
		t.Fatal("want error for non-conflict failure")
	}
	if len(cmd.spawnConfigs) != 1 {
		t.Fatalf("non-conflict error must not retry, got %d attempts", len(cmd.spawnConfigs))
	}
}

func TestSessionSpawnerAdapterEmptyBranchNeverRetries(t *testing.T) {
	cmd := &fakeCommander{spawnErr: checkedOutElsewhereAPIErr()}
	a := &sessionSpawnerAdapter{cmd: cmd, reader: &fakeReader{}, log: slog.Default()}

	if _, err := a.Spawn(context.Background(), executors.SpawnRequest{
		ProjectID: "mer", Branch: "", StageRunID: "sr-1",
	}); err == nil {
		t.Fatal("want error propagated for empty-branch spawn")
	}
	if len(cmd.spawnConfigs) != 1 {
		t.Fatalf("empty-branch spawn must not retry, got %d attempts", len(cmd.spawnConfigs))
	}
}

func TestFallbackBranchNamesUniquePerStage(t *testing.T) {
	// Two stages of the same run carry distinct StageRunIDs, so their derived
	// fallback branches never collide.
	one := fallbackBranchName("sr-" + "aaaa-1111")
	two := fallbackBranchName("sr-" + "bbbb-2222")
	if one == two {
		t.Fatalf("derived names collide: %q", one)
	}
	if one != "pipeline/sr-aaaa-1111" {
		t.Fatalf("unexpected derived name %q", one)
	}
	// A retry attempt (#N suffix) sanitizes to a valid, distinct leaf.
	if got := fallbackBranchName("sr-aaaa-1111#3"); got != "pipeline/sr-aaaa-1111-3" {
		t.Fatalf("retry derived name = %q, want pipeline/sr-aaaa-1111-3", got)
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
	forkYes, forkNo := true, false
	reader := &fakeReader{
		sessions: map[domain.SessionID]domain.SessionRecord{
			"nopr":     {Metadata: domain.SessionMetadata{WorkspacePath: "/ws/nopr"}},
			"unknown":  {Metadata: domain.SessionMetadata{WorkspacePath: "/ws/unknown"}},
			"fork":     {Metadata: domain.SessionMetadata{WorkspacePath: "/ws/fork"}},
			"samerepo": {Metadata: domain.SessionMetadata{WorkspacePath: "/ws/samerepo"}},
		},
		prs: map[domain.SessionID]domain.PRFacts{
			"unknown":  {Number: 42},                       // is_from_fork unpopulated (legacy row)
			"fork":     {Number: 43, IsFromFork: &forkYes}, // observed fork
			"samerepo": {Number: 44, IsFromFork: &forkNo},  // observed same-repo
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

	// PR with unpopulated provenance (nil): fail safe to ForkUnknown so the
	// command executor gates it behind allowForkPRs.
	got, ok, err = a.Get(context.Background(), "unknown")
	if err != nil || !ok {
		t.Fatalf("get unknown: ok=%v err=%v", ok, err)
	}
	if got.Fork != executors.ForkUnknown || got.PRNumber != 42 {
		t.Fatalf("unknown-provenance session = %+v, want ForkUnknown/42", got)
	}

	// PR observed to be from a fork: ForkYes.
	got, ok, err = a.Get(context.Background(), "fork")
	if err != nil || !ok {
		t.Fatalf("get fork: ok=%v err=%v", ok, err)
	}
	if got.Fork != executors.ForkYes || got.PRNumber != 43 {
		t.Fatalf("fork session = %+v, want ForkYes/43", got)
	}

	// PR observed to be same-repo: ForkNo, runs normally.
	got, ok, err = a.Get(context.Background(), "samerepo")
	if err != nil || !ok {
		t.Fatalf("get samerepo: ok=%v err=%v", ok, err)
	}
	if got.Fork != executors.ForkNo || got.PRNumber != 44 {
		t.Fatalf("same-repo session = %+v, want ForkNo/44", got)
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
