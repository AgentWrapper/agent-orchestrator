package attention

// Phase 0 of issue #268 (Refactor notifications and operator attention around
// one canonical projection).
//
// This file is the PARITY CONTRACT for the operator-attention projection. It
// pins the complete "operator-attention story" as a pure, table-driven test
// that drives the attention Service (ListOperator) directly — no HTTP, no DB,
// no Slack.
//
// Why it exists, and what later phases owe it:
//   - Phase 1 (DONE) extracted deriveOperatorAttention out of the httpd
//     controller into this transport-neutral service/attention owner. The
//     contract moved with the logic and every row stayed green; the rows are the
//     behavior being preserved.
//   - Phase 5 deletes the duplicate JS classifiers (ops/attention-core.mjs,
//     ops/what-needs-me.mjs, and the urgency re-derivation in
//     ops/ao-slack-notifier.mjs). Per #271's canonical architecture, that
//     deletion is only licensed once the Go projection demonstrably covers
//     every source. This test is that demonstration.
//
// Design principles (hardened after cross-family review of PR #274):
//   - Every scenario asserts the EXACT projected set (size + membership), so a
//     case can never silently accept an unexpected extra item.
//   - Each PR/notification exclusion is built from a merge-ready baseline with
//     exactly ONE property flipped, so the row isolates the gate it names and
//     cannot pass for the wrong reason.
//   - Decision subtypes assert DecisionKind/Question/Reason/Action, not just
//     the item ID, so a "treat every decision as generic" regression fails.
//   - Order-sensitive behavior (sort, supersede tie-breaks, notification
//     newest-wins dedup) is asserted against the ordered projection, with the
//     superseding input placed FIRST so a naive first-wins implementation fails.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

// parityFakeAttentionService is a minimal implementation of the two derivation
// collaborators (SessionReader and NotificationReader). It lets the parity
// contract drive the Service with no HTTP, DB, or Slack, and it travels with the
// derivation logic (moved here from the controller in Phase 1).
type parityFakeAttentionService struct {
	sessions        []domain.Session
	decisions       map[domain.SessionID]domain.PendingDecision
	decisionErrs    map[domain.SessionID]error
	prSummaries     map[domain.SessionID][]sessionsvc.PRSummary
	prSummaryErrs   map[domain.SessionID]error
	notifications   []notificationsvc.Notification
	notificationErr error
}

func (f *parityFakeAttentionService) List(_ context.Context, _ sessionsvc.ListFilter) ([]domain.Session, error) {
	return f.sessions, nil
}

func (f *parityFakeAttentionService) Decision(_ context.Context, id domain.SessionID) (domain.PendingDecision, bool, error) {
	if err, ok := f.decisionErrs[id]; ok {
		return domain.PendingDecision{}, false, err
	}
	if d, ok := f.decisions[id]; ok {
		return d, true, nil
	}
	return domain.PendingDecision{}, false, nil
}

func (f *parityFakeAttentionService) ListPRSummaries(_ context.Context, id domain.SessionID) ([]sessionsvc.PRSummary, error) {
	if err, ok := f.prSummaryErrs[id]; ok {
		return nil, err
	}
	if prs, ok := f.prSummaries[id]; ok {
		return prs, nil
	}
	return nil, nil
}

func (f *parityFakeAttentionService) ListUnread(_ context.Context, _ notificationsvc.ListFilter) ([]notificationsvc.Notification, error) {
	if f.notificationErr != nil {
		return nil, f.notificationErr
	}
	return f.notifications, nil
}

func (f *parityFakeAttentionService) MarkRead(context.Context, string) (notificationsvc.Notification, bool, error) {
	return notificationsvc.Notification{}, false, nil
}

func (f *parityFakeAttentionService) MarkAllRead(context.Context) ([]notificationsvc.Notification, error) {
	return nil, nil
}

func parityTime(t *testing.T) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, "2026-07-12T04:00:00Z")
	if err != nil {
		t.Fatalf("parse parity time: %v", err)
	}
	return ts
}

func parityWorker(id domain.SessionID, project domain.ProjectID, status domain.SessionStatus, now time.Time) domain.Session {
	return domain.Session{
		SessionRecord: domain.SessionRecord{
			ID:        id,
			ProjectID: project,
			Kind:      domain.KindWorker,
			Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
			CreatedAt: now,
			UpdatedAt: now,
		},
		Status: status,
	}
}

func parityRole(id domain.SessionID, project domain.ProjectID, kind domain.SessionKind, status domain.SessionStatus, now time.Time) domain.Session {
	s := parityWorker(id, project, status, now)
	s.Kind = kind
	return s
}

// mergeReadyPRSession returns a worker session plus a PRSummary that passes
// every merge-ready gate the projection checks. Callers flip exactly one
// property to build an isolated exclusion row. updatedAt sets the PR summary's
// timestamp (which becomes the projected item's UpdatedAt, driving sort order).
func mergeReadyPRSession(id domain.SessionID, project domain.ProjectID, url string, number int, now, updatedAt time.Time) (domain.Session, sessionsvc.PRSummary) {
	sess := parityWorker(id, project, domain.StatusMergeable, now)
	sess.PRs = []domain.PRFacts{{URL: url, Number: number, CI: domain.CIPassing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable, UpdatedAt: updatedAt}}
	pr := sessionsvc.PRSummary{
		URL:          url,
		HTMLURL:      url,
		Number:       number,
		Title:        "Ready and human-gated",
		State:        domain.PRStateOpen,
		CI:           sessionsvc.PRCISummary{State: domain.CIPassing},
		Review:       sessionsvc.PRReviewSummary{Decision: domain.ReviewApproved},
		FinalReview:  sessionsvc.PRFinalReviewSummary{Status: reviewcore.ReviewStateUpToDate, TargetSHA: "sha"},
		Mergeability: sessionsvc.PRMergeabilitySummary{State: domain.MergeMergeable, PRURL: url},
		UpdatedAt:    updatedAt,
	}
	return sess, pr
}

// parityExpect is one expected projected item. Assertion strength varies by
// field, and assertProjectionEquals documents which are exact vs. optional:
//   - id, kind, sessionID, prURL are ALWAYS asserted exactly, including their
//     zero values (e.g. an empty prURL must be empty on the projected item).
//   - deepLink, reason, action, decisionKind, question are asserted only when
//     the expectation sets them (non-empty), so a row can pin decision-specific
//     copy without every row having to restate it.
//
// In addition, every projected item is asserted to carry a non-empty reason and
// action regardless of whether the row pins the exact strings.
type parityExpect struct {
	id           string
	kind         string
	sessionID    string
	prURL        string
	deepLink     string
	reason       string
	action       string
	decisionKind domain.DecisionKind
	question     string
}

// ---- Ordered, exact-set scenarios ------------------------------------------
//
// Each scenario asserts the projection as an ORDERED, EXACT list. This single
// assertion style covers membership, exclusion (anything not listed must be
// absent), size, and the production sort contract at once.

func TestOperatorAttentionParity_Ordered(t *testing.T) {
	now := parityTime(t)

	cases := []struct {
		name  string
		build func() *parityFakeAttentionService
		want  []parityExpect // in the exact order the projection must return
	}{
		{
			name: "empty inputs project nothing",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{}
			},
			want: nil,
		},
		{
			name: "decision/question pins DecisionKind, Question, reason and action",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					sessions: []domain.Session{parityWorker("ask-1", "ao", domain.StatusNeedsInput, now)},
					decisions: map[domain.SessionID]domain.PendingDecision{
						"ask-1": {Kind: domain.DecisionKindQuestion, Question: "A or B?", Options: []string{"A", "B"}},
					},
				}
			},
			want: []parityExpect{{
				id: "session:ask-1:decision", kind: "decision", sessionID: "ask-1",
				deepLink:     "/projects/ao/sessions/ask-1",
				decisionKind: domain.DecisionKindQuestion,
				question:     "A or B?",
				reason:       "Session is waiting on an operator decision.",
				action:       "Answer the session question.",
			}},
		},
		{
			name: "decision/permission has the permission-specific reason and action",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					sessions: []domain.Session{parityWorker("perm-1", "ao", domain.StatusNeedsInput, now)},
					decisions: map[domain.SessionID]domain.PendingDecision{
						"perm-1": {Kind: domain.DecisionKindPermission, Question: "Allow command?"},
					},
				}
			},
			want: []parityExpect{{
				id: "session:perm-1:decision", kind: "decision", sessionID: "perm-1",
				deepLink:     "/projects/ao/sessions/perm-1",
				decisionKind: domain.DecisionKindPermission,
				question:     "Allow command?",
				reason:       "Session is paused on a permission dialog.",
				action:       "Approve or deny the permission in the session terminal.",
			}},
		},
		{
			name: "needs_input session with no pending decision projects nothing",
			build: func() *parityFakeAttentionService {
				// Decision() returns ok=false (no entry in decisions map).
				return &parityFakeAttentionService{
					sessions: []domain.Session{parityWorker("ask-none", "ao", domain.StatusNeedsInput, now)},
				}
			},
			want: nil,
		},
		{
			name: "no_signal: orchestrator and prime surface with role-specific copy; worker does not",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					sessions: []domain.Session{
						parityRole("orch-dead", "ao", domain.KindOrchestrator, domain.StatusNoSignal, now),
						parityRole("prime-dead", "ao", domain.KindPrime, domain.StatusNoSignal, now),
						parityWorker("worker-dead", "ao", domain.StatusNoSignal, now),
					},
				}
			},
			// Equal timestamps → tie-break by ID ascending:
			// "session:orch-dead:no_signal" < "session:prime-dead:no_signal".
			want: []parityExpect{
				{
					id: "session:orch-dead:no_signal", kind: "orchestrator_dead", sessionID: "orch-dead",
					deepLink: "/projects/ao/sessions/orch-dead",
					reason:   "Project orchestrator has no live process signal.",
					action:   "Inspect the project orchestrator and restart or replace it if needed.",
				},
				{
					id: "session:prime-dead:no_signal", kind: "prime_dead", sessionID: "prime-dead",
					deepLink: "/projects/ao/sessions/prime-dead",
					reason:   "Prime orchestrator has no live process signal.",
					action:   "Inspect the prime supervisor and restart or replace it if needed.",
				},
			},
		},
		{
			name: "merge-ready PR (approved) surfaces; kind, action and deep link are pinned",
			build: func() *parityFakeAttentionService {
				url := "https://github.com/aoagents/agent-orchestrator/pull/900"
				sess, pr := mergeReadyPRSession("merge-1", "ao", url, 900, now, now)
				return &parityFakeAttentionService{
					sessions:    []domain.Session{sess},
					prSummaries: map[domain.SessionID][]sessionsvc.PRSummary{"merge-1": {pr}},
				}
			},
			want: []parityExpect{{
				id:   "pr:https://github.com/aoagents/agent-orchestrator/pull/900:merge",
				kind: "pr", sessionID: "merge-1",
				prURL:    "https://github.com/aoagents/agent-orchestrator/pull/900",
				deepLink: "https://github.com/aoagents/agent-orchestrator/pull/900",
				reason:   "PR is locally mergeable and waiting for operator merge authority.",
				action:   "Review final-review status and merge the pull request when the gate is clean.",
			}},
		},
		{
			name: "merge-ready PR with neutral (none) review decision still surfaces",
			// The gate excludes changes_requested / review_required / unresolved
			// human comments — approval is NOT required. Pin that a neutral
			// decision is accepted so a future "require approval" regression fails.
			build: func() *parityFakeAttentionService {
				url := "https://github.com/aoagents/agent-orchestrator/pull/905"
				sess, pr := mergeReadyPRSession("neutral-1", "ao", url, 905, now, now)
				pr.Review = sessionsvc.PRReviewSummary{Decision: domain.ReviewNone}
				return &parityFakeAttentionService{
					sessions:    []domain.Session{sess},
					prSummaries: map[domain.SessionID][]sessionsvc.PRSummary{"neutral-1": {pr}},
				}
			},
			want: []parityExpect{{
				id:   "pr:https://github.com/aoagents/agent-orchestrator/pull/905:merge",
				kind: "pr", sessionID: "neutral-1",
				prURL:    "https://github.com/aoagents/agent-orchestrator/pull/905",
				deepLink: "https://github.com/aoagents/agent-orchestrator/pull/905",
			}},
		},
		{
			name: "worker_retry_exhausted surfaces with PR deep link; worker_died_unfinished does not",
			build: func() *parityFakeAttentionService {
				exhPR := "https://github.com/aoagents/agent-orchestrator/pull/930"
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-exhausted", SessionID: "dead-1", ProjectID: "ao", PRURL: exhPR,
							Type: domain.NotificationWorkerRetryExhausted, Title: "retry cap", Status: domain.NotificationUnread,
							CreatedAt: now,
						}},
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-died", SessionID: "dead-2", ProjectID: "ao",
							Type: domain.NotificationWorkerDiedUnfinished, Title: "died", Status: domain.NotificationUnread,
							CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "notification:n-exhausted:operator", kind: "worker_retry_exhausted",
				sessionID: "dead-1",
				prURL:     "https://github.com/aoagents/agent-orchestrator/pull/930",
				deepLink:  "https://github.com/aoagents/agent-orchestrator/pull/930",
			}},
		},
		{
			name: "worker_retry_exhausted without a PR URL falls back to the session deep link",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-nopr", SessionID: "dead-3", ProjectID: "ao",
							Type: domain.NotificationWorkerRetryExhausted, Title: "retry cap", Status: domain.NotificationUnread,
							CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "notification:n-nopr:operator", kind: "worker_retry_exhausted",
				sessionID: "dead-3",
				prURL:     "",
				deepLink:  "/projects/ao/sessions/dead-3",
			}},
		},
		{
			name: "sort: newer UpdatedAt comes first across mixed sources",
			build: func() *parityFakeAttentionService {
				older := "https://github.com/aoagents/agent-orchestrator/pull/940"
				newer := "https://github.com/aoagents/agent-orchestrator/pull/941"
				sOld, prOld := mergeReadyPRSession("old-1", "ao", older, 940, now, now.Add(-time.Hour))
				sNew, prNew := mergeReadyPRSession("new-1", "ao", newer, 941, now, now.Add(time.Hour))
				return &parityFakeAttentionService{
					sessions: []domain.Session{sOld, sNew},
					prSummaries: map[domain.SessionID][]sessionsvc.PRSummary{
						"old-1": {prOld},
						"new-1": {prNew},
					},
				}
			},
			want: []parityExpect{
				{id: "pr:https://github.com/aoagents/agent-orchestrator/pull/941:merge", kind: "pr", sessionID: "new-1", prURL: "https://github.com/aoagents/agent-orchestrator/pull/941", deepLink: "https://github.com/aoagents/agent-orchestrator/pull/941"},
				{id: "pr:https://github.com/aoagents/agent-orchestrator/pull/940:merge", kind: "pr", sessionID: "old-1", prURL: "https://github.com/aoagents/agent-orchestrator/pull/940", deepLink: "https://github.com/aoagents/agent-orchestrator/pull/940"},
			},
		},
		{
			name: "cross-project PRs with the same number stay distinct items",
			build: func() *parityFakeAttentionService {
				aURL := "https://github.com/aoagents/agent-orchestrator/pull/900"
				bURL := "https://github.com/acme/other/pull/900"
				sA, prA := mergeReadyPRSession("a-1", "ao", aURL, 900, now, now.Add(time.Minute))
				sB, prB := mergeReadyPRSession("b-1", "other", bURL, 900, now, now)
				return &parityFakeAttentionService{
					sessions: []domain.Session{sA, sB},
					prSummaries: map[domain.SessionID][]sessionsvc.PRSummary{
						"a-1": {prA},
						"b-1": {prB},
					},
				}
			},
			// a-1's PR is newer → first.
			want: []parityExpect{
				{id: "pr:https://github.com/aoagents/agent-orchestrator/pull/900:merge", kind: "pr", sessionID: "a-1", prURL: "https://github.com/aoagents/agent-orchestrator/pull/900", deepLink: "https://github.com/aoagents/agent-orchestrator/pull/900"},
				{id: "pr:https://github.com/acme/other/pull/900:merge", kind: "pr", sessionID: "b-1", prURL: "https://github.com/acme/other/pull/900", deepLink: "https://github.com/acme/other/pull/900"},
			},
		},
		{
			name: "sessions deleted mid-derive (NotFound on decision/PR) are skipped, not fatal",
			build: func() *parityFakeAttentionService {
				url := "https://github.com/aoagents/agent-orchestrator/pull/950"
				gonePR := parityWorker("gone-pr", "ao", domain.StatusMergeable, now)
				gonePR.PRs = []domain.PRFacts{{URL: url, Number: 950, CI: domain.CIPassing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable, UpdatedAt: now}}
				return &parityFakeAttentionService{
					sessions: []domain.Session{
						parityWorker("gone-decision", "ao", domain.StatusNeedsInput, now),
						gonePR,
					},
					decisions: map[domain.SessionID]domain.PendingDecision{
						"gone-decision": {Kind: domain.DecisionKindQuestion, Question: "?"},
					},
					decisionErrs: map[domain.SessionID]error{
						"gone-decision": apierr.NotFound("SESSION_NOT_FOUND", "gone"),
					},
					prSummaryErrs: map[domain.SessionID]error{
						"gone-pr": apierr.NotFound("SESSION_NOT_FOUND", "gone"),
					},
				}
			},
			want: nil,
		},
		{
			name: "notification read failure degrades to session-derived items only",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					sessions: []domain.Session{parityWorker("perm-1", "ao", domain.StatusNeedsInput, now)},
					decisions: map[domain.SessionID]domain.PendingDecision{
						"perm-1": {Kind: domain.DecisionKindPermission, Question: "Allow?"},
					},
					notificationErr: errors.New("sqlite busy"),
				}
			},
			want: []parityExpect{{
				id: "session:perm-1:decision", kind: "decision", sessionID: "perm-1",
				deepLink:     "/projects/ao/sessions/perm-1",
				decisionKind: domain.DecisionKindPermission,
				question:     "Allow?",
				reason:       "Session is paused on a permission dialog.",
				action:       "Approve or deny the permission in the session terminal.",
			}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := tc.build()
			items, err := New(Deps{Sessions: svc, Notifications: svc}).ListOperator(context.Background())
			if err != nil {
				t.Fatalf("ListOperator: unexpected error: %v", err)
			}
			assertProjectionEquals(t, items, tc.want)
		})
	}
}

// ---- Isolated exclusion rows (one flipped property from merge-ready) --------
//
// Each row starts from a merge-ready PR and flips exactly ONE property, then
// asserts the PR no longer surfaces. Building from the same baseline guarantees
// the flipped property is the ONLY reason the item is excluded, so removing the
// corresponding gate in the derivation would make exactly this row fail.

func TestOperatorAttentionParity_PRExclusionsAreIsolated(t *testing.T) {
	now := parityTime(t)
	const url = "https://github.com/aoagents/agent-orchestrator/pull/910"

	// Sanity anchor: the untouched baseline DOES surface. If this ever stops
	// being true, every "flip" row below is vacuous, so guard it explicitly.
	t.Run("baseline merge-ready PR surfaces", func(t *testing.T) {
		svc := &parityFakeAttentionService{}
		sess, pr := mergeReadyPRSession("base", "ao", url, 910, now, now)
		svc.sessions = []domain.Session{sess}
		svc.prSummaries = map[domain.SessionID][]sessionsvc.PRSummary{"base": {pr}}
		items, err := New(Deps{Sessions: svc, Notifications: svc}).ListOperator(context.Background())
		if err != nil {
			t.Fatalf("derive: %v", err)
		}
		if len(items) != 1 || items[0].ID != "pr:"+url+":merge" {
			t.Fatalf("baseline did not surface as expected: %v", idsOf(items))
		}
	})

	flips := []struct {
		name string
		flip func(sess *domain.Session, pr *sessionsvc.PRSummary)
	}{
		{
			name: "PR not open (closed) is excluded",
			flip: func(_ *domain.Session, pr *sessionsvc.PRSummary) { pr.State = domain.PRStateClosed },
		},
		{
			name: "failing CI is excluded",
			flip: func(_ *domain.Session, pr *sessionsvc.PRSummary) {
				pr.CI = sessionsvc.PRCISummary{State: domain.CIFailing}
			},
		},
		{
			name: "non-mergeable (conflicting) is excluded",
			flip: func(_ *domain.Session, pr *sessionsvc.PRSummary) {
				pr.Mergeability = sessionsvc.PRMergeabilitySummary{State: domain.MergeConflicting, PRURL: url}
			},
		},
		{
			name: "review changes-requested is excluded",
			flip: func(_ *domain.Session, pr *sessionsvc.PRSummary) {
				pr.Review = sessionsvc.PRReviewSummary{Decision: domain.ReviewChangesRequest}
			},
		},
		{
			name: "review required is excluded",
			flip: func(_ *domain.Session, pr *sessionsvc.PRSummary) {
				pr.Review = sessionsvc.PRReviewSummary{Decision: domain.ReviewRequired}
			},
		},
		{
			name: "unresolved human comments are excluded",
			flip: func(_ *domain.Session, pr *sessionsvc.PRSummary) {
				pr.Review = sessionsvc.PRReviewSummary{Decision: domain.ReviewApproved, HasUnresolvedHumanComments: true}
			},
		},
		{
			name: "final review not up-to-date (needs_review) is excluded",
			flip: func(_ *domain.Session, pr *sessionsvc.PRSummary) {
				// Flip ONLY the status, keeping the baseline TargetSHA, so this row
				// isolates the status gate and cannot pass for a TargetSHA reason.
				pr.FinalReview.Status = reviewcore.ReviewStateNeedsReview
			},
		},
		{
			name: "final review changes-requested is excluded",
			flip: func(_ *domain.Session, pr *sessionsvc.PRSummary) {
				pr.FinalReview.Status = reviewcore.ReviewStateChangesRequested
			},
		},
	}

	for _, f := range flips {
		t.Run(f.name, func(t *testing.T) {
			svc := &parityFakeAttentionService{}
			sess, pr := mergeReadyPRSession("x", "ao", url, 910, now, now)
			f.flip(&sess, &pr)
			svc.sessions = []domain.Session{sess}
			svc.prSummaries = map[domain.SessionID][]sessionsvc.PRSummary{"x": {pr}}
			items, err := New(Deps{Sessions: svc, Notifications: svc}).ListOperator(context.Background())
			if err != nil {
				t.Fatalf("derive: %v", err)
			}
			assertProjectionEquals(t, items, nil)
		})
	}
}

// ---- Supersede + notification dedup (order-placed to defeat first-wins) -----

func TestOperatorAttentionParity_SupersedeAndDedup(t *testing.T) {
	now := parityTime(t)

	t.Run("same PR: live derivation supersedes a terminated session listed FIRST", func(t *testing.T) {
		url := "https://github.com/aoagents/agent-orchestrator/pull/960"
		// Terminated is placed first AND carries the newer timestamp, so only a
		// correct live-over-terminated preference (not first-wins, not
		// newest-wins) yields the live session.
		term, termPR := mergeReadyPRSession("terminated", "ao", url, 960, now, now.Add(time.Hour))
		term.IsTerminated = true
		live, livePR := mergeReadyPRSession("live", "ao", url, 960, now, now)
		svc := &parityFakeAttentionService{
			sessions: []domain.Session{term, live},
			prSummaries: map[domain.SessionID][]sessionsvc.PRSummary{
				"terminated": {termPR},
				"live":       {livePR},
			},
		}
		items, err := New(Deps{Sessions: svc, Notifications: svc}).ListOperator(context.Background())
		if err != nil {
			t.Fatalf("derive: %v", err)
		}
		assertProjectionEquals(t, items, []parityExpect{{
			id: "pr:" + url + ":merge", kind: "pr", sessionID: "live", prURL: url, deepLink: url,
		}})
	})

	t.Run("duplicate notification IDs collapse to one item; newest CreatedAt wins regardless of order", func(t *testing.T) {
		// Two notifications share ID "dup". appendAttentionItem keys the seen-map
		// on the item ID, and attentionItemSupersedes prefers the newer UpdatedAt
		// (a notification's UpdatedAt is its CreatedAt). So exactly one survives
		// and it must be the NEWER one. Asserting the survivor's fields (not just
		// that one row exists) defeats a "keep the first duplicate" regression;
		// running both input orders proves the winner is chosen by timestamp, not
		// by list position.
		olderPR := "https://github.com/aoagents/agent-orchestrator/pull/970"
		newerPR := "https://github.com/aoagents/agent-orchestrator/pull/971"
		older := notificationsvc.Notification{NotificationRecord: domain.NotificationRecord{
			ID: "dup", SessionID: "s-old", ProjectID: "ao", PRURL: olderPR,
			Type: domain.NotificationWorkerRetryExhausted, Title: "older", Status: domain.NotificationUnread,
			CreatedAt: now,
		}}
		newer := notificationsvc.Notification{NotificationRecord: domain.NotificationRecord{
			ID: "dup", SessionID: "s-new", ProjectID: "ao", PRURL: newerPR,
			Type: domain.NotificationWorkerRetryExhausted, Title: "newer", Status: domain.NotificationUnread,
			CreatedAt: now.Add(time.Hour),
		}}
		wantNewerWins := []parityExpect{{
			id: "notification:dup:operator", kind: "worker_retry_exhausted",
			sessionID: "s-new", prURL: newerPR, deepLink: newerPR,
		}}
		for _, order := range []struct {
			name  string
			input []notificationsvc.Notification
		}{
			{name: "older first", input: []notificationsvc.Notification{older, newer}},
			{name: "newer first", input: []notificationsvc.Notification{newer, older}},
		} {
			t.Run(order.name, func(t *testing.T) {
				svc := &parityFakeAttentionService{notifications: order.input}
				items, err := New(Deps{Sessions: svc, Notifications: svc}).ListOperator(context.Background())
				if err != nil {
					t.Fatalf("derive: %v", err)
				}
				assertProjectionEquals(t, items, wantNewerWins)
			})
		}
	})

	t.Run("notification with empty ID uses the project:session:type fallback ID", func(t *testing.T) {
		svc := &parityFakeAttentionService{
			notifications: []notificationsvc.Notification{
				{NotificationRecord: domain.NotificationRecord{
					ID: "", SessionID: "s-x", ProjectID: "ao",
					Type: domain.NotificationWorkerRetryExhausted, Title: "noid", Status: domain.NotificationUnread,
					CreatedAt: now,
				}},
			},
		}
		items, err := New(Deps{Sessions: svc, Notifications: svc}).ListOperator(context.Background())
		if err != nil {
			t.Fatalf("derive: %v", err)
		}
		assertProjectionEquals(t, items, []parityExpect{{
			id: "notification:ao:s-x:worker_retry_exhausted", kind: "worker_retry_exhausted",
			sessionID: "s-x", deepLink: "/projects/ao/sessions/s-x",
		}})
	})
}

// assertProjectionEquals checks the projection matches want exactly: same
// length, same order, and every asserted field on each item.
func assertProjectionEquals(t *testing.T, items []Item, want []parityExpect) {
	t.Helper()
	if len(items) != len(want) {
		t.Fatalf("projection size = %d, want %d; got IDs %v", len(items), len(want), idsOf(items))
	}
	for i, w := range want {
		got := items[i]
		if got.ID != w.id {
			t.Fatalf("item[%d] ID = %q, want %q; full order %v", i, got.ID, w.id, idsOf(items))
		}
		if got.Kind != w.kind {
			t.Errorf("item %q kind = %q, want %q", w.id, got.Kind, w.kind)
		}
		if string(got.SessionID) != w.sessionID {
			t.Errorf("item %q sessionID = %q, want %q", w.id, got.SessionID, w.sessionID)
		}
		if got.PRURL != w.prURL {
			t.Errorf("item %q prURL = %q, want %q", w.id, got.PRURL, w.prURL)
		}
		if w.deepLink != "" && got.DeepLink != w.deepLink {
			t.Errorf("item %q deepLink = %q, want %q", w.id, got.DeepLink, w.deepLink)
		}
		if w.reason != "" && got.Reason != w.reason {
			t.Errorf("item %q reason = %q, want %q", w.id, got.Reason, w.reason)
		}
		if w.action != "" && got.Action != w.action {
			t.Errorf("item %q action = %q, want %q", w.id, got.Action, w.action)
		}
		if w.decisionKind != "" && got.DecisionKind != w.decisionKind {
			t.Errorf("item %q decisionKind = %q, want %q", w.id, got.DecisionKind, w.decisionKind)
		}
		if w.question != "" && got.Question != w.question {
			t.Errorf("item %q question = %q, want %q", w.id, got.Question, w.question)
		}
		// Every projected item must carry reason + action regardless of whether
		// the row pins the exact strings.
		if got.Reason == "" || got.Action == "" {
			t.Errorf("item %q missing reason/action: %+v", w.id, got)
		}
	}
}

func idsOf(items []Item) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.ID)
	}
	return out
}
