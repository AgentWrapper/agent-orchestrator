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
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
// derivation logic (moved here from the controller in Phase 1). ListUnread
// applies the filter's Types/SensitiveOnly the way the sqlite store does, so
// scenarios seed one notification list and the projection's two bounded reads
// (durable escalations; sensitive ready_to_merge) each see only their rows.
type parityFakeAttentionService struct {
	sessions            []domain.Session
	prSummaries         map[domain.SessionID][]sessionsvc.PRSummary
	prSummaryErrs       map[domain.SessionID]error
	notifications       []notificationsvc.Notification
	notificationFilters []notificationsvc.ListFilter
	notificationErr     error
}

func (f *parityFakeAttentionService) List(_ context.Context, _ sessionsvc.ListFilter) ([]domain.Session, error) {
	return f.sessions, nil
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

func (f *parityFakeAttentionService) ListUnread(_ context.Context, filter notificationsvc.ListFilter) ([]notificationsvc.Notification, error) {
	f.notificationFilters = append(f.notificationFilters, filter)
	if f.notificationErr != nil {
		return nil, f.notificationErr
	}
	types := map[domain.NotificationType]bool{}
	for _, t := range filter.Types {
		types[t] = true
	}
	out := make([]notificationsvc.Notification, 0, len(f.notifications))
	for _, n := range f.notifications {
		if len(types) > 0 && !types[n.Type] {
			continue
		}
		if filter.SensitiveOnly && !n.Sensitive {
			continue
		}
		out = append(out, n)
	}
	return out, nil
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

// parityDecisionWorker returns a needs_input worker whose List snapshot carries
// a CAPTURED dialog (Metadata.PendingDecision) — the production shape for a
// decision item. The projection reads the snapshot metadata directly; it never
// calls session_manager.Decision (which synthesizes a permission decision for
// every blocked session and would erase the captured-vs-uncaptured distinction).
func parityDecisionWorker(id domain.SessionID, project domain.ProjectID, decision domain.PendingDecision, now time.Time) domain.Session {
	s := parityWorker(id, project, domain.StatusNeedsInput, now)
	s.Activity.State = domain.ActivityWaitingInput
	s.Metadata.PendingDecision = &decision
	return s
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
	id            string
	kind          string
	sessionID     string
	prURL         string
	deepLink      string
	exactDeepLink bool
	reason        string
	action        string
	decisionKind  domain.DecisionKind
	question      string
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
					sessions: []domain.Session{parityDecisionWorker("ask-1", "ao", domain.PendingDecision{Kind: domain.DecisionKindQuestion, Question: "A or B?", Options: []string{"A", "B"}}, now)},
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
					sessions: []domain.Session{parityDecisionWorker("perm-1", "ao", domain.PendingDecision{Kind: domain.DecisionKindPermission, Question: "Allow command?"}, now)},
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
				// waiting_input with no captured Metadata.PendingDecision: the agent is
				// at an empty prompt, not stopped on a dialog — nothing to project.
				s := parityWorker("ask-none", "ao", domain.StatusNeedsInput, now)
				s.Activity.State = domain.ActivityWaitingInput
				return &parityFakeAttentionService{sessions: []domain.Session{s}}
			},
			want: nil,
		},
		{
			name: "blocked session with no pending decision surfaces as a blocked item",
			build: func() *parityFakeAttentionService {
				// activity_state=blocked, status=needs_input (production shape), but
				// Decision() returns ok=false (no entry) so no decision item is built.
				sess := parityWorker("stuck-1", "ao", domain.StatusNeedsInput, now)
				sess.Activity.State = domain.ActivityBlocked
				return &parityFakeAttentionService{
					sessions: []domain.Session{sess},
				}
			},
			want: []parityExpect{{
				id: "session:stuck-1:blocked", kind: "blocked", sessionID: "stuck-1",
				deepLink: "/projects/ao/sessions/stuck-1",
				reason:   "Session is blocked or stuck and needs the operator.",
				action:   "Inspect the session terminal and unblock it.",
			}},
		},
		{
			name: "blocked session WITH a captured decision surfaces the decision item, not a blocked item",
			build: func() *parityFakeAttentionService {
				sess := parityWorker("perm-block", "ao", domain.StatusNeedsInput, now)
				sess.Activity.State = domain.ActivityBlocked
				sess.Metadata.PendingDecision = &domain.PendingDecision{Kind: domain.DecisionKindPermission, Question: "Allow command?"}
				return &parityFakeAttentionService{
					sessions: []domain.Session{sess},
				}
			},
			want: []parityExpect{{
				id: "session:perm-block:decision", kind: "decision", sessionID: "perm-block",
				deepLink:     "/projects/ao/sessions/perm-block",
				decisionKind: domain.DecisionKindPermission,
				reason:       "Session is paused on a permission dialog.",
				action:       "Approve or deny the permission in the session terminal.",
			}},
		},
		{
			name: "ready_to_merge notification that is SENSITIVE surfaces as parked_sensitive_merge",
			build: func() *parityFakeAttentionService {
				prURL := "https://github.com/aoagents/agent-orchestrator/pull/990"
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-parked", ProjectID: "ao", SessionID: "sens-1", PRURL: prURL,
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Sensitive: true, ChangedPaths: []string{"backend/internal/daemon/x.go"},
							Title:     "Ready and human-gated",
							Body:      "PR touches backend/internal/daemon; a human must merge it.",
							CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "pr:github.com/aoagents/agent-orchestrator#990:parked_sensitive_merge", kind: "parked_sensitive_merge",
				sessionID: "sens-1",
				prURL:     "https://github.com/aoagents/agent-orchestrator/pull/990",
				deepLink:  "https://github.com/aoagents/agent-orchestrator/pull/990",
				reason:    "PR touches backend/internal/daemon; a human must merge it.",
			}},
		},
		{
			// Finding 4 (PR #319 review): parked items are keyed by PR identity, so
			// one sensitive PR yields ONE item even when it is simultaneously
			// merge-ready live (the parked human-gate supersedes the generic "pr"
			// item) and has multiple unread rows (one per head SHA; newest wins).
			name: "one sensitive PR: parked supersedes the live pr item and head-SHA rows collapse",
			build: func() *parityFakeAttentionService {
				prURL := "https://github.com/aoagents/agent-orchestrator/pull/995"
				sess, pr := mergeReadyPRSession("sens-live", "ao", prURL, 995, now, now)
				return &parityFakeAttentionService{
					sessions:    []domain.Session{sess},
					prSummaries: map[domain.SessionID][]sessionsvc.PRSummary{"sens-live": {pr}},
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-parked-new", ProjectID: "ao", SessionID: "sens-live", PRURL: prURL,
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Sensitive: true, HeadSHA: "sha-2", Title: "newer head", CreatedAt: now.Add(time.Minute),
						}},
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-parked-old", ProjectID: "ao", SessionID: "sens-live", PRURL: prURL,
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Sensitive: true, HeadSHA: "sha-1", Title: "older head", CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "pr:github.com/aoagents/agent-orchestrator#995:parked_sensitive_merge", kind: "parked_sensitive_merge",
				sessionID: "sens-live",
				prURL:     "https://github.com/aoagents/agent-orchestrator/pull/995",
				deepLink:  "https://github.com/aoagents/agent-orchestrator/pull/995",
				reason:    "newer head",
			}},
		},
		{
			// Read != delivery means an unread ready_to_merge row can outlive its PR.
			// The projection must not keep reporting a parked merge for a PR the
			// daemon's own session facts show as merged — that is the projection
			// misrepresenting attention (#268/#313).
			name: "parked_sensitive_merge is suppressed when session PR facts show the PR merged",
			build: func() *parityFakeAttentionService {
				prURL := "https://github.com/aoagents/agent-orchestrator/pull/992"
				sess := parityWorker("sens-merged", "ao", domain.StatusMerged, now)
				sess.PRs = []domain.PRFacts{{URL: prURL, Number: 992, Merged: true, UpdatedAt: now}}
				return &parityFakeAttentionService{
					sessions: []domain.Session{sess},
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-parked-merged", ProjectID: "ao", SessionID: "sens-merged", PRURL: prURL,
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Sensitive: true, Title: "Ready and human-gated", CreatedAt: now,
						}},
					},
				}
			},
			want: nil,
		},
		{
			name: "parked_sensitive_merge is suppressed when session PR facts show the PR closed unmerged",
			build: func() *parityFakeAttentionService {
				prURL := "https://github.com/aoagents/agent-orchestrator/pull/993"
				sess := parityWorker("sens-closed", "ao", domain.StatusTerminated, now)
				sess.IsTerminated = true
				sess.PRs = []domain.PRFacts{{URL: prURL, Number: 993, Closed: true, UpdatedAt: now}}
				return &parityFakeAttentionService{
					sessions: []domain.Session{sess},
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-parked-closed", ProjectID: "ao", SessionID: "sens-closed", PRURL: prURL,
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Sensitive: true, Title: "Ready and human-gated", CreatedAt: now,
						}},
					},
				}
			},
			want: nil,
		},
		{
			// Terminal state is resolved from the NEWEST fact per PR identity: a
			// stale closed fact (an old session sharing the PR, or a reopened PR)
			// must not suppress the parked human-gate.
			name: "reopened PR: a newer open fact overrides a stale closed fact, parked item stays",
			build: func() *parityFakeAttentionService {
				prURL := "https://github.com/aoagents/agent-orchestrator/pull/996"
				stale := parityWorker("sens-stale", "ao", domain.StatusTerminated, now)
				stale.IsTerminated = true
				stale.PRs = []domain.PRFacts{{URL: prURL, Number: 996, Closed: true, UpdatedAt: now.Add(-time.Hour)}}
				fresh := parityWorker("sens-fresh", "ao", domain.StatusPROpen, now)
				fresh.PRs = []domain.PRFacts{{URL: prURL, Number: 996, CI: domain.CIFailing, UpdatedAt: now}}
				return &parityFakeAttentionService{
					sessions: []domain.Session{stale, fresh},
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-reopened", ProjectID: "ao", SessionID: "sens-fresh", PRURL: prURL,
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Sensitive: true, Title: "Ready and human-gated", CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "pr:github.com/aoagents/agent-orchestrator#996:parked_sensitive_merge", kind: "parked_sensitive_merge",
				sessionID: "sens-fresh",
				prURL:     "https://github.com/aoagents/agent-orchestrator/pull/996",
				deepLink:  "https://github.com/aoagents/agent-orchestrator/pull/996",
			}},
		},
		{
			// Merged is permanently terminal: even a NEWER open-looking fact cannot
			// resurrect a merged PR's parked item (merges cannot be undone).
			name: "merged PR stays suppressed even when a newer fact looks open",
			build: func() *parityFakeAttentionService {
				prURL := "https://github.com/aoagents/agent-orchestrator/pull/997"
				merged := parityWorker("sens-merged-old", "ao", domain.StatusTerminated, now)
				merged.IsTerminated = true
				merged.PRs = []domain.PRFacts{{URL: prURL, Number: 997, Merged: true, UpdatedAt: now.Add(-time.Hour)}}
				open := parityWorker("sens-open-new", "ao", domain.StatusPROpen, now)
				open.PRs = []domain.PRFacts{{URL: prURL, Number: 997, CI: domain.CIFailing, UpdatedAt: now}}
				return &parityFakeAttentionService{
					sessions: []domain.Session{merged, open},
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-merged-old", ProjectID: "ao", SessionID: "sens-merged-old", PRURL: prURL,
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Sensitive: true, Title: "Ready and human-gated", CreatedAt: now,
						}},
					},
				}
			},
			want: nil,
		},
		{
			// Fail toward showing attention: session PR facts that still show the PR
			// OPEN (or a PR the sessions do not know at all) keep the parked item.
			name: "parked_sensitive_merge stays when session PR facts show the PR still open",
			build: func() *parityFakeAttentionService {
				prURL := "https://github.com/aoagents/agent-orchestrator/pull/994"
				sess := parityWorker("sens-open", "ao", domain.StatusPROpen, now)
				sess.PRs = []domain.PRFacts{{URL: prURL, Number: 994, CI: domain.CIFailing, UpdatedAt: now}}
				return &parityFakeAttentionService{
					sessions: []domain.Session{sess},
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-parked-open", ProjectID: "ao", SessionID: "sens-open", PRURL: prURL,
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Sensitive: true, Title: "Ready and human-gated", CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "pr:github.com/aoagents/agent-orchestrator#994:parked_sensitive_merge", kind: "parked_sensitive_merge",
				sessionID: "sens-open",
				prURL:     "https://github.com/aoagents/agent-orchestrator/pull/994",
				deepLink:  "https://github.com/aoagents/agent-orchestrator/pull/994",
			}},
		},
		{
			name: "ready_to_merge notification that is NOT sensitive is excluded from the projection",
			build: func() *parityFakeAttentionService {
				prURL := "https://github.com/aoagents/agent-orchestrator/pull/991"
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-green", ProjectID: "ao", SessionID: "green-1", PRURL: prURL,
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Sensitive: false, Title: "green PR", CreatedAt: now,
						}},
					},
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
			// #313: worker death is a terminal escalation requiring an explicit
			// operator restart, so it surfaces as operator attention; informational
			// types (pr_merged) stay out of the projection.
			name: "worker_died_unfinished surfaces with PR deep link; informational pr_merged does not",
			build: func() *parityFakeAttentionService {
				diedPR := "https://github.com/aoagents/agent-orchestrator/pull/930"
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-died", SessionID: "dead-1", ProjectID: "ao", PRURL: diedPR,
							Type: domain.NotificationWorkerDiedUnfinished, Title: "died", Status: domain.NotificationUnread,
							CreatedAt: now,
						}},
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-merged", SessionID: "done-1", ProjectID: "ao", PRURL: "https://github.com/aoagents/agent-orchestrator/pull/931",
							Type: domain.NotificationPRMerged, Title: "merged", Status: domain.NotificationUnread,
							CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "notification:ao:dead-1:worker_died_unfinished", kind: "worker_died_unfinished",
				sessionID: "dead-1",
				prURL:     "https://github.com/aoagents/agent-orchestrator/pull/930",
				deepLink:  "https://github.com/aoagents/agent-orchestrator/pull/930",
			}},
		},
		{
			name: "worker_died_unfinished without a PR URL falls back to the session deep link",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-nopr", SessionID: "dead-3", ProjectID: "ao",
							Type: domain.NotificationWorkerDiedUnfinished, Title: "died", Status: domain.NotificationUnread,
							CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "notification:ao:dead-3:worker_died_unfinished", kind: "worker_died_unfinished",
				sessionID: "dead-3",
				prURL:     "",
				deepLink:  "/projects/ao/sessions/dead-3",
			}},
		},
		{
			// Phase 2: main-CI red is a durable operator-attention notification the
			// projection must fold in (it was only surfaced by the JS classifiers
			// before). It carries no session, so it deliberately has no navigation
			// target rather than a self-link back to the waiting page.
			name: "main_ci_red notification surfaces as an operator-attention item",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-mainci", ProjectID: "ao",
							Type: domain.NotificationMainCIRed, Status: domain.NotificationUnread,
							Title:     "main is red at abc1234: build",
							Body:      "Main-branch CI failed for aoagents/agent-orchestrator at abc1234. Merge is frozen until main is green.",
							CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "notification:ao:project:ao:main_ci_red", kind: "main_ci_red",
				sessionID:     "",
				prURL:         "",
				exactDeepLink: true,
				reason:        "Main-branch CI failed for aoagents/agent-orchestrator at abc1234. Merge is frozen until main is green.",
				action:        "Fix main-branch CI before merging; only main-CI fix PRs should merge until it is green.",
			}},
		},
		{
			name: "main_ci_red with no title/body uses type-specific fallback copy and has no deep link",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-mainci-empty", ProjectID: "ao",
							Type: domain.NotificationMainCIRed, Status: domain.NotificationUnread,
							CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "notification:ao:project:ao:main_ci_red", kind: "main_ci_red",
				sessionID:     "",
				prURL:         "",
				exactDeepLink: true,
				reason:        "Main-branch CI is failing; merges are frozen until it is green.",
				action:        "Fix main-branch CI before merging; only main-CI fix PRs should merge until it is green.",
			}},
		},
		{
			// Phase 2: a duplicate-PR alert is an operator-attention item (a human
			// must pick which PR to keep). Its deep link is the duplicate PR URL.
			name: "duplicate_pr notification surfaces with the PR deep link",
			build: func() *parityFakeAttentionService {
				dupPR := "https://github.com/aoagents/agent-orchestrator/pull/981"
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-dup", ProjectID: "ao", SessionID: "dup-sess", PRURL: dupPR,
							Type: domain.NotificationDuplicatePR, Status: domain.NotificationUnread,
							Title:     "Duplicate PR for the same issue",
							CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "notification:ao:pr:https://github.com/aoagents/agent-orchestrator/pull/981:duplicate_pr", kind: "duplicate_pr",
				sessionID: "dup-sess",
				prURL:     "https://github.com/aoagents/agent-orchestrator/pull/981",
				deepLink:  "https://github.com/aoagents/agent-orchestrator/pull/981",
			}},
		},
		{
			// Phase 2: replacement-capped is an operator-attention item
			// (auto-replacement is backing off; a human should inspect the
			// harness). It deep-links to the dead role session.
			name: "orchestrator_replacement_capped notification surfaces with the session deep link",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-capped", ProjectID: "ao", SessionID: "orch-1",
							Type: domain.NotificationOrchestratorReplacementCapped, Status: domain.NotificationUnread,
							Title:     "orchestrator replacement backing off",
							Body:      "AO exhausted this project orchestrator's fast replacement window and is retrying with backoff.",
							CreatedAt: now,
						}},
					},
				}
			},
			want: []parityExpect{{
				id: "notification:ao:orch-1:orchestrator_replacement_capped", kind: "orchestrator_replacement_capped",
				sessionID: "orch-1",
				prURL:     "",
				deepLink:  "/projects/ao/sessions/orch-1",
			}},
		},
		{
			name: "orchestrator_replaced notification is informational and does not surface",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-replaced", ProjectID: "ao", SessionID: "ao-prime-replacement",
							Type: domain.NotificationOrchestratorReplaced, Status: domain.NotificationUnread,
							Title:     "prime replaced",
							Body:      "AO replaced the prime orchestrator.",
							CreatedAt: now,
						}},
					},
				}
			},
			want: nil,
		},
		{
			// Phase 2 negative: informational / non-operator-attention notification
			// types must NOT surface in the projection. pr_merged is informational;
			// model_recovered is a recovery. needs_input and ready_to_merge are
			// intentionally excluded here because the projection derives those from
			// live session/decision and PR facts, not notification rows.
			name: "informational and non-attention notification types are excluded",
			build: func() *parityFakeAttentionService {
				return &parityFakeAttentionService{
					notifications: []notificationsvc.Notification{
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-merged", ProjectID: "ao", SessionID: "m-x",
							Type: domain.NotificationPRMerged, Status: domain.NotificationUnread,
							Title: "merged", CreatedAt: now,
						}},
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-recovered", ProjectID: "ao",
							Type: domain.NotificationModelRecovered, Status: domain.NotificationUnread,
							Title: "model recovered", CreatedAt: now,
						}},
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-needs-input", ProjectID: "ao", SessionID: "ask-x",
							Type: domain.NotificationNeedsInput, Status: domain.NotificationUnread,
							Title: "needs input", CreatedAt: now,
						}},
						{NotificationRecord: domain.NotificationRecord{
							ID: "n-ready", ProjectID: "ao", SessionID: "merge-x",
							Type: domain.NotificationReadyToMerge, Status: domain.NotificationUnread,
							Title: "ready to merge", CreatedAt: now,
						}},
					},
				}
			},
			want: nil,
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
			name: "sessions deleted mid-derive (NotFound on PR summaries) are skipped, not fatal",
			build: func() *parityFakeAttentionService {
				url := "https://github.com/aoagents/agent-orchestrator/pull/950"
				gonePR := parityWorker("gone-pr", "ao", domain.StatusMergeable, now)
				gonePR.PRs = []domain.PRFacts{{URL: url, Number: 950, CI: domain.CIPassing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable, UpdatedAt: now}}
				return &parityFakeAttentionService{
					sessions: []domain.Session{gonePR},
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
					sessions:        []domain.Session{parityDecisionWorker("perm-1", "ao", domain.PendingDecision{Kind: domain.DecisionKindPermission, Question: "Allow?"}, now)},
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

// TestOperatorAttentionNotificationReadsAreBounded pins the two-query read
// (finding 1, PR #319 review): the durable escalation types get their own page
// budget, and ready_to_merge is fetched SENSITIVE-ONLY in SQL with a separate
// budget, so accumulating routine green-PR rows can never crowd escalations out
// of a shared page.
func TestOperatorAttentionNotificationReadsAreBounded(t *testing.T) {
	now := parityTime(t)
	svc := &parityFakeAttentionService{
		notifications: []notificationsvc.Notification{
			{NotificationRecord: domain.NotificationRecord{
				ID: "n-mainci", ProjectID: "ao",
				Type: domain.NotificationMainCIRed, Status: domain.NotificationUnread,
				Title: "main red", CreatedAt: now,
			}},
		},
	}
	if _, err := New(Deps{Sessions: svc, Notifications: svc}).ListOperator(context.Background()); err != nil {
		t.Fatalf("ListOperator: %v", err)
	}
	if len(svc.notificationFilters) != 2 {
		t.Fatalf("notification reads = %d (%+v), want 2", len(svc.notificationFilters), svc.notificationFilters)
	}
	durable := svc.notificationFilters[0]
	if durable.Limit != notificationsvc.MaxListLimit || durable.SensitiveOnly {
		t.Fatalf("durable filter = %+v, want limit=%d sensitiveOnly=false", durable, notificationsvc.MaxListLimit)
	}
	wantTypes := domain.OperatorAttentionNotificationTypes()
	if len(durable.Types) != len(wantTypes) {
		t.Fatalf("durable types = %+v, want %+v", durable.Types, wantTypes)
	}
	for i, want := range wantTypes {
		if durable.Types[i] != want {
			t.Fatalf("durable types = %+v, want %+v", durable.Types, wantTypes)
		}
	}
	parked := svc.notificationFilters[1]
	if parked.Limit != notificationsvc.MaxListLimit || !parked.SensitiveOnly {
		t.Fatalf("parked filter = %+v, want limit=%d sensitiveOnly=true", parked, notificationsvc.MaxListLimit)
	}
	if len(parked.Types) != 1 || parked.Types[0] != domain.NotificationReadyToMerge {
		t.Fatalf("parked types = %+v, want [ready_to_merge]", parked.Types)
	}
}

// TestCanonicalPRKey pins the PR-identity normalization used for terminal
// suppression, parked-item dedup, and parked-over-live-pr supersede.
// Unparseable URLs fall open: they only match themselves. The fixture table is
// SHARED with the JS mirror (ops/attention-core.mjs canonicalPrKey) so the two
// parsers cannot drift: both tests read ops/canonical-pr-key-fixtures.json.
func TestCanonicalPRKey(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "ops", "canonical-pr-key-fixtures.json"))
	if err != nil {
		t.Fatalf("read shared fixtures: %v", err)
	}
	var cases []struct {
		In   string `json:"in"`
		Want string `json:"want"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("parse shared fixtures: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("shared fixture table is empty")
	}
	for _, tc := range cases {
		if got := canonicalPRKey(tc.In); got != tc.Want {
			t.Errorf("canonicalPRKey(%q) = %q, want %q", tc.In, got, tc.Want)
		}
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

	t.Run("re-emitted rows for one subject collapse to one item; newest CreatedAt wins regardless of order", func(t *testing.T) {
		// Two notification ROWS (distinct row ids) describe the same unresolved
		// condition: worker_died_unfinished for the same session. The item id is
		// keyed by subject identity, so appendAttentionItem collapses them and
		// attentionItemSupersedes keeps the NEWER CreatedAt. Asserting the
		// survivor's fields (not just that one row exists) defeats a "keep the
		// first duplicate" regression; running both input orders proves the winner
		// is chosen by timestamp, not by list position.
		olderPR := "https://github.com/aoagents/agent-orchestrator/pull/970"
		newerPR := "https://github.com/aoagents/agent-orchestrator/pull/971"
		older := notificationsvc.Notification{NotificationRecord: domain.NotificationRecord{
			ID: "row-old", SessionID: "s-dup", ProjectID: "ao", PRURL: olderPR,
			Type: domain.NotificationWorkerDiedUnfinished, Title: "older", Status: domain.NotificationUnread,
			SubjectKind: domain.NotificationSubjectSession, SubjectID: "s-dup",
			CreatedAt: now,
		}}
		newer := notificationsvc.Notification{NotificationRecord: domain.NotificationRecord{
			ID: "row-new", SessionID: "s-dup", ProjectID: "ao", PRURL: newerPR,
			Type: domain.NotificationWorkerDiedUnfinished, Title: "newer", Status: domain.NotificationUnread,
			SubjectKind: domain.NotificationSubjectSession, SubjectID: "s-dup",
			CreatedAt: now.Add(time.Hour),
		}}
		wantNewerWins := []parityExpect{{
			id: "notification:ao:s-dup:worker_died_unfinished", kind: "worker_died_unfinished",
			sessionID: "s-dup", prURL: newerPR, deepLink: newerPR,
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
					Type: domain.NotificationWorkerDiedUnfinished, Title: "noid", Status: domain.NotificationUnread,
					CreatedAt: now,
				}},
			},
		}
		items, err := New(Deps{Sessions: svc, Notifications: svc}).ListOperator(context.Background())
		if err != nil {
			t.Fatalf("derive: %v", err)
		}
		assertProjectionEquals(t, items, []parityExpect{{
			id: "notification:ao:s-x:worker_died_unfinished", kind: "worker_died_unfinished",
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
		if (w.exactDeepLink || w.deepLink != "") && got.DeepLink != w.deepLink {
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
