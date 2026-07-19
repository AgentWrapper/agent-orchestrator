package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// fakeReclaimer records the sessions lifecycle asked to reclaim and can inject a
// teardown error to prove it is swallowed.
type fakeReclaimer struct {
	ids []domain.SessionID
	err error
}

func (f *fakeReclaimer) ReclaimOnTerminate(_ context.Context, id domain.SessionID) error {
	f.ids = append(f.ids, id)
	return f.err
}

// A merged PR that completes the session must both terminate it and reclaim its
// worktree — the fix for #2811, where the reaction only flipped is_terminated
// and left the worktree orphaned on disk.
func TestPRObservation_MergeReclaimsWorktree(t *testing.T) {
	m, st, _ := newManager()
	rc := &fakeReclaimer{}
	m.SetTerminationReclaimer(rc)
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{{URL: "pr1", Merged: true}}

	if err := m.ApplyPRObservation(ctx, "mer-1", ports.PRObservation{Fetched: true, URL: "pr1", Merged: true}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.IsTerminated {
		t.Fatalf("merged PR should terminate session, got %+v", got)
	}
	if len(rc.ids) != 1 || rc.ids[0] != "mer-1" {
		t.Fatalf("expected reclaim of mer-1, got %v", rc.ids)
	}
}

// A tracker issue reaching a terminal state terminates the session and reclaims
// its worktree, mirroring the merged-PR path.
func TestApplyTrackerFacts_TerminalStateReclaimsWorktree(t *testing.T) {
	m, st, _ := newManager()
	rc := &fakeReclaimer{}
	m.SetTerminationReclaimer(rc)
	st.sessions["mer-1"] = working("mer-1")

	o := ports.TrackerObservation{
		Fetched: true,
		Issue:   ports.TrackerIssueObservation{URL: "https://github.com/o/r/issues/1", State: domain.IssueDone},
	}
	if err := m.ApplyTrackerFacts(ctx, "mer-1", o); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.IsTerminated {
		t.Fatalf("terminal issue should terminate session, got %+v", got)
	}
	if len(rc.ids) != 1 || rc.ids[0] != "mer-1" {
		t.Fatalf("expected reclaim of mer-1, got %v", rc.ids)
	}
}

// A session that does not reach the completion bar (a merged PR with an open
// sibling) must neither terminate nor reclaim: reclaiming a live session's
// worktree would pull the worktree out from under an agent still at work.
func TestPRObservation_OpenSiblingDoesNotReclaim(t *testing.T) {
	m, st, _ := newManager()
	rc := &fakeReclaimer{}
	m.SetTerminationReclaimer(rc)
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{
		{URL: "pr1", Merged: true},
		{URL: "pr2"},
	}

	if err := m.ApplyPRObservation(ctx, "mer-1", ports.PRObservation{Fetched: true, URL: "pr1", Merged: true}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; got.IsTerminated {
		t.Fatalf("session with an open sibling PR must stay alive, got %+v", got)
	}
	if len(rc.ids) != 0 {
		t.Fatalf("a still-live session must not be reclaimed, got %v", rc.ids)
	}
}

// Repeat terminal observations on an already-terminated session are cheap
// no-ops: the reclaim fires only on the terminating transition, so a still-done
// tracker issue polled every cycle does not re-attempt teardown (which would
// spam warnings destroying an already-removed worktree).
func TestTerminateWithReclaim_IdempotentRepeatDoesNotReclaim(t *testing.T) {
	m, st, _ := newManager()
	rc := &fakeReclaimer{}
	m.SetTerminationReclaimer(rc)
	rec := working("mer-1")
	rec.IsTerminated = true
	st.sessions["mer-1"] = rec
	st.prs["mer-1"] = []domain.PullRequest{{URL: "pr1", Merged: true}}

	if err := m.ApplyPRObservation(ctx, "mer-1", ports.PRObservation{Fetched: true, URL: "pr1", Merged: true}); err != nil {
		t.Fatal(err)
	}
	if len(rc.ids) != 0 {
		t.Fatalf("already-terminated session must not be reclaimed again, got %v", rc.ids)
	}
}

// A best-effort reclaim failure (e.g. a transient filesystem error) is logged
// and swallowed: the reaction still returns nil and the session stays
// terminated, so a teardown hiccup can never wedge the observation pipeline.
func TestTerminateWithReclaim_ReclaimErrorIsSwallowed(t *testing.T) {
	m, st, _ := newManager()
	rc := &fakeReclaimer{err: errors.New("boom")}
	m.SetTerminationReclaimer(rc)
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{{URL: "pr1", Merged: true}}

	if err := m.ApplyPRObservation(ctx, "mer-1", ports.PRObservation{Fetched: true, URL: "pr1", Merged: true}); err != nil {
		t.Fatalf("reclaim error must be swallowed, got %v", err)
	}
	if got := st.sessions["mer-1"]; !got.IsTerminated {
		t.Fatalf("session should stay terminated despite reclaim error, got %+v", got)
	}
	if len(rc.ids) != 1 {
		t.Fatalf("reclaim should have been attempted once, got %v", rc.ids)
	}
}

// With no reclaimer wired, a merge still terminates the session (the pre-#2811
// flag-only behavior) without panicking on the nil seam.
func TestPRObservation_MergeWithoutReclaimerStillTerminates(t *testing.T) {
	m, st, _ := newManager()
	st.sessions["mer-1"] = working("mer-1")
	st.prs["mer-1"] = []domain.PullRequest{{URL: "pr1", Merged: true}}

	if err := m.ApplyPRObservation(ctx, "mer-1", ports.PRObservation{Fetched: true, URL: "pr1", Merged: true}); err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"]; !got.IsTerminated {
		t.Fatalf("merged PR should terminate session even without a reclaimer, got %+v", got)
	}
}
