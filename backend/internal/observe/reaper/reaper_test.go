package reaper

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var ctx = context.Background()

type fakeLCM struct {
	observed map[domain.SessionID]ports.RuntimeFacts
}

func (l *fakeLCM) ApplyRuntimeObservation(_ context.Context, id domain.SessionID, f ports.RuntimeFacts) error {
	if l.observed == nil {
		l.observed = map[domain.SessionID]ports.RuntimeFacts{}
	}
	l.observed[id] = f
	return nil
}

type fakeSessions struct{ rows []domain.SessionRecord }

func (s fakeSessions) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return s.rows, nil
}

type fakeRuntime struct {
	alive         bool
	err           error
	workloadAlive bool
	workloadErr   error
}

func (r fakeRuntime) IsAlive(context.Context, ports.RuntimeHandle) (bool, error) {
	return r.alive, r.err
}

func (r fakeRuntime) IsSupervisedProcessAlive(context.Context, ports.RuntimeHandle, ports.SupervisedProcessRef) (bool, error) {
	return r.workloadAlive, r.workloadErr
}

func probableSession(id domain.SessionID) domain.SessionRecord {
	return domain.SessionRecord{
		ID:       id,
		Activity: domain.Activity{State: domain.ActivityActive},
		Metadata: domain.SessionMetadata{RuntimeHandleID: "h1"},
	}
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newReaper(lcm *fakeLCM, sessions fakeSessions, rt fakeRuntime) *Reaper {
	return New(lcm, sessions, rt, Config{Logger: quietLogger()})
}

func TestTick_ReportsAliveProbe(t *testing.T) {
	lcm := &fakeLCM{}
	sessions := fakeSessions{rows: []domain.SessionRecord{probableSession("mer-1")}}
	if err := newReaper(lcm, sessions, fakeRuntime{alive: true}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if got := lcm.observed["mer-1"]; got.Runtime != ports.ProbeAlive || got.Workload != ports.ProbeFailed {
		t.Fatalf("want alive runtime with unsupported workload, got %+v", got)
	}
}

func TestTick_ReportsSupervisedWorkloadExit(t *testing.T) {
	lcm := &fakeLCM{}
	session := probableSession("mer-1")
	session.Metadata.RuntimeLaunchID = "launch-1"
	sessions := fakeSessions{rows: []domain.SessionRecord{session}}
	if err := newReaper(lcm, sessions, fakeRuntime{alive: true, workloadAlive: false}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	got := lcm.observed["mer-1"]
	if got.Runtime != ports.ProbeAlive || got.Workload != ports.ProbeDead || got.LaunchID != "launch-1" {
		t.Fatalf("unexpected supervised workload facts: %+v", got)
	}
}

func TestTick_ReportsSupervisedWorkloadAlive(t *testing.T) {
	lcm := &fakeLCM{}
	session := probableSession("mer-1")
	session.Metadata.RuntimeLaunchID = "launch-1"
	sessions := fakeSessions{rows: []domain.SessionRecord{session}}
	if err := newReaper(lcm, sessions, fakeRuntime{alive: true, workloadAlive: true}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	got := lcm.observed["mer-1"]
	if got.Runtime != ports.ProbeAlive || got.Workload != ports.ProbeAlive {
		t.Fatalf("unexpected supervised workload facts: %+v", got)
	}
}

func TestTick_ReportsWorkloadProbeErrorAsFailed(t *testing.T) {
	lcm := &fakeLCM{}
	session := probableSession("mer-1")
	session.Metadata.RuntimeLaunchID = "launch-1"
	sessions := fakeSessions{rows: []domain.SessionRecord{session}}
	if err := newReaper(lcm, sessions, fakeRuntime{alive: true, workloadErr: errors.New("ps unavailable")}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	got := lcm.observed["mer-1"]
	if got.Runtime != ports.ProbeAlive || got.Workload != ports.ProbeFailed {
		t.Fatalf("workload probe error must remain inconclusive, got %+v", got)
	}
}

func TestTick_ReportsProbeErrorAsFailed(t *testing.T) {
	lcm := &fakeLCM{}
	sessions := fakeSessions{rows: []domain.SessionRecord{probableSession("mer-1")}}
	if err := newReaper(lcm, sessions, fakeRuntime{err: errors.New("tmux gone")}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if got := lcm.observed["mer-1"]; got.Runtime != ports.ProbeFailed || got.Workload != ports.ProbeFailed {
		t.Fatalf("probe error must report failed facts, got %+v", got)
	}
}

func TestTick_SkipsTerminatedSession(t *testing.T) {
	lcm := &fakeLCM{}
	dead := probableSession("mer-1")
	dead.IsTerminated = true
	sessions := fakeSessions{rows: []domain.SessionRecord{dead}}
	if err := newReaper(lcm, sessions, fakeRuntime{alive: true}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if _, probed := lcm.observed["mer-1"]; probed {
		t.Fatal("terminated sessions must not be probed")
	}
}

func TestTick_SkipsSessionWithoutHandle(t *testing.T) {
	lcm := &fakeLCM{}
	noHandle := domain.SessionRecord{ID: "mer-1"} // no runtime metadata
	sessions := fakeSessions{rows: []domain.SessionRecord{noHandle}}
	if err := newReaper(lcm, sessions, fakeRuntime{alive: true}).Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if _, probed := lcm.observed["mer-1"]; probed {
		t.Fatal("a session without a runtime handle must be skipped")
	}
}
