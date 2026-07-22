package executors

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// fakeStore returns scripted upstream artifacts.
type fakeStore struct {
	arts map[string][]pipeline.Artifact
	err  error
}

func (s *fakeStore) UpstreamArtifacts(_ context.Context, _ pipeline.RunID, _ []string) (map[string][]pipeline.Artifact, error) {
	return s.arts, s.err
}

// fakeMessenger records deliveries and scripts liveness/send behavior.
type fakeMessenger struct {
	alive    bool
	aliveErr error
	sendErr  error

	aliveCalls int
	sent       []string // messages delivered
}

func (m *fakeMessenger) Alive(_ context.Context, _ string) (bool, error) {
	m.aliveCalls++
	return m.alive, m.aliveErr
}

func (m *fakeMessenger) Send(_ context.Context, _, message string) error {
	if m.sendErr != nil {
		return m.sendErr
	}
	m.sent = append(m.sent, message)
	return nil
}

func finding(stage, file, title string) pipeline.Artifact {
	return pipeline.Artifact{
		ArtifactInput: pipeline.ArtifactInput{
			Kind: pipeline.ArtifactKindFinding, FilePath: file, StartLine: 1, EndLine: 2,
			Title: title, Description: "d", Category: "general", Severity: pipeline.SeverityWarning, Confidence: 0.7,
		},
		StageName: stage,
	}
}

func builtinStage(name pipeline.BuiltinName, dependsOn ...string) pipeline.Stage {
	return pipeline.Stage{
		Name:      "builtin-stage",
		Executor:  pipeline.StageExecutor{Kind: pipeline.ExecutorBuiltin, Name: name},
		DependsOn: dependsOn,
	}
}

func runBuiltin(t *testing.T, store ArtifactStore, msg SessionMessenger, in StartInput) Outcome {
	t.Helper()
	exec := NewBuiltinExecutor(store, msg)
	h, err := exec.Start(context.Background(), in)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	out, err := exec.Poll(context.Background(), h)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	return out
}

func builtinInput(stage pipeline.Stage) StartInput {
	return StartInput{
		PipelineName: "ci", RunID: "run-1", StageRunID: "sr-1",
		Stage: stage, LinkedSessionID: "worker-1",
	}
}

func TestRouter_DeliversToLinkedSession(t *testing.T) {
	store := &fakeStore{arts: map[string][]pipeline.Artifact{
		"review": {finding("review", "a.go", "bug A")},
	}}
	msg := &fakeMessenger{alive: true}
	out := runBuiltin(t, store, msg, builtinInput(builtinStage(pipeline.BuiltinRouter, "review")))

	if out.Status != OutcomeCompleted || out.Verdict != pipeline.VerdictNeutral {
		t.Fatalf("want completed/neutral, got %s/%s", out.Status, out.Verdict)
	}
	if msg.aliveCalls != 1 {
		t.Errorf("want a single liveness probe, got %d", msg.aliveCalls)
	}
	if len(msg.sent) != 1 {
		t.Fatalf("want 1 delivery, got %d", len(msg.sent))
	}
	if len(out.Artifacts) != 1 || out.Artifacts[0].Data["result"] != "delivered" {
		t.Fatalf("want a delivered json artifact, got %+v", out.Artifacts)
	}
}

func TestRouter_TargetOverrideWins(t *testing.T) {
	store := &fakeStore{arts: map[string][]pipeline.Artifact{"review": {finding("review", "a.go", "x")}}}
	msg := &fakeMessenger{alive: true}
	in := builtinInput(builtinStage(pipeline.BuiltinRouter, "review"))
	in.RoutingTargetSessionID = "orchestrator-9"
	out := runBuiltin(t, store, msg, in)
	if out.Artifacts[0].Data["targetSessionId"] != "orchestrator-9" {
		t.Errorf("routing target override must win, got %v", out.Artifacts[0].Data["targetSessionId"])
	}
}

func TestRouter_DeadWorkerSkipsDelivery(t *testing.T) {
	store := &fakeStore{arts: map[string][]pipeline.Artifact{
		"review": {finding("review", "a.go", "x")},
		"lint":   {finding("lint", "b.go", "y")},
	}}
	msg := &fakeMessenger{alive: false}
	out := runBuiltin(t, store, msg, builtinInput(builtinStage(pipeline.BuiltinRouter, "review", "lint")))

	if len(msg.sent) != 0 {
		t.Fatalf("dead worker must not receive deliveries, got %d", len(msg.sent))
	}
	if len(out.Observations) != 2 {
		t.Fatalf("want a skipped_worker_dead observation per stage, got %d", len(out.Observations))
	}
	for _, o := range out.Observations {
		if o.Name != "pipeline.send.skipped_worker_dead" {
			t.Errorf("unexpected observation %q", o.Name)
		}
	}
	for _, a := range out.Artifacts {
		if a.Data["result"] != "delivery_failed" || a.Data["reason"] != "worker_dead" {
			t.Errorf("want delivery_failed/worker_dead, got %+v", a.Data)
		}
	}
}

func TestRouter_SendErrorCaptured(t *testing.T) {
	store := &fakeStore{arts: map[string][]pipeline.Artifact{"review": {finding("review", "a.go", "x")}}}
	msg := &fakeMessenger{alive: true, sendErr: errors.New("pipe broke")}
	out := runBuiltin(t, store, msg, builtinInput(builtinStage(pipeline.BuiltinRouter, "review")))

	if len(out.Observations) != 1 || out.Observations[0].Name != "pipeline.send.failed" {
		t.Fatalf("want a send.failed observation, got %+v", out.Observations)
	}
	if out.Artifacts[0].Data["reason"] != "send_error" {
		t.Errorf("want send_error artifact, got %+v", out.Artifacts[0].Data)
	}
}

func TestRouter_ProbeErrorTreatedAsDead(t *testing.T) {
	store := &fakeStore{arts: map[string][]pipeline.Artifact{"review": {finding("review", "a.go", "x")}}}
	msg := &fakeMessenger{aliveErr: errors.New("probe failed")}
	out := runBuiltin(t, store, msg, builtinInput(builtinStage(pipeline.BuiltinRouter, "review")))
	if len(msg.sent) != 0 {
		t.Fatal("a failed probe must skip delivery")
	}
	if out.Observations[0].Name != "pipeline.send.skipped_worker_dead" {
		t.Errorf("want skipped_worker_dead on probe error, got %q", out.Observations[0].Name)
	}
}

func TestRouter_EmptyStagesProduceNothing(t *testing.T) {
	store := &fakeStore{arts: map[string][]pipeline.Artifact{"review": {}}}
	msg := &fakeMessenger{alive: true}
	out := runBuiltin(t, store, msg, builtinInput(builtinStage(pipeline.BuiltinRouter, "review")))
	if len(out.Artifacts) != 0 || len(msg.sent) != 0 {
		t.Fatalf("stages with no artifacts should produce no delivery, got %+v", out.Artifacts)
	}
}

func TestCompose_MergesUpstream(t *testing.T) {
	store := &fakeStore{arts: map[string][]pipeline.Artifact{
		"a": {finding("a", "f1.go", "x")},
		"b": {finding("b", "f2.go", "y"), finding("b", "f3.go", "z")},
	}}
	out := runBuiltin(t, store, &fakeMessenger{}, builtinInput(builtinStage(pipeline.BuiltinCompose, "a", "b")))

	if out.Status != OutcomeCompleted || len(out.Artifacts) != 1 {
		t.Fatalf("compose should yield one json artifact, got %s / %d", out.Status, len(out.Artifacts))
	}
	data := out.Artifacts[0].Data
	if data["totalArtifacts"] != 3 {
		t.Errorf("want totalArtifacts=3, got %v", data["totalArtifacts"])
	}
	from, ok := data["composedFrom"].([]string)
	if !ok || len(from) != 2 || from[0] != "a" || from[1] != "b" {
		t.Errorf("want composedFrom=[a b] (sorted), got %v", data["composedFrom"])
	}
	stages, ok := data["stages"].(map[string]any)
	if !ok || len(stages) != 2 {
		t.Errorf("want per-stage buckets, got %v", data["stages"])
	}
}

func TestBuiltin_StoreErrorFails(t *testing.T) {
	store := &fakeStore{err: errors.New("db down")}
	out := runBuiltin(t, store, &fakeMessenger{}, builtinInput(builtinStage(pipeline.BuiltinCompose, "a")))
	if out.Status != OutcomeFailed {
		t.Fatalf("store error should fail the stage, got %s", out.Status)
	}
}

func TestBuiltin_UnknownNameFails(t *testing.T) {
	store := &fakeStore{arts: map[string][]pipeline.Artifact{}}
	out := runBuiltin(t, store, &fakeMessenger{}, builtinInput(builtinStage(pipeline.BuiltinName("bogus"))))
	if out.Status != OutcomeFailed {
		t.Fatalf("unknown builtin should fail, got %s", out.Status)
	}
}

func TestBuiltin_StartRejectsNonBuiltinStage(t *testing.T) {
	exec := NewBuiltinExecutor(&fakeStore{}, &fakeMessenger{})
	in := builtinInput(agentStage(pipeline.ModeReview))
	if _, err := exec.Start(context.Background(), in); err == nil {
		t.Fatal("expected error for a non-builtin stage")
	}
}

// --- Set facade routing ---

func TestSet_RoutesByKind(t *testing.T) {
	agentSpawner := &mockSpawner{workspace: t.TempDir(), activity: "active"}
	cmdRunner := &fakeRunner{res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded"}`}}
	cmdSessions := &fakeCommandSessions{exists: true, session: CommandSession{WorkspacePath: "/ws", Fork: ForkNo}}
	store := &fakeStore{arts: map[string][]pipeline.Artifact{}}

	set := NewSet(
		NewAgentExecutor(agentSpawner),
		NewCommandExecutor(cmdRunner, cmdSessions),
		NewBuiltinExecutor(store, &fakeMessenger{}),
	)

	// Command stage routes to the command executor.
	h, err := set.Start(context.Background(), baseCommandInput())
	if err != nil {
		t.Fatalf("start command via set: %v", err)
	}
	out, err := set.Poll(context.Background(), h)
	if err != nil || out.Status != OutcomeCompleted {
		t.Fatalf("command via set should complete, got %s (%v)", out.Status, err)
	}
	if !cmdRunner.started {
		t.Error("set did not route the command stage to the command runner")
	}

	// Builtin stage routes to the builtin executor.
	bh, err := set.Start(context.Background(), builtinInput(builtinStage(pipeline.BuiltinCompose)))
	if err != nil {
		t.Fatalf("start builtin via set: %v", err)
	}
	bout, _ := set.Poll(context.Background(), bh)
	if bout.Status != OutcomeCompleted {
		t.Errorf("builtin via set should complete, got %s", bout.Status)
	}
}

func TestSet_CancelRoutesToOwner(t *testing.T) {
	agentSpawner := &mockSpawner{workspace: t.TempDir(), activity: "active"}
	set := NewSet(NewAgentExecutor(agentSpawner), nil, nil)
	in := agentStartInput(agentSpawner.workspace)
	h, err := set.Start(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if err := set.Cancel(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	if agentSpawner.killCalls != 1 {
		t.Errorf("cancel via set should kill the agent session, got %d", agentSpawner.killCalls)
	}
}
