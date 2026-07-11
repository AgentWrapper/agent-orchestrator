package candidatehealth

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type recordingSink struct {
	mu     sync.Mutex
	events []ports.TelemetryEvent
}

func (s *recordingSink) Emit(_ context.Context, ev ports.TelemetryEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, ev)
}

func (s *recordingSink) Close(context.Context) error { return nil }

func (s *recordingSink) named(name string) []ports.TelemetryEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []ports.TelemetryEvent
	for _, ev := range s.events {
		if ev.Name == name {
			out = append(out, ev)
		}
	}
	return out
}

func newTestTracker(sink ports.EventSink) *Tracker {
	return New(Config{
		Source:    "test",
		Telemetry: sink,
		Clock:     func() time.Time { return time.Unix(1700000000, 0).UTC() },
	})
}

func TestMarkDownRecordsReasonAndAlertsOnce(t *testing.T) {
	sink := &recordingSink{}
	tr := newTestTracker(sink)
	c := Candidate{Surface: "worker_mix", Harness: "codex", Model: "gpt-5.5-codex"}

	if tr.IsDown(c) {
		t.Fatal("candidate should start healthy")
	}
	tr.MarkDown(c, errors.New("400 model not available"))
	if !tr.IsDown(c) {
		t.Fatal("candidate should be down after MarkDown")
	}

	down := sink.named(EventCandidateDown)
	if len(down) != 1 {
		t.Fatalf("want 1 candidate_down event, got %d", len(down))
	}
	if got := down[0].Payload["reason"]; got != "400 model not available" {
		t.Fatalf("reason payload = %v, want the observed error", got)
	}
	if got := down[0].Payload["surface"]; got != "worker_mix" {
		t.Fatalf("surface payload = %v, want worker_mix", got)
	}
	if down[0].Level != ports.TelemetryLevelWarn {
		t.Fatalf("candidate_down level = %v, want warn", down[0].Level)
	}

	// A repeat failure must not re-alert (avoid flooding), only debit again.
	tr.MarkDown(c, errors.New("400 model not available"))
	if got := len(sink.named(EventCandidateDown)); got != 1 {
		t.Fatalf("repeat failure must not re-emit candidate_down; got %d events", got)
	}
}

func TestMarkDownNilErrorIsNoop(t *testing.T) {
	sink := &recordingSink{}
	tr := newTestTracker(sink)
	c := Candidate{Surface: "reviewer", Harness: "codex"}
	tr.MarkDown(c, nil)
	if tr.IsDown(c) {
		t.Fatal("nil error must not mark the candidate down")
	}
	if got := len(sink.named(EventCandidateDown)); got != 0 {
		t.Fatalf("nil error must not emit an alert; got %d", got)
	}
}

func TestMarkDownForAttemptCallerCancellationIsNoop(t *testing.T) {
	sink := &recordingSink{}
	tr := newTestTracker(sink)
	c := Candidate{Surface: "reviewer", Harness: "codex"}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	tr.MarkDownForAttempt(ctx, c, fmt.Errorf("spawn: %w", context.Canceled))

	if tr.IsDown(c) {
		t.Fatal("canceled caller context must not mark the candidate down")
	}
	if got := len(sink.named(EventCandidateDown)); got != 0 {
		t.Fatalf("canceled caller context must not emit an alert; got %d", got)
	}
	skips := 0
	tr.ForEachSkipped(func(Candidate, int) { skips++ })
	if skips != 0 {
		t.Fatalf("canceled caller context must not debit a skip; got %d", skips)
	}
}

func TestMarkDownForAttemptCandidateDeadlineMarksDown(t *testing.T) {
	sink := &recordingSink{}
	tr := newTestTracker(sink)
	c := Candidate{Surface: "worker_mix", Harness: "codex", Model: "gpt-5.5-codex"}

	tr.MarkDownForAttempt(context.Background(), c, fmt.Errorf("login probe: %w", context.DeadlineExceeded))

	if !tr.IsDown(c) {
		t.Fatal("candidate-side deadline must mark the candidate down when caller context is active")
	}
	if got := len(sink.named(EventCandidateDown)); got != 1 {
		t.Fatalf("candidate-side deadline must emit one alert; got %d", got)
	}
	skips := 0
	tr.ForEachSkipped(func(Candidate, int) { skips++ })
	if skips != 1 {
		t.Fatalf("candidate-side deadline must debit one skip; got %d", skips)
	}
}

func TestSkipDebitAndRecovery(t *testing.T) {
	sink := &recordingSink{}
	tr := newTestTracker(sink)
	c := Candidate{Surface: "worker_mix", Harness: "codex", Model: "gpt-5.5-codex"}

	// Healthy candidate is never a skip.
	if tr.RecordSkipIfDown(c) {
		t.Fatal("healthy candidate must not be recorded as skipped")
	}

	tr.MarkDown(c, errors.New("boom")) // skipped -> 1
	if !tr.RecordSkipIfDown(c) {       // skipped -> 2
		t.Fatal("down candidate must report a skip")
	}

	// The surface must see the accumulated debit so it can account for lost
	// capacity instead of silently reallocating.
	total := 0
	seen := 0
	tr.ForEachSkipped(func(got Candidate, skipped int) {
		seen++
		total += skipped
	})
	if seen != 1 {
		t.Fatalf("want exactly one skipped candidate, got %d", seen)
	}
	if total != 2 {
		t.Fatalf("skip debit = %d, want 2 (1 from MarkDown + 1 from RecordSkipIfDown)", total)
	}

	// A successful exact-candidate attempt recovers it and clears the debit.
	tr.MarkRecovered(c)
	if tr.IsDown(c) {
		t.Fatal("candidate should be healthy after MarkRecovered")
	}
	cleared := true
	tr.ForEachSkipped(func(Candidate, int) { cleared = false })
	if !cleared {
		t.Fatal("recovery must clear the skip debit")
	}
	if got := len(sink.named(EventCandidateRecovered)); got != 1 {
		t.Fatalf("want 1 candidate_recovered event, got %d", got)
	}
}

func TestMarkRecoveredHealthyIsSilent(t *testing.T) {
	sink := &recordingSink{}
	tr := newTestTracker(sink)
	c := Candidate{Surface: "worker_mix", Harness: "codex"}
	tr.MarkRecovered(c) // never was down
	if got := len(sink.named(EventCandidateRecovered)); got != 0 {
		t.Fatalf("recovering a healthy candidate must be silent; got %d events", got)
	}
}

// TestCandidateIdentityPreventsFalseSubstitution is the core anti-substitution
// invariant: candidates differing on any populated axis are distinct, so one's
// failure never marks another down.
func TestCandidateIdentityPreventsFalseSubstitution(t *testing.T) {
	tr := newTestTracker(&recordingSink{})
	failed := Candidate{Surface: "worker_mix", Harness: "codex", Model: "gpt-5.5-codex"}
	other := Candidate{Surface: "worker_mix", Harness: "claude-code", Model: "opus"}
	sameHarnessOtherModel := Candidate{Surface: "worker_mix", Harness: "codex", Model: "gpt-5.4-codex"}

	tr.MarkDown(failed, errors.New("boom"))
	if !tr.IsDown(failed) {
		t.Fatal("the failed candidate should be down")
	}
	if tr.IsDown(other) {
		t.Fatal("a different harness/model candidate must not be marked down")
	}
	if tr.IsDown(sameHarnessOtherModel) {
		t.Fatal("same harness but different model is a distinct candidate")
	}
}

func TestCandidateNormalizationKeysConsistently(t *testing.T) {
	tr := newTestTracker(&recordingSink{})
	padded := Candidate{Surface: " worker_mix ", Harness: " codex ", Model: " gpt-5.5-codex "}
	clean := Candidate{Surface: "worker_mix", Harness: "codex", Model: "gpt-5.5-codex"}
	tr.MarkDown(padded, errors.New("boom"))
	if !tr.IsDown(clean) {
		t.Fatal("padded and trimmed candidates must key the same slot")
	}
}

func TestCandidateStringOmitsEmptyAxes(t *testing.T) {
	cases := []struct {
		c    Candidate
		want string
	}{
		{Candidate{Surface: "worker_mix", Harness: "codex", Model: "gpt-5.5-codex"}, "worker_mix:codex:gpt-5.5-codex"},
		{Candidate{Surface: "reviewer", Harness: "codex"}, "reviewer:codex"},
		{Candidate{Surface: "reviewer", Harness: "copilot", Bot: "copilot-pr"}, "reviewer:copilot:bot=copilot-pr"},
		{Candidate{}, "candidate"},
	}
	for _, tc := range cases {
		if got := tc.c.String(); got != tc.want {
			t.Errorf("Candidate.String() = %q, want %q", got, tc.want)
		}
	}
}

func TestTrackerConcurrentSafe(t *testing.T) {
	tr := newTestTracker(&recordingSink{})
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := Candidate{Surface: "worker_mix", Harness: "codex", Model: "m"}
			tr.MarkDown(c, errors.New("boom"))
			tr.RecordSkipIfDown(c)
			tr.IsDown(c)
			tr.ForEachSkipped(func(Candidate, int) {})
			tr.MarkRecovered(c)
		}(i)
	}
	wg.Wait()
}
