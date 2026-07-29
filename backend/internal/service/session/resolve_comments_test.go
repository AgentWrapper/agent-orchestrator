package session

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func resolveFixture(t *testing.T, comments []domain.PullRequestComment) (*Service, *fakeStore, *[]string) {
	t.Helper()
	st := newFakeStore()
	st.pr["s1"] = domain.PRFacts{URL: "https://github.com/o/r/pull/7", Number: 7}
	st.comments["https://github.com/o/r/pull/7"] = comments
	recorded := &[]string{}
	svc := NewWithDeps(Deps{Manager: &fakeCommander{}, Store: st, SCM: fakeSCM{resolved: recorded}})
	return svc, st, recorded
}

func TestResolvePRCommentsResolvesEveryUnresolvedHumanThread(t *testing.T) {
	svc, _, recorded := resolveFixture(t, []domain.PullRequestComment{
		// Two comments on one thread must collapse to a single resolve call.
		{ThreadID: "T1", Author: "maya"},
		{ThreadID: "T1", Author: "maya"},
		{ThreadID: "T2", Author: "prateek"},
		{ThreadID: "T3", Author: "bot", IsBot: true},
		{ThreadID: "T4", Author: "maya", Resolved: true},
	})

	got, err := svc.ResolvePRComments(context.Background(), "s1", 7, nil)
	if err != nil {
		t.Fatalf("ResolvePRComments: %v", err)
	}
	if got != 2 {
		t.Fatalf("resolved = %d, want 2", got)
	}
	if len(*recorded) != 2 || (*recorded)[0] != "T1" || (*recorded)[1] != "T2" {
		t.Fatalf("resolved threads = %v, want [T1 T2]", *recorded)
	}
}

func TestResolvePRCommentsHonoursExplicitThreadIDs(t *testing.T) {
	svc, _, recorded := resolveFixture(t, []domain.PullRequestComment{
		{ThreadID: "T1", Author: "maya"},
		{ThreadID: "T2", Author: "prateek"},
	})

	got, err := svc.ResolvePRComments(context.Background(), "s1", 7, []string{"T2", "T2"})
	if err != nil {
		t.Fatalf("ResolvePRComments: %v", err)
	}
	if got != 1 || len(*recorded) != 1 || (*recorded)[0] != "T2" {
		t.Fatalf("resolved = %d %v, want 1 [T2]", got, *recorded)
	}
}

func TestResolvePRCommentsRejectsAPRTheSessionDoesNotOwn(t *testing.T) {
	svc, _, recorded := resolveFixture(t, nil)

	_, err := svc.ResolvePRComments(context.Background(), "s1", 999, nil)
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("err = %v, want ErrPRNotFound", err)
	}
	if len(*recorded) != 0 {
		t.Fatalf("want no provider calls, got %v", *recorded)
	}
}

func TestResolvePRCommentsReportsPartialProgress(t *testing.T) {
	st := newFakeStore()
	st.pr["s1"] = domain.PRFacts{URL: "https://github.com/o/r/pull/7", Number: 7}
	svc := NewWithDeps(Deps{
		Manager: &fakeCommander{},
		Store:   st,
		SCM:     fakeSCM{resolveErr: errors.New("boom")},
	})

	got, err := svc.ResolvePRComments(context.Background(), "s1", 7, []string{"T1"})
	if err == nil {
		t.Fatal("want an error when the provider fails")
	}
	if got != 0 {
		t.Fatalf("resolved = %d, want 0", got)
	}
}
