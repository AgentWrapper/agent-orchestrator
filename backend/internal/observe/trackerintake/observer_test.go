package trackerintake

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/notify"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestPollSpawnsWorkerForEligibleIssue(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:       true,
				Assignee:      "alice",
				MaxConcurrent: 32,
			}},
		}},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Fix login",
		Body:      "The login form submits twice.",
		State:     domain.IssueOpen,
		URL:       "https://github.com/acme/demo/issues/12",
		Labels:    []string{"agent-ready"},
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(spawner.calls))
	}
	call := spawner.calls[0]
	if call.ProjectID != "demo" || call.Kind != domain.KindWorker {
		t.Fatalf("spawn config = %+v", call)
	}
	if call.IssueID != "github:acme/demo#12" {
		t.Fatalf("IssueID = %q, want canonical github id", call.IssueID)
	}
	// The spawn prompt is the router invocation only (GH #118); issue context
	// (title, body) must NOT leak into it — the worker's skill reads the ticket.
	// The canonical id still rides along in the session's IssueID env, asserted
	// above.
	if want := "/address-issue 12"; call.Prompt != want {
		t.Fatalf("prompt = %q, want exactly %q", call.Prompt, want)
	}
	if call.IssueTitle != "Fix login" {
		t.Fatalf("IssueTitle = %q, want issue title for daemon naming", call.IssueTitle)
	}
	if len(tracker.filters) != 1 {
		t.Fatalf("tracker filters = %d, want 1", len(tracker.filters))
	}
	if got := tracker.filters[0]; got.State != domain.ListOpen || got.Assignee != "alice" || len(got.Labels) != 0 {
		t.Fatalf("tracker filter = %+v", got)
	}
}

func TestPollSkipsExistingIssueSessionsAfterRestart(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 32}},
		}},
		sessions: []domain.SessionRecord{{ID: "demo-1", ProjectID: "demo", IssueID: "github:acme/demo#12"}},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Already running",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %d, want 0", len(spawner.calls))
	}
}

// An issue whose open PR still has a *live* worker driving it must not be
// re-dispatched: the live-driven open PR marks the issue seen, upholding the
// duplicate-PR guard (issue #181). The dedup key is "open PR with a live driver",
// not merely "open PR exists" (issue #230).
func TestPollSkipsIssueWithOpenLinkedPRWithLiveDriver(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 32}},
		}},
		// The worker session is still live and its PR is open — a genuine driver.
		sessions: []domain.SessionRecord{{ID: "demo-1", ProjectID: "demo", IssueID: "github:acme/demo#12", Kind: domain.KindWorker}},
		openPRs: []domain.PullRequest{{
			URL:       "https://github.com/acme/demo/pull/99",
			SessionID: "demo-1",
			Number:    99,
		}},
		prsBySession: map[domain.SessionID][]domain.PullRequest{
			"demo-1": {{URL: "https://github.com/acme/demo/pull/99", SessionID: "demo-1", Number: 99}},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Has an open PR with a live driver",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	notifications := &fakeNotificationSink{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger(), Notifications: notifications}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %d, want 0 (open PR with a live driver must not be dispatched)", len(spawner.calls))
	}
	if len(notifications.intents) != 0 {
		t.Fatalf("notifications = %+v, want none for a live-driven open PR", notifications.intents)
	}
}

// A worker that dies with unfinished work is a terminal escalation: intake
// never launches a replacement (#313 removed the respawn subsystem); the issue
// waits for an explicit operator restart.
func TestPollDeadWorkerEscalatesWithoutReplacement(t *testing.T) {
	issueID := domain.IssueID("github:acme/demo#12")
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:       true,
				Assignee:      "*",
				MaxConcurrent: 32,
			}},
		}},
		sessions: []domain.SessionRecord{{
			ID:                    "demo-1",
			ProjectID:             "demo",
			IssueID:               issueID,
			Kind:                  domain.KindWorker,
			DisplayName:           "demo #12 fix-login",
			IsTerminated:          true,
			TerminalFailureReason: "CI / backend test",
			Activity:              domain.Activity{State: domain.ActivityExited},
			UpdatedAt:             time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC),
		}},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Fix login",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	notifications := &fakeNotificationSink{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger(), Notifications: notifications}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %+v, want none: a dead worker requires an explicit operator restart", spawner.calls)
	}
	if len(notifications.intents) != 1 {
		t.Fatalf("notifications = %d, want 1", len(notifications.intents))
	}
	got := notifications.intents[0]
	if got.Type != domain.NotificationWorkerDiedUnfinished || got.SessionID != "demo-1" || got.IssueID != issueID {
		t.Fatalf("notification = %+v", got)
	}
	if got.TerminalFailureReason != "CI / backend test" {
		t.Fatalf("TerminalFailureReason = %q, want the dead session's failure provenance", got.TerminalFailureReason)
	}
	if got.RecoveryAttempt != 1 || got.RecoveryRung != domain.RecoveryRungWorker || got.RecoveryIncidentID == "" {
		t.Fatalf("recovery metadata = id=%q attempt=%d rung=%q, want incident attempt 1 worker", got.RecoveryIncidentID, got.RecoveryAttempt, got.RecoveryRung)
	}
	if len(store.recoveryIncidents) != 1 {
		t.Fatalf("recovery incidents = %+v, want one", store.recoveryIncidents)
	}
	incident := store.recoveryIncidents[0]
	if incident.Attempt != 1 || incident.Rung != domain.RecoveryRungWorker || incident.LastSessionID != "demo-1" {
		t.Fatalf("incident = %+v, want attempt 1 worker for demo-1", incident)
	}
}

// A live NON-worker session bound to the issue (an orchestrator) marks the
// issue seen, but it must not silence a dead worker's terminal escalation.
func TestPollDeadWorkerEscalatesDespiteAttachedNonWorkerSession(t *testing.T) {
	issueID := domain.IssueID("github:acme/demo#12")
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:       true,
				Assignee:      "*",
				MaxConcurrent: 32,
			}},
		}},
		sessions: []domain.SessionRecord{
			{
				ID:           "demo-worker-1",
				ProjectID:    "demo",
				IssueID:      issueID,
				Kind:         domain.KindWorker,
				DisplayName:  "demo #12 fix-login",
				IsTerminated: true,
				Activity:     domain.Activity{State: domain.ActivityExited},
				UpdatedAt:    time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC),
			},
			{
				ID:        "demo-orchestrator",
				ProjectID: "demo",
				IssueID:   issueID,
				Kind:      domain.KindOrchestrator,
			},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Fix login",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	notifications := &fakeNotificationSink{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger(), Notifications: notifications}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %+v, want none: replacement requires an explicit operator restart", spawner.calls)
	}
	if len(notifications.intents) != 1 || notifications.intents[0].Type != domain.NotificationWorkerDiedUnfinished {
		t.Fatalf("notifications = %+v, want one worker death escalation despite the attached orchestrator", notifications.intents)
	}
}

// Repeated polls over the same unresolved dead worker must not spam: the real
// store dedupes the terminal notification by subject+type+body, and the dedupe
// survives an operator marking the row read.
func TestPollDeadWorkerNotificationDedupesAcrossPolls(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC)
	issueID := domain.IssueID("github:acme/demo#12")
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.UpsertProject(ctx, domain.ProjectRecord{
		ID:            "demo",
		Path:          "/repo/demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		RegisteredAt:  now,
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	worker, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID:    "demo",
		IssueID:      issueID,
		Kind:         domain.KindWorker,
		Harness:      domain.HarnessClaudeCode,
		DisplayName:  "demo #12 fix-login",
		IsTerminated: true,
		Activity:     domain.Activity{State: domain.ActivityExited, LastActivityAt: now},
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatalf("seed worker: %v", err)
	}
	if err := store.WriteSCMObservation(ctx, domain.PullRequest{
		URL:          "https://github.com/acme/demo/pull/99",
		SessionID:    worker.ID,
		Number:       99,
		SourceBranch: "ao/demo-1/root",
		TargetBranch: "main",
		UpdatedAt:    now,
		ObservedAt:   now,
	}, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatalf("seed PR: %v", err)
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Fix login",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	publisher := &recordingNotificationPublisher{}
	nextID := 0
	notifications := notify.New(notify.Deps{
		Store:     store,
		Publisher: publisher,
		Clock:     func() time.Time { return now },
		NewID: func() string {
			nextID++
			return fmt.Sprintf("ntf_%d", nextID)
		},
	})
	observer := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger(), Notifications: notifications, Clock: func() time.Time { return now }})

	if err := observer.Poll(ctx); err != nil {
		t.Fatalf("first Poll() error = %v", err)
	}
	if err := observer.Poll(ctx); err != nil {
		t.Fatalf("second Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %+v, want none: intake never respawns a dead worker", spawner.calls)
	}
	if len(publisher.records) != 1 {
		t.Fatalf("published = %+v, want exactly one terminal death notification across polls", publisher.records)
	}
	got := publisher.records[0]
	if got.Type != domain.NotificationWorkerDiedUnfinished || got.SessionID != worker.ID || got.PRURL != "https://github.com/acme/demo/pull/99" {
		t.Fatalf("notification = %+v", got)
	}
	if !strings.Contains(got.Body, "respawn only to verify it") {
		t.Fatalf("body = %q, want terminal recovery copy", got.Body)
	}

	// The dedupe survives read: acknowledging the escalation must not resurrect
	// it on the next poll.
	if _, ok, err := store.MarkNotificationRead(ctx, got.ID); err != nil || !ok {
		t.Fatalf("mark notification read ok=%v err=%v", ok, err)
	}
	if err := observer.Poll(ctx); err != nil {
		t.Fatalf("third Poll() error = %v", err)
	}
	if len(publisher.records) != 1 {
		t.Fatalf("published after read = %+v, want no re-emission", publisher.records)
	}
	rows, err := store.ListUnreadNotifications(ctx, notificationsvc.ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListUnreadNotifications: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("unread rows = %+v, want none after acknowledgement", rows)
	}
}

func TestPollDoesNotRespawnWhenLiveWorkerAlreadyReplacedDeadWorker(t *testing.T) {
	issueID := domain.IssueID("github:acme/demo#12")
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
		}},
		sessions: []domain.SessionRecord{
			{
				ID:           "demo-worker-1",
				ProjectID:    "demo",
				IssueID:      issueID,
				Kind:         domain.KindWorker,
				IsTerminated: true,
				Activity:     domain.Activity{State: domain.ActivityExited},
				UpdatedAt:    time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC),
			},
			{
				ID:        "demo-worker-2",
				ProjectID: "demo",
				IssueID:   issueID,
				Kind:      domain.KindWorker,
				Activity:  domain.Activity{State: domain.ActivityActive},
				UpdatedAt: time.Date(2026, 7, 10, 11, 0, 0, 0, time.UTC),
			},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Fix login",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	notifications := &fakeNotificationSink{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger(), Notifications: notifications}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %+v, want none while a live worker is already attached", spawner.calls)
	}
	if len(notifications.intents) != 0 {
		t.Fatalf("notifications = %+v, want none while live replacement is running", notifications.intents)
	}
}

func TestWorkerDiedIntentCarriesTerminalFailureReasonAndRecoveryMetadata(t *testing.T) {
	intent := workerDiedIntent(domain.SessionRecord{
		ID:                    "demo-3",
		ProjectID:             "demo",
		DisplayName:           "demo #12 fix-login",
		TerminalFailureReason: "CI / backend test",
	}, "github:acme/demo#12", domain.RecoveryIncident{ID: "recovery_abc", Attempt: 2, Rung: domain.RecoveryRungOrc})

	if intent.TerminalFailureReason != "CI / backend test" {
		t.Fatalf("TerminalFailureReason = %q, want failure point", intent.TerminalFailureReason)
	}
	if intent.RecoveryIncidentID != "recovery_abc" || intent.RecoveryAttempt != 2 || intent.RecoveryRung != domain.RecoveryRungOrc {
		t.Fatalf("recovery metadata = id=%q attempt=%d rung=%q", intent.RecoveryIncidentID, intent.RecoveryAttempt, intent.RecoveryRung)
	}
}

func TestPollRepeatDeadWorkerAdvancesRecoveryRungWithoutRespawn(t *testing.T) {
	issueID := domain.IssueID("github:acme/demo#12")
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
		}},
		sessions: []domain.SessionRecord{{
			ID:                    "demo-1",
			ProjectID:             "demo",
			IssueID:               issueID,
			Kind:                  domain.KindWorker,
			DisplayName:           "demo #12 fix-login",
			IsTerminated:          true,
			TerminalFailureReason: "runtime probe reported dead",
			Activity:              domain.Activity{State: domain.ActivityExited},
			UpdatedAt:             time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC),
		}},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Fix login",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	notifications := &fakeNotificationSink{}
	observer := New(singleResolver(tracker), store, spawner, Config{
		Logger:        discardLogger(),
		Notifications: notifications,
		Clock:         func() time.Time { return time.Date(2026, 7, 10, 10, 5, 0, 0, time.UTC) },
	})

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll() error = %v", err)
	}
	if len(store.recoveryIncidents) != 1 || store.recoveryIncidents[0].Attempt != 1 {
		t.Fatalf("after first poll incidents = %+v", store.recoveryIncidents)
	}
	// A second poll over the same dead session is not a repeat death and must
	// not advance the incident.
	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("same-session Poll() error = %v", err)
	}
	if store.recoveryIncidents[0].Attempt != 1 {
		t.Fatalf("same dead session advanced attempt to %d", store.recoveryIncidents[0].Attempt)
	}

	store.recoveryIncidents[0].Status = domain.RecoveryIncidentVerifying
	store.recoveryIncidents[0].FixReference = "PR #400"
	store.recoveryIncidents[0].VerificationSessionID = "demo-verify"
	store.sessions = append(store.sessions, domain.SessionRecord{
		ID:                    "demo-2",
		ProjectID:             "demo",
		IssueID:               issueID,
		Kind:                  domain.KindWorker,
		DisplayName:           "demo #12 fix-login",
		IsTerminated:          true,
		TerminalFailureReason: "runtime probe reported dead",
		Activity:              domain.Activity{State: domain.ActivityExited},
		UpdatedAt:             time.Date(2026, 7, 10, 11, 0, 0, 0, time.UTC),
	})
	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("repeat Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %+v, want none for repeat death", spawner.calls)
	}
	got := store.recoveryIncidents[0]
	if got.Attempt != 2 || got.Rung != domain.RecoveryRungOrc || got.LastSessionID != "demo-2" || got.Status != domain.RecoveryIncidentOpen || got.FixReference != "" || got.LastFailedFixReference != "PR #400" || got.VerificationSessionID != "" {
		t.Fatalf("repeat incident = %+v, want attempt 2 open orc on demo-2 with failed fix retained and verification cleared", got)
	}
	if last := notifications.intents[len(notifications.intents)-1]; last.RecoveryAttempt != 2 || last.RecoveryRung != domain.RecoveryRungOrc {
		t.Fatalf("repeat notification = %+v, want attempt 2 orc", last)
	}

	store.sessions = append(store.sessions, domain.SessionRecord{
		ID:                    "demo-3",
		ProjectID:             "demo",
		IssueID:               issueID,
		Kind:                  domain.KindWorker,
		DisplayName:           "demo #12 fix-login",
		IsTerminated:          true,
		TerminalFailureReason: "runtime probe reported dead",
		Activity:              domain.Activity{State: domain.ActivityExited},
		UpdatedAt:             time.Date(2026, 7, 10, 11, 15, 0, 0, time.UTC),
	})
	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("second repeat Poll() error = %v", err)
	}
	got = store.recoveryIncidents[0]
	if got.Attempt != 3 || got.Rung != domain.RecoveryRungPrime || got.LastSessionID != "demo-3" || got.LastFailedFixReference != "PR #400" {
		t.Fatalf("second repeat incident = %+v, want attempt 3 prime with prior failed fix retained", got)
	}

	store.recoveryIncidents[0].Status = domain.RecoveryIncidentResolved
	store.recoveryIncidents[0].ResolvedAt = time.Date(2026, 7, 10, 11, 30, 0, 0, time.UTC)
	store.recoveryIncidents[0].UpdatedAt = store.recoveryIncidents[0].ResolvedAt
	store.sessions = append(store.sessions, domain.SessionRecord{
		ID:                    "demo-4",
		ProjectID:             "demo",
		IssueID:               issueID,
		Kind:                  domain.KindWorker,
		DisplayName:           "demo #12 fix-login",
		IsTerminated:          true,
		TerminalFailureReason: "runtime probe reported dead",
		Activity:              domain.Activity{State: domain.ActivityExited},
		UpdatedAt:             time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC),
	})
	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("post-resolution Poll() error = %v", err)
	}
	if len(store.recoveryIncidents) != 2 {
		t.Fatalf("post-resolution incidents = %+v, want a new generation", store.recoveryIncidents)
	}
	next := store.recoveryIncidents[1]
	if next.ID == store.recoveryIncidents[0].ID || next.Attempt != 1 || next.Rung != domain.RecoveryRungWorker || next.LastSessionID != "demo-4" {
		t.Fatalf("post-resolution incident = %+v, previous=%+v; want distinct attempt 1 generation for demo-4", next, store.recoveryIncidents[0])
	}
}

// A worker that died leaving an OPEN PR with no live driver must not go silent
// (issue #230): the terminal escalation names the orphaned PR so the operator
// can find it. Intake never dispatches a replacement — resuming the PR is an
// explicit operator decision (#313).
func TestPollEscalatesWhenDeadWorkerLeftOrphanedOpenPR(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
		}},
		sessions: []domain.SessionRecord{{
			ID:           "demo-1",
			ProjectID:    "demo",
			IssueID:      "github:acme/demo#12",
			Kind:         domain.KindWorker,
			IsTerminated: true,
			DisplayName:  "demo #12 fix-login",
			UpdatedAt:    time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC),
		}},
		openPRs: []domain.PullRequest{{URL: "https://github.com/acme/demo/pull/99", SessionID: "demo-1", Number: 99, SourceBranch: "ao/demo-1/issue-12"}},
		prsBySession: map[domain.SessionID][]domain.PullRequest{
			"demo-1": {{URL: "https://github.com/acme/demo/pull/99", SessionID: "demo-1", Number: 99, SourceBranch: "ao/demo-1/issue-12"}},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Has an orphaned open PR",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	notifications := &fakeNotificationSink{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger(), Notifications: notifications}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %+v, want none: an orphaned PR waits for an explicit operator restart", spawner.calls)
	}
	if len(notifications.intents) != 1 {
		t.Fatalf("notifications = %+v, want one worker death escalation", notifications.intents)
	}
	got := notifications.intents[0]
	if got.Type != domain.NotificationWorkerDiedUnfinished || got.SessionID != "demo-1" || got.IssueID != "github:acme/demo#12" {
		t.Fatalf("notification = %+v", got)
	}
	if got.PRURL != "https://github.com/acme/demo/pull/99" {
		t.Fatalf("notification = %+v, want the orphaned PR URL surfaced as a fact", got)
	}
}

// A merged PR belonging to the LATEST dead worker means the work landed:
// no escalation, no dispatch.
func TestPollSuppressesEscalationWhenLatestDeadWorkerMergedItsPR(t *testing.T) {
	issueID := domain.IssueID("github:acme/demo#12")
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
		}},
		sessions: []domain.SessionRecord{{
			ID:           "demo-1",
			ProjectID:    "demo",
			IssueID:      issueID,
			Kind:         domain.KindWorker,
			IsTerminated: true,
			UpdatedAt:    time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC),
		}},
		prsBySession: map[domain.SessionID][]domain.PullRequest{
			"demo-1": {{URL: "https://github.com/acme/demo/pull/99", SessionID: "demo-1", Number: 99, Merged: true, UpdatedAt: time.Date(2026, 7, 10, 9, 30, 0, 0, time.UTC)}},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Landed then reopened tracker state",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	notifications := &fakeNotificationSink{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger(), Notifications: notifications}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 || len(notifications.intents) != 0 {
		t.Fatalf("spawns = %+v notifications = %+v, want none when the latest worker's PR merged", spawner.calls, notifications.intents)
	}
}

// A merged PR from an EARLIER worker generation must not silence the death of a
// LATER worker: a reopened issue (or follow-up work) whose fresh worker dies
// still escalates. Only a merged PR belonging to — or postdating — the latest
// dead worker counts as completion.
func TestPollEscalatesWhenLaterWorkerDiesAfterEarlierWorkersMergedPR(t *testing.T) {
	issueID := domain.IssueID("github:acme/demo#12")
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
		}},
		sessions: []domain.SessionRecord{
			{
				ID:           "demo-1",
				ProjectID:    "demo",
				IssueID:      issueID,
				Kind:         domain.KindWorker,
				IsTerminated: true,
				UpdatedAt:    time.Date(2026, 7, 9, 10, 0, 0, 0, time.UTC),
			},
			{
				ID:           "demo-2",
				ProjectID:    "demo",
				IssueID:      issueID,
				Kind:         domain.KindWorker,
				DisplayName:  "demo #12 reopened follow-up",
				IsTerminated: true,
				UpdatedAt:    time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC),
			},
		},
		// The merged PR belongs to the EARLIER worker and predates the later
		// worker's chronology — stale history, not completion.
		prsBySession: map[domain.SessionID][]domain.PullRequest{
			"demo-1": {{URL: "https://github.com/acme/demo/pull/90", SessionID: "demo-1", Number: 90, Merged: true, UpdatedAt: time.Date(2026, 7, 9, 11, 0, 0, 0, time.UTC)}},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Reopened after an earlier PR merged",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	notifications := &fakeNotificationSink{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger(), Notifications: notifications}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %+v, want none: replacement requires an explicit operator restart", spawner.calls)
	}
	if len(notifications.intents) != 1 {
		t.Fatalf("notifications = %+v, want the later worker's death escalation despite the earlier merged PR", notifications.intents)
	}
	got := notifications.intents[0]
	if got.Type != domain.NotificationWorkerDiedUnfinished || got.SessionID != "demo-2" || got.IssueID != issueID {
		t.Fatalf("notification = %+v, want the LATEST dead worker's escalation", got)
	}
}

// The chronology comparison needs BOTH timestamps: a latest worker with no
// recorded chronology (zero UpdatedAt and CreatedAt) must not let an earlier
// worker's nonzero merged-PR timestamp silence its death escalation. Ownership
// by the latest worker still counts independently of timestamps.
func TestMergedPRIsCurrentRequiresUsableChronologyOnBothSides(t *testing.T) {
	earlier := domain.SessionRecord{ID: "demo-1", Kind: domain.KindWorker, IsTerminated: true}
	latest := domain.SessionRecord{ID: "demo-2", Kind: domain.KindWorker, IsTerminated: true}
	pr := domain.PullRequest{
		URL:       "https://github.com/acme/demo/pull/90",
		SessionID: "demo-1",
		Merged:    true,
		UpdatedAt: time.Date(2026, 7, 9, 11, 0, 0, 0, time.UTC),
	}
	if mergedPRIsCurrent(pr, earlier, latest) {
		t.Fatal("an earlier merged PR must not count as current against a latest worker with no usable chronology")
	}
	// Ownership by the latest worker wins regardless of timestamps.
	ownPR := domain.PullRequest{URL: "https://github.com/acme/demo/pull/91", SessionID: "demo-2", Merged: true}
	if !mergedPRIsCurrent(ownPR, latest, latest) {
		t.Fatal("the latest worker's own merged PR must count as current even without timestamps")
	}
}

// An earlier worker's PR merged AFTER the latest worker died (posthumously, by
// an operator or orchestrator) does complete the issue: no escalation.
func TestPollSuppressesEscalationWhenEarlierWorkersPRMergedPosthumously(t *testing.T) {
	issueID := domain.IssueID("github:acme/demo#12")
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
		}},
		sessions: []domain.SessionRecord{
			{ID: "demo-1", ProjectID: "demo", IssueID: issueID, Kind: domain.KindWorker, IsTerminated: true, UpdatedAt: time.Date(2026, 7, 9, 10, 0, 0, 0, time.UTC)},
			{ID: "demo-2", ProjectID: "demo", IssueID: issueID, Kind: domain.KindWorker, IsTerminated: true, UpdatedAt: time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC)},
		},
		// Merged at 11:00, after the latest worker died at 10:00 — the merge
		// postdates the latest generation, so the issue is complete.
		prsBySession: map[domain.SessionID][]domain.PullRequest{
			"demo-1": {{URL: "https://github.com/acme/demo/pull/90", SessionID: "demo-1", Number: 90, Merged: true, UpdatedAt: time.Date(2026, 7, 10, 11, 0, 0, 0, time.UTC)}},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Merged posthumously",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}
	notifications := &fakeNotificationSink{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger(), Notifications: notifications}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 || len(notifications.intents) != 0 {
		t.Fatalf("spawns = %+v notifications = %+v, want none when the merge postdates the latest dead worker", spawner.calls, notifications.intents)
	}
}

// A read failure on the open-PR surface must not silently re-dispatch a
// duplicate: the pass fails (and is retried after backoff).
func TestPollFailsWhenOpenPRReadFails(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 32}},
		}},
		openPRsErr: errors.New("boom"),
	}
	spawner := &fakeSpawner{}
	err := New(singleResolver(&fakeTracker{}), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background())
	if err == nil {
		t.Fatal("Poll() error = nil, want the open-PR read error to surface")
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %d, want 0 on read failure", len(spawner.calls))
	}
}

func TestPollSkipsSessionScanWhenIntakeDisabled(t *testing.T) {
	store := &fakeStore{
		projects:    []domain.ProjectRecord{{ID: "demo"}},
		sessionsErr: errors.New("session scan should not run"),
	}

	if err := New(singleResolver(&fakeTracker{}), store, &fakeSpawner{}, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v, want nil", err)
	}
}

func TestPollSkipsIneligibleAndInvalidProjects(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{
			{ID: "off", RepoOriginURL: "https://github.com/acme/off.git"},
			// Valid intake still fails later when no repository scope can be derived.
			{ID: "missing-origin", Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 32}}},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:    domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/off#1"},
		Title: "ignored",
		State: domain.IssueOpen,
	}}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(tracker.repos) != 0 {
		t.Fatalf("tracker was called for invalid/off projects: %+v", tracker.repos)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %d, want 0", len(spawner.calls))
	}
}

func TestPollContinuesAfterTrackerAndSpawnFailures(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{
		{ID: "bad", RepoOriginURL: "https://github.com/acme/bad.git", Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 32}}},
		{ID: "good", RepoOriginURL: "https://github.com/acme/good.git", Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 32}}},
	}}
	tracker := &fakeTracker{
		failRepos: map[string]error{"acme/bad": errors.New("rate limited")},
		issuesByRepo: map[string][]domain.Issue{
			"acme/good": {
				{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/good#1"}, Title: "first", State: domain.IssueOpen, Assignees: []string{"alice"}},
				{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/good#2"}, Title: "second", State: domain.IssueOpen, Assignees: []string{"alice"}},
			},
		},
	}
	spawner := &fakeSpawner{failIssue: domain.IssueID("github:acme/good#1")}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn attempts = %d, want 2", len(spawner.calls))
	}
	if spawner.calls[1].IssueID != "github:acme/good#2" {
		t.Fatalf("second spawn issue = %q", spawner.calls[1].IssueID)
	}
}

func TestPollBacksOffProjectAfterFailure(t *testing.T) {
	now := time.Date(2026, 6, 27, 10, 0, 0, 0, time.UTC)
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 32}},
	}}}
	tracker := &fakeTracker{failRepos: map[string]error{"acme/demo": errors.New("rate limited")}}
	observer := New(singleResolver(tracker), store, &fakeSpawner{}, Config{
		Clock:          func() time.Time { return now },
		FailureBackoff: time.Minute,
		Logger:         discardLogger(),
	})

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll() error = %v", err)
	}
	if len(tracker.repos) != 1 {
		t.Fatalf("tracker calls after first poll = %d, want 1", len(tracker.repos))
	}

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll() error = %v", err)
	}
	if len(tracker.repos) != 1 {
		t.Fatalf("tracker calls during backoff = %d, want still 1", len(tracker.repos))
	}

	now = now.Add(time.Minute + time.Nanosecond)
	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("third Poll() error = %v", err)
	}
	if len(tracker.repos) != 2 {
		t.Fatalf("tracker calls after backoff = %d, want 2", len(tracker.repos))
	}
}

func TestPollSkipsNonOpenIssueStates(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 32}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "already active", State: domain.IssueInProgress, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "ready", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 || spawner.calls[0].IssueID != "github:acme/demo#2" {
		t.Fatalf("spawn calls = %+v, want only open issue #2", spawner.calls)
	}
}

func TestPollAppliesLocalEligibilityFilter(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice", MaxConcurrent: 32}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "unassigned", State: domain.IssueOpen},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "wrong assignee", State: domain.IssueOpen, Assignees: []string{"bob"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "eligible", State: domain.IssueOpen, Labels: []string{"Agent-Ready"}, Assignees: []string{"Alice"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 || spawner.calls[0].IssueID != "github:acme/demo#3" {
		t.Fatalf("spawn calls = %+v, want only eligible issue #3", spawner.calls)
	}
}

func TestIssueMatchesConfigAssigneeSpecialValues(t *testing.T) {
	assigned := domain.Issue{Assignees: []string{"alice"}}
	unassigned := domain.Issue{}
	if !issueMatchesConfig(assigned, domain.TrackerIntakeConfig{Assignee: "*"}) {
		t.Fatal("assigned issue should match assignee=*")
	}
	if issueMatchesConfig(unassigned, domain.TrackerIntakeConfig{Assignee: "*"}) {
		t.Fatal("unassigned issue should not match assignee=*")
	}
	if issueMatchesConfig(unassigned, domain.TrackerIntakeConfig{Assignee: "none"}) {
		t.Fatal("assignee=none must never authorize unassigned work")
	}
	if issueMatchesConfig(assigned, domain.TrackerIntakeConfig{Assignee: "none"}) {
		t.Fatal("assigned issue should not match assignee=none")
	}
}

func TestIssueMatchesConfigIgnoresLabelsForAdmission(t *testing.T) {
	withLabels := func(labels ...string) domain.Issue {
		return domain.Issue{Assignees: []string{"alice"}, Labels: labels}
	}
	cfg := domain.TrackerIntakeConfig{Assignee: "alice", Labels: []string{"agent-ok"}, ExcludeLabels: []string{"no-ao"}}
	for _, issue := range []domain.Issue{withLabels(), withLabels("other"), withLabels("no-ao"), withLabels("agent-ok", "human-review")} {
		if !issueMatchesConfig(issue, cfg) {
			t.Fatalf("assigned issue rejected because of labels: %#v", issue.Labels)
		}
	}
}

func TestPollIgnoresLegacyLabelAdmissionFields(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
			Enabled:       true,
			Assignee:      "alice",
			MaxConcurrent: 4,
			Labels:        []string{"agent-ok"},
			ExcludeLabels: []string{"agent:noauto"},
		}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "no included label", State: domain.IssueOpen, Assignees: []string{"alice"}, Labels: []string{"chore"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "excluded", State: domain.IssueOpen, Assignees: []string{"alice"}, Labels: []string{"agent-ok", "agent:noauto"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "eligible", State: domain.IssueOpen, Assignees: []string{"alice"}, Labels: []string{"Agent-OK"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 3 {
		t.Fatalf("spawn calls = %+v, want all three assigned issues regardless of labels", spawner.calls)
	}
}

func TestPollLetsSpawnEnforceMaxConcurrentAgainstLiveWorkers(t *testing.T) {
	// Intake does not compute live capacity. The session manager admits the
	// first issue and returns WORKER_CONCURRENCY_CAP for the second.
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:       true,
				Assignee:      "alice",
				MaxConcurrent: 2,
			}},
		}},
		sessions: []domain.SessionRecord{
			{ID: "demo-live", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#100"},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "first", State: domain.IssueOpen, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "second", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{failErrByIssue: map[domain.IssueID]error{
		"github:acme/demo#2": apierr.Conflict("WORKER_CONCURRENCY_CAP", "session: worker concurrency cap reached", nil),
	}}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want admitted issue then cap collision", len(spawner.calls))
	}
	if spawner.calls[0].IssueID != "github:acme/demo#1" {
		t.Fatalf("first spawn issue = %q, want github:acme/demo#1", spawner.calls[0].IssueID)
	}
}

func TestPollDefersNormalIssuesAfterSpawnReportsMaxConcurrent(t *testing.T) {
	// Once the session manager reports a full pool, intake defers every remaining
	// issue in this pass; labels cannot create an admission bypass.
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:       true,
				Assignee:      "alice",
				MaxConcurrent: 2,
			}},
		}},
		sessions: []domain.SessionRecord{
			{ID: "demo-a", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#100"},
			{ID: "demo-b", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#101"},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "eligible", State: domain.IssueOpen, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "urgent", State: domain.IssueOpen, Assignees: []string{"alice"}, Labels: []string{"nopool", "agent:fugu"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "still capped", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{failErrByIssue: map[domain.IssueID]error{
		"github:acme/demo#1": apierr.Conflict("WORKER_CONCURRENCY_CAP", "session: worker concurrency cap reached", nil),
	}}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want only the first cap collision", len(spawner.calls))
	}
	if len(tracker.repos) != 1 {
		t.Fatalf("tracker queried %d times, want one deterministic list pass", len(tracker.repos))
	}
}

func TestPollDefersWithoutBackoffWhenSpawnHitsConcurrencyCap(t *testing.T) {
	now := time.Date(2026, 7, 8, 10, 0, 0, 0, time.UTC)
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:       true,
				Assignee:      "alice",
				MaxConcurrent: 1,
			}},
		}},
	}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "first", State: domain.IssueOpen, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "second", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{
		failErrByIssue: map[domain.IssueID]error{
			"github:acme/demo#1": apierr.Conflict("WORKER_CONCURRENCY_CAP", "session: worker concurrency cap reached", nil),
		},
	}
	observer := New(singleResolver(tracker), store, spawner, Config{
		Clock:          func() time.Time { return now },
		FailureBackoff: time.Hour,
		Logger:         discardLogger(),
	})

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want 1 cap collision then defer", len(spawner.calls))
	}
	if len(tracker.repos) != 1 {
		t.Fatalf("tracker calls after first poll = %d, want 1", len(tracker.repos))
	}

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll() error = %v", err)
	}
	if len(tracker.repos) != 2 {
		t.Fatalf("tracker calls after second poll = %d, want 2 (cap collision must not enter failure backoff)", len(tracker.repos))
	}
}

func TestPollDefersWithoutBackoffWhenWorkerMixBucketDown(t *testing.T) {
	now := time.Date(2026, 7, 8, 10, 0, 0, 0, time.UTC)
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"},
		Title:     "first",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{failErrByIssue: map[domain.IssueID]error{
		"github:acme/demo#1": apierr.Conflict("WORKER_MIX_BUCKET_DOWN", "session: worker mix bucket is down", nil),
	}}
	observer := New(singleResolver(tracker), store, spawner, Config{
		Clock:          func() time.Time { return now },
		FailureBackoff: time.Hour,
		Logger:         discardLogger(),
	})

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want 1 bucket-down deferral", len(spawner.calls))
	}
	if len(tracker.repos) != 1 {
		t.Fatalf("tracker calls after first poll = %d, want 1", len(tracker.repos))
	}
	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll() error = %v", err)
	}
	if len(tracker.repos) != 2 {
		t.Fatalf("tracker calls after second poll = %d, want 2 (bucket down must not enter failure backoff)", len(tracker.repos))
	}
}

func TestSeenIssueIDsCanonicalizesLegacyBareNumbers(t *testing.T) {
	projects := []domain.ProjectRecord{{
		ID: "ao",
		Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
			Provider: domain.TrackerProviderGitHub,
			Repo:     "acme/other",
		}},
	}}
	sessions := []domain.SessionRecord{{
		ProjectID: "ao",
		IssueID:   "170",
	}}

	seen := seenIssueIDs(projects, sessions, nil)
	if !seen["170"] {
		t.Fatal("raw legacy issue id was not preserved in seen map")
	}
	if !seen["github:acme/other#170"] {
		t.Fatal("legacy issue id was not canonicalized with project tracker repo")
	}
}

// TestBuildIssuePromptIsRouterInvocationOnly pins the permanent contract from
// GH #118: an intake-spawned worker is handed EXACTLY `/address-issue <id>` and
// nothing else. The router reads the issue itself, so no title/url/labels/body
// dump and no "implement the change" footer may leak into the prompt — even for
// a huge issue body that the old code would have truncated and appended.
func TestBuildIssuePromptIsRouterInvocationOnly(t *testing.T) {
	prompt := BuildIssuePrompt(domain.Issue{
		ID:     domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#118"},
		Title:  "Large issue",
		URL:    "https://github.com/acme/demo/issues/118",
		Labels: []string{"feature"},
		Body:   strings.Repeat("body ", 2000),
	})
	if want := "/address-issue 118"; prompt != want {
		t.Fatalf("prompt = %q, want exactly %q", prompt, want)
	}
}

// TestBuildIssuePromptRefFallsBackToNative covers a native id that carries no
// "#N" suffix: the whole trimmed native is used verbatim so the worker still
// gets a resolvable reference rather than an empty argument.
func TestBuildIssuePromptRefFallsBackToNative(t *testing.T) {
	prompt := BuildIssuePrompt(domain.Issue{
		ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "  bare-id  "},
	})
	if want := "/address-issue bare-id"; prompt != want {
		t.Fatalf("prompt = %q, want exactly %q", prompt, want)
	}
}

func TestTrackerRepoUsesConfiguredRepo(t *testing.T) {
	project := domain.ProjectRecord{
		ID:            "demo",
		RepoOriginURL: "https://github.com/wrong/repo.git",
		Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
			Enabled:  true,
			Repo:     "acme/demo",
			Assignee: "alice",
		}},
	}
	repo, ok := trackerRepo(project, project.Config.TrackerIntake.WithDefaults())
	if !ok {
		t.Fatal("trackerRepo ok = false")
	}
	if repo.Native != "acme/demo" {
		t.Fatalf("repo.Native = %q, want acme/demo", repo.Native)
	}
}

func singleResolver(tracker ports.Tracker) TrackerResolver {
	return SingleTrackerResolver{Provider: domain.TrackerProviderGitHub, Adapter: tracker}
}

type fakeStore struct {
	projects          []domain.ProjectRecord
	sessions          []domain.SessionRecord
	sessionsErr       error
	openPRs           []domain.PullRequest
	openPRsErr        error
	prsBySession      map[domain.SessionID][]domain.PullRequest
	recoveryIncidents []domain.RecoveryIncident
	fleetPaused       bool
}

func (f *fakeStore) ListProjects(context.Context) ([]domain.ProjectRecord, error) {
	return append([]domain.ProjectRecord(nil), f.projects...), nil
}

func (f *fakeStore) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return append([]domain.SessionRecord(nil), f.sessions...), f.sessionsErr
}

func (f *fakeStore) ListOpenPRs(context.Context) ([]domain.PullRequest, error) {
	return append([]domain.PullRequest(nil), f.openPRs...), f.openPRsErr
}

func (f *fakeStore) ListPRsBySession(_ context.Context, sessionID domain.SessionID) ([]domain.PullRequest, error) {
	return append([]domain.PullRequest(nil), f.prsBySession[sessionID]...), nil
}

func (f *fakeStore) GetUnresolvedRecoveryIncidentByFingerprint(_ context.Context, projectID domain.ProjectID, issueID domain.IssueID, fingerprint string) (domain.RecoveryIncident, bool, error) {
	for _, rec := range f.recoveryIncidents {
		if rec.ProjectID == projectID && rec.IssueID == issueID && rec.Fingerprint == fingerprint && rec.Status != domain.RecoveryIncidentResolved {
			return rec, true, nil
		}
	}
	return domain.RecoveryIncident{}, false, nil
}

func (f *fakeStore) CreateRecoveryIncident(_ context.Context, rec domain.RecoveryIncident) (domain.RecoveryIncident, error) {
	for _, existing := range f.recoveryIncidents {
		if existing.ID == rec.ID {
			return domain.RecoveryIncident{}, fmt.Errorf("duplicate recovery incident id")
		}
		if existing.ProjectID == rec.ProjectID && existing.IssueID == rec.IssueID && existing.Fingerprint == rec.Fingerprint && existing.Status != domain.RecoveryIncidentResolved {
			return domain.RecoveryIncident{}, fmt.Errorf("duplicate recovery incident")
		}
	}
	f.recoveryIncidents = append(f.recoveryIncidents, rec)
	return rec, nil
}

func (f *fakeStore) UpdateRecoveryIncident(_ context.Context, rec domain.RecoveryIncident) (domain.RecoveryIncident, bool, error) {
	for i := range f.recoveryIncidents {
		if f.recoveryIncidents[i].ID == rec.ID {
			f.recoveryIncidents[i] = rec
			return rec, true, nil
		}
	}
	return domain.RecoveryIncident{}, false, nil
}

func (f *fakeStore) GetFleetPaused(context.Context) (bool, error) {
	return f.fleetPaused, nil
}

type fakeNotificationSink struct {
	intents []ports.NotificationIntent
}

func (f *fakeNotificationSink) Notify(_ context.Context, intent ports.NotificationIntent) error {
	f.intents = append(f.intents, intent)
	return nil
}

type recordingNotificationPublisher struct {
	records []domain.NotificationRecord
}

func (p *recordingNotificationPublisher) Publish(_ context.Context, rec domain.NotificationRecord) error {
	p.records = append(p.records, rec)
	return nil
}

type fakeTracker struct {
	issues       []domain.Issue
	issuesByRepo map[string][]domain.Issue
	failRepos    map[string]error
	repos        []domain.TrackerRepo
	filters      []domain.ListFilter
}

func (f *fakeTracker) Get(context.Context, domain.TrackerID) (domain.Issue, error) {
	return domain.Issue{}, nil
}

func (f *fakeTracker) List(_ context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	f.repos = append(f.repos, repo)
	f.filters = append(f.filters, filter)
	if err := f.failRepos[repo.Native]; err != nil {
		return nil, err
	}
	if f.issuesByRepo != nil {
		return append([]domain.Issue(nil), f.issuesByRepo[repo.Native]...), nil
	}
	return append([]domain.Issue(nil), f.issues...), nil
}

func (f *fakeTracker) Preflight(context.Context) error { return nil }

type fakeSpawner struct {
	calls          []ports.SpawnConfig
	failIssue      domain.IssueID
	failErrByIssue map[domain.IssueID]error
}

func (f *fakeSpawner) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.Session, error) {
	f.calls = append(f.calls, cfg)
	if err := f.failErrByIssue[cfg.IssueID]; err != nil {
		return domain.Session{}, err
	}
	if cfg.IssueID == f.failIssue {
		return domain.Session{}, errors.New("spawn failed")
	}
	return domain.Session{SessionRecord: domain.SessionRecord{ID: domain.SessionID(string(cfg.ProjectID) + "-1"), ProjectID: cfg.ProjectID, IssueID: cfg.IssueID, Kind: cfg.Kind}}, nil
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestIssueMatchesConfigExcludePrefix covers the scoped-label prefix rule from
// issue #80: an exclude entry "charter" opts out the whole charter:* family
// (charter, charter:C03) without enumerating each one, while a distinct label
// like charter-audit (hyphen, not colon) is NOT swept up by the "charter"
// prefix — it must be listed separately.
func TestIssueMatchesConfigIgnoresLegacyScopedExclusions(t *testing.T) {
	withLabels := func(labels ...string) domain.Issue {
		return domain.Issue{Assignees: []string{"alice"}, Labels: labels}
	}
	cfg := domain.TrackerIntakeConfig{Assignee: "alice", ExcludeLabels: []string{"charter"}}

	for _, issue := range []domain.Issue{withLabels("charter"), withLabels("charter:C03"), withLabels("Charter:C03"), withLabels("charter-audit")} {
		if !issueMatchesConfig(issue, cfg) {
			t.Fatalf("legacy exclusion changed assignment admission: %#v", issue.Labels)
		}
	}
}

// TestIssueHasExcludedLabelFoldConsistency locks that the exact-match and
// scoped-prefix-match paths fold identically. The long-s (ſ) folds to "s" under
// EqualFold, so an entry "scope" must exclude both "ſcope" (exact) and "ſcope:x"
// (scoped prefix) — the two case-insensitive paths cannot disagree.
func TestPollUsesAssignmentRegardlessOfStatusLabels(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 4}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "legacy no-ao", State: domain.IssueOpen, Labels: []string{"no-ao"}, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "charter family", State: domain.IssueOpen, Labels: []string{"charter:C03"}, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "deferred", State: domain.IssueOpen, Labels: []string{"deferred"}, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#4"}, Title: "plain unlabeled", State: domain.IssueOpen},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 3 {
		t.Fatalf("spawn calls = %+v, want all assigned issues regardless of labels", spawner.calls)
	}
}

// TestPollPicksUpSensitiveUnlabeledIssue locks the two-gates rule from #80:
// "sensitive" lives ONLY at the merge gate and NEVER at the work gate. An issue
// describing sensitive-path work is picked up and worked exactly like any other
// unlabeled issue; parking for a human happens later at merge, not here.
func TestPollPicksUpSensitiveUnlabeledIssue(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#7"},
		Title:     "Refactor backend/internal/daemon session lifecycle",
		Body:      "Touches backend/internal/session_manager and backend/internal/lifecycle.",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 || spawner.calls[0].IssueID != "github:acme/demo#7" {
		t.Fatalf("sensitive-but-unlabeled issue must be picked up; spawn calls = %+v", spawner.calls)
	}
}

// mixIssues builds n open, eligible issues for a repo.
func mixIssues(repo string, n int) []domain.Issue {
	issues := make([]domain.Issue, 0, n)
	for i := 1; i <= n; i++ {
		issues = append(issues, domain.Issue{
			ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: fmt.Sprintf("%s#%d", repo, i)},
			Title:     fmt.Sprintf("issue %d", i),
			State:     domain.IssueOpen,
			Assignees: []string{"alice"},
		})
	}
	return issues
}

// TestPollWorkerMixDelegatesOrdinaryAllocation proves intake is not an
// allocator: ordinary issue spawns leave harness/model empty and the session
// manager applies concurrency, D'Hondt selection, exact candidate health, and
// persistence atomically.
func TestPollWorkerMixDelegatesOrdinaryAllocation(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 60},
				{Harness: domain.HarnessCodexFugu, Weight: 30},
				{Harness: domain.HarnessClaudeCode, Model: "opus", Weight: 10},
			},
		},
	}}}
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 10)}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 10 {
		t.Fatalf("spawn calls = %d, want 10", len(spawner.calls))
	}
	for _, c := range spawner.calls {
		if c.Harness != "" || c.Model != "" {
			t.Fatalf("ordinary intake spawn should delegate allocation, got harness=%q model=%q", c.Harness, c.Model)
		}
	}
}

// TestPollWorkerMixDoesNotReadRunningBuckets proves intake no longer performs a
// second running-bucket projection. Existing live workers are observed only for
// issue dedupe/retry; allocation stays inside session_manager.Spawn.
func TestPollWorkerMixDoesNotReadRunningBuckets(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{
				TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32},
				WorkerMix: domain.WorkerMix{
					{Harness: domain.HarnessCodex, Weight: 50},
					{Harness: domain.HarnessCodexFugu, Weight: 50},
				},
			},
		}},
		sessions: []domain.SessionRecord{
			{ID: "demo-1", ProjectID: "demo", Kind: domain.KindWorker, Harness: domain.HarnessCodex},
			{ID: "demo-2", ProjectID: "demo", Kind: domain.KindWorker, Harness: domain.HarnessCodex},
		},
	}
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 2)}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2", len(spawner.calls))
	}
	for i, c := range spawner.calls {
		if c.Harness != "" || c.Model != "" {
			t.Fatalf("spawn %d should delegate allocation, got harness=%q model=%q", i, c.Harness, c.Model)
		}
	}
}

// TestPollWorkerMixRespectsConcurrencyCap proves intake treats the session
// manager's cap decision as authoritative: it attempts ordinary spawns until
// Spawn returns WORKER_CONCURRENCY_CAP, then defers further ordinary issues
// without entering failure backoff.
func TestPollWorkerMixRespectsConcurrencyCap(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 2},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 50},
				{Harness: domain.HarnessCodexFugu, Weight: 50},
			},
		},
	}}}
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 4)}
	spawner := &fakeSpawner{failErrByIssue: map[domain.IssueID]error{
		"github:acme/demo#3": apierr.Conflict("WORKER_CONCURRENCY_CAP", "session: worker concurrency cap reached", nil),
	}}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 3 {
		t.Fatalf("spawn calls = %d, want 2 successes then one cap collision", len(spawner.calls))
	}
	for i, c := range spawner.calls[:2] {
		if c.Harness != "" || c.Model != "" {
			t.Fatalf("spawn %d should delegate allocation, got harness=%q model=%q", i, c.Harness, c.Model)
		}
	}
}

func TestPollRoutingLabelOverridesWorkerMixWithinCap(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 2},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 100},
			},
		},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "pinned", State: domain.IssueOpen, Labels: []string{"agent:claude"}, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "mixed", State: domain.IssueOpen, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "capped", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{failErrByIssue: map[domain.IssueID]error{
		"github:acme/demo#3": apierr.Conflict("WORKER_CONCURRENCY_CAP", "session: worker concurrency cap reached", nil),
	}}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 3 {
		t.Fatalf("spawn calls = %d, want pinned, ordinary, then cap collision", len(spawner.calls))
	}
	if spawner.calls[0].Harness != domain.HarnessClaudeCode {
		t.Fatalf("pinned issue harness = %q, want claude-code", spawner.calls[0].Harness)
	}
	if spawner.calls[1].Harness != "" || spawner.calls[1].Model != "" {
		t.Fatalf("ordinary issue should delegate allocation, got harness=%q model=%q", spawner.calls[1].Harness, spawner.calls[1].Model)
	}
}

func TestPollRoutingLabelCountsAgainstWorkerMixWithinPass(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 50},
				{Harness: domain.HarnessCodexFugu, Weight: 50},
			},
		},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "pinned codex", State: domain.IssueOpen, Labels: []string{"agent:codex"}, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "mixed", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2", len(spawner.calls))
	}
	if spawner.calls[0].Harness != domain.HarnessCodex {
		t.Fatalf("pinned issue harness = %q, want codex", spawner.calls[0].Harness)
	}
	if spawner.calls[1].Harness != "" || spawner.calls[1].Model != "" {
		t.Fatalf("ordinary issue should delegate allocation, got harness=%q model=%q", spawner.calls[1].Harness, spawner.calls[1].Model)
	}
}

func TestPollLegacyNoPoolLabelOnlyRoutesWithinCapacity(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 50},
				{Harness: domain.HarnessCodexFugu, Weight: 50},
			},
		},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "urgent pinned codex", State: domain.IssueOpen, Labels: []string{"nopool", "agent:codex"}, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "mixed", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2", len(spawner.calls))
	}
	if spawner.calls[0].Harness != domain.HarnessCodex {
		t.Fatalf("legacy nopool pinned issue harness = %q, want codex routing only", spawner.calls[0].Harness)
	}
	if spawner.calls[1].Harness != "" || spawner.calls[1].Model != "" {
		t.Fatalf("ordinary issue should delegate allocation, got harness=%q model=%q", spawner.calls[1].Harness, spawner.calls[1].Model)
	}
}

func TestPollLegacyNoPoolCannotBypassMaxConcurrent(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{
				TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 1},
				WorkerMix:     domain.WorkerMix{{Harness: domain.HarnessCodex, Weight: 100}},
			},
		}},
		sessions: []domain.SessionRecord{
			{ID: "demo-live", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#100"},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "normal capped", State: domain.IssueOpen, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "urgent", State: domain.IssueOpen, Labels: []string{"nopool", "agent:fugu"}, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "normal still capped", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{failErrByIssue: map[domain.IssueID]error{
		"github:acme/demo#1": apierr.Conflict("WORKER_CONCURRENCY_CAP", "session: worker concurrency cap reached", nil),
		"github:acme/demo#3": apierr.Conflict("WORKER_CONCURRENCY_CAP", "session: worker concurrency cap reached", nil),
	}}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want only the first cap collision", len(spawner.calls))
	}
}

// TestPollNoMixKeepsSingleDefault proves back-compat: with no mix configured the
// spawn carries no harness/model, so the session manager resolves the single
// worker.agent default exactly as before.
func TestPollNoMixKeepsSingleDefault(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32}},
	}}}
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 1)}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(spawner.calls))
	}
	if got := spawner.calls[0]; got.Harness != "" || got.Model != "" {
		t.Fatalf("no-mix spawn should carry no harness/model, got harness=%q model=%q", got.Harness, got.Model)
	}
}

// TestPollWorkerMixFailedSpawnDoesNotConsumeBucket proves intake no longer owns
// the bucket ledger at all: a failed ordinary spawn has no harness/model selected
// by intake for a later issue to account against.
func TestPollWorkerMixFailedSpawnDoesNotConsumeBucket(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "*", MaxConcurrent: 32},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 50},
				{Harness: domain.HarnessCodexFugu, Weight: 50},
			},
		},
	}}}
	// Issue #1 is picked first (codex, the earliest row on a tie) and fails; the
	// running count stays empty, so issue #2 must again pick codex.
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 2)}
	spawner := &fakeSpawner{failIssue: domain.IssueID("github:acme/demo#1")}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2 (both attempted)", len(spawner.calls))
	}
	if spawner.calls[0].Harness != "" || spawner.calls[0].Model != "" {
		t.Fatalf("first ordinary spawn should delegate allocation, got harness=%q model=%q", spawner.calls[0].Harness, spawner.calls[0].Model)
	}
	if spawner.calls[1].Harness != "" || spawner.calls[1].Model != "" {
		t.Fatalf("second ordinary spawn should delegate allocation, got harness=%q model=%q", spawner.calls[1].Harness, spawner.calls[1].Model)
	}
}
