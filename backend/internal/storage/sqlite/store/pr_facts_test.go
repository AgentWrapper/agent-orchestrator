package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ListPRFactsForSession is the real-SQLite batch read the multi-PR status
// aggregator builds stacks from: every owned PR returned newest-first with its
// state flags and branch pair projected (the stack model needs both).
//
// The branch pair is written via WriteSCMObservation (the observer path, the
// source of truth for tracked PRs). The other writer, WritePR, deliberately
// omits source/target branch (UpsertLegacyPR), so the stack model depends on the
// observer having populated the row.
func TestListPRFactsForSessionProjectsAllPRsNewestFirst(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	r, _ := s.CreateSession(ctx, sampleRecord("mer"))
	now := time.Now().UTC().Truncate(time.Second)

	// A stack: root (open) -> child targets the root branch (open) -> a merged
	// historical PR. Distinct updated_at so newest-first ordering is observable.
	write := func(pr domain.PullRequest) {
		t.Helper()
		if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
			t.Fatalf("write %s: %v", pr.URL, err)
		}
	}
	write(domain.PullRequest{URL: "root", SessionID: r.ID, Number: 1, CI: domain.CIPassing, SourceBranch: "feat/x", TargetBranch: "main", UpdatedAt: now, ObservedAt: now})
	write(domain.PullRequest{URL: "child", SessionID: r.ID, Number: 2, Draft: true, SourceBranch: "feat/x/child", TargetBranch: "feat/x", UpdatedAt: now.Add(time.Second), ObservedAt: now})
	write(domain.PullRequest{URL: "old", SessionID: r.ID, Number: 3, Merged: true, SourceBranch: "feat/old", TargetBranch: "main", UpdatedAt: now.Add(2 * time.Second), ObservedAt: now})

	facts, err := s.ListPRFactsForSession(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(facts) != 3 {
		t.Fatalf("ListPRFactsForSession = %d, want 3", len(facts))
	}
	// Newest-first by updated_at: old, child, root.
	if facts[0].URL != "old" || facts[1].URL != "child" || facts[2].URL != "root" {
		t.Fatalf("order = [%s %s %s], want [old child root]", facts[0].URL, facts[1].URL, facts[2].URL)
	}
	byURL := map[string]domain.PRFacts{}
	for _, f := range facts {
		byURL[f.URL] = f
	}
	if !byURL["old"].Merged || byURL["old"].Closed || byURL["old"].Draft {
		t.Fatalf("merged PR flags wrong: %+v", byURL["old"])
	}
	if !byURL["child"].Draft || byURL["child"].Merged {
		t.Fatalf("draft child flags wrong: %+v", byURL["child"])
	}
	// The stack model is derived from the source/target branch pair, so it must
	// survive the projection.
	if byURL["child"].SourceBranch != "feat/x/child" || byURL["child"].TargetBranch != "feat/x" {
		t.Fatalf("child branch pair lost: %+v", byURL["child"])
	}
	if byURL["root"].SourceBranch != "feat/x" || byURL["root"].TargetBranch != "main" {
		t.Fatalf("root branch pair lost: %+v", byURL["root"])
	}
	if byURL["root"].CI != domain.CIPassing {
		t.Fatalf("root CI = %q, want passing", byURL["root"].CI)
	}

	// A session with no PRs returns an empty (non-nil) slice, never an error.
	empty, _ := s.CreateSession(ctx, sampleRecord("mer"))
	got, err := s.ListPRFactsForSession(ctx, empty.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("no-PR session = %d facts, want 0", len(got))
	}
}
