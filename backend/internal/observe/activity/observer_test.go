package activity

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/codex"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeSessions struct {
	rows []domain.SessionRecord
	err  error
}

func (f fakeSessions) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return f.rows, f.err
}

type fakeSink struct {
	id      domain.SessionID
	signals []ports.ActivitySignal
}

func (f *fakeSink) ApplyActivitySignal(_ context.Context, id domain.SessionID, signal ports.ActivitySignal) error {
	f.id = id
	f.signals = append(f.signals, signal)
	return nil
}

type fakeRuntime struct {
	output string
	err    error
	calls  int
}

func (f *fakeRuntime) GetOutput(context.Context, ports.RuntimeHandle, int) (string, error) {
	f.calls++
	return f.output, f.err
}

type fakeAgents map[domain.AgentHarness]ports.Agent

func (f fakeAgents) Agent(harness domain.AgentHarness) (ports.Agent, bool) {
	agent, ok := f[harness]
	return agent, ok
}

func activeSession(now time.Time, harness domain.AgentHarness) domain.SessionRecord {
	return domain.SessionRecord{
		ID:        "ao-1",
		Harness:   harness,
		Activity:  domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(-3 * time.Minute)},
		UpdatedAt: now.Add(-3 * time.Minute),
		Metadata: domain.SessionMetadata{
			RuntimeHandleID: "ao-1",
			RuntimeLaunchID: "launch-1",
		},
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestPollReconcilesStaleCodexAtComposer(t *testing.T) {
	now := time.Unix(500, 0).UTC()
	session := activeSession(now, domain.HarnessCodex)
	sink := &fakeSink{}
	runtime := &fakeRuntime{output: "› Write tests for @filename\n\ngpt-5.6-sol low · ~/project\n"}
	observer := New(
		fakeSessions{rows: []domain.SessionRecord{session}},
		sink,
		runtime,
		fakeAgents{domain.HarnessCodex: codex.New()},
		Config{Clock: func() time.Time { return now }, Logger: testLogger()},
	)

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sink.signals) != 1 {
		t.Fatalf("signals = %d, want 1", len(sink.signals))
	}
	signal := sink.signals[0]
	if sink.id != session.ID || signal.State != domain.ActivityIdle || signal.Event != "terminal-idle" {
		t.Fatalf("unexpected reconciliation: id=%q signal=%+v", sink.id, signal)
	}
	if !signal.ExpectedUpdatedAt.Equal(session.UpdatedAt) || signal.LaunchID != "launch-1" {
		t.Fatalf("reconciliation fence = %+v, want updatedAt=%v launch=launch-1", signal, session.UpdatedAt)
	}
}

func TestPollKeepsGenuineLongCodexTurnActive(t *testing.T) {
	now := time.Unix(500, 0).UTC()
	sink := &fakeSink{}
	runtime := &fakeRuntime{output: "• Working (3m 10s • esc to interrupt)\n› Add tests\n\ngpt-5.6-sol low · ~/project\n"}
	observer := New(
		fakeSessions{rows: []domain.SessionRecord{activeSession(now, domain.HarnessCodex)}},
		sink,
		runtime,
		fakeAgents{domain.HarnessCodex: codex.New()},
		Config{Clock: func() time.Time { return now }, Logger: testLogger()},
	)

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sink.signals) != 0 {
		t.Fatalf("long active turn emitted reconciliation: %+v", sink.signals)
	}
}

func TestPollLeavesOtherHarnessesUntouched(t *testing.T) {
	now := time.Unix(500, 0).UTC()
	sink := &fakeSink{}
	runtime := &fakeRuntime{output: "› prompt\nmodel · ~/project\n"}
	observer := New(
		fakeSessions{rows: []domain.SessionRecord{activeSession(now, domain.HarnessClaudeCode)}},
		sink,
		runtime,
		fakeAgents{domain.HarnessClaudeCode: claudecode.New()},
		Config{Clock: func() time.Time { return now }, Logger: testLogger()},
	)

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runtime.calls != 0 || len(sink.signals) != 0 {
		t.Fatalf("unaffected harness: output calls=%d signals=%+v", runtime.calls, sink.signals)
	}
}

func TestPollSkipsFreshActiveAndOutputFailures(t *testing.T) {
	now := time.Unix(500, 0).UTC()
	fresh := activeSession(now, domain.HarnessCodex)
	fresh.Activity.LastActivityAt = now.Add(-time.Minute)
	runtime := &fakeRuntime{err: errors.New("capture failed")}
	observer := New(
		fakeSessions{rows: []domain.SessionRecord{fresh}},
		&fakeSink{},
		runtime,
		fakeAgents{domain.HarnessCodex: codex.New()},
		Config{Clock: func() time.Time { return now }, Logger: testLogger()},
	)
	if err := observer.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runtime.calls != 0 {
		t.Fatalf("fresh session output calls = %d, want 0", runtime.calls)
	}

	stale := activeSession(now, domain.HarnessCodex)
	observer.sessions = fakeSessions{rows: []domain.SessionRecord{stale}}
	if err := observer.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestPollReturnsSessionListFailure(t *testing.T) {
	want := errors.New("list failed")
	observer := New(fakeSessions{err: want}, &fakeSink{}, &fakeRuntime{}, nil, Config{Logger: testLogger()})
	if err := observer.Poll(context.Background()); !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}
