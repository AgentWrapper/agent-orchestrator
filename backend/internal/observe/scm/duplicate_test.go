package scm

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type dupReactorLifecycle struct {
	fakeLifecycle
	facts []ports.DuplicatePRFact
	err   error
}

func (l *dupReactorLifecycle) HandleDuplicatePR(_ context.Context, fact ports.DuplicatePRFact) error {
	l.facts = append(l.facts, fact)
	return l.err
}

func dupTestStore() *fakeStore {
	return &fakeStore{
		projects: map[string]domain.ProjectRecord{"p": {ID: "p", RepoOriginURL: "https://github.com/o/r.git"}},
		prs:      map[domain.SessionID][]domain.PullRequest{},
		checks:   map[string][]domain.PullRequestCheck{},
	}
}

// Two OPEN PRs from different sessions linked to the same issue are reported as a
// duplicate: the newer (higher-number) PR is the dup, the older is canonical
// (issue #181).
func TestDetectDuplicatePRs_ReportsCrossSessionCollision(t *testing.T) {
	store := dupTestStore()
	store.sessions = []domain.SessionRecord{
		{ID: "s1", ProjectID: "p", IssueID: "github:o/r#169", DisplayName: "r #169 a"},
		{ID: "s2", ProjectID: "p", IssueID: "github:o/r#169", DisplayName: "r #169 b"},
	}
	store.prs["s1"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/172", SessionID: "s1", Number: 172, Repo: "o/r", Provider: "github"}}
	store.prs["s2"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/180", SessionID: "s2", Number: 180, Repo: "o/r", Provider: "github"}}

	reactor := &dupReactorLifecycle{}
	obs := newTestObserver(store, &fakeProvider{}, reactor, time.Unix(1, 0).UTC())
	obs.detectDuplicatePRs(context.Background())

	if len(reactor.facts) != 1 {
		t.Fatalf("facts = %d, want 1 (%+v)", len(reactor.facts), reactor.facts)
	}
	f := reactor.facts[0]
	if f.DupPRURL != "https://github.com/o/r/pull/180" || f.DupPRNumber != 180 {
		t.Fatalf("dup PR = %q #%d, want #180", f.DupPRURL, f.DupPRNumber)
	}
	if f.ExistingPRURL != "https://github.com/o/r/pull/172" || f.ExistingPRNumber != 172 {
		t.Fatalf("existing PR = %q #%d, want #172", f.ExistingPRURL, f.ExistingPRNumber)
	}
	if f.IssueRef != "o/r#169" {
		t.Fatalf("issue ref = %q, want o/r#169", f.IssueRef)
	}
	if f.DupSessionID != "s2" || f.ExistingSessionID != "s1" {
		t.Fatalf("sessions = dup %q existing %q", f.DupSessionID, f.ExistingSessionID)
	}
}

// A single session that owns a stack of PRs for one issue is the intended
// multi-PR flow, not a duplicate — no fact is reported.
func TestDetectDuplicatePRs_IgnoresSameSessionStack(t *testing.T) {
	store := dupTestStore()
	store.sessions = []domain.SessionRecord{{ID: "s1", ProjectID: "p", IssueID: "github:o/r#169"}}
	store.prs["s1"] = []domain.PullRequest{
		{URL: "https://github.com/o/r/pull/10", SessionID: "s1", Number: 10, Repo: "o/r"},
		{URL: "https://github.com/o/r/pull/11", SessionID: "s1", Number: 11, Repo: "o/r"},
	}
	reactor := &dupReactorLifecycle{}
	obs := newTestObserver(store, &fakeProvider{}, reactor, time.Unix(1, 0).UTC())
	obs.detectDuplicatePRs(context.Background())
	if len(reactor.facts) != 0 {
		t.Fatalf("same-session stack reported %d dup facts", len(reactor.facts))
	}
}

// Merged/closed PRs never participate: an issue whose other PRs are terminal has
// no live duplicate.
func TestDetectDuplicatePRs_IgnoresTerminalPRs(t *testing.T) {
	store := dupTestStore()
	store.sessions = []domain.SessionRecord{
		{ID: "s1", ProjectID: "p", IssueID: "github:o/r#169"},
		{ID: "s2", ProjectID: "p", IssueID: "github:o/r#169"},
	}
	store.prs["s1"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/1", SessionID: "s1", Number: 1, Merged: true, Repo: "o/r"}}
	store.prs["s2"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/2", SessionID: "s2", Number: 2, Repo: "o/r"}}
	reactor := &dupReactorLifecycle{}
	obs := newTestObserver(store, &fakeProvider{}, reactor, time.Unix(1, 0).UTC())
	obs.detectDuplicatePRs(context.Background())
	if len(reactor.facts) != 0 {
		t.Fatalf("terminal PR treated as live duplicate: %+v", reactor.facts)
	}
}

// Distinct issues with one open PR each are not duplicates.
func TestDetectDuplicatePRs_NoCollisionAcrossDistinctIssues(t *testing.T) {
	store := dupTestStore()
	store.sessions = []domain.SessionRecord{
		{ID: "s1", ProjectID: "p", IssueID: "github:o/r#1"},
		{ID: "s2", ProjectID: "p", IssueID: "github:o/r#2"},
	}
	store.prs["s1"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/10", SessionID: "s1", Number: 10, Repo: "o/r"}}
	store.prs["s2"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/11", SessionID: "s2", Number: 11, Repo: "o/r"}}
	reactor := &dupReactorLifecycle{}
	obs := newTestObserver(store, &fakeProvider{}, reactor, time.Unix(1, 0).UTC())
	obs.detectDuplicatePRs(context.Background())
	if len(reactor.facts) != 0 {
		t.Fatalf("distinct issues reported %d dup facts", len(reactor.facts))
	}
}

// A PR whose session has no linked issue can't be attributed and is skipped.
func TestDetectDuplicatePRs_SkipsUnlinkedSessions(t *testing.T) {
	store := dupTestStore()
	store.sessions = []domain.SessionRecord{
		{ID: "s1", ProjectID: "p"},
		{ID: "s2", ProjectID: "p"},
	}
	store.prs["s1"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/10", SessionID: "s1", Number: 10, Repo: "o/r"}}
	store.prs["s2"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/11", SessionID: "s2", Number: 11, Repo: "o/r"}}
	reactor := &dupReactorLifecycle{}
	obs := newTestObserver(store, &fakeProvider{}, reactor, time.Unix(1, 0).UTC())
	obs.detectDuplicatePRs(context.Background())
	if len(reactor.facts) != 0 {
		t.Fatalf("unlinked sessions reported %d dup facts", len(reactor.facts))
	}
}

// Three open PRs on one issue: the lowest number is canonical, the other two are
// each reported as duplicates of it.
func TestDetectDuplicatePRs_MultipleDuplicatesAllPointToCanonical(t *testing.T) {
	store := dupTestStore()
	store.sessions = []domain.SessionRecord{
		{ID: "s1", ProjectID: "p", IssueID: "github:o/r#169"},
		{ID: "s2", ProjectID: "p", IssueID: "github:o/r#169"},
		{ID: "s3", ProjectID: "p", IssueID: "github:o/r#169"},
	}
	store.prs["s1"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/20", SessionID: "s1", Number: 20, Repo: "o/r"}}
	store.prs["s2"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/12", SessionID: "s2", Number: 12, Repo: "o/r"}}
	store.prs["s3"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/30", SessionID: "s3", Number: 30, Repo: "o/r"}}
	reactor := &dupReactorLifecycle{}
	obs := newTestObserver(store, &fakeProvider{}, reactor, time.Unix(1, 0).UTC())
	obs.detectDuplicatePRs(context.Background())
	if len(reactor.facts) != 2 {
		t.Fatalf("facts = %d, want 2", len(reactor.facts))
	}
	for _, f := range reactor.facts {
		if f.ExistingPRNumber != 12 {
			t.Fatalf("canonical existing PR = #%d, want #12 (lowest number)", f.ExistingPRNumber)
		}
	}
}

// Two sessions link the same issue via DIFFERENT stored shapes — a bare number
// ("169") and the canonical form ("github:o/r#169"). Canonicalization must group
// them so the collision is still detected (reviewer finding 1d).
func TestDetectDuplicatePRs_CanonicalizesMixedIssueIDShapes(t *testing.T) {
	store := dupTestStore()
	// The project's intake repo resolves the bare number to the same canonical id.
	store.projects["p"] = domain.ProjectRecord{
		ID:            "p",
		RepoOriginURL: "https://github.com/o/r.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Repo: "o/r"}},
	}
	store.sessions = []domain.SessionRecord{
		{ID: "s1", ProjectID: "p", IssueID: "github:o/r#169"},
		{ID: "s2", ProjectID: "p", IssueID: "169"},
	}
	store.prs["s1"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/172", SessionID: "s1", Number: 172, Repo: "o/r"}}
	store.prs["s2"] = []domain.PullRequest{{URL: "https://github.com/o/r/pull/180", SessionID: "s2", Number: 180, Repo: "o/r"}}

	reactor := &dupReactorLifecycle{}
	obs := newTestObserver(store, &fakeProvider{}, reactor, time.Unix(1, 0).UTC())
	obs.detectDuplicatePRs(context.Background())

	if len(reactor.facts) != 1 {
		t.Fatalf("facts = %d, want 1 (mixed issue-id shapes must group)", len(reactor.facts))
	}
	if reactor.facts[0].ExistingPRNumber != 172 || reactor.facts[0].DupPRNumber != 180 {
		t.Fatalf("fact = existing #%d dup #%d, want existing #172 dup #180", reactor.facts[0].ExistingPRNumber, reactor.facts[0].DupPRNumber)
	}
}

// Two DIFFERENT projects carrying the same bare issue number must not be grouped
// together when canonicalization is unavailable (reviewer finding 2a): the group
// key is scoped by project, so no cross-project false positive is reported.
func TestDetectDuplicatePRs_DoesNotGroupAcrossProjectsOnRawFallback(t *testing.T) {
	store := dupTestStore()
	// Two projects, neither resolvable to a tracker repo, so the raw id "169" is
	// the fallback key in both.
	store.projects["p1"] = domain.ProjectRecord{ID: "p1"}
	store.projects["p2"] = domain.ProjectRecord{ID: "p2"}
	store.sessions = []domain.SessionRecord{
		{ID: "s1", ProjectID: "p1", IssueID: "169"},
		{ID: "s2", ProjectID: "p2", IssueID: "169"},
	}
	store.prs["s1"] = []domain.PullRequest{{URL: "https://github.com/a/r/pull/1", SessionID: "s1", Number: 1, Repo: "a/r"}}
	store.prs["s2"] = []domain.PullRequest{{URL: "https://github.com/b/r/pull/2", SessionID: "s2", Number: 2, Repo: "b/r"}}
	reactor := &dupReactorLifecycle{}
	obs := newTestObserver(store, &fakeProvider{}, reactor, time.Unix(1, 0).UTC())
	obs.detectDuplicatePRs(context.Background())
	if len(reactor.facts) != 0 {
		t.Fatalf("cross-project raw-id fallback grouped %d dup facts, want 0", len(reactor.facts))
	}
}
