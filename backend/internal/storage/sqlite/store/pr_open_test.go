package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ListOpenPRs returns only PRs that are neither merged nor closed, across every
// session, ordered by number then URL — the surface the duplicate-PR guard and
// intake open-PR dedup read (issue #181).
func TestListOpenPRs_ExcludesTerminalAndOrders(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	sess1, err := s.CreateSession(ctx, sampleRecord("ao"))
	if err != nil {
		t.Fatalf("create session 1: %v", err)
	}
	sess2, err := s.CreateSession(ctx, sampleRecord("ao"))
	if err != nil {
		t.Fatalf("create session 2: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	write := func(pr domain.PullRequest) {
		t.Helper()
		if err := s.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
			t.Fatalf("write pr %s: %v", pr.URL, err)
		}
	}
	write(domain.PullRequest{URL: "https://x/pr/3", SessionID: sess1.ID, Number: 3, SourceBranch: "a", TargetBranch: "main", UpdatedAt: now, ObservedAt: now})
	write(domain.PullRequest{URL: "https://x/pr/1", SessionID: sess1.ID, Number: 1, SourceBranch: "b", TargetBranch: "main", UpdatedAt: now, ObservedAt: now})
	write(domain.PullRequest{URL: "https://x/pr/2", SessionID: sess2.ID, Number: 2, Merged: true, SourceBranch: "c", TargetBranch: "main", UpdatedAt: now, ObservedAt: now})
	write(domain.PullRequest{URL: "https://x/pr/4", SessionID: sess2.ID, Number: 4, Closed: true, SourceBranch: "d", TargetBranch: "main", UpdatedAt: now, ObservedAt: now})

	open, err := s.ListOpenPRs(ctx)
	if err != nil {
		t.Fatalf("ListOpenPRs: %v", err)
	}
	if len(open) != 2 {
		t.Fatalf("open PRs = %d, want 2 (%+v)", len(open), open)
	}
	if open[0].Number != 1 || open[1].Number != 3 {
		t.Fatalf("order = [%d,%d], want [1,3]", open[0].Number, open[1].Number)
	}
}

// The notification store accepts and dedupes the duplicate_pr type end to end,
// proving the widened CHECK migration (0035) applies to a fresh DB.
func TestNotificationStore_DuplicatePRTypeInsertsAndDedupes(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "ao")
	sess, err := s.CreateSession(ctx, sampleRecord("ao"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	rec := domain.NotificationRecord{
		ID:        "ntf_dup_1",
		SessionID: sess.ID,
		ProjectID: sess.ProjectID,
		PRURL:     "https://x/pr/180",
		Type:      domain.NotificationDuplicatePR,
		Title:     "Duplicate PR #180 for the same issue",
		Body:      "This PR duplicates https://x/pr/172 for issue owner/repo#169.",
		Status:    domain.NotificationUnread,
		CreatedAt: now,
	}
	if _, inserted, err := s.CreateNotification(ctx, rec); err != nil || !inserted {
		t.Fatalf("CreateNotification inserted=%v err=%v", inserted, err)
	}
	dup := rec
	dup.ID = "ntf_dup_2"
	if _, inserted, err := s.CreateNotification(ctx, dup); err != nil {
		t.Fatalf("CreateNotification dup err=%v", err)
	} else if inserted {
		t.Fatal("second identical duplicate_pr notification should have been deduped")
	}
}
