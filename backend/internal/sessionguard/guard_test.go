package sessionguard

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeStore struct {
	rec domain.SessionRecord
	ok  bool
	err error
}

func (s *fakeStore) GetSession(_ context.Context, _ domain.SessionID) (domain.SessionRecord, bool, error) {
	return s.rec, s.ok, s.err
}

type fakeMessenger struct {
	sent []string
	err  error
}

func (m *fakeMessenger) Send(_ context.Context, _ domain.SessionID, msg string) error {
	m.sent = append(m.sent, msg)
	return m.err
}

func record(state domain.ActivityState, terminated bool) domain.SessionRecord {
	return domain.SessionRecord{ID: "s1", IsTerminated: terminated, Activity: domain.Activity{State: state}}
}

func TestGuard_OutcomeByState(t *testing.T) {
	cases := []struct {
		name        string
		rec         domain.SessionRecord
		ok          bool
		wantDeliver Outcome
		wantNudge   Outcome
	}{
		{"active", record(domain.ActivityActive, false), true, Sent, Sent},
		{"idle", record(domain.ActivityIdle, false), true, Sent, Sent},
		// waiting_input is the split that motivates two methods: a user message
		// (or its Enter re-submit) belongs at an idle prompt; an unsolicited
		// automated nudge does not.
		{"waiting_input", record(domain.ActivityWaitingInput, false), true, Sent, SuppressedAwaitingUser},
		{"blocked", record(domain.ActivityBlocked, false), true, SuppressedAwaitingUser, SuppressedAwaitingUser},
		// exited is refused even without IsTerminated: the pane holds an
		// interactive shell after agent exit, so a paste would execute there.
		{"exited", record(domain.ActivityExited, false), true, SuppressedTerminated, SuppressedTerminated},
		{"terminated", record(domain.ActivityIdle, true), true, SuppressedTerminated, SuppressedTerminated},
		{"missing", domain.SessionRecord{}, false, SuppressedNotFound, SuppressedNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for method, want := range map[string]Outcome{"Deliver": tc.wantDeliver, "Nudge": tc.wantNudge} {
				msgr := &fakeMessenger{}
				g := New(&fakeStore{rec: tc.rec, ok: tc.ok}, msgr, nil)
				var got Outcome
				var err error
				if method == "Deliver" {
					got, err = g.Deliver(context.Background(), "s1", "hello")
				} else {
					got, err = g.Nudge(context.Background(), "s1", "hello")
				}
				if err != nil {
					t.Fatalf("%s: unexpected error: %v", method, err)
				}
				if got != want {
					t.Errorf("%s: outcome = %v, want %v", method, got, want)
				}
				if wantSent := want == Sent; (len(msgr.sent) == 1) != wantSent {
					t.Errorf("%s: messenger sends = %d, want sent=%v", method, len(msgr.sent), wantSent)
				}
			}
		})
	}
}

func TestGuard_StoreErrorFailsClosed(t *testing.T) {
	msgr := &fakeMessenger{}
	g := New(&fakeStore{err: errors.New("db locked")}, msgr, nil)
	for name, call := range map[string]func() (Outcome, error){
		"Deliver": func() (Outcome, error) { return g.Deliver(context.Background(), "s1", "x") },
		"Nudge":   func() (Outcome, error) { return g.Nudge(context.Background(), "s1", "x") },
	} {
		got, err := call()
		if err == nil {
			t.Fatalf("%s: want error from store failure", name)
		}
		if got != SuppressedUnknown {
			t.Errorf("%s: outcome = %v, want SuppressedUnknown", name, got)
		}
	}
	if len(msgr.sent) != 0 {
		t.Errorf("messenger was called %d times on unknown state, want 0", len(msgr.sent))
	}
}

func TestGuard_MessengerErrorIsSentPlusError(t *testing.T) {
	sendErr := errors.New("pane gone")
	g := New(&fakeStore{rec: record(domain.ActivityActive, false), ok: true}, &fakeMessenger{err: sendErr}, nil)
	got, err := g.Deliver(context.Background(), "s1", "x")
	if !errors.Is(err, sendErr) {
		t.Fatalf("error = %v, want wrapped %v", err, sendErr)
	}
	if got != Sent {
		t.Errorf("outcome = %v, want Sent (the write was attempted)", got)
	}
}
