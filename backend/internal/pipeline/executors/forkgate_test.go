package executors

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

func boolp(b bool) *bool { return &b }

// TestForkFromContext pins the tri-state resolution the agent and builtin gates
// rely on: a known verdict passes through, an unknown verdict with a PR is
// fail-safe blocked, and an unknown verdict with no PR (manual run) runs.
func TestForkFromContext(t *testing.T) {
	cases := []struct {
		name     string
		ctx      pipeline.RunContext
		wantFork ForkStatus
		wantPR   int
	}{
		{"known fork", pipeline.RunContext{IsFromFork: boolp(true), PRNumber: 7}, ForkYes, 7},
		{"known same-repo", pipeline.RunContext{IsFromFork: boolp(false), PRNumber: 7}, ForkNo, 7},
		{"unknown with PR", pipeline.RunContext{PRNumber: 7}, ForkUnknown, 7},
		{"unknown no PR (manual)", pipeline.RunContext{}, ForkNo, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fork, pr := forkFromContext(c.ctx)
			if fork != c.wantFork || pr != c.wantPR {
				t.Fatalf("got fork=%v pr=%d, want fork=%v pr=%d", fork, pr, c.wantFork, c.wantPR)
			}
		})
	}
}

// TestAgent_ForkGate covers the fork/no-fork/unknown x allowForkPRs matrix: a
// gated stage self-skips completed/neutral WITHOUT spawning, and carries the
// uniform observation plus a human note; an allowed or non-fork PR spawns.
func TestAgent_ForkGate(t *testing.T) {
	cases := []struct {
		name        string
		ctx         pipeline.RunContext
		allow       bool
		wantSpawn   bool
		wantVerdict pipeline.Verdict
	}{
		{"fork blocked", pipeline.RunContext{IsFromFork: boolp(true), PRNumber: 7}, false, false, pipeline.VerdictNeutral},
		{"unknown blocked", pipeline.RunContext{PRNumber: 7}, false, false, pipeline.VerdictNeutral},
		{"fork allowed", pipeline.RunContext{IsFromFork: boolp(true), PRNumber: 7}, true, true, ""},
		{"same-repo runs", pipeline.RunContext{IsFromFork: boolp(false), PRNumber: 7}, false, true, ""},
		{"manual runs", pipeline.RunContext{}, false, true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := &mockSpawner{workspace: t.TempDir(), activity: "active"}
			exec := NewAgentExecutor(m)
			in := agentStartInput(m.workspace)
			in.Context = c.ctx
			in.AllowForkPRs = c.allow

			h, err := exec.Start(context.Background(), in)
			if err != nil {
				t.Fatalf("start: %v", err)
			}
			if c.wantSpawn {
				if m.spawnCalls != 1 {
					t.Fatalf("want a spawn, got %d spawn calls", m.spawnCalls)
				}
				return
			}
			if m.spawnCalls != 0 {
				t.Fatalf("gated stage must NOT spawn, got %d spawn calls", m.spawnCalls)
			}
			out, err := exec.Poll(context.Background(), h)
			if err != nil {
				t.Fatalf("poll: %v", err)
			}
			if out.Status != OutcomeCompleted || out.Verdict != c.wantVerdict {
				t.Fatalf("want completed/%s skip, got %s/%s", c.wantVerdict, out.Status, out.Verdict)
			}
			if len(out.Observations) != 1 || out.Observations[0].Name != forkSkipObservation {
				t.Fatalf("expected a fork-skip observation, got %+v", out.Observations)
			}
			if out.Observations[0].Note == "" {
				t.Fatal("fork-skip observation must carry a human note")
			}
		})
	}
}

// TestBuiltin_ForkGate mirrors the agent matrix for the builtin router: a gated
// stage self-skips WITHOUT any delivery, an allowed/non-fork/manual run delivers.
func TestBuiltin_ForkGate(t *testing.T) {
	cases := []struct {
		name     string
		ctx      pipeline.RunContext
		allow    bool
		wantSkip bool
	}{
		{"fork blocked", pipeline.RunContext{IsFromFork: boolp(true), PRNumber: 7}, false, true},
		{"unknown blocked", pipeline.RunContext{PRNumber: 7}, false, true},
		{"fork allowed", pipeline.RunContext{IsFromFork: boolp(true), PRNumber: 7}, true, false},
		{"same-repo runs", pipeline.RunContext{IsFromFork: boolp(false), PRNumber: 7}, false, false},
		{"manual runs", pipeline.RunContext{}, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			store := &fakeStore{arts: map[string][]pipeline.Artifact{
				"review": {finding("review", "a.go", "bug A")},
			}}
			msg := &fakeMessenger{alive: true}
			in := builtinInput(builtinStage(pipeline.BuiltinRouter, "review"))
			in.Context = c.ctx
			in.AllowForkPRs = c.allow

			out := runBuiltin(t, store, msg, in)

			if c.wantSkip {
				if len(msg.sent) != 0 {
					t.Fatalf("gated builtin must NOT deliver, got %d messages", len(msg.sent))
				}
				if out.Status != OutcomeCompleted || out.Verdict != pipeline.VerdictNeutral {
					t.Fatalf("want completed/neutral skip, got %s/%s", out.Status, out.Verdict)
				}
				if len(out.Observations) != 1 || out.Observations[0].Name != forkSkipObservation {
					t.Fatalf("expected a fork-skip observation, got %+v", out.Observations)
				}
				return
			}
			if len(msg.sent) != 1 {
				t.Fatalf("ungated builtin must deliver once, got %d messages", len(msg.sent))
			}
		})
	}
}

// TestAgent_SetsSessionIDOnOutcomes verifies the spawned session id rides both a
// completed and a failed agent outcome so the run detail can link to it either way.
func TestAgent_SetsSessionIDOnOutcomes(t *testing.T) {
	// Failed path: session terminates without findings.
	m := &mockSpawner{workspace: t.TempDir(), activity: "exited"}
	exec := NewAgentExecutor(m)
	h, err := exec.Start(context.Background(), agentStartInput(m.workspace))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	out, _ := exec.Poll(context.Background(), h)
	if out.Status != OutcomeFailed || out.SessionID != "sess-1" {
		t.Fatalf("failed outcome must carry session id, got %s/%q", out.Status, out.SessionID)
	}

	// Completed path: idle with a findings file.
	ws := t.TempDir()
	m2 := &mockSpawner{workspace: ws, activity: "idle"}
	exec2 := NewAgentExecutor(m2)
	h2, err := exec2.Start(context.Background(), agentStartInput(ws))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	writeFindingsAt(t, ws, findingLine(t, 0.9, "error"))
	out2, _ := exec2.Poll(context.Background(), h2)
	if out2.Status != OutcomeCompleted || out2.SessionID != "sess-1" {
		t.Fatalf("completed outcome must carry session id, got %s/%q", out2.Status, out2.SessionID)
	}
}
